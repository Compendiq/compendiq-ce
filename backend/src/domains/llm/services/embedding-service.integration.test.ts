import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { embedPage } from './embedding-service.js';
import pgvector from 'pgvector';

// Deterministic 1024-dim vector for fixtures
function fakeVec(seed: number): number[] {
  return Array.from({ length: 1024 }, (_, i) => Math.sin((i + 1) * seed) * 0.01);
}

const dbAvailable = await isDbAvailable();

// Regression for ce-migrations-1: migration 030 silently dropped the
// UNIQUE (confluence_id, chunk_index) constraint on page_embeddings when it
// removed the confluence_id column, and never recreated it on the new page_id
// column. Migration 079 restores the invariant as UNIQUE (page_id, chunk_index).
describe.skipIf(!dbAvailable)('page_embeddings (page_id, chunk_index) uniqueness — migration 079', () => {
  beforeAll(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await truncateAllTables();
  });

  async function seedPage(): Promise<number> {
    const page = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html)
       VALUES (gen_random_uuid()::text, 'confluence', 'DEV', 'Page', 'body', '', '')
       RETURNING id`,
    );
    return page.rows[0]!.id;
  }

  async function insertEmbedding(pageId: number, chunkIndex: number): Promise<void> {
    await query(
      `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        pageId,
        chunkIndex,
        `chunk ${chunkIndex}`,
        pgvector.toSql(fakeVec(chunkIndex + 1)),
        JSON.stringify({ page_title: 'Page', section_title: 'Page', space_key: 'DEV' }),
      ],
    );
  }

  it('rejects a duplicate (page_id, chunk_index) row', async () => {
    const pageId = await seedPage();
    await insertEmbedding(pageId, 0);

    await expect(insertEmbedding(pageId, 0)).rejects.toThrow(
      /duplicate key value|unique constraint|page_embeddings_page_id_chunk_unique/i,
    );
  });

  it('allows distinct chunk_index values for the same page', async () => {
    const pageId = await seedPage();
    await insertEmbedding(pageId, 0);
    await insertEmbedding(pageId, 1);

    const { rows } = await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM page_embeddings WHERE page_id = $1',
      [pageId],
    );
    expect(rows[0]!.count).toBe('2');
  });

  it('allows the same chunk_index across different pages', async () => {
    const pageA = await seedPage();
    const pageB = await seedPage();
    await insertEmbedding(pageA, 0);
    await insertEmbedding(pageB, 0);

    const { rows } = await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM page_embeddings',
    );
    expect(rows[0]!.count).toBe('2');
  });
});

// Regression for #918: the empty/short-page short-circuit in embedPage cleared
// embedding_dirty but never moved embedding_status off the transient 'embedding'
// value set when the batch was marked. That left short pages stuck showing
// "embedding" forever. The branch must land on the terminal 'not_embedded'.
describe.skipIf(!dbAvailable)('embedPage short-page short-circuit — issue #918', () => {
  beforeAll(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await truncateAllTables();
  });

  async function seedShortPage(): Promise<number> {
    const page = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html,
                          embedding_status, embedding_dirty)
       VALUES (gen_random_uuid()::text, 'confluence', 'DEV', 'Short', 'hi', '', '<p>hi</p>',
               'embedding', TRUE)
       RETURNING id`,
    );
    return page.rows[0]!.id;
  }

  it('clears embedding_dirty and lands on terminal not_embedded status', async () => {
    const pageId = await seedShortPage();

    // '<p>hi</p>' has <20 chars of text, so embedPage short-circuits before any
    // LLM call — no provider mock needed.
    const written = await embedPage('user-1', pageId, 'Short', 'DEV', '<p>hi</p>');
    expect(written).toBe(0);

    const { rows } = await query<{ embedding_status: string; embedding_dirty: boolean }>(
      'SELECT embedding_status, embedding_dirty FROM pages WHERE id = $1',
      [pageId],
    );
    expect(rows[0]!.embedding_dirty).toBe(false);
    expect(rows[0]!.embedding_status).toBe('not_embedded');
  });
});
