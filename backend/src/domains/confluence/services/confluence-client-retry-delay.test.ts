import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock at the HTTP boundary, as confluence-client.test.ts does.
vi.mock('undici', () => ({ request: vi.fn() }));
vi.mock('../../../core/utils/ssrf-guard.js', () => ({
  validateUrl: vi.fn(),
  addAllowedBaseUrl: vi.fn(),
  resolveConfluenceUrl: vi.fn((url: string) => url),
}));
vi.mock('../../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../core/utils/tls-config.js', () => ({
  confluenceDispatcher: {},
  buildConnectOptions: vi.fn().mockReturnValue(undefined),
  isVerifySslEnabled: vi.fn().mockReturnValue(true),
}));

import { request } from 'undici';
import { ConfluenceClient, computeConfluenceRetryDelayMs, parseRetryAfter } from './confluence-client.js';
import { resetRateLimiter } from './confluence-rate-limiter.js';
import { logger } from '../../../core/utils/logger.js';

const mockRequest = vi.mocked(request);

// The bounds #1778 fixes (RETRY_DELAY_FLOOR_MS, RETRY_DELAY_CEILING_MS, 0–500 ms
// jitter), spelled out so a drifted constant fails here.
const FLOOR_MS = 1_000;
const CEILING_MS = 30_000;
const JITTER_MS = 500;
/** `withRetry`'s default `baseDelay`. */
const BASE_DELAY_MS = 1_000;
/** `fetchOnce`'s per-attempt request timeout. */
const REQUEST_TIMEOUT_MS = 30_000;
const A_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

describe('computeConfluenceRetryDelayMs (#1778)', () => {
  const NOW = new Date('2026-11-10T12:00:00.000Z');
  /** An HTTP-date `Retry-After` `offsetMs` from NOW. */
  const httpDate = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toUTCString();
  /** Math.random() values: the lowest, a middle and a near-highest jitter. */
  const JITTERS = [0, 0.5, 0.999];

  /** The helper's result at each jitter. */
  function atEachJitter(compute: () => number): number[] {
    const random = vi.spyOn(Math, 'random');
    return JITTERS.map((fraction) => {
      random.mockReturnValue(fraction);
      return compute();
    });
  }
  /** `wantedMs` plus each jitter: the sleep for a wanted value inside the bounds. */
  const plusJitter = (wantedMs: number) => JITTERS.map((fraction) => wantedMs + fraction * JITTER_MS);

  beforeEach(() => {
    // HTTP-date Retry-After values count from Date.now().
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    { case: 'Retry-After: 3600', header: '3600', attempt: 0 },
    { case: 'an HTTP-date Retry-After a year ahead', header: httpDate(A_YEAR_MS), attempt: 0 },
    { case: 'the backoff of attempt 5 (32 s)', header: undefined, attempt: 5 },
    { case: 'the backoff of attempt 6 (64 s)', header: undefined, attempt: 6 },
  ])('caps $case at exactly the 30 s ceiling, whatever the jitter', ({ header, attempt }) => {
    expect(atEachJitter(() => computeConfluenceRetryDelayMs(attempt, parseRetryAfter(header), BASE_DELAY_MS)))
      .toEqual([CEILING_MS, CEILING_MS, CEILING_MS]);
  });

  it.each([
    { case: 'Retry-After: 0', header: '0', baseDelay: BASE_DELAY_MS, attempt: 0 },
    { case: 'Retry-After: 0.2', header: '0.2', baseDelay: BASE_DELAY_MS, attempt: 0 },
    { case: 'an HTTP-date Retry-After in the past', header: httpDate(-60_000), baseDelay: BASE_DELAY_MS, attempt: 0 },
    { case: 'a 1 ms backoff (baseDelay: 1)', header: undefined, baseDelay: 1, attempt: 0 },
    { case: 'Retry-After: 0 at attempt 1', header: '0', baseDelay: BASE_DELAY_MS, attempt: 1 },
  ])('raises $case to the 1 s floor plus jitter, within [1000, 1500)', ({ header, baseDelay, attempt }) => {
    expect(atEachJitter(() => computeConfluenceRetryDelayMs(attempt, parseRetryAfter(header), baseDelay)))
      .toEqual(plusJitter(FLOOR_MS));
  });

  it.each([0, 1, 2, 3, 4])(
    'leaves the default backoff of attempt %i unchanged: 1 s × 2^attempt plus jitter',
    (attempt) => {
      expect(atEachJitter(() => computeConfluenceRetryDelayMs(attempt, undefined, BASE_DELAY_MS)))
        .toEqual(plusJitter(BASE_DELAY_MS * 2 ** attempt));
    },
  );

  it.each([
    { case: 'Retry-After: soon', header: 'soon' },
    { case: 'Retry-After: -5', header: '-5' },
  ])('falls back to the backoff for an unparseable $case', ({ header }) => {
    expect(atEachJitter(() => computeConfluenceRetryDelayMs(1, parseRetryAfter(header), BASE_DELAY_MS)))
      .toEqual(plusJitter(BASE_DELAY_MS * 2));
  });

  it.each([
    { case: 'Retry-After: 5', header: '5', wantedMs: 5_000 },
    { case: 'an HTTP-date Retry-After 10 s ahead', header: httpDate(10_000), wantedMs: 10_000 },
  ])('honours $case inside the bounds, plus jitter', ({ header, wantedMs }) => {
    expect(atEachJitter(() => computeConfluenceRetryDelayMs(0, parseRetryAfter(header), BASE_DELAY_MS)))
      .toEqual(plusJitter(wantedMs));
  });
});

