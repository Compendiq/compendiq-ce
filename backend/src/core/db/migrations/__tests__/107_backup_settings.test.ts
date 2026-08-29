import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();
const sql = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '107_backup_settings.sql'),
  'utf8',
);

describe.skipIf(!dbAvailable)('Migration 107 — backup settings (#1420)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  it('seeds backup keys idempotently and creates backup_runs', async () => {
    await query(sql);
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
       VALUES ('backup_interval_hours', '12', NOW())
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = '12'`,
    );
    await query(sql);
    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'backup_interval_hours'`,
    );
    expect(r.rows[0]!.setting_value).toBe('12');
    const table = await query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables WHERE table_name = 'backup_runs'
       ) AS exists`,
    );
    expect(table.rows[0]!.exists).toBe(true);
  });
});
