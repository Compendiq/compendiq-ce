import { describe, expect, it } from 'vitest';
import {
  BackupExportTicketRequestSchema,
  BackupExportTicketResponseSchema,
  UpdateBackupSettingsSchema,
  BackupStatusResponseSchema,
  BackupRunSchema,
  BackupObjectLockConfigSchema,
  BackupKmsConfigSchema,
  UpdateBackupKmsSchema,
} from './backup.js';

describe('BackupExportTicketRequestSchema', () => {
  it('accepts an omitted passphrase', () => {
    expect(BackupExportTicketRequestSchema.parse({})).toEqual({});
  });

  it('rejects short passphrases and unknown fields', () => {
    expect(() => BackupExportTicketRequestSchema.parse({ passphrase: 'short' })).toThrow();
    expect(() => BackupExportTicketRequestSchema.parse({ unexpected: true })).toThrow();
  });
});

describe('BackupExportTicketResponseSchema', () => {
  it('accepts only a same-origin download path with a lowercase 256-bit ticket', () => {
    expect(
      BackupExportTicketResponseSchema.parse({
        downloadUrl: `/api/backup/download/${'a'.repeat(64)}`,
      }),
    ).toEqual({ downloadUrl: `/api/backup/download/${'a'.repeat(64)}` });
    expect(() =>
      BackupExportTicketResponseSchema.parse({
        downloadUrl: `https://example.com/api/backup/download/${'a'.repeat(64)}`,
      }),
    ).toThrow();
    expect(() =>
      BackupExportTicketResponseSchema.parse({
        downloadUrl: `/api/backup/download/${'A'.repeat(64)}`,
      }),
    ).toThrow();
  });
});

describe('UpdateBackupSettingsSchema', () => {
  it('does not materialise omitted keys', () => {
    const parsed = UpdateBackupSettingsSchema.parse({ s3Enabled: true });
    expect(parsed).toEqual({ s3Enabled: true });
    expect('s3SecretKey' in parsed).toBe(false);
  });

  it('rejects an interval outside 1–168 hours', () => {
    expect(() => UpdateBackupSettingsSchema.parse({ intervalHours: 0 })).toThrow();
    expect(() => UpdateBackupSettingsSchema.parse({ intervalHours: 169 })).toThrow();
  });

  it('preserves optional enterprise policy patches and rejects invalid retention', () => {
    const patch = { objectLockEnabled: true, objectLockMode: 'GOVERNANCE', objectLockRetentionDays: 730, objectLockLegalHold: true };
    expect(UpdateBackupSettingsSchema.parse(patch)).toEqual(patch);
    expect(UpdateBackupSettingsSchema.safeParse({ objectLockRetentionDays: 0 }).success).toBe(false);
    expect(UpdateBackupSettingsSchema.safeParse({ objectLockRetentionDays: 3651 }).success).toBe(false);
    expect(UpdateBackupSettingsSchema.safeParse({ objectLockRetentionDays: 1.5 }).success).toBe(false);
    expect(UpdateBackupSettingsSchema.safeParse({ objectLockMode: 'unknown' }).success).toBe(false);
    expect(UpdateBackupSettingsSchema.safeParse({ objectLockEnabled: 'true' }).success).toBe(false);
  });
});

describe('BackupRunSchema', () => {
  const run = {
    id: 'run-1',
    createdAt: '2026-08-28T10:00:00.000Z',
    finishedAt: null,
    destination: 's3',
    status: 'running',
    bytes: null,
    objectKey: null,
    error: null,
    triggeredBy: 'admin-1',
  } as const;

  it('requires a nullable queue job ID', () => {
    expect(BackupRunSchema.parse({ ...run, jobId: 'backup-job-42' }).jobId).toBe(
      'backup-job-42',
    );
    expect(BackupRunSchema.parse({ ...run, jobId: null }).jobId).toBeNull();
    expect(() => BackupRunSchema.parse(run)).toThrow();
  });
});

describe('BackupStatusResponseSchema', () => {
  it('keeps legacy status fields compatible without inventing enterprise readiness', () => {
    const status = {
      hasMasterKey: false, lockHeld: false,
      s3: { enabled: false, endpoint: '', bucket: '', region: '', accessKey: '', secretKey: '', prefix: '', forcePathStyle: false, hasAccessKey: false, hasSecretKey: false },
      schedule: { enabled: false, intervalHours: 24, retentionCount: 7, retentionDays: 30, lastRunAt: null },
      history: [],
    };
    expect(BackupStatusResponseSchema.parse(status)).toEqual(status);
    const objectLock = { enabled: true, mode: 'COMPLIANCE', retentionDays: 3650, legalHold: false };
    expect(BackupStatusResponseSchema.parse({ ...status, kmsEnabled: true, objectLock })).toEqual({ ...status, kmsEnabled: true, objectLock });
    expect(BackupStatusResponseSchema.safeParse({ ...status, kmsEnabled: 'true' }).success).toBe(false);
    expect(BackupObjectLockConfigSchema.safeParse({ ...objectLock, retentionDays: -1 }).success).toBe(false);
  });
});

describe('Backup KMS contracts', () => {
  it('accepts partial provider changes without allowing credential writes', () => {
    expect(UpdateBackupKmsSchema.parse({ provider: 'vault', vaultAddr: 'https://vault.example.com' })).toEqual({ provider: 'vault', vaultAddr: 'https://vault.example.com' });
    expect(UpdateBackupKmsSchema.safeParse({ vaultToken: 'secret' }).success).toBe(false);
    expect(UpdateBackupKmsSchema.safeParse({ credentialsPresent: true }).success).toBe(false);
    expect(UpdateBackupKmsSchema.safeParse({ provider: 'unknown' }).success).toBe(false);
  });

  it('refuses incomplete provider responses instead of rendering a disabled policy', () => {
    expect(BackupKmsConfigSchema.safeParse({ provider: 'none' }).success).toBe(false);
    expect(BackupKmsConfigSchema.safeParse({ provider: 'none', keyId: '', awsRegion: '', vaultAddr: '', vaultNamespace: '', credentialsPresent: false }).success).toBe(true);
  });
});
