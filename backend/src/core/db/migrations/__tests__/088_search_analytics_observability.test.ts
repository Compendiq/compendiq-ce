import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('Migration 088 — search_analytics observability columns (#1117)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  async function seedUser(id: string): Promise<void> {
    await query(
      `INSERT INTO users (id, username, email, role, password_hash)
       VALUES ($1::uuid, $1::text, $1::text || '@t', 'user', 'x')
       ON CONFLICT (id) DO NOTHING`,
      [id],
    );
  }

  it('adds rerank_score, degraded_reason and embedding_coverage as nullable columns', async () => {
    const { rows } = await query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'search_analytics'
         AND column_name IN ('rerank_score', 'degraded_reason', 'embedding_coverage')
       ORDER BY column_name`,
    );
    expect(rows).toEqual([
      { column_name: 'degraded_reason', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'embedding_coverage', data_type: 'real', is_nullable: 'YES' },
      { column_name: 'rerank_score', data_type: 'real', is_nullable: 'YES' },
    ]);
  });

  it('keeps the legacy insert shape working — historical rows are NOT backfilled', async () => {
    const userId = 'aaaaaaaa-0000-0000-0000-000000000001';
    await seedUser(userId);
    // The exact INSERT recordSearchAnalytics ran before this migration.
    await query(
      `INSERT INTO search_analytics (user_id, query, result_count, max_score, search_type)
       VALUES ($1, 'q', 3, 0.033, 'hybrid')`,
      [userId],
    );
    const { rows } = await query<{
      rerank_score: number | null;
      degraded_reason: string | null;
      embedding_coverage: number | null;
    }>(
      `SELECT rerank_score, degraded_reason, embedding_coverage FROM search_analytics`,
    );
    expect(rows[0]).toEqual({
      rerank_score: null,
      degraded_reason: null,
      embedding_coverage: null,
    });
  });

  it('accepts the new observability fields', async () => {
    const userId = 'aaaaaaaa-0000-0000-0000-000000000002';
    await seedUser(userId);
    await query(
      `INSERT INTO search_analytics
         (user_id, query, result_count, max_score, search_type, degraded_reason, embedding_coverage)
       VALUES ($1, 'q', 0, NULL, 'keyword_fallback', 'embedding_failed', 0.42)`,
      [userId],
    );
    const { rows } = await query<{ degraded_reason: string; embedding_coverage: number }>(
      `SELECT degraded_reason, embedding_coverage FROM search_analytics`,
    );
    expect(rows[0]!.degraded_reason).toBe('embedding_failed');
    expect(rows[0]!.embedding_coverage).toBeCloseTo(0.42, 5);
  });
});
