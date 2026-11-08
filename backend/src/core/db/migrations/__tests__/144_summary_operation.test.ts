import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDbAvailable, setupTestDb, teardownTestDb } from '../../../../test-db-helper.js';
import { getPool } from '../../postgres.js';

const available = await isDbAvailable();
describe.skipIf(!available)('durable summary operation migration', () => {
  beforeAll(setupTestDb);
  afterAll(teardownTestDb);
  it('upgrades existing work, reapplies, retains retries and resets a new generation', async () => {
    const sql = await readFile(new URL('../144_summary_operation.sql', import.meta.url), 'utf8');
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP TRIGGER zz_summary_ai_operation_reset ON pages');
      await client.query('ALTER TABLE pages DROP COLUMN summary_ai_operation_id, DROP COLUMN summary_ai_attempt');
      const id = (await client.query("INSERT INTO pages (title,body_text,summary_status) VALUES ('authored','body','failed') RETURNING id")).rows[0].id;
      await client.query(sql);
      await client.query(sql);
      expect((await client.query('SELECT summary_ai_operation_id,summary_ai_attempt,summary_status FROM pages WHERE id=$1', [id])).rows)
        .toEqual([{ summary_ai_operation_id: null, summary_ai_attempt: 0, summary_status: 'failed' }]);
      await client.query("UPDATE pages SET summary_ai_operation_id='00000000-0000-0000-0000-000000000001',summary_ai_attempt=1,summary_status='summarizing' WHERE id=$1", [id]);
      await client.query("UPDATE pages SET summary_status='pending' WHERE id=$1", [id]);
      expect((await client.query('SELECT summary_ai_attempt FROM pages WHERE id=$1', [id])).rows[0].summary_ai_attempt).toBe(1);
      await client.query("UPDATE pages SET summary_status='summarized' WHERE id=$1", [id]);
      await client.query("UPDATE pages SET summary_status='pending' WHERE id=$1", [id]);
      expect((await client.query('SELECT summary_ai_operation_id,summary_ai_attempt,body_text FROM pages WHERE id=$1', [id])).rows)
        .toEqual([{ summary_ai_operation_id: null, summary_ai_attempt: 0, body_text: 'body' }]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
