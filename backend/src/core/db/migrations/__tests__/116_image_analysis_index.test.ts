import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();

/**
 * ADR-027 migration 116 (#1616): the page-level analysis backlog carrier and
 * revision token, and the per-chunk lexical document `page_embeddings.chunk_tsv`
 * maintained like `pages.tsv` (049). Nothing here touches `page_image_analyses`
 * — that is migration 115's (#1615) — so the two land in either order.
 */
describe.skipIf(!dbAvailable)('Migration 116 — image analysis index (#1616)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => {
    await truncateAllTables();
    await query(`INSERT INTO admin_settings (setting_key, setting_value, updated_at)
                 VALUES ('fts_language', 'simple', NOW())
                 ON CONFLICT (setting_key) DO UPDATE SET setting_value = 'simple'`);
  });

  async function seedPage(opts: {
    title?: string;
    bodyHtml?: string | null;
    pageType?: string | null;
    deleted?: boolean;
  } = {}): Promise<number> {
    const res = await query<{ id: number }>(
      `INSERT INTO pages (space_key, title, body_html, body_text, version, source, page_type, deleted_at)
       VALUES ('TEST', $1, $2, 'text', 1, 'standalone', $3, $4) RETURNING id`,
      [opts.title ?? 'Page', opts.bodyHtml ?? '<p>v1</p>', opts.pageType ?? 'page', opts.deleted ? new Date() : null],
    );
    return res.rows[0]!.id;
  }

  const VEC = `[${Array.from({ length: 1024 }, () => 0).join(',')}]`;
  async function insertChunk(pageId: number, chunkIndex: number, text: string): Promise<void> {
    await query(
      `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
       VALUES ($1, $2, $3, $4::vector, '{}'::jsonb)`,
      [pageId, chunkIndex, text, VEC],
    );
  }

  it('adds pages.image_analysis_dirty (FALSE) and image_analysis_revision (0) with a partial dirty index', async () => {
    const pageId = await seedPage();
    const cols = await query<{ column_name: string; data_type: string; is_nullable: string; column_default: string }>(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'pages' AND column_name IN ('image_analysis_dirty', 'image_analysis_revision')
        ORDER BY column_name`,
    );
    expect(cols.rows.map((c) => [c.column_name, c.data_type, c.is_nullable])).toEqual([
      ['image_analysis_dirty', 'boolean', 'NO'],
      ['image_analysis_revision', 'bigint', 'NO'],
    ]);
    const row = await query<{ image_analysis_dirty: boolean; image_analysis_revision: string }>(
      `SELECT image_analysis_dirty, image_analysis_revision FROM pages WHERE id = $1`,
      [pageId],
    );
    expect(row.rows[0]).toEqual({ image_analysis_dirty: false, image_analysis_revision: '0' });

    const idx = await query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'pages' AND indexname = 'pages_image_analysis_dirty_idx'`,
    );
    expect(idx.rows[0]!.indexdef).toMatch(/WHERE image_analysis_dirty/i);
  });

  it('fills chunk_tsv on INSERT under the configured FTS language, NOT NULL', async () => {
    const pageId = await seedPage();
    await insertChunk(pageId, 0, 'Screenshot showing the release pipeline dashboard');

    const notnull = await query<{ attnotnull: boolean }>(
      `SELECT attnotnull FROM pg_attribute WHERE attrelid = 'page_embeddings'::regclass AND attname = 'chunk_tsv'`,
    );
    expect(notnull.rows[0]!.attnotnull).toBe(true);

    const hit = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM page_embeddings
        WHERE page_id = $1 AND chunk_tsv @@ plainto_tsquery('simple', 'dashboard')`,
      [pageId],
    );
    expect(hit.rows[0]!.n).toBe(1);
  });

  it('re-derives chunk_tsv on UPDATE OF chunk_text, and reads fts_language at write time', async () => {
    const pageId = await seedPage();
    await insertChunk(pageId, 0, 'the old text');
    await query(`UPDATE admin_settings SET setting_value = 'german' WHERE setting_key = 'fts_language'`);

    await query(`UPDATE page_embeddings SET chunk_text = 'Die Häuser wurden gebaut' WHERE page_id = $1`, [pageId]);

    const tsv = await query<{ tsv: string }>(
      `SELECT chunk_tsv::text AS tsv FROM page_embeddings WHERE page_id = $1`,
      [pageId],
    );
    // German stemming: `Häuser` → `haus`; under `simple` it would stay `häuser`.
    expect(tsv.rows[0]!.tsv).toContain("'haus'");
    expect(tsv.rows[0]!.tsv).not.toContain('old');
  });

  it('indexes chunk_tsv with GIN and the derived rows partially', async () => {
    const idx = await query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'page_embeddings'
        AND indexname IN ('page_embeddings_chunk_tsv_idx', 'page_embeddings_derived_idx') ORDER BY indexname`,
    );
    expect(idx.rows).toHaveLength(2);
    expect(idx.rows[0]!.indexdef).toMatch(/USING gin \(chunk_tsv\)/i);
    expect(idx.rows[1]!.indexdef).toMatch(/WHERE \(\(metadata ->> 'source'::text\) = 'image_analysis'::text\)/i);
  });

  it('seeds image_analysis_batch_size = 50', async () => {
    // truncateAllTables emptied admin_settings; the seed is what the migration
    // wrote, so re-run the file (it is idempotent) and read the row back.
    await query(migrationSql());
    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'image_analysis_batch_size'`,
    );
    expect(r.rows[0]!.setting_value).toBe('50');
  });

  it('is idempotent, and its backlog seed marks exactly the live, non-folder pages that reference an attachment image', async () => {
    const withConfluenceImage = await seedPage({ bodyHtml: '<p>x</p><img src="/api/attachments/7/a.png">' });
    const withLocalImage = await seedPage({ bodyHtml: '<img src="/api/local-attachments/9/b.png">' });
    const textOnly = await seedPage({ bodyHtml: '<p>no pictures here</p>' });
    const externalOnly = await seedPage({ bodyHtml: '<img src="https://example.com/c.png">' });
    const folder = await seedPage({ bodyHtml: '<img src="/api/attachments/7/a.png">', pageType: 'folder' });
    const trashed = await seedPage({ bodyHtml: '<img src="/api/attachments/7/a.png">', deleted: true });
    const nullBody = await seedPage({ bodyHtml: null });
    await insertChunk(withConfluenceImage, 0, 'a chunk that survives the re-run');

    // Second application of the whole file against a populated database.
    await query(migrationSql());

    const dirty = await query<{ id: number }>(
      `SELECT id FROM pages WHERE image_analysis_dirty ORDER BY id`,
    );
    expect(dirty.rows.map((r) => r.id)).toEqual([withConfluenceImage, withLocalImage]);
    for (const id of [textOnly, externalOnly, folder, trashed, nullBody]) {
      expect(dirty.rows.map((r) => r.id)).not.toContain(id);
    }
    const chunks = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM page_embeddings WHERE chunk_tsv IS NOT NULL`);
    expect(chunks.rows[0]!.n).toBe(1);
  });
});

function migrationSql(): string {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  return fs.readFileSync(path.join(dir, '116_image_analysis_index.sql'), 'utf-8');
}
