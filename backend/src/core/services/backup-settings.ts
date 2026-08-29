import type { PoolClient } from 'pg';
import { BACKUP_SECRET_MASK } from '@compendiq/contracts';
import type { BackupS3Config, BackupScheduleConfig, UpdateBackupSettingsInput } from '@compendiq/contracts';
import { getPool, query } from '../db/postgres.js';
import { encryptPat, decryptPat, isEncryptedSecretFormat } from '../utils/crypto.js';

export const BACKUP_SETTING_KEYS = {
  s3Enabled: 'backup_s3_enabled',
  s3Endpoint: 'backup_s3_endpoint',
  s3Bucket: 'backup_s3_bucket',
  s3Region: 'backup_s3_region',
  s3AccessKey: 'backup_s3_access_key',
  s3SecretKey: 'backup_s3_secret_key',
  s3Prefix: 'backup_s3_prefix',
  s3ForcePathStyle: 'backup_s3_force_path_style',
  scheduleEnabled: 'backup_schedule_enabled',
  intervalHours: 'backup_interval_hours',
  retentionCount: 'backup_retention_count',
  retentionDays: 'backup_retention_days',
  lastRunAt: 'backup_last_run_at',
} as const;

const DEFAULTS = {
  s3Enabled: false,
  s3Endpoint: '',
  s3Bucket: '',
  s3Region: 'us-east-1',
  s3Prefix: 'compendiq-backups/',
  s3ForcePathStyle: true,
  scheduleEnabled: false,
  intervalHours: 24,
  retentionCount: 7,
  retentionDays: 30,
} as const;

async function readSettings(): Promise<Record<string, string>> {
  const result = await query<{ setting_key: string; setting_value: string }>(
    `SELECT setting_key, setting_value FROM admin_settings WHERE setting_key LIKE 'backup_%'`,
  );
  const map: Record<string, string> = {};
  for (const row of result.rows) map[row.setting_key] = row.setting_value;
  return map;
}

const UPSERT_SQL = `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (setting_key) DO UPDATE
       SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`;

async function upsert(client: PoolClient, key: string, value: string): Promise<void> {
  await client.query(UPSERT_SQL, [key, value]);
}

