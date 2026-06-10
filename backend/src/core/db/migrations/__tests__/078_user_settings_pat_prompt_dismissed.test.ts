import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('Migration 078 — user_settings.confluence_pat_prompt_dismissed_at (#771)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  it('adds a nullable TIMESTAMPTZ column', async () => {
    const cols = await query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name='user_settings' AND column_name='confluence_pat_prompt_dismissed_at'`,
    );
    expect(cols.rows).toHaveLength(1);
    expect(cols.rows[0]!.data_type).toBe('timestamp with time zone');
    expect(cols.rows[0]!.is_nullable).toBe('YES');
  });

  it('defaults to NULL for new rows (banner never dismissed)', async () => {
    const user = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role) VALUES ('mig078_user', 'h', 'user') RETURNING id`,
    );
    await query('INSERT INTO user_settings (user_id) VALUES ($1)', [user.rows[0]!.id]);

    const res = await query<{ confluence_pat_prompt_dismissed_at: Date | null }>(
      'SELECT confluence_pat_prompt_dismissed_at FROM user_settings WHERE user_id = $1',
      [user.rows[0]!.id],
    );
    expect(res.rows[0]!.confluence_pat_prompt_dismissed_at).toBeNull();
  });
});
