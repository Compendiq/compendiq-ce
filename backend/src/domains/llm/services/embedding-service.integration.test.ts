import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { computePageRelationships } from './embedding-service.js';
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

// Regression for #916: embedding_similarity edges are DIRECTED (page_id_1 is
// the source, page_id_2 the KNN neighbour). The incremental recompute deleted
// every edge touching a changed page on EITHER side, but only re-inserted the
// changed page's own outbound edges. Any reverse edge Y→X owned by an unchanged
// page Y was therefore dropped and never rebuilt. The fix scopes the
// embedding_similarity delete to the source side (page_id_1) only.
describe.skipIf(!dbAvailable)('computePageRelationships — directed similarity edges (#916)', () => {
  beforeAll(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await truncateAllTables();
  });

  // Unit vector on the (x, y) plane at `angleDeg`, padded to 1024 dims.
  // Cosine similarity between two such vectors is cos(angle difference), so
  // the angular layout below fully controls the KNN graph.
  function unitVec(angleDeg: number): number[] {
    const rad = (angleDeg * Math.PI) / 180;
    const v = new Array(1024).fill(0);
    v[0] = Math.cos(rad);
    v[1] = Math.sin(rad);
    return v;
  }

  async function seedPageWithEmbedding(title: string, angleDeg: number): Promise<number> {
    const page = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html)
       VALUES (gen_random_uuid()::text, 'confluence', 'DEV', $1, 'body', '', '')
       RETURNING id`,
      [title],
    );
    const pageId = page.rows[0]!.id;
    await query(
      `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
       VALUES ($1, 0, $2, $3, $4::jsonb)`,
      [
        pageId,
        'chunk',
        pgvector.toSql(unitVec(angleDeg)),
        JSON.stringify({ page_title: title, section_title: title, space_key: 'DEV' }),
      ],
    );
    return pageId;
  }

  async function similarityEdge(from: number, to: number): Promise<boolean> {
    const { rows } = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM page_relationships
       WHERE relationship_type = 'embedding_similarity'
         AND page_id_1 = $1 AND page_id_2 = $2`,
      [from, to],
    );
    return rows[0]!.count !== '0';
  }

  it('keeps an unchanged page\'s reverse edge (Y→X) after re-embedding X', async () => {
    // Cluster c1..c5 sits within 5° of X; Y sits 10° away from X. With TOP_K=5:
    //   X's 5 nearest are c1..c5 → X→Y is NOT created (asymmetric KNN).
    //   Y's 5 nearest are X + c5..c2 → Y→X IS created.
    const c1 = await seedPageWithEmbedding('C1', -5);
    const c2 = await seedPageWithEmbedding('C2', -4);
    const c3 = await seedPageWithEmbedding('C3', -3);
    const c4 = await seedPageWithEmbedding('C4', -2);
    const c5 = await seedPageWithEmbedding('C5', -1);
    const x = await seedPageWithEmbedding('X', 0);
    const y = await seedPageWithEmbedding('Y', 10);
    void c1;
    void c2;
    void c3;
    void c4;
    void c5;

    // Full recompute establishes the asymmetric graph.
    await computePageRelationships();
    expect(await similarityEdge(y, x)).toBe(true); // Y→X exists
    expect(await similarityEdge(x, y)).toBe(false); // X→Y does not

    // Simulate X being re-embedded: incremental recompute scoped to [X].
    await computePageRelationships([x]);

    // Y is unchanged, so its outbound Y→X edge must survive.
    expect(await similarityEdge(y, x)).toBe(true);
  });
});