function readSecret(stored: string | undefined): string {
  if (!stored) return '';
  if (!isEncryptedSecretFormat(stored)) return stored;
  try {
    return decryptPat(stored);
  } catch {
    return '';
  }
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

export interface BackupRuntimeConfig {
  s3: {
    enabled: boolean;
    endpoint: string;
    bucket: string;
    region: string;
    accessKey: string;
    secretKey: string;
    prefix: string;
    forcePathStyle: boolean;
  };
  schedule: {
    enabled: boolean;
    intervalHours: number;
    retentionCount: number;
    retentionDays: number;
    lastRunAt: string | null;
  };
}

export async function getBackupRuntimeConfig(): Promise<BackupRuntimeConfig> {
  const rows = await readSettings();
  return {
    s3: {
      enabled: bool(rows[BACKUP_SETTING_KEYS.s3Enabled], DEFAULTS.s3Enabled),
      endpoint: rows[BACKUP_SETTING_KEYS.s3Endpoint] ?? DEFAULTS.s3Endpoint,
      bucket: rows[BACKUP_SETTING_KEYS.s3Bucket] ?? DEFAULTS.s3Bucket,
      region: rows[BACKUP_SETTING_KEYS.s3Region] ?? DEFAULTS.s3Region,
      accessKey: readSecret(rows[BACKUP_SETTING_KEYS.s3AccessKey]),
      secretKey: readSecret(rows[BACKUP_SETTING_KEYS.s3SecretKey]),
      prefix: rows[BACKUP_SETTING_KEYS.s3Prefix] ?? DEFAULTS.s3Prefix,
      forcePathStyle: bool(rows[BACKUP_SETTING_KEYS.s3ForcePathStyle], DEFAULTS.s3ForcePathStyle),
    },
    schedule: {
      enabled: bool(rows[BACKUP_SETTING_KEYS.scheduleEnabled], DEFAULTS.scheduleEnabled),
      intervalHours: int(rows[BACKUP_SETTING_KEYS.intervalHours], DEFAULTS.intervalHours, 1, 168),
      retentionCount: int(rows[BACKUP_SETTING_KEYS.retentionCount], DEFAULTS.retentionCount, 1, 100),
      retentionDays: int(rows[BACKUP_SETTING_KEYS.retentionDays], DEFAULTS.retentionDays, 1, 365),
      lastRunAt: rows[BACKUP_SETTING_KEYS.lastRunAt] || null,
    },
  };
}

export async function getBackupPublicConfig(): Promise<{
  s3: BackupS3Config;
  schedule: BackupScheduleConfig;
}> {
  const cfg = await getBackupRuntimeConfig();
  return {
    s3: {
      enabled: cfg.s3.enabled,
      endpoint: cfg.s3.endpoint,
      bucket: cfg.s3.bucket,
      region: cfg.s3.region,
      accessKey: cfg.s3.accessKey ? BACKUP_SECRET_MASK : '',
      secretKey: cfg.s3.secretKey ? BACKUP_SECRET_MASK : '',
      prefix: cfg.s3.prefix,
      forcePathStyle: cfg.s3.forcePathStyle,
      hasAccessKey: cfg.s3.accessKey.length > 0,
      hasSecretKey: cfg.s3.secretKey.length > 0,
    },
    schedule: cfg.schedule,
  };
}

export async function updateBackupSettings(input: UpdateBackupSettingsInput): Promise<void> {
  const updates: Array<[key: string, value: string]> = [];

  if (input.s3Enabled !== undefined) {
    updates.push([BACKUP_SETTING_KEYS.s3Enabled, String(input.s3Enabled)]);
  }
  if (input.s3Endpoint !== undefined) {
    updates.push([BACKUP_SETTING_KEYS.s3Endpoint, input.s3Endpoint.trim()]);
  }
  if (input.s3Bucket !== undefined) {
    updates.push([BACKUP_SETTING_KEYS.s3Bucket, input.s3Bucket.trim()]);
  }
  if (input.s3Region !== undefined) {
    updates.push([BACKUP_SETTING_KEYS.s3Region, input.s3Region.trim()]);
  }
  if (input.s3Prefix !== undefined) {
    updates.push([BACKUP_SETTING_KEYS.s3Prefix, input.s3Prefix.trim()]);
  }
  if (input.s3ForcePathStyle !== undefined) {
    updates.push([BACKUP_SETTING_KEYS.s3ForcePathStyle, String(input.s3ForcePathStyle)]);
  }
  if (input.s3AccessKey !== undefined && input.s3AccessKey !== BACKUP_SECRET_MASK) {
    updates.push([
      BACKUP_SETTING_KEYS.s3AccessKey,
      input.s3AccessKey === '' ? '' : encryptPat(input.s3AccessKey),
    ]);
  }
  if (input.s3SecretKey !== undefined && input.s3SecretKey !== BACKUP_SECRET_MASK) {
    updates.push([
      BACKUP_SETTING_KEYS.s3SecretKey,
      input.s3SecretKey === '' ? '' : encryptPat(input.s3SecretKey),
    ]);
  }
  if (input.scheduleEnabled !== undefined) {
    updates.push([BACKUP_SETTING_KEYS.scheduleEnabled, String(input.scheduleEnabled)]);
  }
  if (input.intervalHours !== undefined) {
    updates.push([BACKUP_SETTING_KEYS.intervalHours, String(input.intervalHours)]);
  }
  if (input.retentionCount !== undefined) {
    updates.push([BACKUP_SETTING_KEYS.retentionCount, String(input.retentionCount)]);
  }
  if (input.retentionDays !== undefined) {
    updates.push([BACKUP_SETTING_KEYS.retentionDays, String(input.retentionDays)]);
  }

  if (updates.length === 0) return;

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    for (const [key, value] of updates) {
      await upsert(client, key, value);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function markBackupLastRun(iso: string): Promise<void> {
  await query(UPSERT_SQL, [BACKUP_SETTING_KEYS.lastRunAt, iso]);
}

export function hasMasterBackupKey(): boolean {
  const key = process.env.BACKUP_ENCRYPTION_KEY ?? '';
  return Buffer.byteLength(key, 'utf8') >= 32;
}

export function requireMasterBackupKey(): string {
  const key = process.env.BACKUP_ENCRYPTION_KEY ?? '';
  if (Buffer.byteLength(key, 'utf8') < 32) {
    throw new Error('BACKUP_ENCRYPTION_KEY is missing or shorter than 32 bytes');
  }
  return key;
}
