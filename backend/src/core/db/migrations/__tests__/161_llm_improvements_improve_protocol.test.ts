import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool, query } from '../../postgres.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../../test-db-helper.js';

const dbAvailable = await isDbAvailable();

/**
 * #1958 (D26): `llm_improvements.improve_protocol` records the converter
 * protocol of a stored Improve suggestion. Rows of the earlier release keep
 * NULL, which the Apply route reads as "generated before #1958".
 */
describe.skipIf(!dbAvailable)('migration 161 llm_improvements.improve_protocol and improve_code_nonce (#1958)', () => {
  beforeAll(async () => { await setupTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });
  afterAll(async () => { await teardownTestDb(); });

  it('is recorded on a freshly migrated database with two nullable columns without a default', async () => {
    const applied = await query<{ name: string }>(
      "SELECT name FROM _migrations WHERE name = '161_llm_improvements_improve_protocol.sql'",
    );
    expect(applied.rows).toHaveLength(1);
    const columns = await query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'llm_improvements' AND column_name IN ('improve_protocol', 'improve_code_nonce')
        ORDER BY column_name`,
    );
    expect(columns.rows).toEqual([
      { column_name: 'improve_code_nonce', data_type: 'text', is_nullable: 'YES', column_default: null },
      { column_name: 'improve_protocol', data_type: 'integer', is_nullable: 'YES', column_default: null },
    ]);
  });

  it('applies on a database at 160 and leaves every existing suggestion without a protocol', async () => {
    const user = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role) VALUES ('m161', 'x', 'user') RETURNING id`,
    );
    const page = await query<{ id: number }>(
      `INSERT INTO pages (title, body_html, body_text, source, visibility)
       VALUES ('Marker', '<p>seed</p>', 'seed', 'standalone', 'shared') RETURNING id`,
    );
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      // The state of a database migrated at the previous level.
      await client.query('ALTER TABLE llm_improvements DROP COLUMN improve_protocol, DROP COLUMN improve_code_nonce');
      await client.query(
        `INSERT INTO llm_improvements (user_id, page_id, improvement_type, model, original_content, improved_content, status)
         VALUES ($1, $2, 'clarity', 'm', 'old', 'suggestion', 'completed')`,
        [user.rows[0]!.id, page.rows[0]!.id],
      );

      const migration = await readFile(new URL('../161_llm_improvements_improve_protocol.sql', import.meta.url), 'utf8');
      await client.query(migration);
      // Forward-only and idempotent: a second run changes nothing.
      await client.query(migration);

      const rows = await client.query<{ improved_content: string; improve_protocol: number | null; improve_code_nonce: string | null }>(
        'SELECT improved_content, improve_protocol, improve_code_nonce FROM llm_improvements',
      );
      expect(rows.rows).toEqual([{ improved_content: 'suggestion', improve_protocol: null, improve_code_nonce: null }]);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
