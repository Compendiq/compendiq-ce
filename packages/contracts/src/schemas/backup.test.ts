import { describe, expect, it } from 'vitest';
import {
  BackupExportRequestSchema,
  UpdateBackupSettingsSchema,
  BackupStatusResponseSchema,
} from './backup.js';

describe('BackupExportRequestSchema', () => {
  it('accepts an omitted passphrase', () => {
    expect(BackupExportRequestSchema.parse({})).toEqual({});
  });

  it('rejects a short passphrase', () => {
    expect(() => BackupExportRequestSchema.parse({ passphrase: 'short' })).toThrow();
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

describe('BackupStatusResponseSchema', () => {
  it('requires hasMasterKey and history', () => {
    expect(() => BackupStatusResponseSchema.parse({})).toThrow();
  });
});
