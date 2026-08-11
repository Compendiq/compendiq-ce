import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { KNOWLEDGE_GAP_PREDICATE_SQL, GAP_FUSION_THRESHOLD } from './_gap-predicate.js';
import { rrfWorstCase } from '../../domains/llm/services/rag-service.js';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('Search Analytics (DB)', () => {
  let userId: string;

  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();

    // Create a test user
    const userResult = await query<{ id: string }>(
      "INSERT INTO users (username, password_hash) VALUES ('analytics_user', 'hash') RETURNING id",
    );
    userId = userResult.rows[0].id;
  });

  it('should create search_analytics table with migrations', async () => {
    const result = await query<{ exists: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'search_analytics'
      ) AS exists`,
    );
    expect(result.rows[0].exists).toBe(true);
  });

  it('should insert search analytics records', async () => {
    await query(
      `INSERT INTO search_analytics (user_id, query, result_count, max_score, search_type)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, 'test query', 5, 0.85, 'hybrid'],
    );

    const result = await query<{
      query: string;
      result_count: number;
      max_score: number;
      search_type: string;
    }>(
      'SELECT query, result_count, max_score, search_type FROM search_analytics WHERE user_id = $1',
      [userId],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].query).toBe('test query');
    expect(result.rows[0].result_count).toBe(5);
    expect(result.rows[0].search_type).toBe('hybrid');
  });

  it('should support zero-result search tracking', async () => {
    await query(
      `INSERT INTO search_analytics (user_id, query, result_count, max_score, search_type)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, 'unknown topic', 0, null, 'hybrid'],
    );

    const result = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM search_analytics WHERE user_id = $1 AND result_count = 0',
      [userId],
    );

    expect(parseInt(result.rows[0].count, 10)).toBe(1);
  });

  it('should support knowledge gap queries (zero results grouped)', async () => {
    // Insert multiple searches, some with 0 results
    for (let i = 0; i < 3; i++) {
      await query(
        `INSERT INTO search_analytics (user_id, query, result_count, max_score, search_type)
         VALUES ($1, 'kubernetes deployment', 0, NULL, 'hybrid')`,
        [userId],
      );
    }
    await query(
      `INSERT INTO search_analytics (user_id, query, result_count, max_score, search_type)
       VALUES ($1, 'redis configuration', 5, 0.9, 'hybrid')`,
      [userId],
    );

    const gaps = await query<{
      query_text: string;
      occurrence_count: string;
    }>(
      // The ROUTE's shared predicate, not an inline restatement — an inline
      // copy kept this test green while the real predicate changed (#1269
      // code-review layer, finding 1).
      `SELECT LOWER(TRIM(query)) AS query_text, COUNT(*) AS occurrence_count
       FROM search_analytics
       WHERE user_id = $1 AND ${KNOWLEDGE_GAP_PREDICATE_SQL}
       GROUP BY LOWER(TRIM(query))
       ORDER BY COUNT(*) DESC`,
      [userId],
    );

    expect(gaps.rows).toHaveLength(1);
    expect(gaps.rows[0].query_text).toBe('kubernetes deployment');
    expect(parseInt(gaps.rows[0].occurrence_count, 10)).toBe(3);
  });

  it('should cascade delete on user deletion', async () => {
    await query(
      `INSERT INTO search_analytics (user_id, query, result_count, search_type)
       VALUES ($1, 'test', 0, 'hybrid')`,
      [userId],
    );

    await query('DELETE FROM users WHERE id = $1', [userId]);

    const result = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM search_analytics WHERE user_id = $1',
      [userId],
    );
    expect(parseInt(result.rows[0].count, 10)).toBe(0);
  });

  it('should use partial index for zero-result queries', async () => {
    const result = await query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'search_analytics'
       AND indexname = 'idx_search_analytics_zero_results'`,
    );
    expect(result.rows).toHaveLength(1);
  });
});

describe.skipIf(!dbAvailable)('knowledge-gap predicate — per-unit arms (#1269)', () => {
  const userId = 'aaaaaaaa-9999-4000-8000-0000000a0a99';

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await query('DELETE FROM search_analytics WHERE user_id = $1', [userId]);
    await query(
      `INSERT INTO users (id, username, email, role, password_hash)
       VALUES ($1::uuid, 'gap-pin-user', 'gap-pin@test', 'user', 'x')
       ON CONFLICT (id) DO NOTHING`,
      [userId],
    );
  });

  it('derives the fusion threshold from rrfWorstCase — strictly between single-leg and both-legs', () => {
    expect(GAP_FUSION_THRESHOLD).toBeGreaterThan(rrfWorstCase(false));
    expect(GAP_FUSION_THRESHOLD).toBeLessThan(rrfWorstCase(true));
  });

  it('pins every arm against real rows — the defect each arm fixes cannot silently return', async () => {
    // (query label, result_count, max_score, search_type, expectGap)
    const rows: Array<[string, number, number | null, string, boolean]> = [
      ['hybrid weak',            3, rrfWorstCase(false), 'hybrid',           true],  // single-leg only
      ['hybrid strong',          3, rrfWorstCase(true),  'hybrid',           false], // found by both legs
      ['rerank weak',            3, 0.02,                'hybrid_rerank',    true],
      ['fallback with results',  3, rrfWorstCase(false), 'keyword_fallback', false], // outage signal, not a gap
      ['fallback empty',         0, null,                'keyword_fallback', true],  // result_count catches it
      ['semantic weak',          3, 0.25,                'semantic',         true],  // cosine unit keeps 0.3
      ['semantic strong',        3, 0.5,                 'semantic',         false],
      ['keyword weak',           3, 0.06,                'keyword',          true],  // ts_rank unit keeps 0.3
      ['keyword strong',         3, 0.4,                 'keyword',          false],
    ];
    for (const [label, count, score, type] of rows) {
      await query(
        `INSERT INTO search_analytics (user_id, query, result_count, max_score, search_type)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, label, count, score, type],
      );
    }

    const gaps = await query<{ q: string }>(
      `SELECT query AS q FROM search_analytics
       WHERE user_id = $1 AND ${KNOWLEDGE_GAP_PREDICATE_SQL}
       ORDER BY query`,
      [userId],
    );
    const expected = rows.filter(([, , , , gap]) => gap).map(([label]) => label).sort();
    expect(gaps.rows.map((r) => r.q)).toEqual(expected);
  });
});
