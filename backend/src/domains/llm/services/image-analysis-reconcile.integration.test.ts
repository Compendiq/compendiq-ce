import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { invalidateRagImageIntakeCache } from '../../../core/services/admin-settings-service.js';
import { ImageAnalysisLeaseLostError, reconcileDirtyPages, reconcilePageImageAnalyses } from './image-analysis-reconcile.js';

/**
 * ADR-027 D4/D6 — the reconcile against real Postgres and a real attachment
 * tree. Nothing is mocked: the store, the pages, the bytes and the settings
 * rows are all real, and no vision model is involved (the reconcile runs
 * assigned or not).
 */
const dbAvailable = await isDbAvailable();

let attachmentsDir: string;
let previousAttachmentsDir: string | undefined;

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function png(width: number, height: number, padding = 0): Buffer {
  const ihdr = Buffer.alloc(8);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  return Buffer.concat([PNG_SIG, Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), ihdr, Buffer.alloc(padding)]);
}
const DRAWIO_PNG = Buffer.from('<mxfile host="Confluence"><diagram/></mxfile>', 'utf8');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

async function writeAttachment(pageId: number, name: string, bytes: Buffer): Promise<void> {
  const dir = path.join(attachmentsDir, String(pageId));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), bytes);
}

async function seedPage(opts: { bodyHtml: string | null; dirty?: boolean; pageType?: string; deleted?: boolean } ): Promise<number> {
  const r = await query<{ id: number }>(
    `INSERT INTO pages (title, space_key, body_html, page_type, source, deleted_at, image_analysis_dirty, embedding_dirty)
     VALUES ('Doc', 'DEV', $1, $2, 'standalone', $3, $4, FALSE) RETURNING id`,
    [opts.bodyHtml, opts.pageType ?? 'page', opts.deleted ? new Date() : null, opts.dirty ?? true],
  );
  return r.rows[0]!.id;
}

interface Row {
  source: string;
  attachment_key: string;
  content_hash: string;
  format: string;
  width: number | null;
  status: string;
  skip_reason: string | null;
  payload: unknown;
  attempts: number;
  next_attempt_at: Date | null;
  error: string | null;
}
async function rowsFor(pageId: number): Promise<Row[]> {
  const r = await query<Row>(
    `SELECT source, attachment_key, content_hash, format, width, status, skip_reason, payload, attempts, next_attempt_at, error
       FROM page_image_analyses WHERE page_id = $1 ORDER BY source, attachment_key`,
    [pageId],
  );
  return r.rows;
}

async function pageState(pageId: number): Promise<{ dirty: boolean; revision: number; embeddingDirty: boolean }> {
  const r = await query<{ image_analysis_dirty: boolean; image_analysis_revision: string; embedding_dirty: boolean }>(
    `SELECT image_analysis_dirty, image_analysis_revision, embedding_dirty FROM pages WHERE id = $1`,
    [pageId],
  );
  const row = r.rows[0]!;
  return { dirty: row.image_analysis_dirty, revision: Number(row.image_analysis_revision), embeddingDirty: row.embedding_dirty };
}

async function markAnalyzed(pageId: number, key: string): Promise<void> {
  await query(
    `UPDATE page_image_analyses SET status = 'analyzed', payload = '{"schemaVersion":1}'::jsonb,
            identity_hash = 'h', prompt_version = 1, schema_version = 1
      WHERE page_id = $1 AND attachment_key = $2`,
    [pageId, key],
  );
}

