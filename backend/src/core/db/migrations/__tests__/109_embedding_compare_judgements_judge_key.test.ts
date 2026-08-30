import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();

// #1527 — the judgement key gains its admin dimension. 101 keyed a judgement
// by (query, live PAIR, candidate PAIR) with no judge, so on a multi-admin
// instance the second admin's `DO UPDATE` physically overwrote the first
// admin's `live_page_ids` / `candidate_page_ids` — arrays retrieved under
// THAT admin's `visiblePagesPredicate`, and therefore unrecoverable evidence.
// 109 adds `judged_by` to the key so every judge's row survives on disk; the
// one-trial-per-query invariant the McNemar N depends on moves to the READ
// path (`judgementsForReport` collapses to the newest judgement per query).
describe.skipIf(!dbAvailable)('Migration 109 — embedding_compare_judgements per-judge key (#1527)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  const ADMIN_A = 'aaaaaaaa-1527-4000-8000-00000000000a';
  const ADMIN_B = 'aaaaaaaa-1527-4000-8000-00000000000b';

  async function seedUsers(): Promise<void> {
    for (const id of [ADMIN_A, ADMIN_B]) {
      await query(
        `INSERT INTO users (id, username, email, role, password_hash)
         VALUES ($1::uuid, $1::text, $1::text || '@t', 'admin', 'x')
         ON CONFLICT (id) DO NOTHING`,
        [id],
      );
    }
  }

  /** The upsert as `recordShadowCompareJudgement` issues it after 109: the
   *  conflict target is the SIX-column key, and `judged_by` is no longer in
   *  the SET list because it is a key column. */
  async function judge(judgedBy: string, side: string, hash = 'h1'): Promise<void> {
    await query(
      `INSERT INTO embedding_compare_judgements
         (query_hash, query_text, live_provider_id, live_model, candidate_provider_id, candidate_model,
          judged_side, live_page_ids, candidate_page_ids, judged_by)
       VALUES ($1, 'how to configure sync', 'p1', 'bge-m3', 'p2', 'qwen3-embedding:4b', $2,
               ARRAY[1,2,3], ARRAY[3,2,4], $3)
       ON CONFLICT (query_hash, live_provider_id, live_model, candidate_provider_id, candidate_model, judged_by)
       DO UPDATE SET query_text = EXCLUDED.query_text,
                     judged_side = EXCLUDED.judged_side,
                     live_page_ids = EXCLUDED.live_page_ids,
                     candidate_page_ids = EXCLUDED.candidate_page_ids,
                     created_at = NOW()`,
      [hash, side, judgedBy],
    );
  }

  it('two admins judging the SAME query keep TWO rows — neither overwrites the other', async () => {
    await seedUsers();
    await judge(ADMIN_A, 'live');
    await judge(ADMIN_B, 'candidate');
    const { rows } = await query<{ judged_by: string; judged_side: string }>(
      `SELECT judged_by, judged_side FROM embedding_compare_judgements
       WHERE query_hash = 'h1' ORDER BY judged_by`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.judged_by, row.judged_side])).toEqual([
      [ADMIN_A, 'live'],
      [ADMIN_B, 'candidate'],
    ]);
  });

  it('one admin re-judging the same query still UPDATEs in place — no row growth', async () => {
    // The mutation guard on the migration: drop the old constraint and forget
    // to create the new one and this reds with 2 rows.
    await seedUsers();
    await judge(ADMIN_A, 'live');
    await judge(ADMIN_A, 'candidate');
    const { rows } = await query<{ judged_side: string }>(
      `SELECT judged_side FROM embedding_compare_judgements WHERE query_hash = 'h1'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.judged_side).toBe('candidate');
  });

  it('no unique key on the table lacks judged_by — the old five-column one is gone', async () => {
    // Catches a migration that created the new index but mis-typed the old
    // constraint's 63-byte-truncated name and so silently dropped nothing.
    const { rows } = await query<{ index_name: string; def: string }>(
      `SELECT i.relname AS index_name, pg_get_indexdef(x.indexrelid) AS def
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       WHERE x.indrelid = 'embedding_compare_judgements'::regclass
         AND x.indisunique AND NOT x.indisprimary
       ORDER BY i.relname`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.def).toContain('judged_by');
    for (const column of [
      'query_hash',
      'live_provider_id',
      'live_model',
      'candidate_provider_id',
      'candidate_model',
      'judged_by',
    ]) {
      expect(rows[0]!.def).toContain(column);
    }
    // Default NULLS DISTINCT, deliberately — see the SET-NULL guard below.
    expect(rows[0]!.def).not.toContain('NULLS NOT DISTINCT');
  });

  it('deleting BOTH judges of one query succeeds and keeps both rows — why NULLS NOT DISTINCT was rejected', async () => {
    // `judged_by` is REFERENCES users(id) ON DELETE SET NULL and 101's whole
    // point is that the fixture outlives its author. Under NULLS NOT DISTINCT
    // the second SET NULL would collide with the first row's now-NULL key and
    // the DELETE FROM users itself would fail — i.e. the admin would become
    // undeletable. Default NULLS DISTINCT lets the orphans coexist, and the
    // read path collapses them anyway.
    await seedUsers();
    await judge(ADMIN_A, 'live');
    await judge(ADMIN_B, 'candidate');
    await query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[ADMIN_A, ADMIN_B]]);
    const { rows } = await query<{ judged_by: string | null; judged_side: string }>(
      `SELECT judged_by, judged_side FROM embedding_compare_judgements
       WHERE query_hash = 'h1' ORDER BY judged_side`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.judged_by === null)).toBe(true);
    expect(rows.map((row) => row.judged_side)).toEqual(['candidate', 'live']);
  });
});
