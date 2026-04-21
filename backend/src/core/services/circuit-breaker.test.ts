import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  getProviderBreaker,
  invalidateProviderBreaker,
  listProviderBreakers,
} from './circuit-breaker.js';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker('test', {
      failureThreshold: 3,
      successThreshold: 2,
      timeout: 1000,
    });
  });

  describe('initial state', () => {
    it('should start in CLOSED state', () => {
      const status = breaker.getStatus();
      expect(status.state).toBe('CLOSED');
      expect(status.failureCount).toBe(0);
      expect(status.successCount).toBe(0);
      expect(status.lastFailureTime).toBeNull();
      expect(status.nextRetryTime).toBeNull();
    });
  });

  describe('CLOSED state', () => {
    it('should allow calls through when CLOSED', async () => {
      const result = await breaker.execute(async () => 'success');
      expect(result).toBe('success');
    });

    it('should stay CLOSED on isolated failures below threshold', async () => {
      // Fail once
      await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow('fail');
      expect(breaker.getStatus().state).toBe('CLOSED');
      expect(breaker.getStatus().failureCount).toBe(1);

      // Fail twice
      await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow('fail');
      expect(breaker.getStatus().state).toBe('CLOSED');
      expect(breaker.getStatus().failureCount).toBe(2);
    });

    it('should transition to OPEN after reaching failure threshold', async () => {
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow('fail');
      }
      expect(breaker.getStatus().state).toBe('OPEN');
      expect(breaker.getStatus().failureCount).toBe(3);
    });

    it('should reset failure count on success', async () => {
      // Two failures
      await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
      await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
      expect(breaker.getStatus().failureCount).toBe(2);

      // One success resets
      await breaker.execute(async () => 'ok');
      expect(breaker.getStatus().failureCount).toBe(0);
    });
  });

  describe('OPEN state', () => {
    beforeEach(async () => {
      // Trip the breaker
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow('fail');
      }
    });

    it('should reject calls immediately when OPEN', async () => {
      await expect(breaker.execute(async () => 'should not run')).rejects.toThrow(CircuitBreakerOpenError);
      await expect(breaker.execute(async () => 'should not run')).rejects.toThrow(
        'test: LLM server temporarily unavailable',
      );
    });

    it('should have a nextRetryTime when OPEN', () => {
      const status = breaker.getStatus();
      expect(status.state).toBe('OPEN');
      expect(status.nextRetryTime).not.toBeNull();
      expect(status.nextRetryTime! - Date.now()).toBeLessThanOrEqual(1000);
    });

    it('should transition to HALF_OPEN after timeout expires', async () => {
      // Fast-forward time
      vi.useFakeTimers();
      vi.advanceTimersByTime(1100);

      const status = breaker.getStatus();
      expect(status.state).toBe('HALF_OPEN');

      vi.useRealTimers();
    });
  });

  describe('HALF_OPEN state', () => {
    beforeEach(async () => {
      // Trip the breaker and wait for timeout
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow('fail');
      }
      vi.useFakeTimers();
      vi.advanceTimersByTime(1100);
      breaker.getStatus(); // triggers transition
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should allow one request through in HALF_OPEN', async () => {
      vi.useRealTimers();
      const result = await breaker.execute(async () => 'probe-success');
      expect(result).toBe('probe-success');
    });

    it('should go back to OPEN on failure in HALF_OPEN', async () => {
      vi.useRealTimers();
      await expect(breaker.execute(async () => { throw new Error('probe-fail'); })).rejects.toThrow('probe-fail');
      expect(breaker.getStatus().state).toBe('OPEN');
    });

    it('should transition to CLOSED after successThreshold successes in HALF_OPEN', async () => {
      vi.useRealTimers();
      // Need 2 successes (successThreshold = 2)
      await breaker.execute(async () => 'success-1');
      expect(breaker.getStatus().state).toBe('HALF_OPEN');

      await breaker.execute(async () => 'success-2');
      expect(breaker.getStatus().state).toBe('CLOSED');
      expect(breaker.getStatus().failureCount).toBe(0);
    });
  });

  describe('reset', () => {
    it('should reset to initial CLOSED state', async () => {
      // Trip the breaker
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
      }
      expect(breaker.getStatus().state).toBe('OPEN');

      breaker.reset();
      const status = breaker.getStatus();
      expect(status.state).toBe('CLOSED');
      expect(status.failureCount).toBe(0);
      expect(status.successCount).toBe(0);
      expect(status.lastFailureTime).toBeNull();
    });
  });

  describe('recordSuccess / recordFailure', () => {
    it('should allow manual success/failure recording', async () => {
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getStatus().failureCount).toBe(2);

      breaker.recordSuccess();
      expect(breaker.getStatus().failureCount).toBe(0);
    });
  });
});

