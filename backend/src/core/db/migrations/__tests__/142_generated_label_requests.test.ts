import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDbAvailable, setupTestDb, teardownTestDb } from '../../../../test-db-helper.js';
import { getPool } from '../../postgres.js';

const available = await isDbAvailable();
describe.skipIf(!available)('generated label request journal migration', () => {
  beforeAll(setupTestDb);
  afterAll(teardownTestDb);
  it('creates and reapplies the ordered request journal without inventing acknowledgments', async () => {
    const sql = await readFile(new URL('../142_generated_label_requests.sql', import.meta.url), 'utf8');
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP TABLE page_generated_label_requests');
      await client.query(sql);
      await client.query(sql);
      const columns = await client.query(`SELECT column_name, column_default FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'page_generated_label_requests'`);
      expect(columns.rows.map((row) => row.column_name)).toEqual(expect.arrayContaining([
        'intent_id', 'request_index', 'runtime_id', 'actor_id', 'original_revisions', 'original_effect', 'request', 'started_at', 'acknowledged_at',
      ]));
      expect(columns.rows.find((row) => row.column_name === 'acknowledged_at').column_default).toBeNull();
      await expect(client.query(`INSERT INTO page_generated_label_requests
        (intent_id, request_index, runtime_id, actor_id, original_revisions, original_effect, request)
        VALUES ('00000000-0000-0000-0000-000000000000', -1, 'invalid', '00000000-0000-0000-0000-000000000000', '{}', '{}', '{}')`))
        .rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
