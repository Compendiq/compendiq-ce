import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();
const migrationSql = await readFile(new URL('../099_inline_completion_mode.sql', import.meta.url), 'utf8');

describe.skipIf(!dbAvailable)('Migration 099 — inline completion mode', () => {
  beforeAll(async () => setupTestDb());
  afterAll(async () => teardownTestDb());
  beforeEach(async () => {
    await truncateAllTables();
    await query(migrationSql);
  });

  it('adds a safe full-suggestion default and constrains the mode', async () => {
    const { rows: users } = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role)
       VALUES ('completion-mode-user', 'h', 'user') RETURNING id`,
    );
    await query(`INSERT INTO user_settings (user_id) VALUES ($1)`, [users[0]!.id]);

    const { rows } = await query<{ inline_completion_mode: string }>(
      `SELECT inline_completion_mode FROM user_settings WHERE user_id = $1`,
      [users[0]!.id],
    );
    expect(rows[0]?.inline_completion_mode).toBe('full');
    await expect(query(
      `UPDATE user_settings SET inline_completion_mode = 'paragraph' WHERE user_id = $1`,
      [users[0]!.id],
    )).rejects.toThrow();
  });
});
