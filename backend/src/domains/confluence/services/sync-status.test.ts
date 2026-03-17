import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  processDirtyPages: vi.fn().mockResolvedValue({ processed: 0, errors: 0 }),
}));

vi.mock('../../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mocks.query(...args),
}));

vi.mock('../../llm/services/embedding-service.js', () => ({
  processDirtyPages: mocks.processDirtyPages,
}));

vi.mock('./confluence-client.js', () => ({
  ConfluenceClient: class MockConfluenceClient {},
}));

vi.mock('../../../core/services/content-converter.js', () => ({
  confluenceToHtml: vi.fn().mockReturnValue('<p>html</p>'),
  htmlToText: vi.fn().mockReturnValue('plain text'),
}));

vi.mock('./attachment-handler.js', () => ({
  syncDrawioAttachments: vi.fn().mockResolvedValue(undefined),
  syncImageAttachments: vi.fn().mockResolvedValue(undefined),
  cleanPageAttachments: vi.fn().mockResolvedValue(undefined),
  getMissingAttachments: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../core/services/version-snapshot.js', () => ({
  saveVersionSnapshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../core/utils/crypto.js', () => ({
  decryptPat: vi.fn().mockReturnValue('decrypted-pat'),
}));

vi.mock('../../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: vi.fn().mockResolvedValue([]),
}));

import { getSyncStatus, setSyncStatus } from './sync-service.js';

describe('getSyncStatus DB fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear the in-memory map by setting a known state then removing it
    // We use setSyncStatus to seed, then verify fallback by testing a different userId
  });

  it('returns in-memory status when available (no DB query)', async () => {
    const now = new Date();
    setSyncStatus('user-mem', { userId: 'user-mem', status: 'idle', lastSynced: now });

    const status = await getSyncStatus('user-mem');

    expect(status.status).toBe('idle');
    expect(status.lastSynced).toBe(now);
    // query should NOT have been called for this user since in-memory cache exists
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('falls back to DB when in-memory map has no entry for the user', async () => {
    const dbDate = new Date('2025-06-15T10:30:00Z');
    mocks.query.mockResolvedValueOnce({
      rows: [{ last_synced: dbDate }],
    });

    // Use a userId that was never set in-memory
    const status = await getSyncStatus('user-db-fallback');

    expect(status.status).toBe('idle');
    expect(status.lastSynced).toEqual(dbDate);
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('MAX(s.last_synced)'),
      ['user-db-fallback'],
    );
  });

  it('returns no lastSynced when DB has no spaces for the user', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ last_synced: null }],
    });

    const status = await getSyncStatus('user-no-spaces');

    expect(status.status).toBe('idle');
    expect(status.lastSynced).toBeUndefined();
  });

  it('caches DB result so subsequent calls skip the query', async () => {
    const dbDate = new Date('2025-06-15T10:30:00Z');
    mocks.query.mockResolvedValueOnce({
      rows: [{ last_synced: dbDate }],
    });

    // First call — hits DB
    await getSyncStatus('user-cache-test');
    expect(mocks.query).toHaveBeenCalledOnce();

    // Second call — should use in-memory cache, no additional DB query
    mocks.query.mockClear();
    const status = await getSyncStatus('user-cache-test');

    expect(status.lastSynced).toEqual(dbDate);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('returns DB fallback with empty rows array', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });

    const status = await getSyncStatus('user-empty-rows');

    expect(status.status).toBe('idle');
    expect(status.lastSynced).toBeUndefined();
  });
});
