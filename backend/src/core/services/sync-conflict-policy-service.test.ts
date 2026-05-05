/**
 * Unit tests for sync-conflict-policy-service (Compendiq/compendiq-ee#118).
 *
 * Verifies:
 *   - cold-load reads admin_settings.sync_conflict_policy and exposes it
 *     via the sync getter
 *   - invalid persisted values fall back to the default (defensive parse —
 *     a typo in admin_settings should not flip a sync run into manual-
 *     review mode silently)
 *   - the getter returns the default when the service hasn't been
 *     initialised yet (startup-order safety)
 *   - re-init replaces the previous getter
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../db/postgres.js', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
}));

vi.mock('./redis-cache-bus.js', () => ({
  subscribe: vi.fn(),
  onReconnect: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  initSyncConflictPolicyService,
  getSyncConflictPolicy,
  DEFAULT_SYNC_CONFLICT_POLICY,
  _resetForTests,
} from './sync-conflict-policy-service.js';

describe('sync-conflict-policy-service', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    _resetForTests();
  });

  it('returns DEFAULT_SYNC_CONFLICT_POLICY when uninitialised', () => {
    expect(getSyncConflictPolicy()).toBe(DEFAULT_SYNC_CONFLICT_POLICY);
    expect(DEFAULT_SYNC_CONFLICT_POLICY).toBe('confluence-wins');
  });

  it('cold-loads "confluence-wins" from admin_settings', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ setting_value: 'confluence-wins' }],
    });
    await initSyncConflictPolicyService();
    expect(getSyncConflictPolicy()).toBe('confluence-wins');
  });

  it('cold-loads "compendiq-wins" from admin_settings', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ setting_value: 'compendiq-wins' }],
    });
    await initSyncConflictPolicyService();
    expect(getSyncConflictPolicy()).toBe('compendiq-wins');
  });

  it('cold-loads "manual-review" from admin_settings', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ setting_value: 'manual-review' }],
    });
    await initSyncConflictPolicyService();
    expect(getSyncConflictPolicy()).toBe('manual-review');
  });

  it('falls back to default on invalid persisted value', async () => {
    // A typo / corrupted value should NOT silently land us in
    // manual-review mode (which would silently start queueing pending
    // versions on every sync). Defensive parse → return default.
    mockQuery.mockResolvedValueOnce({
      rows: [{ setting_value: 'always-clobber-everything' }],
    });
    await initSyncConflictPolicyService();
    expect(getSyncConflictPolicy()).toBe('confluence-wins');
  });

  it('falls back to default when admin_settings row is absent', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await initSyncConflictPolicyService();
    expect(getSyncConflictPolicy()).toBe('confluence-wins');
  });

  it('falls back to default when DB query fails (cold-load soft-fail)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('postgres unreachable'));
    await initSyncConflictPolicyService();
    expect(getSyncConflictPolicy()).toBe('confluence-wins');
  });

  it('re-init replaces the previous getter', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ setting_value: 'manual-review' }],
    });
    await initSyncConflictPolicyService();
    expect(getSyncConflictPolicy()).toBe('manual-review');

    mockQuery.mockResolvedValueOnce({
      rows: [{ setting_value: 'compendiq-wins' }],
    });
    await initSyncConflictPolicyService();
    expect(getSyncConflictPolicy()).toBe('compendiq-wins');
  });
});
