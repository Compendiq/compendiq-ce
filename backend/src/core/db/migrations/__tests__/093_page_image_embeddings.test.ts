import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();

/**
 * #1115 P0 — the image index's schema, and nothing that uses it yet.
 *
 * The whole point of a separate table (ADR-025 D6) is that `page_embeddings`,
 * `embedPage`, the #1116 shadow columns, MMR, rerank, sibling assembly and
 * `pages.page_avg_embedding` stay **text-only by construction**. So the
 * assertions below are about shape and about isolation: the table is its own
 * object with its own uniqueness rule, and the one thing it deliberately does
 * NOT have is a vector index.
 */
describe.skipIf(!dbAvailable)('Migration 093 — page_image_embeddings (#1115)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  async function seedPage(title = 'Test page'): Promise<number> {
    const res = await query<{ id: number }>(
      `INSERT INTO pages (
         space_key, title, body_html, body_text, version, source,
         embedding_dirty, embedding_status
       ) VALUES ('TEST', $1, '<p>v1</p>', 'v1', 1, 'standalone', FALSE, 'not_embedded')
       RETURNING id`,
      [title],
    );
    return res.rows[0]!.id;
  }

  /** A literal pgvector value of the placeholder width. */
  const VEC_2048 = `[${Array.from({ length: 2048 }, () => 0).join(',')}]`;

  async function insertImageRow(opts: {
    pageId: number;
    source?: string;
    key?: string;
    sha?: string;
    format?: string;
  }): Promise<void> {
    await query(
      `INSERT INTO page_image_embeddings
         (page_id, source, attachment_key, sha256, format, width, height, model, embedding)
       VALUES ($1, $2, $3, $4, $5, 800, 600, 'Qwen/Qwen3-VL-Embedding-2B', $6::vector)`,
      [
        opts.pageId,
        opts.source ?? 'confluence',
        opts.key ?? 'diagram.png',
        opts.sha ?? 'a'.repeat(64),
        opts.format ?? 'png',
        VEC_2048,
      ],
    );
  }

  it('creates the table', async () => {
    const { rows } = await query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename = 'page_image_embeddings'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('types the embedding column vector(2048) NOT NULL as the placeholder width', async () => {
    // 2048 is Qwen3-VL-Embedding-2B's native width and the recommended default,
    // but the live width is whatever the probe reports: P1's
    // `ensureImageEmbeddingColumn(dims)` re-types this column (and only then
    // builds the HNSW index). Pinning the declared type here is what makes that
    // later re-type a visible, deliberate act rather than a silent drift.
    const { rows } = await query<{ type: string; notnull: boolean }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull
         FROM pg_attribute a
        WHERE a.attrelid = 'page_image_embeddings'::regclass
          AND a.attname = 'embedding'`,
    );
    expect(rows[0]!.type).toBe('vector(2048)');
    expect(rows[0]!.notnull).toBe(true);
  });

  it('carries the identity, provenance and geometry columns the reconciler needs', async () => {
    const { rows } = await query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'page_image_embeddings'
        ORDER BY column_name`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]));

    expect(Object.keys(byName).sort()).toEqual([
      'attachment_key', 'created_at', 'embedding', 'format', 'height',
      'id', 'model', 'page_id', 'sha256', 'source', 'width',
    ]);
    expect(byName.id!.data_type).toBe('bigint');
    expect(byName.page_id!.data_type).toBe('integer');
    expect(byName.page_id!.is_nullable).toBe('NO');
    expect(byName.sha256!.is_nullable).toBe('NO');
    expect(byName.format!.is_nullable).toBe('NO');
    expect(byName.model!.is_nullable).toBe('NO');
    // Dimensions are read from the file header where the format declares them
    // and are unknown otherwise (#1154's `image-validator` reads four header
    // layouts and never decodes pixels), so they must be nullable.
    expect(byName.width!.is_nullable).toBe('YES');
    expect(byName.height!.is_nullable).toBe('YES');
  });

  it('CASCADEs when its page is deleted', async () => {
    const pageId = await seedPage();
    await insertImageRow({ pageId });

    await query('DELETE FROM pages WHERE id = $1', [pageId]);

    const { rows } = await query('SELECT 1 FROM page_image_embeddings WHERE page_id = $1', [pageId]);
    expect(rows).toHaveLength(0);
  });

  it('admits both stores and refuses a third', async () => {
    const pageId = await seedPage();
    await insertImageRow({ pageId, source: 'confluence', key: 'a.png' });
    await insertImageRow({ pageId, source: 'local', key: 'b.png' });

    await expect(
      insertImageRow({ pageId, source: 'external', key: 'c.png' }),
    ).rejects.toThrow();
  });

  it('is unique per (page_id, source, attachment_key), not per page', async () => {
    // The key is a filename inside ONE of the two stores, and the two stores
    // are independent namespaces — the same basename can legitimately exist in
    // both for the same page. `source` is therefore part of the key, not a tag.
    const pageId = await seedPage();
    await insertImageRow({ pageId, source: 'confluence', key: 'diagram.png' });
    await insertImageRow({ pageId, source: 'local', key: 'diagram.png' });

    await expect(
      insertImageRow({ pageId, source: 'confluence', key: 'diagram.png' }),
    ).rejects.toThrow();
  });

  it('indexes page_id for the per-page reconcile and the CASCADE', async () => {
    const { rows } = await query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'page_image_embeddings'
          AND indexname = 'page_image_embeddings_page_id_idx'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toContain('(page_id)');
  });

  it('ships NO vector index — the HNSW is probe-time DDL (P1)', async () => {
    // Deliberate, and pinned so a later "the migration forgot an index" fix
    // cannot land: the index's opclass depends on the probed width
    // (`vector_cosine_ops` ≤2000, `halfvec_cosine_ops` ≤4000, none above), and
    // the width is not known until the model answers. A migration-time HNSW
    // would be dropped and rebuilt by the first probe anyway.
    const { rows } = await query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'page_image_embeddings'`,
    );
    expect(rows.map((r) => r.indexdef).filter((d) => /USING hnsw/i.test(d))).toEqual([]);
  });

  it('adds pages.image_embedding_dirty, NOT NULL DEFAULT FALSE', async () => {
    const pageId = await seedPage();
    const { rows } = await query<{ is_nullable: string; column_default: string; data_type: string }>(
      `SELECT is_nullable, column_default, data_type
         FROM information_schema.columns
        WHERE table_name = 'pages' AND column_name = 'image_embedding_dirty'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data_type).toBe('boolean');
    expect(rows[0]!.is_nullable).toBe('NO');
    expect(rows[0]!.column_default).toBe('false');

    const seeded = await query<{ image_embedding_dirty: boolean }>(
      'SELECT image_embedding_dirty FROM pages WHERE id = $1',
      [pageId],
    );
    expect(seeded.rows[0]!.image_embedding_dirty).toBe(false);
  });

  it('indexes the dirty flag partially, the way embedding_dirty is scanned', async () => {
    const { rows } = await query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'pages' AND indexname = 'pages_image_embedding_dirty_idx'`,
    );
    expect(rows).toHaveLength(1);
    // A partial index: the worker only ever asks for the dirty ones, and on a
    // corpus where almost nothing is dirty a full index is mostly dead weight.
    expect(rows[0]!.indexdef).toMatch(/WHERE image_embedding_dirty/i);
  });

  it('widens the use-case CHECK to admit image_embedding, and still refuses nonsense', async () => {
    // The row is what P1's `resolveImageEmbeddingUsecase` reads. It never
    // inherits (ADR-021's rerank rule), so its ABSENCE is the disabled state —
    // which is why the constraint has to admit the name before any UI exists.
    await query(
      `INSERT INTO llm_usecase_assignments (usecase, provider_id, model)
       VALUES ('image_embedding', NULL, 'Qwen/Qwen3-VL-Embedding-2B')`,
    );
    const { rows } = await query<{ usecase: string }>(
      `SELECT usecase FROM llm_usecase_assignments WHERE usecase = 'image_embedding'`,
    );
    expect(rows).toHaveLength(1);

    await expect(
      query(`INSERT INTO llm_usecase_assignments (usecase) VALUES ('bogus')`),
    ).rejects.toThrow();
  });

  it('keeps every use case 090 admitted', async () => {
    // Re-adding a CHECK is a rewrite of the whole list, and dropping a name
    // here would disable that use case's assignment on the next save.
    for (const usecase of ['chat', 'summary', 'quality', 'auto_tag', 'embedding', 'rerank']) {
      await query(
        `INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ($1, NULL, 'm')`,
        [usecase],
      );
    }
    const { rows } = await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM llm_usecase_assignments',
    );
    expect(rows[0]!.count).toBe('6');
  });
});
