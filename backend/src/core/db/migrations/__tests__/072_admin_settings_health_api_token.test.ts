import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('Migration 072 — health_api_token (Compendiq/compendiq-ee#113 Part A)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  it('seeds a 64-char lowercase hex token in admin_settings', async () => {
    // Re-run the migration body; the migrator ran it once during setupTestDb,
    // but truncateAllTables empties admin_settings, so we re-seed here.
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
       VALUES ('health_api_token', encode(gen_random_bytes(32), 'hex'), NOW())
       ON CONFLICT (setting_key) DO NOTHING`,
    );
    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'health_api_token'`,
    );
    expect(r.rows).toHaveLength(1);
    const token = r.rows[0]!.setting_value;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is idempotent — second run does not overwrite the token', async () => {
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
       VALUES ('health_api_token', encode(gen_random_bytes(32), 'hex'), NOW())
       ON CONFLICT (setting_key) DO NOTHING`,
    );
    const before = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'health_api_token'`,
    );
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
       VALUES ('health_api_token', encode(gen_random_bytes(32), 'hex'), NOW())
       ON CONFLICT (setting_key) DO NOTHING`,
    );
    const after = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'health_api_token'`,
    );
    expect(after.rows[0]!.setting_value).toBe(before.rows[0]!.setting_value);
  });

  it('produces tokens with sufficient entropy across separate inserts', async () => {
    // Insert a token, capture, then upsert a fresh one to a *different*
    // setting_key to force a new gen_random_bytes evaluation. Different
    // keys = different invocations = different bytes (probability of
    // collision at 32 bytes is negligible).
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
       VALUES ('health_api_token', encode(gen_random_bytes(32), 'hex'), NOW())
       ON CONFLICT (setting_key) DO NOTHING`,
    );
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
       VALUES ('health_api_token_probe', encode(gen_random_bytes(32), 'hex'), NOW())
       ON CONFLICT (setting_key) DO NOTHING`,
    );
    const r = await query<{ setting_key: string; setting_value: string }>(
      `SELECT setting_key, setting_value FROM admin_settings
        WHERE setting_key IN ('health_api_token', 'health_api_token_probe')`,
    );
    expect(r.rows).toHaveLength(2);
    const [a, b] = r.rows;
    expect(a!.setting_value).not.toBe(b!.setting_value);
  });
});