// ─── Per-provider breaker lifecycle (cache-bus invalidation) ────────────────
// This covers the cache-bus contract: when provider config changes, the
// resolver calls `invalidateProviderBreaker(id)` so the next request starts
// with a fresh CLOSED breaker instead of inheriting stale failure state
// against the old configuration.
describe('provider breaker lifecycle', () => {
  it('returns the same instance on subsequent calls for the same providerId', () => {
    const id = 'lifecycle-same-' + Math.random().toString(36).slice(2);
    invalidateProviderBreaker(id);
    const a = getProviderBreaker(id);
    const b = getProviderBreaker(id);
    expect(a).toBe(b);
  });

  it('invalidateProviderBreaker drops OPEN state — next get() returns a fresh CLOSED breaker', () => {
    const id = 'lifecycle-reset-' + Math.random().toString(36).slice(2);
    invalidateProviderBreaker(id); // start clean

    // Trip the breaker to OPEN
    const first = getProviderBreaker(id);
    for (let i = 0; i < 3; i++) first.recordFailure();
    expect(first.getStatus().state).toBe('OPEN');

    // Simulate cache-bus bump: invalidate, then retrieve again.
    invalidateProviderBreaker(id);
    const fresh = getProviderBreaker(id);

    // Must be a different instance AND in the CLOSED initial state —
    // no carry-over of failureCount or lastFailureTime.
    expect(fresh).not.toBe(first);
    const status = fresh.getStatus();
    expect(status.state).toBe('CLOSED');
    expect(status.failureCount).toBe(0);
    expect(status.lastFailureTime).toBeNull();
    expect(status.nextRetryTime).toBeNull();
  });

  it('listProviderBreakers omits a providerId after it is invalidated', () => {
    const id = 'lifecycle-list-' + Math.random().toString(36).slice(2);
    invalidateProviderBreaker(id);
    // Touch once so it appears in the map.
    getProviderBreaker(id);
    expect(listProviderBreakers().some((b) => b.providerId === id)).toBe(true);

    invalidateProviderBreaker(id);
    expect(listProviderBreakers().some((b) => b.providerId === id)).toBe(false);
  });
});

// ─── Issue #267: provider-deletion event drops breaker map entry ─────────────
// Prior to the fix, `providerBreakers` kept entries for deleted providers
// forever (O(n) memory leak over process lifetime). The fix emits a
// `providerDeleted(id)` signal on the cache-bus that the resolver listens for
// and routes to `invalidateBreaker`/`invalidateDispatcher`. The test pins the
// whole wiring end-to-end, not just `invalidateProviderBreaker` in isolation.
describe('provider deletion event drops breaker entry via cache-bus', () => {
  it('emitProviderDeleted drops the breaker — listProviderBreakers no longer sees the id', async () => {
    // Importing the resolver module registers its `onProviderDeleted` listener
    // as a module-evaluation side effect. This mirrors how the listener is
    // wired in production via `llm-provider-bootstrap.ts`.
    await import('../../domains/llm/services/llm-provider-resolver.js');
    const { emitProviderDeleted } = await import('../../domains/llm/services/cache-bus.js');

    const id = 'provider-to-delete-267';
    // Start from a clean slate in case another test created a breaker for this id.
    invalidateProviderBreaker(id);

    // Trip the breaker to OPEN so we can prove the freshly-created replacement
    // is CLOSED (no state bleed from the old instance).
    const breaker = getProviderBreaker(id);
    for (let i = 0; i < 3; i++) {
      await breaker.execute(() => Promise.reject(new Error('boom'))).catch(() => {});
    }
    expect(breaker.getStatus().state).toBe('OPEN');
    expect(listProviderBreakers().find((b) => b.providerId === id)).toBeDefined();

    // Act — emit the deletion event. Synchronous: must be gone on the next tick.
    emitProviderDeleted(id);

    expect(listProviderBreakers().find((b) => b.providerId === id)).toBeUndefined();

    // Re-create with the same id → fresh CLOSED breaker, no state bleed.
    // (Data model uses DB UUIDs so this is exotic in practice, but the issue
    // body calls it out as an acceptance criterion.)
    const reborn = getProviderBreaker(id);
    expect(reborn.getStatus().state).toBe('CLOSED');
    expect(reborn).not.toBe(breaker);
  });
});
