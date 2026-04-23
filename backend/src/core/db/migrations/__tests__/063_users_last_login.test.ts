import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('Migration 063 — users.last_login_at (#307 P0a)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  it('adds last_login_at column + partial index', async () => {
    const cols = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='users' AND column_name='last_login_at'`,
    );
    expect(cols.rows).toHaveLength(1);

    const idx = await query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename='users'
         AND indexname='idx_users_last_login_at'`,
    );
    expect(idx.rows).toHaveLength(1);
  });

  it('last_login_at is nullable and defaults to NULL', async () => {
    await query(
      `INSERT INTO users (username, password_hash, role) VALUES ('u1', 'h', 'user')`,
    );
    const res = await query<{ last_login_at: Date | null }>(
      `SELECT last_login_at FROM users WHERE username = 'u1'`,
    );
    expect(res.rows[0]!.last_login_at).toBeNull();
  });
});
