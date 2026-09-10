import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKUP_SECRET_MASK } from '@compendiq/contracts';
import { encryptPat } from '../utils/crypto.js';
import {
  getBackupPublicConfig,
  getBackupRuntimeConfig,
  updateBackupSettings,
} from './backup-settings.js';

const rows: Array<{ setting_key: string; setting_value: string }> = [];
const db = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn(),
  connect: vi.fn(),
  release: vi.fn(),
}));

async function runSql(sql: string, params?: unknown[]): Promise<{ rows: typeof rows }> {
  if (sql.includes('SELECT')) {
    return { rows: [...rows] };
  }
  if (sql.includes('INSERT')) {
    const key = String(params?.[0]);
    const value = String(params?.[1]);
    const existing = rows.find((row) => row.setting_key === key);
    if (existing) existing.setting_value = value;
    else rows.push({ setting_key: key, setting_value: value });
  }
  return { rows: [] };
}

vi.mock('../db/postgres.js', () => ({
  query: db.query,
  getPool: () => ({ connect: db.connect }),
}));

describe('backup-settings', () => {
  beforeEach(() => {
    rows.length = 0;
    db.query.mockReset();
    db.query.mockImplementation(runSql);
    db.clientQuery.mockReset();
    db.clientQuery.mockImplementation(runSql);
    db.connect.mockReset();
    db.connect.mockResolvedValue({ query: db.clientQuery, release: db.release });
    db.release.mockReset();
    process.env.PAT_ENCRYPTION_KEY = 'pat-key-at-least-32-characters!!!!';
    process.env.BACKUP_ENCRYPTION_KEY = 'backup-master-key-at-least-32-chars!!';
  });

  it('masks stored S3 secrets on the public config', async () => {
    rows.push({
      setting_key: 'backup_s3_secret_key',
      setting_value: encryptPat('super-secret'),
    });
    const cfg = await getBackupPublicConfig();
    expect(cfg.s3.secretKey).toBe(BACKUP_SECRET_MASK);
    expect(cfg.s3.hasSecretKey).toBe(true);
  });

  it('does not overwrite a secret when the mask is posted back', async () => {
    await updateBackupSettings({ s3SecretKey: 'real-secret' });
    const before = await getBackupRuntimeConfig();
    await updateBackupSettings({ s3SecretKey: BACKUP_SECRET_MASK });
    const after = await getBackupRuntimeConfig();
    expect(after.s3.secretKey).toBe(before.s3.secretKey);
  });

  it('rolls back every provided setting when the third upsert fails', async () => {
    let upsertCount = 0;
    db.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT')) {
        upsertCount += 1;
        if (upsertCount === 3) throw new Error('third upsert failed');
      }
      return { rows: [] };
    });

    await expect(
      updateBackupSettings({
        s3Endpoint: 'https://backup.example.test',
        s3Bucket: 'backups',
        s3Region: 'us-west-2',
      }),
    ).rejects.toThrow('third upsert failed');

    expect(db.connect).toHaveBeenCalledOnce();
    expect(db.clientQuery.mock.calls[0]?.[0]).toBe('BEGIN');
    expect(db.clientQuery.mock.calls.filter(([sql]) => String(sql).includes('INSERT'))).toHaveLength(3);
    expect(db.clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(db.clientQuery).not.toHaveBeenCalledWith('COMMIT');
    expect(db.release).toHaveBeenCalledOnce();
  });
});