describe('ConfluenceClient retry sleeps (#1778)', () => {
  const BASE_URL = 'https://confluence.example.com';
  const PAGE = { id: '42', title: 'Runbook', version: { number: 5 } };

  /** One answer of the fake Confluence; `takesMs` holds it back on the (fake) clock. */
  interface Reply { status: 200 | 429; retryAfter?: string; takesMs?: number }

  /** Fake Confluence answering the n-th request with `replies[n]`, the last one repeating. Returns what crossed the wire. */
  function confluenceAnswering(...replies: Reply[]): string[] {
    const requests: string[] = [];
    mockRequest.mockImplementation(async (url: unknown) => {
      const reply = replies[Math.min(requests.length, replies.length - 1)]!;
      requests.push(`GET ${new URL(String(url)).pathname}`);
      if (reply.takesMs) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, reply.takesMs);
        await promise;
      }
      return {
        statusCode: reply.status,
        headers: reply.retryAfter === undefined ? {} : { 'retry-after': reply.retryAfter },
        body: { text: async () => (reply.status === 200 ? JSON.stringify(PAGE) : 'Too Many Requests') },
      } as never;
    });
    return requests;
  }

  /** How a call has settled so far. Attaches at once, so a rejection is never unhandled while the clock moves. */
  function track(call: Promise<unknown>): { settled?: 'resolved' | 'rejected'; value?: unknown } {
    const outcome: { settled?: 'resolved' | 'rejected'; value?: unknown } = {};
    void call.then(
      (value) => Object.assign(outcome, { settled: 'resolved', value }),
      (error: unknown) => Object.assign(outcome, { settled: 'rejected', value: error }),
    );
    return outcome;
  }

  /** A client with the default retry options: 3 attempts, baseDelay 1 s. */
  const newClient = () => new ConfluenceClient(BASE_URL, 'pat');

  beforeEach(() => {
    vi.clearAllMocks();
    // A full token bucket, so acquireToken() never queues behind the fake clock.
    resetRateLimiter();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    {
      case: 'Retry-After: 3600',
      retryAfter: () => '3600',
      after: 'exactly the 30 s ceiling',
      earliestMs: CEILING_MS,
      latestMs: CEILING_MS,
    },
    {
      case: 'an HTTP-date Retry-After a year ahead',
      retryAfter: () => new Date(Date.now() + A_YEAR_MS).toUTCString(),
      after: 'exactly the 30 s ceiling',
      earliestMs: CEILING_MS,
      latestMs: CEILING_MS,
    },
    {
      case: 'Retry-After: 0',
      retryAfter: () => '0',
      after: 'the 1 s floor plus jitter',
      earliestMs: FLOOR_MS,
      latestMs: FLOOR_MS + JITTER_MS,
    },
    {
      case: 'an unparseable Retry-After',
      retryAfter: () => 'soon',
      after: 'its 1 s backoff plus jitter',
      earliestMs: BASE_DELAY_MS,
      latestMs: BASE_DELAY_MS + JITTER_MS,
    },
  ])(
    'retries a 429 with $case after $after, then resolves',
    async ({ retryAfter, earliestMs, latestMs }) => {
      const requests = confluenceAnswering({ status: 429, retryAfter: retryAfter() }, { status: 200 });
      const outcome = track(newClient().getPage('42'));

      await vi.advanceTimersByTimeAsync(earliestMs - 1);
      expect({ requests: requests.length, outcome }).toEqual({ requests: 1, outcome: {} });

      await vi.advanceTimersByTimeAsync(latestMs - earliestMs + 1);
      expect({ requests: requests.length, outcome }).toEqual({
        requests: 2,
        outcome: { settled: 'resolved', value: PAGE },
      });
    },
  );

  it('spends at least 2 s on three attempts answered 429 with Retry-After: 0', async () => {
    const requests = confluenceAnswering({ status: 429, retryAfter: '0' });
    const outcome = track(newClient().getPage('42'));

    await vi.advanceTimersByTimeAsync(2 * FLOOR_MS - 1);
    expect({ requests: requests.length, settled: outcome.settled }).toEqual({ requests: 2, settled: undefined });

    await vi.runAllTimersAsync();
    expect({ requests: requests.length, settled: outcome.settled }).toEqual({ requests: 3, settled: 'rejected' });
  });

  it('settles within 150 s when every attempt uses its whole 30 s request timeout and answers Retry-After: 3600', async () => {
    // Two sleeps at the 30 s ceiling plus three attempts at the 30 s request timeout.
    const WORST_CASE_MS = 150_000;
    const requests = confluenceAnswering({ status: 429, retryAfter: '3600', takesMs: REQUEST_TIMEOUT_MS });
    const outcome = track(newClient().getPage('42'));

    await vi.advanceTimersByTimeAsync(WORST_CASE_MS - 1);
    expect({ requests: requests.length, outcome }).toEqual({ requests: 3, outcome: {} });

    await vi.advanceTimersByTimeAsync(1);
    expect({ requests: requests.length, outcome }).toEqual({
      requests: 3,
      outcome: { settled: 'rejected', value: expect.objectContaining({ name: 'ConfluenceError', statusCode: 429 }) },
    });
    expect(vi.mocked(logger.warn).mock.calls).toEqual([
      [expect.objectContaining({ attempt: 1, delayMs: CEILING_MS }), 'Confluence API transient error, retrying'],
      [expect.objectContaining({ attempt: 2, delayMs: CEILING_MS }), 'Confluence API transient error, retrying'],
    ]);
  });
});
