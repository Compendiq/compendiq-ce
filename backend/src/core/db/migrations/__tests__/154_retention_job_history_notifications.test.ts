import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();
const sql = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '154_retention_job_history_notifications.sql'),
  'utf8',
);

async function settingValues(): Promise<Record<string, string>> {
  const r = await query<{ setting_key: string; setting_value: string }>(
    `SELECT setting_key, setting_value FROM admin_settings
      WHERE setting_key IN ('job_history_retention_days', 'notifications_read_retention_days')`,
  );
  return Object.fromEntries(r.rows.map((row) => [row.setting_key, row.setting_value]));
}

describe.skipIf(!dbAvailable)('Migration 154 — job_history / read-notification retention (#1760)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  it('seeds both windows at 90 days', async () => {
    await query(sql);
    expect(await settingValues()).toEqual({
      job_history_retention_days: '90',
      notifications_read_retention_days: '90',
    });
  });

  it('is idempotent and never overwrites an administrator-chosen value', async () => {
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value)
       VALUES ('job_history_retention_days', '30')`,
    );
    await query(sql);
    await query(sql);
    expect(await settingValues()).toEqual({
      job_history_retention_days: '30',
      notifications_read_retention_days: '90',
    });
  });
});
