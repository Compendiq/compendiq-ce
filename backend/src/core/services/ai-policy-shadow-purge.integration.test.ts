import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { setupTestDb, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { getPool } from '../db/postgres.js';
import { purgeDerivedAiState } from './ai-policy-service.js';

const available = await isDbAvailable();
describe.skipIf(!available)('policy purge during a shadow migration', () => {
  beforeAll(setupTestDb);
  afterAll(teardownTestDb);

  it('clears live, candidate and rollback averages atomically without changing authored content', async () => {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE pages ADD COLUMN IF NOT EXISTS page_avg_embedding_next vector(1024)');
      await client.query('ALTER TABLE pages ADD COLUMN IF NOT EXISTS page_avg_embedding_prev vector(1024)');
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO pages (title, body_html, body_text, source)
         VALUES ('Authored title', '<p>Authored body</p>', 'Authored body', 'standalone') RETURNING id`,
      );
      const id = inserted.rows[0]!.id;
      const vector = `[${Array(1024).fill(0.1).join(',')}]`;
      await client.query(`UPDATE pages SET page_avg_embedding = $2::vector,
        page_avg_embedding_next = $2::vector, page_avg_embedding_prev = $2::vector WHERE id = $1`, [id, vector]);
      await client.query('SAVEPOINT before_purge');
      await purgeDerivedAiState(client, [id]);
      const after = await client.query(`SELECT title, body_html, body_text, page_avg_embedding,
        page_avg_embedding_next, page_avg_embedding_prev, embedding_status FROM pages WHERE id = $1`, [id]);
      expect(after.rows[0]).toEqual({ title: 'Authored title', body_html: '<p>Authored body</p>',
        body_text: 'Authored body', page_avg_embedding: null, page_avg_embedding_next: null,
        page_avg_embedding_prev: null, embedding_status: 'policy_blocked' });
      await client.query('ROLLBACK TO SAVEPOINT before_purge');
      const restored = await client.query(`SELECT page_avg_embedding IS NOT NULL AS live,
        page_avg_embedding_next IS NOT NULL AS candidate, page_avg_embedding_prev IS NOT NULL AS previous
        FROM pages WHERE id = $1`, [id]);
      expect(restored.rows[0]).toEqual({ live: true, candidate: true, previous: true });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
