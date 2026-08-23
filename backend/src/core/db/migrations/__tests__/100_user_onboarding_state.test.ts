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
const migrationSql = await readFile(new URL('../100_user_onboarding_state.sql', import.meta.url), 'utf8');

describe.skipIf(!dbAvailable)('Migration 100 — user onboarding state (#1402)', () => {
  beforeAll(async () => setupTestDb());
  afterAll(async () => teardownTestDb());
  beforeEach(async () => {
    await truncateAllTables();
    // Re-run after truncation so this file tests the column + default too.
    await query(migrationSql);
  });

  async function createUser(): Promise<string> {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role)
       VALUES ('onboarding-test-user', 'h', 'user') RETURNING id`,
    );
    return rows[0]!.id;
  }

  it('defaults a freshly inserted row to an empty object', async () => {
    const userId = await createUser();
    await query(`INSERT INTO user_settings (user_id) VALUES ($1)`, [userId]);

    const { rows } = await query<{ onboarding_state: Record<string, unknown> }>(
      `SELECT onboarding_state FROM user_settings WHERE user_id = $1`,
      [userId],
    );
    expect(rows[0]!.onboarding_state).toEqual({});
  });

  it('merges two sequential single-key updates rather than overwriting (merge-not-overwrite)', async () => {
    // This is the test a naive full-overwrite implementation
    // (`onboarding_state = $1::jsonb`) would fail: the second UPDATE would wipe
    // out the key the first one set, leaving only { shortcutsModalViewed: true }.
    const userId = await createUser();
    await query(`INSERT INTO user_settings (user_id) VALUES ($1)`, [userId]);

    await query(
      `UPDATE user_settings SET onboarding_state = onboarding_state || $1::jsonb WHERE user_id = $2`,
      [JSON.stringify({ firstAiQueryMade: true }), userId],
    );
    await query(
      `UPDATE user_settings SET onboarding_state = onboarding_state || $1::jsonb WHERE user_id = $2`,
      [JSON.stringify({ shortcutsModalViewed: true }), userId],
    );

    const { rows } = await query<{ onboarding_state: Record<string, unknown> }>(
      `SELECT onboarding_state FROM user_settings WHERE user_id = $1`,
      [userId],
    );
    expect(rows[0]!.onboarding_state).toEqual({
      firstAiQueryMade: true,
      shortcutsModalViewed: true,
    });
  });
});
