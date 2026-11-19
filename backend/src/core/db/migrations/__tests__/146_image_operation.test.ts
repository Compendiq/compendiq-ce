import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDbAvailable, setupTestDb, teardownTestDb } from '../../../../test-db-helper.js';
import { getPool } from '../../postgres.js';
const available = await isDbAvailable();
describe.skipIf(!available)('durable image operation migration', () => {
  beforeAll(setupTestDb);
  afterAll(teardownTestDb);
  it('upgrades idempotently, retains retry identity and resets changed bytes', async () => {
    const sql = await readFile(new URL('../146_image_operation.sql', import.meta.url), 'utf8');
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP TRIGGER zz_image_ai_operation_reset ON page_image_analyses');
      await client.query('ALTER TABLE page_image_analyses DROP COLUMN ai_operation_id, DROP COLUMN ai_attempt');
      const pageId = (await client.query("INSERT INTO pages (title) VALUES ('image') RETURNING id")).rows[0].id;
      const id = (await client.query("INSERT INTO page_image_analyses (page_id,source,attachment_key,content_hash,format,status) VALUES ($1,'confluence','x.png','hash','png','pending') RETURNING id", [pageId])).rows[0].id;
      await client.query(sql);
      await client.query(sql);
      expect((await client.query('SELECT ai_operation_id,ai_attempt FROM page_image_analyses WHERE id=$1', [id])).rows).toEqual([{ ai_operation_id: null, ai_attempt: 0 }]);
      await client.query("UPDATE page_image_analyses SET ai_operation_id='00000000-0000-0000-0000-000000000001',ai_attempt=2,status='failed',error='unavailable:500',next_attempt_at=NOW() WHERE id=$1", [id]);
      await client.query("UPDATE page_image_analyses SET attempts=0,next_attempt_at=NOW() WHERE id=$1", [id]);
      expect((await client.query('SELECT ai_attempt FROM page_image_analyses WHERE id=$1', [id])).rows[0].ai_attempt).toBe(2);
      await client.query("UPDATE page_image_analyses SET content_hash='new-hash' WHERE id=$1", [id]);
      expect((await client.query('SELECT ai_operation_id,ai_attempt FROM page_image_analyses WHERE id=$1', [id])).rows).toEqual([{ ai_operation_id: null, ai_attempt: 0 }]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
