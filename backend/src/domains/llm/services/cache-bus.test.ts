/**
 * Unit tests for the LLM provider cache-bus adapter
 * (`backend/src/domains/llm/services/cache-bus.ts`).
 *
 * Sub-PR 1d of Compendiq/compendiq-ee#113. The module delegates fan-out
 * to the generic `redis-cache-bus`, but soft-fails to a process-local
 * listener registry when the bus is inactive. This file pins ONLY the
 * single-pod / local-fan-out contract — the cluster fan-out is exercised
 * at the underlying primitive in `core/services/redis-cache-bus.test.ts`
 * (subscribe/publish/dispatch path with two-instance scenarios), and the
 * end-to-end "two pods see each other's bumps" check is deferred to the
 * EE multi-instance integration suite (per the plan).
 *
 * Why pin `isCacheBusActive() === false` at the start of every case:
 * Vitest runs test files in isolation but cases inside a file share
 * module state. The contract for "tests in this file" is the local-only
 * branch of the adapter; if a future case accidentally activates the
 * bus, every assertion below would silently route through `publish()`
 * (a no-op against the unconfigured main client) and listeners would
 * never fire — green by accident. The explicit pin makes that bug loud.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  bumpProviderCacheVersion,
  emitProviderDeleted,
  getProviderCacheVersion,
  onProviderCacheBump,
  onProviderDeleted,
} from './cache-bus.js';
import { isCacheBusActive } from '../../../core/services/redis-cache-bus.js';

describe('llm cache-bus (single-pod / local fan-out)', () => {
  beforeEach(() => {
    // Pin the precondition: this file exercises the local-only branch.
    // If this ever fires, the bus was activated by a sibling test and
    // pollution is in play — fail loud rather than silently route through
    // the publish path.
    expect(isCacheBusActive()).toBe(false);
  });

  describe('bumpProviderCacheVersion', () => {
    it('fires registered listeners with the new version (awaitable)', async () => {
      const startVersion = getProviderCacheVersion();
      const listener = vi.fn();
      const unsubscribe = onProviderCacheBump(listener);

      try {
        await bumpProviderCacheVersion();

        expect(listener).toHaveBeenCalledTimes(1);
        // The version is monotone-increasing per pod. We don't assert an
        // absolute value because earlier cases in this file may have
        // bumped it; we only assert it advanced by exactly one.
        expect(listener).toHaveBeenCalledWith(startVersion + 1);
        expect(getProviderCacheVersion()).toBe(startVersion + 1);
      } finally {
        unsubscribe();
      }
    });

    it('fans out to multiple listeners on a single bump', async () => {
      const a = vi.fn();
      const b = vi.fn();
      const c = vi.fn();
      const unA = onProviderCacheBump(a);
      const unB = onProviderCacheBump(b);
      const unC = onProviderCacheBump(c);

      try {
        await bumpProviderCacheVersion();

        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);
        expect(c).toHaveBeenCalledTimes(1);
      } finally {
        unA();
        unB();
        unC();
      }
    });

    it('isolates listener throws — a throwing listener does NOT deregister others', async () => {
      const before = vi.fn();
      const throwing = vi.fn(() => {
        throw new Error('listener boom');
      });
      const after = vi.fn();

      const unBefore = onProviderCacheBump(before);
      const unThrowing = onProviderCacheBump(throwing);
      const unAfter = onProviderCacheBump(after);

      try {
        // First bump: throwing listener executes (and throws), other two
        // must still fire. The module catches the throw and warn-logs;
        // the awaiting caller does not see the rejection.
        await expect(bumpProviderCacheVersion()).resolves.toBeUndefined();

        expect(before).toHaveBeenCalledTimes(1);
        expect(throwing).toHaveBeenCalledTimes(1);
        expect(after).toHaveBeenCalledTimes(1);

        // Second bump: the throwing listener is still subscribed (no
        // deregister-on-throw), proving fan-out resilience.
        await bumpProviderCacheVersion();

        expect(before).toHaveBeenCalledTimes(2);
        expect(throwing).toHaveBeenCalledTimes(2);
        expect(after).toHaveBeenCalledTimes(2);
      } finally {
        unBefore();
        unThrowing();
        unAfter();
      }
    });

    it('unsubscribe stops further notifications', async () => {
      const listener = vi.fn();
      const unsubscribe = onProviderCacheBump(listener);

      await bumpProviderCacheVersion();
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();

      await bumpProviderCacheVersion();
      expect(listener).toHaveBeenCalledTimes(1); // still 1 — no new fire
    });
  });

  describe('emitProviderDeleted', () => {
    it('fires registered listeners with the providerId (awaitable)', async () => {
      const listener = vi.fn();
      const unsubscribe = onProviderDeleted(listener);

      try {
        await emitProviderDeleted('prov-123');

        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith('prov-123');
      } finally {
        unsubscribe();
      }
    });

    it('carries the providerId verbatim — no truncation, no transformation', async () => {
      const listener = vi.fn();
      const unsubscribe = onProviderDeleted(listener);
      const id = '00000000-0000-4000-8000-deadbeefcafe'; // looks like a v4 UUID

      try {
        await emitProviderDeleted(id);

        expect(listener).toHaveBeenCalledWith(id);
      } finally {
        unsubscribe();
      }
    });

    it('fans out to multiple deleted-listeners and isolates throws', async () => {
      const a = vi.fn();
      const throwing = vi.fn(() => {
        throw new Error('deleted listener boom');
      });
      const b = vi.fn();

      const unA = onProviderDeleted(a);
      const unT = onProviderDeleted(throwing);
      const unB = onProviderDeleted(b);

      try {
        await expect(emitProviderDeleted('prov-xyz')).resolves.toBeUndefined();

        expect(a).toHaveBeenCalledWith('prov-xyz');
        expect(throwing).toHaveBeenCalledWith('prov-xyz');
        expect(b).toHaveBeenCalledWith('prov-xyz');
      } finally {
        unA();
        unT();
        unB();
      }
    });

    it('unsubscribe stops further notifications', async () => {
      const listener = vi.fn();
      const unsubscribe = onProviderDeleted(listener);

      await emitProviderDeleted('first');
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();

      await emitProviderDeleted('second');
      expect(listener).toHaveBeenCalledTimes(1); // unchanged
    });
  });

  describe('getProviderCacheVersion', () => {
    it('is monotone-increasing across bumps in single-pod mode', async () => {
      const before = getProviderCacheVersion();

      await bumpProviderCacheVersion();
      const after1 = getProviderCacheVersion();
      expect(after1).toBe(before + 1);

      await bumpProviderCacheVersion();
      const after2 = getProviderCacheVersion();
      expect(after2).toBe(before + 2);
    });
  });
});
