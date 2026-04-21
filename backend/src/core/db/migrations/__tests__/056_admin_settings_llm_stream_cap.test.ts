import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationSql = fs.readFileSync(
  path.join(__dirname, '..', '056_admin_settings_llm_stream_cap.sql'),
  'utf8',
);

/** Wraps the INSERT-in-text in an ad-hoc transaction so we can run it twice in
 * the same test and prove idempotency without going through the migration
 * registry (which tracks which migrations ran). */
async function runMigrationInline(): Promise<void> {
  await query(migrationSql);
}

describe.skipIf(!dbAvailable)('Migration 056 — admin-configurable SSE stream cap (#268)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  it('seeds the llm_max_concurrent_streams_per_user row with value 3 (fresh insert)', async () => {
    // After truncateAllTables() the row is gone; re-running the migration
    // re-seeds the default.
    await runMigrationInline();

    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings
       WHERE setting_key = 'llm_max_concurrent_streams_per_user'`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.setting_value).toBe('3');
  });

  it('is idempotent — does not overwrite an existing user-configured value', async () => {
    // Simulate a user who has already configured a custom cap.
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value) VALUES ($1, $2)
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`,
      ['llm_max_concurrent_streams_per_user', '12'],
    );

    // Re-run the migration. `ON CONFLICT DO NOTHING` must preserve the user value.
    await runMigrationInline();

    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings
       WHERE setting_key = 'llm_max_concurrent_streams_per_user'`,
    );
    expect(r.rows[0]!.setting_value).toBe('12');
  });

  it('is safe to re-run multiple times without side effects', async () => {
    await runMigrationInline();
    await runMigrationInline();
    await runMigrationInline();

    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings
       WHERE setting_key = 'llm_max_concurrent_streams_per_user'`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.setting_value).toBe('3');
  });
});
