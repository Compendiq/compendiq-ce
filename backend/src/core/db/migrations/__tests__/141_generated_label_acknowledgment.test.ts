import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../../test-db-helper.js';
import { getPool } from '../../postgres.js';

const available = await isDbAvailable();
describe.skipIf(!available)('generated label acknowledgment migration', () => {
  beforeAll(async () => { await setupTestDb(); await truncateAllTables(); });
  afterAll(teardownTestDb);
  it('creates an idempotent separate supersession journal with object constraints', async () => {
    const sql = await readFile(new URL('../141_generated_label_acknowledgment.sql', import.meta.url), 'utf8');
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(sql);
      const columns = await client.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'page_generated_label_supersessions'`);
      expect(columns.rows.map((row) => row.column_name)).toEqual(expect.arrayContaining([
        'intent_id', 'runtime_id', 'original_revisions', 'original_effect', 'effect_started_at', 'superseded_at',
      ]));
      await expect(client.query(`INSERT INTO page_generated_label_supersessions
        (intent_id, runtime_id, original_revisions, original_effect, effect_started_at)
        VALUES ('00000000-0000-0000-0000-000000000000', 'invalid', '[]', '{}', NOW())`))
        .rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
