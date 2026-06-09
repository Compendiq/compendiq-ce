import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../db/postgres.js';
import { getAiOutputRules, upsertAiOutputRules } from './ai-safety-service.js';

const dbAvailable = await isDbAvailable();

// Real-Postgres coverage for the Swiss-spelling output rule (#705): persistence
// into `admin_settings`, the default-off getter, and cache invalidation on
// write. The 60s TTL cache is module-level, but `upsertAiOutputRules` nulls it
// on every write, so a read-after-write reflects the new value immediately.
describe.skipIf(!dbAvailable)('ai-safety-service — Swiss spelling output rule (#705)', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    // Read once after truncate to refresh the module cache to the post-truncate
    // (empty admin_settings) state, so each test starts from defaults.
    await getAiOutputRules();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('defaults swissSpelling to false when no admin_settings row exists', async () => {
    const rules = await getAiOutputRules();
    expect(rules.swissSpelling).toBe(false);
  });

  it('persists swissSpelling=true and reflects it on the next read (cache invalidated on write)', async () => {
    await upsertAiOutputRules({ swissSpelling: true });

    const row = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'ai_output_rule_swiss_spelling'`,
    );
    expect(row.rows[0]?.setting_value).toBe('true');

    const rules = await getAiOutputRules();
    expect(rules.swissSpelling).toBe(true);
  });

  it('persists swissSpelling=false explicitly', async () => {
    await upsertAiOutputRules({ swissSpelling: true });
    expect((await getAiOutputRules()).swissSpelling).toBe(true);

    await upsertAiOutputRules({ swissSpelling: false });
    expect((await getAiOutputRules()).swissSpelling).toBe(false);
  });

  it('leaves swissSpelling untouched when an unrelated output rule is updated', async () => {
    await upsertAiOutputRules({ swissSpelling: true });
    await upsertAiOutputRules({ referenceAction: 'strip' });

    const rules = await getAiOutputRules();
    expect(rules.swissSpelling).toBe(true);
    expect(rules.referenceAction).toBe('strip');
  });
});
