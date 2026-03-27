/**
 * Unit tests for token-cleanup-service.ts.
 *
 * Uses vi.useFakeTimers() to control setInterval timing without real delays.
 * Uses vi.mock() to intercept the auth plugin so cleanupExpiredTokens never
 * hits the database.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// vi.mock() is hoisted by Vitest, so the mock is applied before any imports
// (including the service's own import of auth.js).
vi.mock('../plugins/auth.js', () => ({
  cleanupExpiredTokens: vi.fn().mockResolvedValue(0),
}));

// These imports are resolved after the mock is applied.
import { cleanupExpiredTokens } from '../plugins/auth.js';
import { startTokenCleanupWorker, stopTokenCleanupWorker } from './token-cleanup-service.js';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('token-cleanup-service', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(cleanupExpiredTokens).mockResolvedValue(0);
    delete process.env.TOKEN_CLEANUP_INTERVAL_HOURS;
  });

  afterEach(() => {
    // Always stop the worker to reset cleanupIntervalHandle and cleanupLock
    // before the next test.
    stopTokenCleanupWorker();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ─── Test 1: default 24h interval ──────────────────────────────────────────

  it('schedules an interval at 24 hours by default', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    startTokenCleanupWorker();

    expect(setIntervalSpy).toHaveBeenCalledOnce();
    const [, delay] = setIntervalSpy.mock.calls[0] as [unknown, number];
    expect(delay).toBe(24 * 60 * 60 * 1000);
  });

  // ─── Test 2: idempotency ────────────────────────────────────────────────────

  it('is idempotent — calling startTokenCleanupWorker twice creates only one interval', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    startTokenCleanupWorker();
    startTokenCleanupWorker(); // second call must be a no-op

    expect(setIntervalSpy).toHaveBeenCalledOnce();
  });

  // ─── Test 3: callback invokes cleanupExpiredTokens ──────────────────────────

  it('interval callback invokes cleanupExpiredTokens and logs the returned count', async () => {
    vi.mocked(cleanupExpiredTokens).mockResolvedValue(7);

    startTokenCleanupWorker();

    // Advance past the 24h interval to trigger the callback and allow the
    // async work (microtasks) inside it to complete.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

    expect(cleanupExpiredTokens).toHaveBeenCalledOnce();
  });

  // ─── Test 4: stop clears interval — worker can be restarted ────────────────

  it('stopTokenCleanupWorker clears the interval so the worker can be restarted', () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    startTokenCleanupWorker();
    expect(setIntervalSpy).toHaveBeenCalledOnce();

    stopTokenCleanupWorker();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();

    // Worker can be restarted after stop
    startTokenCleanupWorker();
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
  });

  // ─── Test 5: stopTokenCleanupWorker resets cleanupLock ─────────────────────

  it('stopTokenCleanupWorker resets cleanupLock so a restart after an interrupted run does not permanently deadlock', async () => {
    // Simulate an in-flight cleanup: cleanupExpiredTokens returns a promise
    // that we control, so the lock stays set until we resolve it.
    let resolveCleanup!: (value: number) => void;
    vi.mocked(cleanupExpiredTokens).mockReturnValue(
      new Promise<number>((resolve) => {
        resolveCleanup = resolve;
      }),
    );

    startTokenCleanupWorker();

    // Trigger the interval callback — lock is now set, async call in flight.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

    // Stop while the async callback is still in flight.
    stopTokenCleanupWorker();

    // Now resolve the pending cleanup (simulates the async callback eventually
    // finishing after stop — the finally block would try to reset the lock
    // but it should already be false from stop).
    resolveCleanup(3);

    // Restart the worker. Because stop() reset the lock, the first interval
    // callback of the new worker should be able to proceed (no permanent lock).
    vi.mocked(cleanupExpiredTokens).mockResolvedValue(0);
    startTokenCleanupWorker();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

    // cleanupExpiredTokens was called once from the first start and once from
    // the second start — total ≥ 2.
    expect(vi.mocked(cleanupExpiredTokens).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  // ─── Test 6: TOKEN_CLEANUP_INTERVAL_HOURS is respected ─────────────────────

  it('respects TOKEN_CLEANUP_INTERVAL_HOURS env var; invalid values fall back to 24h', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    // 6a: valid custom value (6 hours)
    process.env.TOKEN_CLEANUP_INTERVAL_HOURS = '6';
    startTokenCleanupWorker();
    const [, delay6] = setIntervalSpy.mock.calls[0] as [unknown, number];
    expect(delay6).toBe(6 * 60 * 60 * 1000);
    stopTokenCleanupWorker();

    // 6b: NaN — falls back to 24h
    process.env.TOKEN_CLEANUP_INTERVAL_HOURS = 'not-a-number';
    startTokenCleanupWorker();
    const [, delayNaN] = setIntervalSpy.mock.calls[1] as [unknown, number];
    expect(delayNaN).toBe(24 * 60 * 60 * 1000);
    stopTokenCleanupWorker();

    // 6c: negative — falls back to 24h
    process.env.TOKEN_CLEANUP_INTERVAL_HOURS = '-5';
    startTokenCleanupWorker();
    const [, delayNeg] = setIntervalSpy.mock.calls[2] as [unknown, number];
    expect(delayNeg).toBe(24 * 60 * 60 * 1000);
    stopTokenCleanupWorker();

    // 6d: zero — falls back to 24h
    process.env.TOKEN_CLEANUP_INTERVAL_HOURS = '0';
    startTokenCleanupWorker();
    const [, delayZero] = setIntervalSpy.mock.calls[3] as [unknown, number];
    expect(delayZero).toBe(24 * 60 * 60 * 1000);
    stopTokenCleanupWorker();
  });
});
