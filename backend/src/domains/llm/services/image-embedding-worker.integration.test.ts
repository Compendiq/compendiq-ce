import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  processDirtyPageImages,
  readImageIndexLastRun,
  markAllPagesImageDirty,
  IMAGE_INDEX_WORKER_LOCK,
  _resetImageWorkerNoticeForTests,
} from './image-embedding-service.js';
import {
  ensureImageEmbeddingColumn,
  IMAGE_EMBEDDING_HNSW_INDEX,
} from './image-embedding-index.js';
import { invalidateRagImageIntakeCache } from '../../../core/services/admin-settings-service.js';
import {
  acquireWorkerLock,
  releaseWorkerLock,
  setRedisClient,
} from '../../../core/services/redis-cache.js';
import { createClient, type RedisClientType } from 'redis';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { logger } from '../../../core/utils/logger.js';

/**
 * #1115 P2 — the corpus-walking half, against real Postgres and a real local
 * endpoint. Redis is real too where it is reachable: the lock is the only
 * thing stopping two pods embedding the same backlog, and a mocked lock
 * asserts the mock.
 */

const dbAvailable = await isDbAvailable();
const DIMS = 4;
const MODEL = 'Qwen/Qwen3-VL-Embedding-2B';

let srv: Server;
let vlBaseUrl: string;
let calls = 0;
let respond: (res: ServerResponse) => void = (res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0] }] }));
};
let attachmentsDir: string;
let previousAttachmentsDir: string | undefined;

/**
 * A REAL Redis where one is reachable, connected at MODULE level.
 *
 * Two reasons it cannot wait for `beforeAll`. `acquireWorkerLock`'s no-Redis
 * fallback hands every caller a token — correct for a single node, and exactly
 * the behaviour that would make a mutual-exclusion test assert nothing — so
 * the lock case has to skip itself when Redis is absent, and `it.skipIf` is
 * evaluated while the suite is being collected, before any hook has run.
 */
const redis = await (async (): Promise<RedisClientType | null> => {
  try {
    const client = createClient({
      url: process.env.REDIS_URL ?? 'redis://localhost:6379',
    }) as RedisClientType;
    client.on('error', () => undefined);
    await client.connect();
    setRedisClient(client);
    return client;
  } catch {
    return null;
  }
})();

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(8);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  return Buffer.concat([PNG_SIG, Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), ihdr]);
}

