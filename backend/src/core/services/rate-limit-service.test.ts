import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// #1755: `getRateLimits()` must never reject and never wait unbounded on the
// database. `query` is mocked at the module boundary (a unit test of the
// cache/refresh state machine, not a database test); fake timers drive the
// 60 s TTL, the 10 s retry window, the 1 s wait and the 30 s abandon rule.
const mockQuery = vi.fn();
vi.mock('../db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('./audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import { getRateLimits, upsertRateLimits, _resetCache } from './rate-limit-service.js';
import { logger } from '../utils/logger.js';

const CACHE_TTL_MS = 60_000;
const FAILURE_RETRY_MS = 10_000;
const REFRESH_WAIT_MS = 1_000;
const REFRESH_ABANDON_MS = 30_000;

const DEFAULT_LIMITS = {
  global: { max: 300, timeWindow: '1 minute' },
  auth: { max: 5, timeWindow: '1 minute' },
  admin: { max: 20, timeWindow: '1 minute' },
  llmStream: { max: 10, timeWindow: '1 minute' },
  llmEmbedding: { max: 5, timeWindow: '1 minute' },
};

/** A settings read result with the given global and auth limits stored. */
function rows(globalMax: number, authMax: number) {
  return {
    rows: [
      { setting_key: 'rate_limit_global_max', setting_value: String(globalMax) },
      { setting_key: 'rate_limit_auth_max', setting_value: String(authMax) },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const isSettingsRead = (call: unknown[]) => String(call[0]).startsWith('SELECT');
const settingsReads = () => mockQuery.mock.calls.filter(isSettingsRead).length;

const REFUSED = new Error('ECONNREFUSED');

/**
 * Answer settings reads from `reads` in order (a promise as is, an Error as a
 * rejection created only when the read happens, anything else as a result);
 * writes succeed.
 */
function queueReads(...reads: unknown[]) {
  mockQuery.mockImplementation((sql: string) => {
    if (sql.startsWith('SELECT')) {
      if (reads.length === 0) throw new Error('unexpected settings read');
      const next = reads.shift();
      if (next instanceof Promise) return next;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }
    return Promise.resolve({ rows: [], rowCount: 1 });
  });
}

/** Record when a call settles without awaiting it. */
function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T } = { settled: false };
  void promise.then((value) => {
    state.settled = true;
    state.value = value;
  });
  return state;
}

describe('rate-limit-service getRateLimits (#1755)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    mockQuery.mockReset();
    vi.mocked(logger.warn).mockClear();
    _resetCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves stored values and keeps them for the 60 s TTL (healthy path unchanged)', async () => {
    queueReads(rows(400, 7), rows(500, 8));

    const first = await getRateLimits();
    expect(first.global.max).toBe(400);
    expect(first.auth.max).toBe(7);

    await vi.advanceTimersByTimeAsync(CACHE_TTL_MS - 1);
    expect((await getRateLimits()).global.max).toBe(400);
    expect(settingsReads()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect((await getRateLimits()).global.max).toBe(500);
    expect(settingsReads()).toBe(2);
  });

  it('serves the last loaded value when the refresh read rejects', async () => {
    queueReads(rows(400, 7), REFUSED);
    await getRateLimits();

    await vi.advanceTimersByTimeAsync(CACHE_TTL_MS);
    const limits = await getRateLimits();

    expect(limits.global.max).toBe(400);
    expect(limits.auth.max).toBe(7);
    expect(settingsReads()).toBe(2);
  });

  it('serves the defaults when the read rejects and nothing was ever loaded', async () => {
    queueReads(REFUSED);

    await expect(getRateLimits()).resolves.toEqual(DEFAULT_LIMITS);
  });

  it('applies the auth floor to stored values, and the fallback keeps it', async () => {
    queueReads(rows(400, 1), REFUSED);

    expect((await getRateLimits()).auth.max).toBe(3);

    await vi.advanceTimersByTimeAsync(CACHE_TTL_MS);
    expect((await getRateLimits()).auth.max).toBe(3);
  });

  it('issues one read for N concurrent and N sequential calls inside the retry window', async () => {
    const read = deferred<unknown>();
    queueReads(read.promise);

    const concurrent = Array.from({ length: 10 }, () => getRateLimits());
    read.reject(new Error('ECONNREFUSED'));
    const results = await Promise.all(concurrent);
    results.forEach((limits) => expect(limits).toEqual(DEFAULT_LIMITS));

    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(FAILURE_RETRY_MS / 10 - 1);
      expect(await getRateLimits()).toEqual(DEFAULT_LIMITS);
    }

    expect(settingsReads()).toBe(1);
  });

  it('starts a new attempt once the retry window has passed', async () => {
    queueReads(REFUSED, REFUSED);
    await getRateLimits();

    await vi.advanceTimersByTimeAsync(FAILURE_RETRY_MS - 1);
    await getRateLimits();
    expect(settingsReads()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await getRateLimits();
    expect(settingsReads()).toBe(2);
  });

  it('bounds the wait on a never-settling read and abandons it after 30 s', async () => {
    mockQuery.mockImplementation(() => new Promise(() => {}));

    const a = track(getRateLimits());
    await vi.advanceTimersByTimeAsync(REFRESH_WAIT_MS / 2);
    const b = track(getRateLimits());

    // The deadline is shared: a later caller waits only for the rest of it.
    await vi.advanceTimersByTimeAsync(REFRESH_WAIT_MS / 2 - 1);
    expect(a.settled).toBe(false);
    expect(b.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(a.settled && b.settled).toBe(true);
    expect(a.value).toEqual(DEFAULT_LIMITS);
    expect(b.value).toEqual(DEFAULT_LIMITS);

    // Past the deadline a caller does not wait at all, and joins the pending read.
    await expect(getRateLimits()).resolves.toEqual(DEFAULT_LIMITS);
    await vi.advanceTimersByTimeAsync(REFRESH_ABANDON_MS - REFRESH_WAIT_MS);
    await expect(getRateLimits()).resolves.toEqual(DEFAULT_LIMITS);
    expect(settingsReads()).toBe(1);
    expect(logger.warn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const c = track(getRateLimits());
    expect(settingsReads()).toBe(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REFRESH_WAIT_MS);
    expect(c.value).toEqual(DEFAULT_LIMITS);
  });

  it('does not cache the late success of an abandoned read', async () => {
    const abandoned = deferred<unknown>();
    queueReads(abandoned.promise, rows(400, 7));

    const first = getRateLimits();
    await vi.advanceTimersByTimeAsync(REFRESH_WAIT_MS);
    await first;

    // A call after the abandon time and before the late settle releases the slot.
    await vi.advanceTimersByTimeAsync(REFRESH_ABANDON_MS);
    expect((await getRateLimits()).global.max).toBe(400);

    abandoned.resolve(rows(111, 9));
    await vi.advanceTimersByTimeAsync(0);

    const limits = await getRateLimits();
    expect(limits.global.max).toBe(400);
    expect(limits.auth.max).toBe(7);
    expect(settingsReads()).toBe(2);
  });

  it('does not let the late failure of an abandoned read delay the next attempt', async () => {
    const abandoned = deferred<unknown>();
    queueReads(abandoned.promise, rows(400, 7), rows(500, 8));

    const first = getRateLimits();
    await vi.advanceTimersByTimeAsync(REFRESH_WAIT_MS);
    await first;

    await vi.advanceTimersByTimeAsync(REFRESH_ABANDON_MS);
    expect((await getRateLimits()).global.max).toBe(400); // cached until +60 s

    // Fails 5 s before that cache expires; a retry window opened by it would
    // still be running when the cache expires.
    await vi.advanceTimersByTimeAsync(CACHE_TTL_MS - FAILURE_RETRY_MS / 2);
    abandoned.reject(new Error('connection terminated'));
    await vi.advanceTimersByTimeAsync(FAILURE_RETRY_MS / 2);

    expect((await getRateLimits()).global.max).toBe(500);
    expect(settingsReads()).toBe(3);
  });

  it('recovers: the next successful read replaces the fallback and restores the 60 s TTL', async () => {
    queueReads(rows(400, 7), REFUSED, rows(600, 9), rows(700, 10));
    await getRateLimits();
    await vi.advanceTimersByTimeAsync(CACHE_TTL_MS);
    expect((await getRateLimits()).global.max).toBe(400);

    await vi.advanceTimersByTimeAsync(FAILURE_RETRY_MS);
    expect((await getRateLimits()).global.max).toBe(600);
    expect(settingsReads()).toBe(3);

    await vi.advanceTimersByTimeAsync(CACHE_TTL_MS - 1);
    expect((await getRateLimits()).global.max).toBe(600);
    expect(settingsReads()).toBe(3);

    await vi.advanceTimersByTimeAsync(1);
    expect((await getRateLimits()).global.max).toBe(700);
  });

  it('after upsertRateLimits during an in-flight read, the next read queries again and never sees the pre-write result', async () => {
    const preWrite = deferred<unknown>();
    const postWrite = deferred<unknown>();
    queueReads(rows(400, 7), preWrite.promise, postWrite.promise);
    await getRateLimits();
    await vi.advanceTimersByTimeAsync(CACHE_TTL_MS);

    const beforeWrite = track(getRateLimits());
    expect(settingsReads()).toBe(2);

    await upsertRateLimits({ global: 900 });

    const afterWrite = track(getRateLimits());
    expect(settingsReads()).toBe(3);

    // The pre-write read settles first, with the value from before the write.
    preWrite.resolve(rows(111, 6));
    await vi.advanceTimersByTimeAsync(0);
    expect(afterWrite.settled).toBe(false);
    expect(beforeWrite.value?.global.max).not.toBe(111);

    postWrite.resolve(rows(900, 7));
    await vi.advanceTimersByTimeAsync(0);
    expect(afterWrite.value?.global.max).toBe(900);
    expect((await getRateLimits()).global.max).toBe(900);
    expect(settingsReads()).toBe(3);
  });

  it('raises no unhandled rejection when a read fails after every caller stopped waiting', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const read = deferred<unknown>();
      queueReads(read.promise);

      const pending = getRateLimits();
      await vi.advanceTimersByTimeAsync(REFRESH_WAIT_MS);
      expect(await pending).toEqual(DEFAULT_LIMITS);

      read.reject(new Error('connection terminated'));
      // setImmediate is not faked: two real turns let Node report a rejection.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
