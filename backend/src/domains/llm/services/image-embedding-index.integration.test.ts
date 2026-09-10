import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  ensureImageEmbeddingColumn,
  IMAGE_EMBEDDING_DIMENSIONS_KEY,
  IMAGE_EMBEDDING_INDEX_MODEL_KEY,
  IMAGE_EMBEDDING_HNSW_INDEX,
} from './image-embedding-index.js';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { logger } from '../../../core/utils/logger.js';

/**
 * Real Postgres, never mocked (CLAUDE.md). The whole content of this module is
 * DDL against pgvector, so a mocked client would assert the strings we wrote
 * rather than that Postgres accepts them — and the one bug this replaces is
 * exactly a `halfvec` column indexed with `vector_cosine_ops`, which only
 * Postgres can refuse.
 */

const dbAvailable = await isDbAvailable();

const PAIR = {
  providerId: '22222222-2222-4222-8222-222222222222',
  model: 'Qwen/Qwen3-VL-Embedding-2B',
  baseUrl: 'http://vllm-a:8000/v1',
  /** No MRL truncation: the leg takes whatever the checkpoint answers with. */
  targetDimensions: null,
};
const IDENTITY = `${PAIR.providerId}:${PAIR.model}@${PAIR.baseUrl}#native`;

async function liveColumn(): Promise<{ type: string; dims: number }> {
  const r = await query<{ type: string; dims: number }>(
    `SELECT format_type(atttypid, atttypmod) AS type, atttypmod AS dims
       FROM pg_attribute
      WHERE attrelid = 'page_image_embeddings'::regclass AND attname = 'embedding'`,
  );
  return r.rows[0]!;
}

