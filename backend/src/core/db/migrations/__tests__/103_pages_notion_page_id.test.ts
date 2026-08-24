import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('Migration 103 — pages.notion_page_id (#1465)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  it('adds a nullable TEXT column so source can stay standalone', async () => {
    const cols = await query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name='pages' AND column_name='notion_page_id'`,
    );
    expect(cols.rows).toHaveLength(1);
    expect(cols.rows[0]!.data_type).toBe('text');
    expect(cols.rows[0]!.is_nullable).toBe('YES');

    const check = await query<{ consrc: string | null }>(
      `SELECT pg_get_constraintdef(oid) AS consrc FROM pg_constraint
        WHERE conrelid = 'pages'::regclass AND conname = 'pages_source_check'`,
    );
    expect(check.rows[0]?.consrc ?? '').toMatch(/standalone/);
    expect(check.rows[0]?.consrc ?? '').not.toMatch(/notion/);
  });

  it('rejects a second live import of the same Notion page by the same owner', async () => {
    const user = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role) VALUES ('mig103_user', 'h', 'user') RETURNING id`,
    );
    const userId = user.rows[0]!.id;
    await query(
      `INSERT INTO pages (title, body_html, body_text, version, source, created_by_user_id, notion_page_id)
       VALUES ('Handbook', '', '', 1, 'standalone', $1, 'page-1')`,
      [userId],
    );
    await expect(
      query(
        `INSERT INTO pages (title, body_html, body_text, version, source, created_by_user_id, notion_page_id)
         VALUES ('Handbook copy', '', '', 1, 'standalone', $1, 'page-1')`,
        [userId],
      ),
    ).rejects.toThrow();
  });
});
