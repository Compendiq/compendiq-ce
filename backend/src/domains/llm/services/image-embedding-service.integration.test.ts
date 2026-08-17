import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { embedPageImages } from './image-embedding-service.js';
import {
  ensureImageEmbeddingColumn,
  IMAGE_EMBEDDING_HNSW_INDEX,
  IMAGE_EMBEDDING_INDEX_MODEL_KEY,
} from './image-embedding-index.js';
import { invalidateRagImageIntakeCache } from '../../../core/services/admin-settings-service.js';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';

/**
 * #1115 P2 — the image intake, end to end against real Postgres and a real
 * (local) HTTP endpoint. Only the VL provider is mocked, and it is mocked at
 * the HTTP boundary (CLAUDE.md): the enumeration, the store read, the sniff,
 * the sha256 skip, the upsert and the reconcile are all the production code.
 *
 * The width is 4 throughout. `ensureImageEmbeddingColumn(4, PAIR)` retypes the
 * column for this file and records the identity the service rechecks inside
 * its write transaction; `afterAll` puts migration 093's placeholder back, so
 * the migration's own test keeps asserting the migration rather than whichever
 * file ran first.
 */

const dbAvailable = await isDbAvailable();

const DIMS = 4;
const MODEL = 'Qwen/Qwen3-VL-Embedding-2B';

let srv: Server;
let vlBaseUrl: string;
let calls: Array<{ model?: string; dimensions?: number; messages?: unknown }> = [];
let respond: (res: ServerResponse) => void = (res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0] }] }));
};

let attachmentsDir: string;
let previousAttachmentsDir: string | undefined;

// ── image bytes ───────────────────────────────────────────────────────────
// Hand-built headers rather than fixtures: `readImageDimensions` reads the
// PNG IHDR at a fixed offset and nothing here decodes pixels, so a header plus
// padding IS a test image — and it lets a 5 MB case cost 5 MB of zeros rather
// than 5 MB in git.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function png(width: number, height: number, padding = 0): Buffer {
  const ihdr = Buffer.alloc(8);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  return Buffer.concat([
    PNG_SIG,
    Buffer.from([0, 0, 0, 13]),
    Buffer.from('IHDR'),
    ihdr,
    Buffer.alloc(padding),
  ]);
}
/** Confluence's draw.io export: `<mxfile>` XML behind a `.png` name. */
const DRAWIO_PNG = Buffer.from('<mxfile host="Confluence"><diagram/></mxfile>', 'utf8');

async function writeConfluenceAttachment(key: string, name: string, bytes: Buffer): Promise<void> {
  const dir = path.join(attachmentsDir, key);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), bytes);
}

async function writeLocalAttachment(pageId: number, name: string, bytes: Buffer): Promise<void> {
  const dir = path.join(attachmentsDir, 'local', String(pageId));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), bytes);
}

// ── db helpers ────────────────────────────────────────────────────────────

async function seedPage(opts: {
  bodyHtml: string | null;
  source?: 'confluence' | 'standalone';
  confluenceId?: string | null;
  pageType?: string;
  deleted?: boolean;
}): Promise<number> {
  const r = await query<{ id: number }>(
    `INSERT INTO pages (title, space_key, body_html, page_type, source, confluence_id, deleted_at, image_embedding_dirty)
     VALUES ('Doc', 'DEV', $1, $2, $3, $4, $5, TRUE) RETURNING id`,
    [
      opts.bodyHtml,
      opts.pageType ?? 'page',
      opts.source ?? 'standalone',
      opts.confluenceId ?? null,
      opts.deleted ? new Date() : null,
    ],
  );
  return r.rows[0]!.id;
}

async function assignImageEmbedding(): Promise<string> {
  const prov = await query<{ id: string }>(
    `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, default_model)
     VALUES ('vl-box', $1, 'none', TRUE, $2) RETURNING id`,
    [vlBaseUrl, MODEL],
  );
  const providerId = prov.rows[0]!.id;
  await query(
    `INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('image_embedding', $1, $2)`,
    [providerId, MODEL],
  );
  return providerId;
}

