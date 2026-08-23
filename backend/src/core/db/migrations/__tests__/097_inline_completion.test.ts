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
const migrationSql = await readFile(new URL('../097_inline_completion.sql', import.meta.url), 'utf8');

describe.skipIf(!dbAvailable)('Migration 097 — inline completion (#1417)', () => {
  beforeAll(async () => setupTestDb());
  afterAll(async () => teardownTestDb());
  beforeEach(async () => {
    await truncateAllTables();
    // Re-run after truncation so this file tests the seed as well as the DDL.
    await query(migrationSql);
  });

  it('admits inline_completion and rejects unknown use cases', async () => {
    await expect(query(
      `INSERT INTO llm_usecase_assignments (usecase, provider_id, model)
       VALUES ('inline_completion', NULL, NULL)
       ON CONFLICT (usecase) DO NOTHING`,
    )).resolves.toBeDefined();
    await expect(
      query(`INSERT INTO llm_usecase_assignments (usecase) VALUES ('completion_but_wrong')`),
    ).rejects.toThrow();
  });

  it('seeds an explicitly unassigned use-case row', async () => {
    const { rows } = await query<{ provider_id: string | null; model: string | null }>(
      `SELECT provider_id, model FROM llm_usecase_assignments
       WHERE usecase = 'inline_completion'`,
    );
    expect(rows).toEqual([{ provider_id: null, model: null }]);
  });

  it('adds safe personal defaults and constrains the delay choice', async () => {
    const { rows: users } = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role)
       VALUES ('inline-pref-user', 'h', 'user') RETURNING id`,
    );
    await query(`INSERT INTO user_settings (user_id) VALUES ($1)`, [users[0]!.id]);
    const { rows } = await query<{
      inline_completion_enabled: boolean;
      inline_completion_delay: string;
      inline_completion_code_only: boolean;
    }>(
      `SELECT inline_completion_enabled, inline_completion_delay,
              inline_completion_code_only
         FROM user_settings WHERE user_id = $1`,
      [users[0]!.id],
    );
    expect(rows[0]).toEqual({
      inline_completion_enabled: true,
      inline_completion_delay: 'balanced',
      inline_completion_code_only: false,
    });
    await expect(query(
      `UPDATE user_settings SET inline_completion_delay = 'instant' WHERE user_id = $1`,
      [users[0]!.id],
    )).rejects.toThrow();
  });
});
