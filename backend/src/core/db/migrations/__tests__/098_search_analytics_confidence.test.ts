import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();

/**
 * #1284 — the refuse gate's verdict becomes a COLUMN, not only a span
 * attribute. The Retrieval panel tells operators to pick a threshold from
 * their own observed `rag.confidence` distribution, and until this migration
 * `search_analytics` held nothing that could answer that: `max_score` is the
 * RRF fusion value and `rerank_score` is the reranker's own scale, neither of
 * which is the number the gate compares.
 */
describe.skipIf(!dbAvailable)('Migration 098 — search_analytics confidence columns (#1284)', () => {
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

  it('adds confidence, confidence_basis and surface as nullable columns', async () => {
    const { rows } = await query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'search_analytics'
         AND column_name IN ('confidence', 'confidence_basis', 'surface')
       ORDER BY column_name`,
    );
    expect(rows).toEqual([
      { column_name: 'confidence', data_type: 'real', is_nullable: 'YES' },
      { column_name: 'confidence_basis', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'surface', data_type: 'text', is_nullable: 'YES' },
    ]);
  });

  it('keeps the pre-#1284 insert shape working — historical rows are NOT backfilled', async () => {
    const userId = 'bbbbbbbb-0000-0000-0000-000000000001';
    await seedUser(userId);
    // The exact INSERT recordSearchAnalytics ran before this migration.
    await query(
      `INSERT INTO search_analytics
         (user_id, query, result_count, max_score, search_type,
          rerank_score, degraded_reason, embedding_coverage)
       VALUES ($1, 'q', 3, 0.033, 'hybrid', NULL, NULL, 1.0)`,
      [userId],
    );
    const { rows } = await query<{
      confidence: number | null;
      confidence_basis: string | null;
      surface: string | null;
    }>(`SELECT confidence, confidence_basis, surface FROM search_analytics`);
    expect(rows[0]).toEqual({ confidence: null, confidence_basis: null, surface: null });
  });

  it('accepts the recorded verdict, including a basis with no score', async () => {
    const userId = 'bbbbbbbb-0000-0000-0000-000000000002';
    await seedUser(userId);
    await query(
      `INSERT INTO search_analytics
         (user_id, query, result_count, max_score, search_type, confidence, confidence_basis, surface)
       VALUES
         ($1, 'q1', 5, 0.03, 'hybrid_rerank', 0.62, 'rerank', 'ask'),
         ($1, 'q2', 5, 0.03, 'hybrid', 0.41, 'similarity', 'ask'),
         -- basis 'none' carries no number at all: a keyword-led set is
         -- unmeasurable, and the endpoint must never read it as a 0.
         ($1, 'q3', 5, 0.03, 'keyword_fallback', NULL, 'none', 'ask'),
         ($1, 'q4', 5, 0.03, 'semantic', NULL, NULL, 'search')`,
      [userId],
    );
    const { rows } = await query<{ confidence: number | null; confidence_basis: string | null; surface: string | null }>(
      `SELECT confidence, confidence_basis, surface FROM search_analytics ORDER BY query`,
    );
    expect(rows[0]!.confidence).toBeCloseTo(0.62, 5);
    expect(rows[0]!.confidence_basis).toBe('rerank');
    expect(rows[0]!.surface).toBe('ask');
    expect(rows[1]!.confidence_basis).toBe('similarity');
    expect(rows[2]).toEqual({ confidence: null, confidence_basis: 'none', surface: 'ask' });
    expect(rows[3]).toEqual({ confidence: null, confidence_basis: null, surface: 'search' });
  });

  it('leaves confidence_basis unconstrained — the vocabulary lives in TypeScript, like search_type', async () => {
    const { rows } = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM information_schema.constraint_column_usage ccu
       JOIN information_schema.table_constraints tc
         ON tc.constraint_name = ccu.constraint_name
       WHERE ccu.table_name = 'search_analytics'
         AND ccu.column_name IN ('confidence_basis', 'surface')
         AND tc.constraint_type = 'CHECK'`,
    );
    expect(rows[0]!.count).toBe('0');
  });
});