async function hnswIndexDef(): Promise<string | null> {
  const r = await query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'page_image_embeddings' AND indexname = $1`,
    [IMAGE_EMBEDDING_HNSW_INDEX],
  );
  return r.rows[0]?.indexdef ?? null;
}

async function setting(key: string): Promise<string | null> {
  const r = await query<{ setting_value: string }>(
    `SELECT setting_value FROM admin_settings WHERE setting_key = $1`, [key],
  );
  return r.rows[0]?.setting_value ?? null;
}

async function seedPages(): Promise<{ pageId: number; folderId: number }> {
  const p = await query<{ id: number }>(
    `INSERT INTO pages (title, space_key, body_html, page_type, source)
     VALUES ('Doc', 'DEV', '<p>x</p>', 'page', 'standalone') RETURNING id`,
  );
  const f = await query<{ id: number }>(
    `INSERT INTO pages (title, space_key, body_html, page_type, source)
     VALUES ('Folder', 'DEV', NULL, 'folder', 'standalone') RETURNING id`,
  );
  return { pageId: p.rows[0]!.id, folderId: f.rows[0]!.id };
}

async function insertVector(pageId: number, dims: number): Promise<void> {
  const literal = `[${new Array(dims).fill(0).map((_, i) => (i === 0 ? 1 : 0)).join(',')}]`;
  await query(
    `INSERT INTO page_image_embeddings
       (page_id, source, attachment_key, sha256, format, model, embedding)
     VALUES ($1, 'local', 'a.png', 'deadbeef', 'png', 'old-model', $2)`,
    [pageId, literal],
  );
}

describe.skipIf(!dbAvailable)('ensureImageEmbeddingColumn (#1115)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => {
    // Leave the shared test database as migration 093 left it. This file
    // retypes a real column, and the migration's own test asserts the
    // placeholder shape — restoring it here is what keeps that assertion about
    // the migration rather than about which file happened to run first.
    await query(`DROP INDEX IF EXISTS ${IMAGE_EMBEDDING_HNSW_INDEX}`);
    await query(`ALTER TABLE page_image_embeddings ALTER COLUMN embedding TYPE vector(2048)`);
    await teardownTestDb();
  });
  beforeEach(async () => {
    await truncateAllTables();
    // Migration 093 ships `vector(2048)` as a PLACEHOLDER and no HNSW index.
    // Reset to that shape so each case starts where a fresh install does.
    await query(`DROP INDEX IF EXISTS ${IMAGE_EMBEDDING_HNSW_INDEX}`);
    await query(`ALTER TABLE page_image_embeddings ALTER COLUMN embedding TYPE vector(2048)`);
  });

  describe('the width changed', () => {
    it('retypes, truncates, indexes and records the pair', async () => {
      const { pageId } = await seedPages();
      await insertVector(pageId, 2048);

      const result = await ensureImageEmbeddingColumn(1024, PAIR);

      expect(result).toMatchObject({ action: 'rebuilt', dimensions: 1024, tier: 'vector', indexed: true });
      expect((await liveColumn()).type).toBe('vector(1024)');
      // TRUNCATE, not ALTER … USING: the rows carry the old width and cannot
      // be cast into the new one.
      const rows = await query(`SELECT 1 FROM page_image_embeddings`);
      expect(rows.rows).toHaveLength(0);
      expect(await hnswIndexDef()).toContain('vector_cosine_ops');
      expect(await setting(IMAGE_EMBEDDING_DIMENSIONS_KEY)).toBe('1024');
      expect(await setting(IMAGE_EMBEDDING_INDEX_MODEL_KEY)).toBe(IDENTITY);
    });

    it('builds a halfvec index above 2000 dims', async () => {
      const result = await ensureImageEmbeddingColumn(2560, PAIR);
      expect(result).toMatchObject({ tier: 'halfvec', indexed: true });
      expect((await liveColumn()).type).toBe('halfvec(2560)');
      expect(await hnswIndexDef()).toContain('halfvec_cosine_ops');
    });

    // D7: a model change empties the index and re-scans. Text search is
    // untouched — `embedding_dirty` must not move.
    it('marks every non-folder page image-dirty and leaves text embedding alone', async () => {
      const { pageId, folderId } = await seedPages();
      await query(`UPDATE pages SET image_embedding_dirty = FALSE, embedding_dirty = FALSE`);

      const result = await ensureImageEmbeddingColumn(1024, PAIR);

      expect(result.dirtiedPages).toBe(1);
      const rows = await query<{ id: number; image_embedding_dirty: boolean; embedding_dirty: boolean }>(
        `SELECT id, image_embedding_dirty, embedding_dirty FROM pages ORDER BY id`,
      );
      const byId = new Map(rows.rows.map((r) => [r.id, r]));
      expect(byId.get(pageId)!.image_embedding_dirty).toBe(true);
      expect(byId.get(pageId)!.embedding_dirty).toBe(false);
      // A folder has no body to carry an image reference — the same exclusion
      // `embedding-service` and the quality/summary workers apply.
      expect(byId.get(folderId)!.image_embedding_dirty).toBe(false);
    });
  });

  describe('the MODEL changed at the same width', () => {
    it('rebuilds anyway — the vector space moved even though the column did not', async () => {
      const { pageId } = await seedPages();
      await ensureImageEmbeddingColumn(1024, PAIR);
      await insertVector(pageId, 1024);
      await query(`UPDATE pages SET image_embedding_dirty = FALSE`);

      const result = await ensureImageEmbeddingColumn(1024, { ...PAIR, model: 'other-vl-model' });

      expect(result.action).toBe('rebuilt');
      expect((await query(`SELECT 1 FROM page_image_embeddings`)).rows).toHaveLength(0);
      expect(await setting(IMAGE_EMBEDDING_INDEX_MODEL_KEY)).toBe(
        `${PAIR.providerId}:other-vl-model@${PAIR.baseUrl}#native`,
      );
      expect(result.dirtiedPages).toBe(1);
    });

    it('treats the same model on a different provider as a change', async () => {
      await ensureImageEmbeddingColumn(1024, PAIR);
      const result = await ensureImageEmbeddingColumn(1024, {
        ...PAIR, providerId: '33333333-3333-4333-8333-333333333333',
      });
      expect(result.action).toBe('rebuilt');
    });

    /**
     * Review round 1: the base URL is in the identity in its own right, not
     * implied by the provider id. `PATCH /admin/llm-providers/:id` can move a
     * provider row's `base_url` to a different container without changing that
     * id — and ADR-025 D12 makes a differently-served model a re-index event,
     * while one model NAME can mean two different checkpoints on two servers.
     */
    it('treats the same provider and model at a NEW base URL as a change', async () => {
      const { pageId } = await seedPages();
      await ensureImageEmbeddingColumn(1024, PAIR);
      await insertVector(pageId, 1024);
      await query(`UPDATE pages SET image_embedding_dirty = FALSE`);

      const result = await ensureImageEmbeddingColumn(1024, {
        ...PAIR, baseUrl: 'http://vllm-b:8000/v1',
      });

      expect(result.action).toBe('rebuilt');
      expect((await query(`SELECT 1 FROM page_image_embeddings`)).rows).toHaveLength(0);
      expect(result.dirtiedPages).toBe(1);
    });
  });

  /**
   * The MRL truncation width is the fourth part of the identity (#1115, review
   * round 2). It is what every image-side call REQUESTS, so it describes the
   * space even where the returned width alone would also have caught the move.
   */
  describe('the requested truncation width', () => {
    it('types the column to the truncated width an 8B was asked for', async () => {
      // The 8B's native answer is 4096 — pgvector's unindexed tier. With
      // `image_embedding_target_dimensions = 2048` the probe asks for 2048,
      // requires 2048 back, and the column follows THAT.
      const result = await ensureImageEmbeddingColumn(2048, {
        ...PAIR,
        model: 'Qwen/Qwen3-VL-Embedding-8B',
        targetDimensions: 2048,
      });

      expect(result).toMatchObject({ action: 'rebuilt', dimensions: 2048, tier: 'halfvec', indexed: true });
      expect((await liveColumn()).type).toBe('halfvec(2048)');
      expect(await hnswIndexDef()).toContain('halfvec_cosine_ops');
      expect(await setting(IMAGE_EMBEDDING_DIMENSIONS_KEY)).toBe('2048');
      expect(await setting(IMAGE_EMBEDDING_INDEX_MODEL_KEY)).toBe(
        `${PAIR.providerId}:Qwen/Qwen3-VL-Embedding-8B@${PAIR.baseUrl}#2048`,
      );
    });

    it('rebuilds when only the requested width changed, at the same returned width', async () => {
      const { pageId } = await seedPages();
      await ensureImageEmbeddingColumn(2048, PAIR);
      await insertVector(pageId, 2048);
      await query(`UPDATE pages SET image_embedding_dirty = FALSE`);

      // Same provider, same model, same URL, same returned width — but the
      // deployment now truncates explicitly. A column type cannot tell the two
      // apart, which is exactly why the request parameter is in the identity.
      const result = await ensureImageEmbeddingColumn(2048, { ...PAIR, targetDimensions: 2048 });

      expect(result.action).toBe('rebuilt');
      expect((await query(`SELECT 1 FROM page_image_embeddings`)).rows).toHaveLength(0);
      expect(result.dirtiedPages).toBe(1);
      expect(await setting(IMAGE_EMBEDDING_INDEX_MODEL_KEY)).toBe(`${IDENTITY.replace('#native', '#2048')}`);
    });

    it('re-saving the same truncation width costs nothing', async () => {
      const pinned = { ...PAIR, targetDimensions: 2048 };
      await ensureImageEmbeddingColumn(2048, pinned);
      const result = await ensureImageEmbeddingColumn(2048, pinned);
      expect(result).toMatchObject({ action: 'index_only', dirtiedPages: 0 });
    });
  });

  describe('same width, same model', () => {
    it('only ensures the index exists — no truncate, no re-dirty', async () => {
      const { pageId } = await seedPages();
      await ensureImageEmbeddingColumn(1024, PAIR);
      await insertVector(pageId, 1024);
      await query(`UPDATE pages SET image_embedding_dirty = FALSE`);

      const result = await ensureImageEmbeddingColumn(1024, PAIR);

      expect(result).toMatchObject({ action: 'index_only', dimensions: 1024, dirtiedPages: 0 });
      expect((await query(`SELECT 1 FROM page_image_embeddings`)).rows).toHaveLength(1);
      const dirty = await query<{ n: string }>(
        `SELECT COUNT(*) n FROM pages WHERE image_embedding_dirty`,
      );
      expect(Number(dirty.rows[0]!.n)).toBe(0);
    });

    it('recreates an index that was dropped underneath it', async () => {
      await ensureImageEmbeddingColumn(1024, PAIR);
      await query(`DROP INDEX ${IMAGE_EMBEDDING_HNSW_INDEX}`);
      const result = await ensureImageEmbeddingColumn(1024, PAIR);
      expect(result.action).toBe('index_only');
      expect(await hnswIndexDef()).toContain('vector_cosine_ops');
    });
  });

  describe('the unindexed tier', () => {
    it('retypes without an index and warns', async () => {
      const warn = vi.spyOn(logger, 'warn');
      const result = await ensureImageEmbeddingColumn(4096, PAIR);

      expect(result).toMatchObject({ tier: 'unindexed', indexed: false });
      expect((await liveColumn()).type).toBe('vector(4096)');
      expect(await hnswIndexDef()).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ dimensions: 4096 }),
        expect.stringMatching(/sequential scan|no HNSW|unindexed/i),
      );
      warn.mockRestore();
    });

    it('drops a leftover index from a previously indexed width', async () => {
      await ensureImageEmbeddingColumn(1024, PAIR);
      expect(await hnswIndexDef()).not.toBeNull();
      await ensureImageEmbeddingColumn(4096, PAIR);
      expect(await hnswIndexDef()).toBeNull();
    });
  });

  it('refuses an implausible width before it reaches DDL', async () => {
    await expect(ensureImageEmbeddingColumn(0, PAIR)).rejects.toThrow(/dimension/i);
    await expect(ensureImageEmbeddingColumn(16_001, PAIR)).rejects.toThrow(/dimension/i);
    expect((await liveColumn()).type).toBe('vector(2048)');
  });
});
