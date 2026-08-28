import { describe, expect, it } from 'vitest';
import {
  BackupExportTicketRequestSchema,
  BackupExportTicketResponseSchema,
  UpdateBackupSettingsSchema,
  BackupStatusResponseSchema,
  BackupRunSchema,
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
  it('requires hasMasterKey and history', () => {
    expect(() => BackupStatusResponseSchema.parse({})).toThrow();
  });
});
