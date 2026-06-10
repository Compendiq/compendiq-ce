/**
 * Unit tests for the per-user security-state cache (#737).
 *
 * Contract:
 *   - getUserSecurityState(userId) reads `role` + `deactivated_at` from the
 *     users table and caches the result in-process for
 *     USER_SECURITY_CACHE_TTL_MS.
 *   - Within the TTL, repeated calls do NOT hit the DB (hot-path safety —
 *     `authenticate` calls this on every request).
 *   - After the TTL, the next call re-reads from the DB.
 *   - Concurrent calls during a cache miss share one in-flight query.
 *   - Row states map to: active (with role) / deactivated / missing.
 *   - DB errors soft-fail: stale last-known value if one exists, otherwise
 *     'unknown' (callers treat 'unknown' as "proceed on token claims" so a
 *     transient DB blip cannot 401 every request — mirrors cached-setting).
 *   - invalidateUserSecurityState(userId) clears the local entry AND
 *     publishes on the 'user:security:changed' cache-bus channel so peer
 *     pods invalidate too.
 *   - Invalidation fences in-flight loads (per-user generation counter): a
 *     load whose SELECT was already running when the invalidation landed may
 *     have snapshotted pre-COMMIT state, so its result must NOT be cached —
 *     otherwise the stale "active/old-role" answer would be re-cached for a
 *     full TTL window on the very pod that handled the admin action.
 *   - initUserSecurityCacheBus() wires the subscriber (clear one entry per
 *     message) + an onReconnect handler (clear everything — missed pub/sub
 *     messages are not replayed). Idempotent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../db/postgres.js', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
}));

const mockPublish = vi.fn();
const mockSubscribe = vi.fn();
const mockOnReconnect = vi.fn();
vi.mock('./redis-cache-bus.js', () => ({
  publish: (channel: string, payload: unknown) => mockPublish(channel, payload),
  subscribe: (channel: string, handler: (payload: unknown) => void) =>
    mockSubscribe(channel, handler),
  onReconnect: (handler: () => void | Promise<void>) => mockOnReconnect(handler),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  getUserSecurityState,
  invalidateUserSecurityState,
  initUserSecurityCacheBus,
  USER_SECURITY_CACHE_TTL_MS,
  _resetForTests,
} from './user-security-cache.js';
import { logger } from '../utils/logger.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';

function activeRow(role = 'admin') {
  return { rows: [{ role, deactivated_at: null }] };
}

describe('user-security-cache (#737)', () => {
  beforeEach(() => {
    _resetForTests();
    mockQuery.mockReset();
    mockPublish.mockReset().mockResolvedValue(undefined);
    mockSubscribe.mockReset().mockReturnValue(() => {});
    mockOnReconnect.mockReset().mockReturnValue(() => {});
    vi.mocked(logger.warn).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('state mapping', () => {
    it('returns active + role for a live user row', async () => {
      mockQuery.mockResolvedValueOnce(activeRow('admin'));

      const state = await getUserSecurityState(USER_ID);

      expect(state).toEqual({ kind: 'active', role: 'admin' });
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('FROM users'),
        [USER_ID],
      );
    });

    it('returns deactivated when deactivated_at is set', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ role: 'user', deactivated_at: new Date() }],
      });

      const state = await getUserSecurityState(USER_ID);
      expect(state).toEqual({ kind: 'deactivated' });
    });

    it('returns missing when the user row is gone', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const state = await getUserSecurityState(USER_ID);
      expect(state).toEqual({ kind: 'missing' });
    });
  });

  describe('TTL caching (hot path)', () => {
    it('serves repeated calls within the TTL from cache without re-querying', async () => {
      mockQuery.mockResolvedValueOnce(activeRow('user'));

      await getUserSecurityState(USER_ID);
      await getUserSecurityState(USER_ID);
      await getUserSecurityState(USER_ID);

      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('re-reads from the DB after the TTL elapses', async () => {
      vi.useFakeTimers();
      mockQuery.mockResolvedValueOnce(activeRow('admin'));
      await getUserSecurityState(USER_ID);

      vi.advanceTimersByTime(USER_SECURITY_CACHE_TTL_MS + 1);

      mockQuery.mockResolvedValueOnce({
        rows: [{ role: 'user', deactivated_at: null }],
      });
      const state = await getUserSecurityState(USER_ID);

      expect(state).toEqual({ kind: 'active', role: 'user' });
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('deduplicates concurrent lookups into a single in-flight query', async () => {
      let resolveQuery: (v: unknown) => void;
      mockQuery.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveQuery = resolve;
        }),
      );

      const p1 = getUserSecurityState(USER_ID);
      const p2 = getUserSecurityState(USER_ID);
      resolveQuery!(activeRow('user'));

      const [s1, s2] = await Promise.all([p1, p2]);
      expect(s1).toEqual({ kind: 'active', role: 'user' });
      expect(s2).toEqual({ kind: 'active', role: 'user' });
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });

  describe('DB-error soft-fail', () => {
    it('returns unknown and logs a warn when the lookup fails with no cached value', async () => {
      mockQuery.mockRejectedValueOnce(new Error('pool exhausted'));

      const state = await getUserSecurityState(USER_ID);

      expect(state).toEqual({ kind: 'unknown' });
      expect(logger.warn).toHaveBeenCalled();
    });

    it('returns the stale last-known state when a re-read fails after TTL expiry', async () => {
      vi.useFakeTimers();
      mockQuery.mockResolvedValueOnce(activeRow('admin'));
      await getUserSecurityState(USER_ID);

      vi.advanceTimersByTime(USER_SECURITY_CACHE_TTL_MS + 1);
      mockQuery.mockRejectedValueOnce(new Error('pool exhausted'));

      const state = await getUserSecurityState(USER_ID);
      expect(state).toEqual({ kind: 'active', role: 'admin' });
    });
  });

  describe('invalidation', () => {
    it('clears the local entry and publishes on the cache-bus', async () => {
      mockQuery.mockResolvedValueOnce(activeRow('admin'));
      await getUserSecurityState(USER_ID);

      await invalidateUserSecurityState(USER_ID);

      expect(mockPublish).toHaveBeenCalledWith('user:security:changed', {
        userId: USER_ID,
      });

      // Next read must hit the DB again even though the TTL has not elapsed.
      mockQuery.mockResolvedValueOnce({
        rows: [{ role: 'admin', deactivated_at: new Date() }],
      });
      const state = await getUserSecurityState(USER_ID);
      expect(state).toEqual({ kind: 'deactivated' });
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    // #756 review: TOCTOU between invalidation and an in-flight load. The
    // load's SELECT may have snapshotted pre-COMMIT state; if it resolves
    // AFTER the invalidation, caching its result would re-extend the stale
    // "active" answer for a full TTL window on the acting pod.
    it('does not re-cache a stale in-flight load that resolves after an invalidation', async () => {
      let resolveSlow: (v: unknown) => void;
      mockQuery.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSlow = resolve;
        }),
      );
      const staleLoad = getUserSecurityState(USER_ID);

      // Admin deactivation COMMITs and invalidates while the SELECT is in flight.
      await invalidateUserSecurityState(USER_ID);

      // The stale "still active" row arrives AFTER the invalidation ran.
      resolveSlow!(activeRow('admin'));
      await expect(staleLoad).resolves.toEqual({ kind: 'active', role: 'admin' });

      // The stale result must NOT have been cached: the next call re-reads
      // the DB and sees the committed deactivation.
      mockQuery.mockResolvedValueOnce({
        rows: [{ role: 'admin', deactivated_at: new Date() }],
      });
      const after = await getUserSecurityState(USER_ID);
      expect(after).toEqual({ kind: 'deactivated' });
      expect(mockQuery).toHaveBeenCalledTimes(2);

      // …and the fresh 'deactivated' entry stays cached (the stale load did
      // not overwrite it).
      const cached = await getUserSecurityState(USER_ID);
      expect(cached).toEqual({ kind: 'deactivated' });
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('a lookup arriving after the invalidation starts a fresh load instead of joining the stale one', async () => {
      let resolveSlow: (v: unknown) => void;
      mockQuery.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSlow = resolve;
        }),
      );
      const staleLoad = getUserSecurityState(USER_ID);

      await invalidateUserSecurityState(USER_ID);

      // The post-invalidation lookup must hit the DB (fresh, post-COMMIT
      // read) rather than being deduplicated onto the stale in-flight load.
      mockQuery.mockResolvedValueOnce({
        rows: [{ role: 'user', deactivated_at: new Date() }],
      });
      const fresh = await getUserSecurityState(USER_ID);
      expect(fresh).toEqual({ kind: 'deactivated' });

      // The slow stale load resolves last — it must not clobber the fresh entry.
      resolveSlow!(activeRow('user'));
      await staleLoad;

      const cached = await getUserSecurityState(USER_ID);
      expect(cached).toEqual({ kind: 'deactivated' });
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });
  });

  describe('cache-bus subscriber', () => {
    it('subscribes to user:security:changed and registers a reconnect handler', () => {
      initUserSecurityCacheBus();

      expect(mockSubscribe).toHaveBeenCalledWith(
        'user:security:changed',
        expect.any(Function),
      );
      expect(mockOnReconnect).toHaveBeenCalledWith(expect.any(Function));
    });

    it('is idempotent — a second init does not double-subscribe', () => {
      initUserSecurityCacheBus();
      initUserSecurityCacheBus();

      expect(mockSubscribe).toHaveBeenCalledTimes(1);
    });

    it('clears the matching entry when a bus message arrives', async () => {
      initUserSecurityCacheBus();
      mockQuery.mockResolvedValueOnce(activeRow('admin'));
      await getUserSecurityState(USER_ID);

      const handler = mockSubscribe.mock.calls[0]![1] as (payload: unknown) => void;
      handler({ userId: USER_ID });

      mockQuery.mockResolvedValueOnce({ rows: [] });
      const state = await getUserSecurityState(USER_ID);
      expect(state).toEqual({ kind: 'missing' });
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('fences an in-flight load against a bus invalidation from a peer pod', async () => {
      initUserSecurityCacheBus();
      const handler = mockSubscribe.mock.calls[0]![1] as (payload: unknown) => void;

      let resolveSlow: (v: unknown) => void;
      mockQuery.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSlow = resolve;
        }),
      );
      const staleLoad = getUserSecurityState(USER_ID);

      // A peer pod deactivated the user while our SELECT was in flight.
      handler({ userId: USER_ID });

      resolveSlow!(activeRow('user'));
      await expect(staleLoad).resolves.toEqual({ kind: 'active', role: 'user' });

      // The stale result must not have been cached.
      mockQuery.mockResolvedValueOnce({
        rows: [{ role: 'user', deactivated_at: new Date() }],
      });
      const after = await getUserSecurityState(USER_ID);
      expect(after).toEqual({ kind: 'deactivated' });
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('clears the whole cache on a malformed bus payload (fail safe)', async () => {
      initUserSecurityCacheBus();
      mockQuery.mockResolvedValueOnce(activeRow('admin'));
      await getUserSecurityState(USER_ID);

      const handler = mockSubscribe.mock.calls[0]![1] as (payload: unknown) => void;
      handler('not-an-object');

      mockQuery.mockResolvedValueOnce(activeRow('admin'));
      await getUserSecurityState(USER_ID);
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('clears the whole cache after a bus reconnect (missed messages are not replayed)', async () => {
      initUserSecurityCacheBus();
      mockQuery.mockResolvedValueOnce(activeRow('admin'));
      await getUserSecurityState(USER_ID);

      const reconnect = mockOnReconnect.mock.calls[0]![0] as () => void;
      reconnect();

      mockQuery.mockResolvedValueOnce(activeRow('admin'));
      await getUserSecurityState(USER_ID);
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('fences in-flight loads against a full-cache clear (bus reconnect)', async () => {
      initUserSecurityCacheBus();
      const reconnect = mockOnReconnect.mock.calls[0]![0] as () => void;

      let resolveSlow: (v: unknown) => void;
      mockQuery.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSlow = resolve;
        }),
      );
      const staleLoad = getUserSecurityState(USER_ID);

      // The bus reconnects mid-load → missed invalidations may exist, so the
      // whole cache is cleared; the in-flight result may be stale too.
      reconnect();

      resolveSlow!(activeRow('admin'));
      await staleLoad;

      // Next lookup must re-read the DB, not serve the fenced stale result.
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const after = await getUserSecurityState(USER_ID);
      expect(after).toEqual({ kind: 'missing' });
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });
  });
});
