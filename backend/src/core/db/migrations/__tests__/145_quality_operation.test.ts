import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDbAvailable, setupTestDb, teardownTestDb } from '../../../../test-db-helper.js';
import { getPool } from '../../postgres.js';

const available = await isDbAvailable();
describe.skipIf(!available)('durable quality operation migration', () => {
  beforeAll(setupTestDb);
  afterAll(teardownTestDb);
  it('upgrades idempotently and retains interrupted retries but resets new content', async () => {
    const sql = await readFile(new URL('../145_quality_operation.sql', import.meta.url), 'utf8');
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP TRIGGER zz_quality_ai_operation_reset ON pages');
      await client.query('ALTER TABLE pages DROP COLUMN quality_ai_operation_id, DROP COLUMN quality_ai_attempt');
      const id = (await client.query("INSERT INTO pages (title,body_text,quality_status) VALUES ('authored','body','failed') RETURNING id")).rows[0].id;
      await client.query(sql);
      await client.query(sql);
      expect((await client.query('SELECT quality_ai_operation_id,quality_ai_attempt,quality_status FROM pages WHERE id=$1', [id])).rows)
        .toEqual([{ quality_ai_operation_id: null, quality_ai_attempt: 0, quality_status: 'failed' }]);
      await client.query("UPDATE pages SET quality_ai_operation_id='00000000-0000-0000-0000-000000000001',quality_ai_attempt=1,quality_status='analyzing' WHERE id=$1", [id]);
      await client.query("UPDATE pages SET quality_status='pending' WHERE id=$1", [id]);
      expect((await client.query('SELECT quality_ai_attempt FROM pages WHERE id=$1', [id])).rows[0].quality_ai_attempt).toBe(1);
      await client.query("UPDATE pages SET body_text='new authored content' WHERE id=$1", [id]);
      expect((await client.query('SELECT quality_ai_operation_id,quality_ai_attempt FROM pages WHERE id=$1', [id])).rows)
        .toEqual([{ quality_ai_operation_id: null, quality_ai_attempt: 0 }]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