describe.skipIf(!dbAvailable)('reconcilePageImageAnalyses (ADR-027 D4/D6, #1616)', () => {
  beforeAll(async () => {
    await setupTestDb();
    previousAttachmentsDir = process.env.ATTACHMENTS_DIR;
    attachmentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cq-image-analysis-reconcile-'));
    process.env.ATTACHMENTS_DIR = attachmentsDir;
  });
  afterAll(async () => {
    if (previousAttachmentsDir === undefined) delete process.env.ATTACHMENTS_DIR;
    else process.env.ATTACHMENTS_DIR = previousAttachmentsDir;
    await fs.rm(attachmentsDir, { recursive: true, force: true });
    await teardownTestDb();
  });
  beforeEach(async () => {
    await truncateAllTables();
    invalidateRagImageIntakeCache();
  });

  it('claims the flag before enumerating, so a raise landing mid-scan survives', async () => {
    const pageId = await seedPage({ bodyHtml: '<img src="/api/attachments/1/a.png">' });
    await writeAttachment(pageId, 'a.png', png(4, 4));
    let raisedDuring = false;
    const outcome = await reconcilePageImageAnalyses(pageId, async () => {
      // The first checkpoint runs before the claim; the second (before the
      // write transaction) is after enumeration — a writer raising here is
      // exactly the mid-scan raise ADR-025 P2 lost.
      if (raisedDuring) return;
      const state = await pageState(pageId);
      if (!state.dirty) {
        raisedDuring = true;
        await query(`UPDATE pages SET image_analysis_dirty = TRUE WHERE id = $1`, [pageId]);
      }
    });
    expect(outcome).toMatchObject({ claimed: true, pended: 1 });
    expect(raisedDuring).toBe(true);
    expect((await pageState(pageId)).dirty).toBe(true);
  });

  it('answers claimed: false for a page that is not dirty, a folder, or in the trash', async () => {
    const clean = await seedPage({ bodyHtml: '<img src="/api/attachments/1/a.png">', dirty: false });
    const folder = await seedPage({ bodyHtml: null, pageType: 'folder' });
    const trashed = await seedPage({ bodyHtml: '<img src="/api/attachments/1/a.png">', deleted: true });
    for (const id of [clean, folder, trashed]) {
      expect(await reconcilePageImageAnalyses(id)).toEqual({ claimed: false });
    }
  });

  it('inserts pending rows for new references without bumping, re-pends a changed hash with a fresh budget, deletes gone references', async () => {
    const pageId = await seedPage({ bodyHtml: '<img src="/api/attachments/1/a.png"><img src="/api/attachments/1/b.png">' });
    await writeAttachment(pageId, 'a.png', png(4, 4));
    await writeAttachment(pageId, 'b.png', png(5, 5));

    const first = await reconcilePageImageAnalyses(pageId);
    expect(first).toMatchObject({ claimed: true, pended: 2, removed: 0, unchanged: 0, changed: true, bumped: false });
    const rows = await rowsFor(pageId);
    expect(rows.map((r) => [r.attachment_key, r.status, r.content_hash, r.format, r.width])).toEqual([
      ['a.png', 'pending', sha(png(4, 4)), 'png', 4],
      ['b.png', 'pending', sha(png(5, 5)), 'png', 5],
    ]);
    // D6.3: two pending rows compose nothing — the valid derived set did not
    // change, so the page is neither bumped nor re-embedded.
    const afterFirst = await pageState(pageId);
    expect(afterFirst).toEqual({ dirty: false, revision: 0, embeddingDirty: false });

    // A terminal row whose bytes change gets a fresh budget and leaves the
    // terminal state (no bump: it composed nothing); b, analyzed meanwhile,
    // is removed from the body — an analyzed row leaving IS a bump.
    await query(
      `UPDATE page_image_analyses SET status = 'failed_terminal', attempts = 5, error = 'malformed', next_attempt_at = NULL
        WHERE page_id = $1 AND attachment_key = 'a.png'`,
      [pageId],
    );
    await markAnalyzed(pageId, 'b.png');
    await writeAttachment(pageId, 'a.png', png(6, 6));
    await query(`UPDATE pages SET body_html = '<img src="/api/attachments/1/a.png">', image_analysis_dirty = TRUE WHERE id = $1`, [pageId]);

    const second = await reconcilePageImageAnalyses(pageId);
    expect(second).toMatchObject({ claimed: true, pended: 1, removed: 1, changed: true, bumped: true });
    const after = await rowsFor(pageId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      attachment_key: 'a.png',
      status: 'pending',
      content_hash: sha(png(6, 6)),
      payload: null,
      attempts: 0,
      next_attempt_at: null,
      error: null,
    });
    expect(await pageState(pageId)).toEqual({ dirty: false, revision: 1, embeddingDirty: true });
  });

  it('bumps only for an analyzed row: a pending row re-pended under new bytes does not, an analyzed one does', async () => {
    const pageId = await seedPage({ bodyHtml: '<img src="/api/attachments/1/a.png"><img src="/api/attachments/1/b.png">' });
    await writeAttachment(pageId, 'a.png', png(4, 4));
    await writeAttachment(pageId, 'b.png', png(5, 5));
    await reconcilePageImageAnalyses(pageId);
    await markAnalyzed(pageId, 'b.png');

    // Only the pending row's bytes change.
    await writeAttachment(pageId, 'a.png', png(6, 6));
    await query(`UPDATE pages SET image_analysis_dirty = TRUE, embedding_dirty = FALSE WHERE id = $1`, [pageId]);
    const pendingReplaced = await reconcilePageImageAnalyses(pageId);
    expect(pendingReplaced).toMatchObject({ pended: 1, unchanged: 1, changed: true, bumped: false });
    expect(await pageState(pageId)).toEqual({ dirty: false, revision: 0, embeddingDirty: false });

    // Now the analyzed row's bytes change: its composed text is stale.
    await writeAttachment(pageId, 'b.png', png(7, 7));
    await query(`UPDATE pages SET image_analysis_dirty = TRUE WHERE id = $1`, [pageId]);
    const analyzedReplaced = await reconcilePageImageAnalyses(pageId);
    expect(analyzedReplaced).toMatchObject({ pended: 1, unchanged: 1, changed: true, bumped: true });
    expect((await rowsFor(pageId)).map((r) => [r.attachment_key, r.status, r.payload])).toEqual([
      ['a.png', 'pending', null],
      ['b.png', 'pending', null],
    ]);
    expect(await pageState(pageId)).toEqual({ dirty: false, revision: 1, embeddingDirty: true });
  });

  it('bumps the revision exactly once per pass that moved the valid set, and not at all when nothing changed', async () => {
    const pageId = await seedPage({ bodyHtml: '<img src="/api/attachments/1/a.png">' });
    await writeAttachment(pageId, 'a.png', png(4, 4));
    await reconcilePageImageAnalyses(pageId);
    await query(`UPDATE pages SET image_analysis_dirty = TRUE, embedding_dirty = FALSE WHERE id = $1`, [pageId]);

    const again = await reconcilePageImageAnalyses(pageId);

    expect(again).toMatchObject({ claimed: true, pended: 0, unchanged: 1, changed: false, bumped: false });
    expect(await pageState(pageId)).toEqual({ dirty: false, revision: 0, embeddingDirty: false });
  });

  it('leaves an existing row alone when its file is unreadable, and records missing only for a never-rowed reference', async () => {
    const pageId = await seedPage({ bodyHtml: '<img src="/api/attachments/1/kept.png"><img src="/api/attachments/1/never.png">' });
    await writeAttachment(pageId, 'kept.png', png(4, 4));
    const first = await reconcilePageImageAnalyses(pageId);
    expect(first).toMatchObject({ pended: 1, skipped: expect.objectContaining({ missing: 1 }) });
    await markAnalyzed(pageId, 'kept.png');

    await fs.rm(path.join(attachmentsDir, String(pageId), 'kept.png'));
    await query(`UPDATE pages SET image_analysis_dirty = TRUE, embedding_dirty = FALSE WHERE id = $1`, [pageId]);
    const outcome = await reconcilePageImageAnalyses(pageId);

    // Both references are untouched: the analyzed row survives the unreadable
    // file (not a deletion), the missing skip is already recorded. No bump.
    expect(outcome).toMatchObject({ claimed: true, unchanged: 2, changed: false });
    const rows = await rowsFor(pageId);
    expect(rows.map((r) => [r.attachment_key, r.status, r.skip_reason])).toEqual([
      ['kept.png', 'analyzed', null],
      ['never.png', 'skipped', 'missing'],
    ]);
    expect((await pageState(pageId)).embeddingDirty).toBe(false);
  });

  it('skips and counts unsupported, too_large and oversized bytes', async () => {
    const pageId = await seedPage({
      bodyHtml: [
        '<img src="/api/attachments/1/diagram.png">',
        '<img src="/api/attachments/1/huge-bytes.png">',
        '<img src="/api/attachments/1/huge-dims.png">',
        '<img src="/api/attachments/1/ok.png">',
      ].join(''),
    });
    await writeAttachment(pageId, 'diagram.png', DRAWIO_PNG);
    await writeAttachment(pageId, 'huge-bytes.png', png(10, 10, 5 * 1024 * 1024 + 1));
    await writeAttachment(pageId, 'huge-dims.png', png(5000, 10));
    await writeAttachment(pageId, 'ok.png', png(10, 10));

    const outcome = await reconcilePageImageAnalyses(pageId);

    expect(outcome).toMatchObject({
      pended: 1,
      skipped: { missing: 0, unsupported: 1, too_large: 1, oversized: 1, external: 0, capped: 0 },
    });
    const rows = await rowsFor(pageId);
    expect(rows.map((r) => [r.attachment_key, r.status, r.skip_reason])).toEqual([
      ['diagram.png', 'skipped', 'unsupported'],
      ['huge-bytes.png', 'skipped', 'too_large'],
      ['huge-dims.png', 'skipped', 'oversized'],
      ['ok.png', 'pending', null],
    ]);
  });

  it('applies the external policy before the cap, and flips rows in place when the policy changes', async () => {
    const external = 'external-0123456789ab.png';
    const pageId = await seedPage({
      bodyHtml: [`<img src="/api/attachments/1/${external}">`, '<img src="/api/attachments/1/own.png">', '<img src="/api/attachments/1/more.png">'].join(''),
    });
    for (const f of [external, 'own.png', 'more.png']) await writeAttachment(pageId, f, png(4, 4));
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value) VALUES ('rag_images_per_page_max', '2'), ('rag_image_index_external', '0')`,
    );
    invalidateRagImageIntakeCache();

    const off = await reconcilePageImageAnalyses(pageId);
    expect(off).toMatchObject({ pended: 2, skipped: expect.objectContaining({ external: 1, capped: 0 }) });
    expect((await rowsFor(pageId)).map((r) => [r.attachment_key, r.status, r.skip_reason])).toEqual([
      [external, 'skipped', 'external'],
      ['more.png', 'pending', null],
      ['own.png', 'pending', null],
    ]);

    // External indexing on: the external image takes a cap slot, `more.png`
    // (third in body order) is capped, and a previously analyzed row that is
    // now capped leaves composition — a policy change bumps the page.
    await markAnalyzed(pageId, 'more.png');
    await query(`UPDATE admin_settings SET setting_value = '1' WHERE setting_key = 'rag_image_index_external'`);
    invalidateRagImageIntakeCache();
    await query(`UPDATE pages SET image_analysis_dirty = TRUE, embedding_dirty = FALSE WHERE id = $1`, [pageId]);
    const before = (await pageState(pageId)).revision;

    const on = await reconcilePageImageAnalyses(pageId);

    expect(on).toMatchObject({ pended: 1, skipped: expect.objectContaining({ external: 0, capped: 1 }) });
    expect((await rowsFor(pageId)).map((r) => [r.attachment_key, r.status, r.skip_reason])).toEqual([
      [external, 'pending', null],
      ['more.png', 'skipped', 'capped'],
      ['own.png', 'pending', null],
    ]);
    const state = await pageState(pageId);
    expect(state.revision).toBe(before + 1);
    expect(state.embeddingDirty).toBe(true);
  });

  it('changes no row for a caption, heading or title edit', async () => {
    const pageId = await seedPage({ bodyHtml: '<h2>Setup</h2><img src="/api/attachments/1/a.png" alt="before">' });
    await writeAttachment(pageId, 'a.png', png(4, 4));
    await reconcilePageImageAnalyses(pageId);
    await query(
      `UPDATE pages SET title = 'Renamed', body_html = '<h2>Installation</h2><img src="/api/attachments/1/a.png" alt="after">',
              image_analysis_dirty = TRUE, embedding_dirty = FALSE WHERE id = $1`,
      [pageId],
    );

    const outcome = await reconcilePageImageAnalyses(pageId);

    expect(outcome).toMatchObject({ claimed: true, pended: 0, unchanged: 1, changed: false, bumped: false });
    expect(await pageState(pageId)).toEqual({ dirty: false, revision: 0, embeddingDirty: false });
  });

  it('re-raises the flag when the pass throws', async () => {
    const pageId = await seedPage({ bodyHtml: '<img src="/api/attachments/1/a.png">' });
    await writeAttachment(pageId, 'a.png', png(4, 4));
    let calls = 0;
    await expect(
      reconcilePageImageAnalyses(pageId, async () => {
        if (++calls === 2) throw new ImageAnalysisLeaseLostError();
      }),
    ).rejects.toBeInstanceOf(ImageAnalysisLeaseLostError);
    expect((await pageState(pageId)).dirty).toBe(true);
    expect(await rowsFor(pageId)).toEqual([]);
  });

  it('walks every dirty page, steps past one that throws, and stops on a lost lease', async () => {
    const a = await seedPage({ bodyHtml: '<img src="/api/attachments/1/a.png">' });
    const b = await seedPage({ bodyHtml: '<img src="/api/attachments/1/b.png">' });
    await writeAttachment(a, 'a.png', png(4, 4));
    await writeAttachment(b, 'b.png', png(4, 4));

    const totals = await reconcileDirtyPages(async () => undefined);
    expect(totals).toMatchObject({ pages: 2, pended: 2, pagesFailed: 0 });
    expect((await pageState(a)).dirty).toBe(false);
    expect((await pageState(b)).dirty).toBe(false);

    await query(`UPDATE pages SET image_analysis_dirty = TRUE`);
    let checks = 0;
    await expect(
      reconcileDirtyPages(async () => {
        if (++checks > 1) throw new ImageAnalysisLeaseLostError();
      }),
    ).rejects.toBeInstanceOf(ImageAnalysisLeaseLostError);
    // The first page was claimed then re-raised; the second was never reached.
    const dirty = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pages WHERE image_analysis_dirty`);
    expect(dirty.rows[0]!.n).toBe(2);
  });
});
