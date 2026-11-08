import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDbAvailable, setupTestDb, teardownTestDb } from '../../../../test-db-helper.js';
import { getPool } from '../../postgres.js';

const available = await isDbAvailable();
describe.skipIf(!available)('canonical label repair migration', () => {
  beforeAll(setupTestDb);
  afterAll(teardownTestDb);
  it('creates and reapplies without inventing remote observation or completion', async () => {
    const sql = await readFile(new URL('../143_label_canonical_repairs.sql', import.meta.url), 'utf8');
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP TABLE page_label_canonical_repairs');
      await client.query(sql);
      await client.query(sql);
      const columns = await client.query(`SELECT column_name, column_default FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'page_label_canonical_repairs'`);
      for (const name of ['observed_at', 'completed_at']) {
        expect(columns.rows.find((row) => row.column_name === name).column_default).toBeNull();
      }
      await expect(client.query(`INSERT INTO page_label_canonical_repairs (intent_id, plan, next_step)
        VALUES ('00000000-0000-0000-0000-000000000000', '{}', -1)`)).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
