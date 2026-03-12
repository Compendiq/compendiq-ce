import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../test-db-helper.js';
import { query } from '../core/db/postgres.js';

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
      `SELECT LOWER(TRIM(query)) AS query_text, COUNT(*) AS occurrence_count
       FROM search_analytics
       WHERE user_id = $1 AND (result_count = 0 OR max_score < 0.3)
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