async function rowsFor(pageId: number): Promise<Array<{ source: string; attachment_key: string; sha256: string; format: string; width: number | null; height: number | null; model: string }>> {
  const r = await query<{ source: string; attachment_key: string; sha256: string; format: string; width: number | null; height: number | null; model: string }>(
    `SELECT source, attachment_key, sha256, format, width, height, model
       FROM page_image_embeddings WHERE page_id = $1 ORDER BY source, attachment_key`,
    [pageId],
  );
  return r.rows;
}

async function isDirty(pageId: number): Promise<boolean> {
  const r = await query<{ image_embedding_dirty: boolean }>(
    `SELECT image_embedding_dirty FROM pages WHERE id = $1`, [pageId],
  );
  return r.rows[0]!.image_embedding_dirty;
}

describe.skipIf(!dbAvailable)('embedPageImages (#1115 P2)', () => {
  beforeAll(async () => {
    await setupTestDb();
    srv = createServer((req, res) => {
      if (req.url !== '/v1/embeddings' || req.method !== 'POST') {
        res.writeHead(404);
        res.end();
        return;
      }
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        calls.push(JSON.parse(raw));
        respond(res);
      });
    });
    await new Promise<void>((r) => srv.listen(0, r));
    vlBaseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`;

    previousAttachmentsDir = process.env.ATTACHMENTS_DIR;
    attachmentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cq-image-index-'));
    process.env.ATTACHMENTS_DIR = attachmentsDir;
  });

  afterAll(async () => {
    await new Promise<void>((r) => srv.close(() => r()));
    if (previousAttachmentsDir === undefined) delete process.env.ATTACHMENTS_DIR;
    else process.env.ATTACHMENTS_DIR = previousAttachmentsDir;
    await fs.rm(attachmentsDir, { recursive: true, force: true });
    // Restore migration 093's placeholder shape — see the file header.
    await query(`DROP INDEX IF EXISTS ${IMAGE_EMBEDDING_HNSW_INDEX}`);
    await query(`ALTER TABLE page_image_embeddings ALTER COLUMN embedding TYPE vector(2048)`);
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    calls = [];
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0] }] }));
    };
    invalidateRagImageIntakeCache();
    await ensureImageEmbeddingColumn(DIMS, {
      providerId: '11111111-1111-4111-8111-111111111111',
      model: MODEL,
      baseUrl: 'http://vl/v1',
      targetDimensions: null,
    });
  });

  afterEach(() => {
    invalidateRagImageIntakeCache();
  });

  it('embeds both stores off one body, with the source that follows the URL PREFIX', async () => {
    // The P0 record's rule: a relocated page is `confluence_id IS NULL` with
    // its bytes in the LOCAL store, and a page pasted into afterwards carries
    // both prefixes. Deriving the store from `confluence_id` reads the wrong
    // directory and answers null — a silent miss.
    await assignImageEmbedding();
    const pageId = await seedPage({
      bodyHtml: `<p><img src="/api/local-attachments/PID/moved.png"><img src="/api/attachments/PID/Screen%20shot.png"></p>`,
    });
    const body = (await query<{ body_html: string }>(`SELECT body_html FROM pages WHERE id = $1`, [pageId]))
      .rows[0]!.body_html.replaceAll('PID', String(pageId));
    await query(`UPDATE pages SET body_html = $2 WHERE id = $1`, [pageId, body]);
    await writeLocalAttachment(pageId, 'moved.png', png(10, 10));
    await writeConfluenceAttachment(String(pageId), 'Screen shot.png', png(20, 20));

    const outcome = await embedPageImages(pageId);

    expect(outcome.status).toBe('ok');
    expect(outcome.embedded).toBe(2);
    expect(calls).toHaveLength(2);
    expect(await rowsFor(pageId)).toEqual([
      expect.objectContaining({ source: 'confluence', attachment_key: 'Screen shot.png', width: 20, height: 20, format: 'png', model: MODEL }),
      expect.objectContaining({ source: 'local', attachment_key: 'moved.png', width: 10, height: 10 }),
    ]);
    expect(await isDirty(pageId)).toBe(false);
  });

  it('keys the Confluence tree by confluence_id for a Confluence-sourced page', async () => {
    await assignImageEmbedding();
    const pageId = await seedPage({
      bodyHtml: '<img src="/api/attachments/99001/a.png">',
      source: 'confluence',
      confluenceId: '99001',
    });
    await writeConfluenceAttachment('99001', 'a.png', png(8, 8));

    const outcome = await embedPageImages(pageId);
    expect(outcome.embedded).toBe(1);
    expect((await rowsFor(pageId))[0]).toMatchObject({ source: 'confluence', attachment_key: 'a.png' });
  });

  it('is a no-op that KEEPS the page dirty when the use case is unassigned', async () => {
    // The flag is the queue. Clearing it would drop every page silently on the
    // way to an assignment that has not happened yet — the operator assigns
    // the leg later and finds an index that never fills.
    const pageId = await seedPage({ bodyHtml: '<img src="/api/attachments/1/a.png">' });
    await writeConfluenceAttachment(String(pageId), 'a.png', png(4, 4));

    const outcome = await embedPageImages(pageId);

    expect(outcome.status).toBe('unassigned');
    expect(calls).toHaveLength(0);
    expect(await rowsFor(pageId)).toHaveLength(0);
    expect(await isDirty(pageId)).toBe(true);
  });

  it('reuses a row whose bytes are unchanged, without a single HTTP call', async () => {
    await assignImageEmbedding();
    const pageId = await seedPage({ bodyHtml: '<img src="/api/attachments/1/a.png">' });
    await writeConfluenceAttachment(String(pageId), 'a.png', png(6, 6));

    const first = await embedPageImages(pageId);
    expect(first.embedded).toBe(1);
    const created = (await query<{ created_at: Date }>(
      `SELECT created_at FROM page_image_embeddings WHERE page_id = $1`, [pageId],
    )).rows[0]!.created_at;

    await query(`UPDATE pages SET image_embedding_dirty = TRUE WHERE id = $1`, [pageId]);
    calls = [];
    const second = await embedPageImages(pageId);

    expect(second.status).toBe('ok');
    expect(second.embedded).toBe(0);
    expect(second.reused).toBe(1);
    expect(calls).toHaveLength(0);
    const after = (await query<{ created_at: Date }>(
      `SELECT created_at FROM page_image_embeddings WHERE page_id = $1`, [pageId],
    )).rows[0]!.created_at;
    expect(after.getTime()).toBe(created.getTime());
  });

  it('re-embeds when the bytes behind the same filename change', async () => {
    await assignImageEmbedding();
    const pageId = await seedPage({ bodyHtml: '<img src="/api/attachments/1/a.png">' });
    await writeConfluenceAttachment(String(pageId), 'a.png', png(6, 6));
    await embedPageImages(pageId);
    const before = (await rowsFor(pageId))[0]!.sha256;

    await writeConfluenceAttachment(String(pageId), 'a.png', png(9, 9));
    await query(`UPDATE pages SET image_embedding_dirty = TRUE WHERE id = $1`, [pageId]);
    calls = [];
    const outcome = await embedPageImages(pageId);

    expect(outcome.embedded).toBe(1);
    expect(outcome.reused).toBe(0);
    expect(calls).toHaveLength(1);
    const row = (await rowsFor(pageId))[0]!;
    expect(row.sha256).not.toBe(before);
    expect(row.width).toBe(9);
  });

  it('skips and COUNTS every reason, and never resizes (D10)', async () => {
    await assignImageEmbedding();
    const pageId = await seedPage({
      bodyHtml: `
        <img src="/api/attachments/1/gone.png">
        <img src="/api/attachments/1/diagram.png">
        <img src="/api/attachments/1/huge-bytes.png">
        <img src="/api/attachments/1/huge-dims.png">
        <img src="/api/attachments/1/ok.png">
      `,
    });
    await writeConfluenceAttachment(String(pageId), 'diagram.png', DRAWIO_PNG);
    await writeConfluenceAttachment(String(pageId), 'huge-bytes.png', png(10, 10, 5 * 1024 * 1024 + 1));
    await writeConfluenceAttachment(String(pageId), 'huge-dims.png', png(5000, 10));
    await writeConfluenceAttachment(String(pageId), 'ok.png', png(10, 10));

    const outcome = await embedPageImages(pageId);

    expect(outcome.embedded).toBe(1);
    expect(outcome.skipped).toMatchObject({
      missing: 1,
      unsupported: 1,
      tooLarge: 1,
      oversized: 1,
    });
    expect(calls).toHaveLength(1);
    expect(await rowsFor(pageId)).toHaveLength(1);
    // Skipping is not failing: the page is fully processed and clears.
    expect(await isDirty(pageId)).toBe(false);
  });

  it('caps at rag_images_per_page_max and counts the remainder', async () => {
    await assignImageEmbedding();
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value) VALUES ('rag_images_per_page_max', '2')`,
    );
    invalidateRagImageIntakeCache();
    const pageId = await seedPage({
      bodyHtml: ['a', 'b', 'c', 'd'].map((n) => `<img src="/api/attachments/1/${n}.png">`).join(''),
    });
    for (const n of ['a', 'b', 'c', 'd']) {
      await writeConfluenceAttachment(String(pageId), `${n}.png`, png(4, 4));
    }

    const outcome = await embedPageImages(pageId);

    expect(outcome.embedded).toBe(2);
    expect(outcome.skipped.capped).toBe(2);
    expect(await rowsFor(pageId)).toHaveLength(2);
  });

  it('indexes externally-fetched images by default and excludes them when the knob is off', async () => {
    await assignImageEmbedding();
    const external = 'external-0123456789ab.png';
    const pageId = await seedPage({
      bodyHtml: `<img src="/api/attachments/1/${external}"><img src="/api/attachments/1/own.png">`,
    });
    await writeConfluenceAttachment(String(pageId), external, png(4, 4));
    await writeConfluenceAttachment(String(pageId), 'own.png', png(4, 4));

    const on = await embedPageImages(pageId);
    expect(on.embedded).toBe(2);
    expect(on.skipped.external).toBe(0);

    await query(
      `INSERT INTO admin_settings (setting_key, setting_value) VALUES ('rag_image_index_external', '0')`,
    );
    invalidateRagImageIntakeCache();
    await query(`UPDATE pages SET image_embedding_dirty = TRUE WHERE id = $1`, [pageId]);
    const off = await embedPageImages(pageId);

    expect(off.skipped.external).toBe(1);
    // Reconcile follows the knob: an excluded image is no longer indexed.
    expect(await rowsFor(pageId)).toEqual([
      expect.objectContaining({ attachment_key: 'own.png' }),
    ]);
    expect(off.removed).toBe(1);
  });

  it('reconciles: a row whose image the body no longer references is deleted', async () => {
    await assignImageEmbedding();
    const pageId = await seedPage({
      bodyHtml: '<img src="/api/attachments/1/a.png"><img src="/api/attachments/1/b.png">',
    });
    await writeConfluenceAttachment(String(pageId), 'a.png', png(4, 4));
    await writeConfluenceAttachment(String(pageId), 'b.png', png(5, 5));
    await embedPageImages(pageId);
    expect(await rowsFor(pageId)).toHaveLength(2);

    await query(
      `UPDATE pages SET body_html = '<img src="/api/attachments/1/a.png">', image_embedding_dirty = TRUE WHERE id = $1`,
      [pageId],
    );
    const outcome = await embedPageImages(pageId);

    expect(outcome.removed).toBe(1);
    expect(await rowsFor(pageId)).toEqual([expect.objectContaining({ attachment_key: 'a.png' })]);
  });

  it("reconciles a page's LAST image away, leaving no rows behind", async () => {
    // The single case that exercises the DELETE with an EMPTY keep set, and
    // therefore `<> ALL` over an empty `unnest` — which is TRUE in SQL, so
    // every row goes. The two-images-to-one test above can never reach it.
    // Two plausible rewrites invert this with the suite otherwise green: an
    // early `if (keep.size === 0) skip the DELETE` "optimisation", and a
    // switch to `NOT IN` phrasing.
    await assignImageEmbedding();
    const pageId = await seedPage({ bodyHtml: '<img src="/api/attachments/1/only.png">' });
    await writeConfluenceAttachment(String(pageId), 'only.png', png(4, 4));
    await embedPageImages(pageId);
    expect(await rowsFor(pageId)).toHaveLength(1);

    await query(
      `UPDATE pages SET body_html = '<p>text only</p>', image_embedding_dirty = TRUE WHERE id = $1`,
      [pageId],
    );
    const outcome = await embedPageImages(pageId);

    expect(outcome.removed).toBe(1);
    expect(await rowsFor(pageId)).toEqual([]);
    expect(await isDirty(pageId)).toBe(false);
  });

  it('keeps the row of a still-referenced image whose file went missing', async () => {
    // `resolveAttachmentBytes` answers the same null for "gone" and for "the
    // read failed", so deleting on a miss lets one bad disk moment empty a
    // page's entries. A stale row is recoverable; a deleted one is a re-embed.
    await assignImageEmbedding();
    const pageId = await seedPage({ bodyHtml: '<img src="/api/attachments/1/a.png">' });
    await writeConfluenceAttachment(String(pageId), 'a.png', png(4, 4));
    await embedPageImages(pageId);
    expect(await rowsFor(pageId)).toHaveLength(1);

    await fs.rm(path.join(attachmentsDir, String(pageId), 'a.png'));
    await query(`UPDATE pages SET image_embedding_dirty = TRUE WHERE id = $1`, [pageId]);
    const outcome = await embedPageImages(pageId);

    expect(outcome.skipped.missing).toBe(1);
    expect(outcome.removed).toBe(0);
    expect(await rowsFor(pageId)).toHaveLength(1);
  });

  it('leaves the page DIRTY and reports the failure category when the endpoint refuses', async () => {
    await assignImageEmbedding();
    const pageId = await seedPage({ bodyHtml: '<img src="/api/attachments/1/a.png">' });
    await writeConfluenceAttachment(String(pageId), 'a.png', png(4, 4));
    respond = (res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'model still loading' }));
    };

    const outcome = await embedPageImages(pageId);

    expect(outcome.status).toBe('failed');
    expect(outcome.failed).toBe(1);
    expect(outcome.error).toBeTruthy();
    // The provider's own body must not travel on the outcome — this string
    // reaches an admin card (#1184's rule).
    expect(outcome.error).not.toContain('model still loading');
    expect(await isDirty(pageId)).toBe(true);
    expect(await rowsFor(pageId)).toHaveLength(0);
  });

  it('rolls back and keeps the page dirty when the index identity changes mid-embed', async () => {
    // Mirrors `embedPage`'s shadow-epoch recheck: the vectors above were
    // produced for one space, and a concurrent `ensureImageEmbeddingColumn`
    // TRUNCATEd the table for another. Writing them anyway would put stale
    // vectors into a freshly-emptied index, under keys that look current.
    await assignImageEmbedding();
    const pageId = await seedPage({ bodyHtml: '<img src="/api/attachments/1/a.png">' });
    await writeConfluenceAttachment(String(pageId), 'a.png', png(4, 4));
    respond = (res) => {
      // The rebuild lands while the embed call is in flight.
      void query(
        `UPDATE admin_settings SET setting_value = 'someone-else' WHERE setting_key = $1`,
        [IMAGE_EMBEDDING_INDEX_MODEL_KEY],
      ).then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0] }] }));
      });
    };

    const outcome = await embedPageImages(pageId);

    expect(outcome.status).toBe('stale');
    expect(await rowsFor(pageId)).toHaveLength(0);
    expect(await isDirty(pageId)).toBe(true);
  });

  it('skips a folder, a soft-deleted page and a page that is gone', async () => {
    await assignImageEmbedding();
    const folder = await seedPage({ bodyHtml: null, pageType: 'folder' });
    const deleted = await seedPage({ bodyHtml: '<img src="/api/attachments/1/a.png">', deleted: true });

    expect((await embedPageImages(folder)).status).toBe('skipped');
    expect((await embedPageImages(deleted)).status).toBe('skipped');
    expect((await embedPageImages(9_999_999)).status).toBe('skipped');
    expect(calls).toHaveLength(0);
  });

  it('sends the configured MRL truncation width on every image call', async () => {
    await assignImageEmbedding();
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value) VALUES ('image_embedding_target_dimensions', '4')`,
    );
    const pageId = await seedPage({ bodyHtml: '<img src="/api/attachments/1/a.png">' });
    await writeConfluenceAttachment(String(pageId), 'a.png', png(4, 4));

    await embedPageImages(pageId);

    expect(calls[0]?.dimensions).toBe(4);
  });

  it('clears the flag for a page whose body references no image at all', async () => {
    await assignImageEmbedding();
    const pageId = await seedPage({ bodyHtml: '<p>text only</p>' });

    const outcome = await embedPageImages(pageId);

    expect(outcome.status).toBe('ok');
    expect(outcome.embedded).toBe(0);
    expect(calls).toHaveLength(0);
    expect(await isDirty(pageId)).toBe(false);
  });
});
