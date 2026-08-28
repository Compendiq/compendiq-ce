import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BACKUP_SECRET_MASK } from '@compendiq/contracts';
import { encryptPat } from '../utils/crypto.js';

const rows: Array<{ setting_key: string; setting_value: string }> = [];

vi.mock('../db/postgres.js', () => ({
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('SELECT')) {
      return { rows: [...rows] };
    }
    if (sql.includes('INSERT')) {
      const key = String(params?.[0]);
      const value = String(params?.[1]);
      const existing = rows.find((r) => r.setting_key === key);
      if (existing) existing.setting_value = value;
      else rows.push({ setting_key: key, setting_value: value });
      return { rows: [] };
    }
    return { rows: [] };
  }),
}));

describe('backup-settings', () => {
  beforeEach(() => {
    rows.length = 0;
    process.env.PAT_ENCRYPTION_KEY = 'pat-key-at-least-32-characters!!!!';
    process.env.BACKUP_ENCRYPTION_KEY = 'backup-master-key-at-least-32-chars!!';
  });

  it('masks stored S3 secrets on the public config', async () => {
    rows.push({
      setting_key: 'backup_s3_secret_key',
      setting_value: encryptPat('super-secret'),
    });
    const { getBackupPublicConfig } = await import('./backup-settings.js');
    const cfg = await getBackupPublicConfig();
    expect(cfg.s3.secretKey).toBe(BACKUP_SECRET_MASK);
    expect(cfg.s3.hasSecretKey).toBe(true);
  });

  it('does not overwrite a secret when the mask is posted back', async () => {
    const { updateBackupSettings, getBackupRuntimeConfig } = await import('./backup-settings.js');
    await updateBackupSettings({ s3SecretKey: 'real-secret' });
    const before = await getBackupRuntimeConfig();
    await updateBackupSettings({ s3SecretKey: BACKUP_SECRET_MASK });
    const after = await getBackupRuntimeConfig();
    expect(after.s3.secretKey).toBe(before.s3.secretKey);
  });
});
