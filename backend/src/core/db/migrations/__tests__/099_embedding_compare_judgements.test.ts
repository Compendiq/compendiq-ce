import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();

// #1260 Mode 2 — side-by-side judgements. The table is the accumulating
// fixture: it references the models by NAME (no FK to llm_providers, no FK
// to a run), because a judgement must survive the migration, the run and
// even the provider row that produced it — that is what makes the SECOND
// model change cheaper to evaluate than the first.
describe.skipIf(!dbAvailable)('Migration 099 — embedding_compare_judgements (#1260)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  const USER = 'aaaaaaaa-0099-4000-8000-000000000001';

  async function seedUser(): Promise<void> {
    await query(
      `INSERT INTO users (id, username, email, role, password_hash)
       VALUES ($1::uuid, $1::text, $1::text || '@t', 'admin', 'x')
       ON CONFLICT (id) DO NOTHING`,
      [USER],
    );
  }

  async function insertJudgement(
    side: string,
    hash = 'h1',
    pair: { liveProvider?: string; candidateProvider?: string } = {},
  ): Promise<void> {
    await query(
      `INSERT INTO embedding_compare_judgements
         (query_hash, query_text, live_provider_id, live_model, candidate_provider_id, candidate_model,
          judged_side, live_page_ids, candidate_page_ids, judged_by)
       VALUES ($1, 'how to configure sync', $4, 'bge-m3', $5, 'qwen3-embedding:4b', $2,
               ARRAY[1,2,3], ARRAY[3,2,4], $3)
       ON CONFLICT (query_hash, live_provider_id, live_model, candidate_provider_id, candidate_model)
       DO UPDATE SET query_text = EXCLUDED.query_text,
                     judged_side = EXCLUDED.judged_side,
                     live_page_ids = EXCLUDED.live_page_ids,
                     candidate_page_ids = EXCLUDED.candidate_page_ids,
                     judged_by = EXCLUDED.judged_by,
                     created_at = NOW()`,
      [hash, side, USER, pair.liveProvider ?? 'p1', pair.candidateProvider ?? 'p2'],
    );
  }

  it('accepts the four sides and refuses anything else', async () => {
    await seedUser();
    for (const side of ['live', 'candidate', 'neither', 'both']) {
      await insertJudgement(side, `h-${side}`);
    }
    const { rows } = await query<{ n: string }>(`SELECT COUNT(*) AS n FROM embedding_compare_judgements`);
    expect(Number(rows[0]!.n)).toBe(4);
    await expect(insertJudgement('draw', 'h-bad')).rejects.toThrow(/check constraint|violates/i);
  });

  it('re-judging the same query for the same model pair replaces, never duplicates', async () => {
    await seedUser();
    await insertJudgement('live');
    await insertJudgement('candidate');
    const { rows } = await query<{ judged_side: string }>(
      `SELECT judged_side FROM embedding_compare_judgements WHERE query_hash = 'h1'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.judged_side).toBe('candidate');
  });

  it('keys on the PROVIDER beside the model, so re-hosting a model does not pool two indexes', async () => {
    // Same query, same two model NAMES, different candidate provider: a
    // second migration to `qwen3-embedding:4b` behind another endpoint is a
    // different index, and its page-id arrays must not land in the earlier
    // migration's verdict. Keyed on names alone this is one row.
    await seedUser();
    await insertJudgement('live', 'h1', { candidateProvider: 'p2' });
    await insertJudgement('candidate', 'h1', { candidateProvider: 'p3' });
    const { rows } = await query<{ candidate_provider_id: string; judged_side: string }>(
      `SELECT candidate_provider_id, judged_side FROM embedding_compare_judgements
       WHERE query_hash = 'h1' ORDER BY candidate_provider_id`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.candidate_provider_id, row.judged_side])).toEqual([
      ['p2', 'live'],
      ['p3', 'candidate'],
    ]);
  });

  it('survives the judging user being deleted — the fixture outlives its author', async () => {
    await seedUser();
    await insertJudgement('live');
    await query(`DELETE FROM users WHERE id = $1`, [USER]);
    const { rows } = await query<{ judged_by: string | null }>(
      `SELECT judged_by FROM embedding_compare_judgements WHERE query_hash = 'h1'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.judged_by).toBeNull();
  });

  it('carries no FK to llm_providers or to the run — models are recorded by name', async () => {
    const { rows } = await query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'embedding_compare_judgements'::regclass AND contype = 'f'`,
    );
    // The one FK is judged_by → users (SET NULL). Nothing ties a judgement
    // to a provider row or a benchmark run row.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conname).toMatch(/judged_by/);
  });
});
