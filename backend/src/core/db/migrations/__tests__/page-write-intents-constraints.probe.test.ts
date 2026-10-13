import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDbAvailable, setupTestDb, teardownTestDb } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();

/**
 * Pins the named constraints the write-intent ledger relies on after the
 * full migration chain (120 → 125 → 137). A rename or drop of one of these
 * silently widens what an intent row may look like, so the inventory is
 * asserted here rather than assumed by the per-migration tests.
 */
describe.skipIf(!dbAvailable)('page_write_intents constraint inventory', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });

  it('keeps the policy, page-set and classification constraints', async () => {
    const r = await query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'page_write_intents'::regclass AND contype = 'c'
        ORDER BY conname`,
    );
    const names = r.rows.map((x) => x.conname);
    for (const expected of [
      'page_write_intents_effect_policy_check',
      'page_write_intents_page_ids_check',
      'page_write_intents_effect_check1',
      'page_write_intents_kind_check',
      'page_write_intents_recovery_mode_check',
      'page_write_intents_status_check',
    ]) {
      expect(names, expected).toContain(expected);
    }
  });
});
