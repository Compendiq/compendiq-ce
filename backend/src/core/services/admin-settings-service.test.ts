import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../db/postgres.js', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
}));

import { getAdminAccessDeniedRetentionDays } from './admin-settings-service.js';

describe('getAdminAccessDeniedRetentionDays (#264)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    delete process.env.RETENTION_ADMIN_ACCESS_DENIED_DAYS;
  });

  afterEach(() => {
    delete process.env.RETENTION_ADMIN_ACCESS_DENIED_DAYS;
  });

  it('returns the persisted admin_settings value when in range', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ setting_value: '30' }] });
    await expect(getAdminAccessDeniedRetentionDays()).resolves.toBe(30);
  });

  it('honours the env fallback when the admin_settings row is absent', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    process.env.RETENTION_ADMIN_ACCESS_DENIED_DAYS = '45';
    await expect(getAdminAccessDeniedRetentionDays()).resolves.toBe(45);
  });

  it('returns the hard default of 90 when both the DB row and the env var are missing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(getAdminAccessDeniedRetentionDays()).resolves.toBe(90);
  });

  it('rejects an out-of-range DB value (1) and falls back to env / default', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ setting_value: '1' }] });
    await expect(getAdminAccessDeniedRetentionDays()).resolves.toBe(90);
  });

  it('rejects an out-of-range DB value (4000) and falls back to env / default', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ setting_value: '4000' }] });
    await expect(getAdminAccessDeniedRetentionDays()).resolves.toBe(90);
  });

  it('rejects a non-numeric DB value and falls back', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ setting_value: 'banana' }] });
    await expect(getAdminAccessDeniedRetentionDays()).resolves.toBe(90);
  });

  it('never throws when the DB query rejects — swallows and falls back', async () => {
    mockQuery.mockRejectedValueOnce(new Error('pool exhausted'));
    await expect(getAdminAccessDeniedRetentionDays()).resolves.toBe(90);
  });

  it('rejects an out-of-range env override and falls through to the hard default', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    process.env.RETENTION_ADMIN_ACCESS_DENIED_DAYS = '6'; // below min
    await expect(getAdminAccessDeniedRetentionDays()).resolves.toBe(90);
  });

  it('accepts boundary values — 7 and 3650', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ setting_value: '7' }] });
    await expect(getAdminAccessDeniedRetentionDays()).resolves.toBe(7);

    mockQuery.mockResolvedValueOnce({ rows: [{ setting_value: '3650' }] });
    await expect(getAdminAccessDeniedRetentionDays()).resolves.toBe(3650);
  });
});