async function seedPageWithImage(name: string, modifiedAt: string): Promise<number> {
  const r = await query<{ id: number }>(
    `INSERT INTO pages (title, space_key, body_html, page_type, source, last_modified_at, image_embedding_dirty)
     VALUES ($1, 'DEV', $2, 'page', 'standalone', $3, TRUE) RETURNING id`,
    [name, `<img src="/api/attachments/x/${name}.png">`, modifiedAt],
  );
  const pageId = r.rows[0]!.id;
  const dir = path.join(attachmentsDir, String(pageId));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.png`), png(4, 4));
  return pageId;
}

/** One page carrying SEVERAL images — the shape a single slow page takes. */
async function seedPageWithImages(
  name: string,
  files: string[],
  modifiedAt: string,
): Promise<number> {
  const r = await query<{ id: number }>(
    `INSERT INTO pages (title, space_key, body_html, page_type, source, last_modified_at, image_embedding_dirty)
     VALUES ($1, 'DEV', $2, 'page', 'standalone', $3, TRUE) RETURNING id`,
    [name, files.map((f) => `<img src="/api/attachments/x/${f}">`).join(''), modifiedAt],
  );
  const pageId = r.rows[0]!.id;
  const dir = path.join(attachmentsDir, String(pageId));
  await fs.mkdir(dir, { recursive: true });
  for (const f of files) await fs.writeFile(path.join(dir, f), png(4, 4));
  return pageId;
}

async function assign(): Promise<void> {
  const prov = await query<{ id: string }>(
    `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, default_model)
     VALUES ('vl-box', $1, 'none', TRUE, $2) RETURNING id`,
    [vlBaseUrl, MODEL],
  );
  await query(
    `INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('image_embedding', $1, $2)`,
    [prov.rows[0]!.id, MODEL],
  );
}

describe.skipIf(!dbAvailable)('processDirtyPageImages (#1115 P2)', () => {
  beforeAll(async () => {
    await setupTestDb();
    srv = createServer((req, res) => {
      if (req.url !== '/v1/embeddings' || req.method !== 'POST') {
        res.writeHead(404);
        res.end();
        return;
      }
      req.on('data', () => undefined);
      req.on('end', () => {
        calls++;
        respond(res);
      });
    });
    await new Promise<void>((r) => srv.listen(0, r));
    vlBaseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`;
    previousAttachmentsDir = process.env.ATTACHMENTS_DIR;
    attachmentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cq-image-worker-'));
    process.env.ATTACHMENTS_DIR = attachmentsDir;
  });

  afterAll(async () => {
    await new Promise<void>((r) => srv.close(() => r()));
    if (redis) {
      try { await redis.quit(); } catch { /* best effort */ }
    }
    if (previousAttachmentsDir === undefined) delete process.env.ATTACHMENTS_DIR;
    else process.env.ATTACHMENTS_DIR = previousAttachmentsDir;
    await fs.rm(attachmentsDir, { recursive: true, force: true });
    await query(`DROP INDEX IF EXISTS ${IMAGE_EMBEDDING_HNSW_INDEX}`);
    await query(`ALTER TABLE page_image_embeddings ALTER COLUMN embedding TYPE vector(2048)`);
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    calls = 0;
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0] }] }));
    };
    invalidateRagImageIntakeCache();
    _resetImageWorkerNoticeForTests();
    await ensureImageEmbeddingColumn(DIMS, {
      providerId: '11111111-1111-4111-8111-111111111111',
      model: MODEL,
      baseUrl: 'http://vl/v1',
      targetDimensions: null,
    });
  });

  it('walks the whole backlog and clears every page it embedded', async () => {
    await assign();
    await seedPageWithImage('one', '2026-01-01T00:00:00Z');
    await seedPageWithImage('two', '2026-01-02T00:00:00Z');
    await seedPageWithImage('three', '2026-01-03T00:00:00Z');

    const result = await processDirtyPageImages();

    expect(result.pages).toBe(3);
    expect(result.embedded).toBe(3);
    expect(calls).toBe(3);
    const dirty = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM pages WHERE image_embedding_dirty`,
    );
    expect(Number(dirty.rows[0]!.count)).toBe(0);
  });

  it('takes the newest-modified page first', async () => {
    await assign();
    await seedPageWithImage('old', '2020-01-01T00:00:00Z');
    const newest = await seedPageWithImage('new', '2026-06-01T00:00:00Z');

    await processDirtyPageImages({ maxPages: 1 });

    const rows = await query<{ page_id: number }>(`SELECT page_id FROM page_image_embeddings`);
    expect(rows.rows.map((r) => r.page_id)).toEqual([newest]);
  });

  it('excludes folders and soft-deleted pages from the backlog', async () => {
    await assign();
    await query(
      `INSERT INTO pages (title, space_key, body_html, page_type, source, image_embedding_dirty)
       VALUES ('Folder', 'DEV', NULL, 'folder', 'standalone', TRUE),
              ('Gone', 'DEV', '<img src="/api/attachments/x/a.png">', 'page', 'standalone', TRUE)`,
    );
    await query(`UPDATE pages SET deleted_at = NOW() WHERE title = 'Gone'`);

    const result = await processDirtyPageImages();

    expect(result.pages).toBe(0);
    expect(calls).toBe(0);
  });

  it('does nothing, spins nothing and logs ONCE when the use case is unassigned', async () => {
    const info = vi.spyOn(logger, 'info');
    await seedPageWithImage('one', '2026-01-01T00:00:00Z');

    const first = await processDirtyPageImages();
    const second = await processDirtyPageImages();

    expect(first.unassigned).toBe(true);
    expect(second.unassigned).toBe(true);
    expect(calls).toBe(0);
    // The flag is the queue — a page waiting for an assignment must stay in it.
    const dirty = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM pages WHERE image_embedding_dirty`,
    );
    expect(Number(dirty.rows[0]!.count)).toBe(1);
    const notices = info.mock.calls.filter((c) =>
      typeof c[0] === 'string' && c[0].includes('Image embedding is unassigned'),
    );
    expect(notices).toHaveLength(1);
    info.mockRestore();
  });

  it.skipIf(!redis)('stands down while another holder owns the worker lock', async () => {
    await assign();
    await seedPageWithImage('one', '2026-01-01T00:00:00Z');
    const held = await acquireWorkerLock(IMAGE_INDEX_WORKER_LOCK, 60);
    expect(held).toBeTruthy();

    try {
      const result = await processDirtyPageImages();
      expect(result.alreadyRunning).toBe(true);
      expect(calls).toBe(0);
    } finally {
      await releaseWorkerLock(IMAGE_INDEX_WORKER_LOCK, held!);
    }

    // …and runs once the lock is free, so the backoff is a delay, not a drop.
    const after = await processDirtyPageImages();
    expect(after.pages).toBe(1);
  });

  it('steps past a page that stayed dirty instead of re-reading the same window', async () => {
    // A failing page keeps its flag, so an offset that only counted successes
    // would re-fetch it forever and never reach the page behind it.
    await assign();
    await seedPageWithImage('broken', '2026-02-02T00:00:00Z');
    await seedPageWithImage('fine', '2026-01-01T00:00:00Z');
    let seen = 0;
    respond = (res) => {
      seen++;
      if (seen === 1) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'boom' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0] }] }));
    };

    const result = await processDirtyPageImages();

    expect(result.pages).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.embedded).toBe(1);
    const stillDirty = await query<{ title: string }>(
      `SELECT title FROM pages WHERE image_embedding_dirty ORDER BY title`,
    );
    expect(stillDirty.rows.map((r) => r.title)).toEqual(['broken']);
  });

  it('reaches the pages BEHIND a full window that all stayed dirty', async () => {
    // The offset-advance rule, at the only size where it is observable. Below
    // the batch size the loop always exits on the short read and the offset is
    // never read a second time, so the previous test — which seeds two pages
    // against a batch of fifty — passes with `offset += 0`. Here the first
    // window FILLS with pages that keep their flag, and zeroing the advance
    // re-reads those same two forever while `fine` is never visited.
    await assign();
    await seedPageWithImage('brokenA', '2026-03-03T00:00:00Z');
    await seedPageWithImage('brokenB', '2026-03-02T00:00:00Z');
    await seedPageWithImage('fine', '2020-01-01T00:00:00Z');
    let seen = 0;
    respond = (res) => {
      seen++;
      if (seen <= 2) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'boom' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0] }] }));
    };

    const result = await processDirtyPageImages({ batchSize: 2 });

    expect(result.pages).toBe(3);
    expect(result.failed).toBe(2);
    expect(result.embedded).toBe(1);
    const stillDirty = await query<{ title: string }>(
      `SELECT title FROM pages WHERE image_embedding_dirty ORDER BY title`,
    );
    expect(stillDirty.rows.map((r) => r.title)).toEqual(['brokenA', 'brokenB']);
  });

  it.skipIf(!redis)('aborts when the worker lock is re-acquired mid-scan', async () => {
    // The holder-epoch guard. `lockGuardIntervalMs: 0` makes it run before
    // every page rather than on its production time cadence — the branch is
    // otherwise unreachable in a fixture, since the real interval is a third
    // of a ten-minute TTL.
    await assign();
    await seedPageWithImage('first', '2026-04-02T00:00:00Z');
    await seedPageWithImage('second', '2026-04-01T00:00:00Z');
    const lockKey = `worker:lock:${IMAGE_INDEX_WORKER_LOCK}`;
    let seen = 0;
    respond = (res) => {
      void (async () => {
        seen++;
        if (seen === 1) {
          // Another pod takes the lock while this page is in flight — the
          // expiry-and-re-acquire case the guard exists to notice. Stolen
          // BEFORE the response returns, so the next guard check sees it.
          await redis!.set(lockKey, 'another-pod');
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0] }] }));
      })();
    };

    try {
      const result = await processDirtyPageImages({ lockGuardIntervalMs: 0 });

      expect(result.pages).toBe(1);
      expect(calls).toBe(1);
      // The page behind it keeps its flag: the run stood down, it did not
      // decide the page was done.
      const stillDirty = await query<{ title: string }>(
        `SELECT title FROM pages WHERE image_embedding_dirty`,
      );
      expect(stillDirty.rows.map((r) => r.title)).toEqual(['second']);
      // …and the release is ownership-checked, so standing down did not delete
      // the other holder's lock on the way out.
      expect(await redis!.get(lockKey)).toBe('another-pod');
    } finally {
      await redis!.del(lockKey);
    }
  });

  it.skipIf(!redis)('renews the lock WHILE one slow page is still in flight', async () => {
    // Review r3. The guard's whole justification is that ONE page can outlive
    // the lock TTL — up to `rag_images_per_page_max` sequential requests at
    // `IMAGE_EMBED_TIMEOUT_MS` each — so a renewal that can only reach a page
    // BOUNDARY has the identical hole the page-count cadence had: the key
    // expires mid-page, the next sync tick or `Process now` acquires the free
    // lock, and two scans walk the same backlog.
    //
    // Read from inside the page: the first image shortens the key's TTL to
    // 800 ms and then holds the response for two seconds, and the second image
    // reports whether the key is still there. Between-pages renewal alone
    // cannot answer 1 — nothing runs between those two requests.
    await assign();
    await seedPageWithImages('slow', ['a.png', 'b.png'], '2026-07-01T00:00:00Z');
    const lockKey = `worker:lock:${IMAGE_INDEX_WORKER_LOCK}`;
    let seen = 0;
    let aliveAtSecondImage: number | null = null;
    respond = (res) => {
      void (async () => {
        seen++;
        if (seen === 1) {
          await redis!.pExpire(lockKey, 800);
          await new Promise((r) => setTimeout(r, 2000));
        } else if (seen === 2) {
          aliveAtSecondImage = await redis!.exists(lockKey);
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0] }] }));
      })();
    };

    const result = await processDirtyPageImages({ lockGuardIntervalMs: 200 });

    expect(seen).toBe(2);
    expect(aliveAtSecondImage).toBe(1);
    expect(result.embedded).toBe(2);
  }, 30_000);

  it('counts a page whose WRITE fails, keeps going, and still records the run', async () => {
    // Reachable and permanent, not transient: `ensureImageEmbeddingColumn`
    // retypes the column and records the width in ONE transaction, and that
    // DDL is guarded — so a restored dump or a failed `ALTER` leaves the
    // recorded width agreeing with the model and disagreeing with the column.
    // The INSERT then raises a pgvector dimension error, which is a DATABASE
    // failure and escapes `embedPageImages` by design. Unwrapped, it aborted
    // the whole scan on the first page and recorded nothing at all.
    await assign();
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value) VALUES ('image_embedding_dimensions', '8')
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = '8'`,
    );
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0, 0, 0, 0, 0] }] }));
    };
    await seedPageWithImage('one', '2026-05-02T00:00:00Z');
    await seedPageWithImage('two', '2026-05-01T00:00:00Z');

    const result = await processDirtyPageImages();

    expect(result.pages).toBe(2);
    expect(result.pagesFailed).toBe(2);
    // Both pages stay queued — nothing about them was decided.
    const dirty = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM pages WHERE image_embedding_dirty`,
    );
    expect(Number(dirty.rows[0]!.count)).toBe(2);
    // …and the card learns about it. Without the run summary the operator sees
    // a backlog that never drains and no failure anywhere on screen.
    expect(await readImageIndexLastRun()).toMatchObject({ pages: 2, pagesFailed: 2 });
  });

  it('counts a width the index is not typed for as a failed IMAGE, before the write', async () => {
    // The guarded-DDL branch proper: the assignment saved, the `ALTER` did
    // not, so the recorded width still describes the column and the model
    // answers the new one. Caught before the INSERT, so it is a counted image
    // failure with a remedy rather than a thrown page.
    await assign();
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0, 0, 0, 0, 0] }] }));
    };
    await seedPageWithImage('one', '2026-05-02T00:00:00Z');

    const result = await processDirtyPageImages();

    expect(result.failed).toBe(1);
    expect(result.pagesFailed).toBe(0);
    expect(result.embedded).toBe(0);
    const rows = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM page_image_embeddings`,
    );
    expect(Number(rows.rows[0]!.count)).toBe(0);
  });

  it('records the run summary, and does not overwrite it with a no-op trigger', async () => {
    await assign();
    await seedPageWithImage('one', '2026-01-01T00:00:00Z');
    await processDirtyPageImages();

    const recorded = await readImageIndexLastRun();
    expect(recorded).toMatchObject({ pages: 1, embedded: 1, reused: 0, failed: 0 });
    expect(recorded?.skipped).toEqual({
      missing: 0, unsupported: 0, oversized: 0, tooLarge: 0, capped: 0, external: 0,
    });

    // Nothing is dirty now. A sync kick must not report "the last scan found
    // nothing" over a real run's counters.
    const noop = await processDirtyPageImages();
    expect(noop.pages).toBe(0);
    expect(await readImageIndexLastRun()).toMatchObject({ pages: 1, embedded: 1 });
  });

  it('ignores an unreadable last-run row rather than half-rendering it', async () => {
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value) VALUES ('image_index_last_run', '{"pages":1}')`,
    );
    expect(await readImageIndexLastRun()).toBeNull();
  });

  it('markAllPagesImageDirty marks live non-folder pages and leaves embedding_dirty alone', async () => {
    await query(
      `INSERT INTO pages (title, space_key, body_html, page_type, source, image_embedding_dirty, embedding_dirty)
       VALUES ('A', 'DEV', '<p>a</p>', 'page', 'standalone', FALSE, FALSE),
              ('B', 'DEV', '<p>b</p>', 'page', 'standalone', FALSE, FALSE),
              ('F', 'DEV', NULL, 'folder', 'standalone', FALSE, FALSE),
              ('D', 'DEV', '<p>d</p>', 'page', 'standalone', FALSE, FALSE)`,
    );
    await query(`UPDATE pages SET deleted_at = NOW() WHERE title = 'D'`);

    expect(await markAllPagesImageDirty()).toBe(2);

    const rows = await query<{ title: string; image_embedding_dirty: boolean; embedding_dirty: boolean }>(
      `SELECT title, image_embedding_dirty, embedding_dirty FROM pages ORDER BY title`,
    );
    expect(rows.rows).toEqual([
      { title: 'A', image_embedding_dirty: true, embedding_dirty: false },
      { title: 'B', image_embedding_dirty: true, embedding_dirty: false },
      { title: 'D', image_embedding_dirty: false, embedding_dirty: false },
      { title: 'F', image_embedding_dirty: false, embedding_dirty: false },
    ]);
  });
});
