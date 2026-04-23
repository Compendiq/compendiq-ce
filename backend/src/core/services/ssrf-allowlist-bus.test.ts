/**
 * Unit tests for ssrf-allowlist-bus.ts — direct coverage of the pub/sub
 * glue between the main Redis client and ssrf-guard (issue #306, PR #309
 * review finding #1).
 *
 * The ssrf-guard side is already well-covered via a mock publisher in
 * `ssrf-guard.test.ts`. This file focuses on the bus itself:
 *   - publisher is wired and writes the expected (channel, payload) pair
 *   - subscriber hands incoming messages to applyAllowlistEventLocal
 *   - soft-fail path when subscriber cannot connect
 *   - malformed JSON on the channel does not crash
 *   - teardown unsubscribes + quits and unwires the publisher
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RedisClientType } from 'redis';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { initSsrfAllowlistBus } from './ssrf-allowlist-bus.js';
import {
  addAllowedBaseUrl,
  addAllowedBaseUrlSilent,
  clearAllowedBaseUrls,
  getAllowedBaseUrlCount,
  setSsrfAllowlistPublisher,
  SSRF_ALLOWLIST_CHANNEL,
  validateUrl,
  SsrfError,
} from '../utils/ssrf-guard.js';
import { logger } from '../utils/logger.js';

/**
 * Build a mock main Redis client whose `duplicate()` returns a controllable
 * subscriber client. The returned helper exposes the subscriber mock and the
 * channel handler so tests can simulate incoming messages.
 */
function createMockRedis(opts?: {
  connectRejects?: Error;
  subscribeRejects?: Error;
}) {
  const handlers = new Map<string, (message: string) => void>();
  const errorListeners: Array<(err: Error) => void> = [];

  const subscriber = {
    on: vi.fn((event: string, fn: (err: Error) => void) => {
      if (event === 'error') errorListeners.push(fn);
    }),
    connect: vi.fn(async () => {
      if (opts?.connectRejects) throw opts.connectRejects;
    }),
    subscribe: vi.fn(async (channel: string, handler: (message: string) => void) => {
      if (opts?.subscribeRejects) throw opts.subscribeRejects;
      handlers.set(channel, handler);
    }),
    unsubscribe: vi.fn(async () => {
      handlers.clear();
    }),
    quit: vi.fn(async () => undefined),
  };

  const main = {
    duplicate: vi.fn(() => subscriber),
    publish: vi.fn(async () => 1),
  };

  return {
    main: main as unknown as RedisClientType,
    mainMock: main,
    subscriber,
    /** Simulate a message arriving on the SSRF allowlist channel. */
    emit(channel: string, message: string) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No subscriber for channel ${channel}`);
      handler(message);
    },
    /** Simulate a Redis client error event. */
    emitError(err: Error) {
      for (const fn of errorListeners) fn(err);
    },
  };
}

describe('ssrf-allowlist-bus', () => {
  beforeEach(() => {
    clearAllowedBaseUrls();
    setSsrfAllowlistPublisher(null);
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.debug).mockClear();
  });

  afterEach(() => {
    clearAllowedBaseUrls();
    setSsrfAllowlistPublisher(null);
  });

  describe('publisher wiring', () => {
    it('wires the main client as publisher — addAllowedBaseUrl writes to the right channel with the right payload', async () => {
      const env = createMockRedis();

      const teardown = await initSsrfAllowlistBus(env.main);

      addAllowedBaseUrl('http://10.0.0.5:8090');

      expect(env.mainMock.publish).toHaveBeenCalledTimes(1);
      expect(env.mainMock.publish).toHaveBeenCalledWith(
        SSRF_ALLOWLIST_CHANNEL,
        JSON.stringify({ action: 'add', urls: ['http://10.0.0.5:8090'] }),
      );

      await teardown();
    });
  });

  describe('subscriber behaviour', () => {
    it('invokes applyAllowlistEventLocal on incoming add messages (Pod B sees what Pod A published)', async () => {
      const env = createMockRedis();

      const teardown = await initSsrfAllowlistBus(env.main);

      // Pod A published this payload on Redis; simulate Pod B receiving it.
      env.emit(
        SSRF_ALLOWLIST_CHANNEL,
        JSON.stringify({ action: 'add', urls: ['http://10.0.0.42:8090'] }),
      );

      expect(getAllowedBaseUrlCount()).toBe(1);
      expect(() => validateUrl('http://10.0.0.42:8090/api')).not.toThrow();

      await teardown();
    });

    it('invokes applyAllowlistEventLocal on incoming remove messages', async () => {
      const env = createMockRedis();
      addAllowedBaseUrlSilent('http://10.0.0.42:8090');
      expect(getAllowedBaseUrlCount()).toBe(1);

      const teardown = await initSsrfAllowlistBus(env.main);

      env.emit(
        SSRF_ALLOWLIST_CHANNEL,
        JSON.stringify({ action: 'remove', urls: ['http://10.0.0.42:8090'] }),
      );

      expect(getAllowedBaseUrlCount()).toBe(0);
      expect(() => validateUrl('http://10.0.0.42:8090/api')).toThrow(SsrfError);

      await teardown();
    });

    it('does NOT crash on malformed JSON — logs a warn and keeps running', async () => {
      const env = createMockRedis();

      const teardown = await initSsrfAllowlistBus(env.main);

      expect(() =>
        env.emit(SSRF_ALLOWLIST_CHANNEL, 'not-valid-json{'),
      ).not.toThrow();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'not-valid-json{' }),
        expect.stringContaining('failed to parse event'),
      );

      // After the bad message, the next good message still applies.
      env.emit(
        SSRF_ALLOWLIST_CHANNEL,
        JSON.stringify({ action: 'add', urls: ['http://10.0.0.7:8090'] }),
      );
      expect(getAllowedBaseUrlCount()).toBe(1);

      await teardown();
    });

    it('registers an error listener on the subscriber client', async () => {
      const env = createMockRedis();

      const teardown = await initSsrfAllowlistBus(env.main);

      expect(env.subscriber.on).toHaveBeenCalledWith('error', expect.any(Function));

      // Emitting an error must not throw; it should route to logger.error.
      env.emitError(new Error('transient redis blip'));
      expect(logger.error).toHaveBeenCalled();

      await teardown();
    });
  });

  describe('soft-fail on Redis unavailable', () => {
    it('unwires the publisher and returns a noop teardown when connect() rejects', async () => {
      const env = createMockRedis({ connectRejects: new Error('ECONNREFUSED') });

      const teardown = await initSsrfAllowlistBus(env.main);

      // addAllowedBaseUrl must NOT reach out to Redis (publisher unwired).
      addAllowedBaseUrl('http://10.0.0.9:8090');
      expect(env.mainMock.publish).not.toHaveBeenCalled();

      // Local state still works (single-pod fallback).
      expect(getAllowedBaseUrlCount()).toBe(1);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining('single-pod mode'),
      );

      // Teardown is the noop — must not throw.
      await expect(teardown()).resolves.toBeUndefined();
    });

    it('unwires the publisher when subscribe() rejects', async () => {
      const env = createMockRedis({ subscribeRejects: new Error('NOAUTH') });

      const teardown = await initSsrfAllowlistBus(env.main);

      addAllowedBaseUrl('http://10.0.0.9:8090');
      expect(env.mainMock.publish).not.toHaveBeenCalled();

      await teardown();
    });
  });

  describe('teardown', () => {
    it('unsubscribes and quits the subscriber client on teardown', async () => {
      const env = createMockRedis();

      const teardown = await initSsrfAllowlistBus(env.main);
      await teardown();

      expect(env.subscriber.unsubscribe).toHaveBeenCalledWith(SSRF_ALLOWLIST_CHANNEL);
      expect(env.subscriber.quit).toHaveBeenCalledTimes(1);

      // Publisher is unwired after teardown — no broadcasts on subsequent mutations.
      addAllowedBaseUrl('http://10.0.0.99:8090');
      expect(env.mainMock.publish).not.toHaveBeenCalled();
    });

    it('logs a warn if teardown throws but still unwires the publisher', async () => {
      const env = createMockRedis();
      env.subscriber.unsubscribe.mockRejectedValueOnce(new Error('teardown boom'));

      const teardown = await initSsrfAllowlistBus(env.main);
      await teardown();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining('teardown failed'),
      );

      // Publisher still unwired even though unsubscribe threw.
      addAllowedBaseUrl('http://10.0.0.100:8090');
      expect(env.mainMock.publish).not.toHaveBeenCalled();
    });

    it('second call to initSsrfAllowlistBus is a no-op while first subscriber is alive', async () => {
      const env = createMockRedis();

      const teardownA = await initSsrfAllowlistBus(env.main);
      expect(env.mainMock.duplicate).toHaveBeenCalledTimes(1);

      // Second init must NOT duplicate() again or subscribe again.
      const teardownB = await initSsrfAllowlistBus(env.main);
      expect(env.mainMock.duplicate).toHaveBeenCalledTimes(1);

      // teardownB is the noop (resolves immediately, does not touch subscriber).
      await teardownB();
      expect(env.subscriber.unsubscribe).not.toHaveBeenCalled();

      // teardownA still tears down the real subscriber.
      await teardownA();
      expect(env.subscriber.unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('allows re-init after full teardown (simulates transient disconnect + reconnect)', async () => {
      const envA = createMockRedis();
      const teardownA = await initSsrfAllowlistBus(envA.main);
      await teardownA();

      // After teardown, a fresh init on a new main client must succeed.
      const envB = createMockRedis();
      const teardownB = await initSsrfAllowlistBus(envB.main);

      expect(envB.mainMock.duplicate).toHaveBeenCalledTimes(1);

      // New publisher is wired to envB.
      addAllowedBaseUrl('http://10.0.0.200:8090');
      expect(envB.mainMock.publish).toHaveBeenCalledTimes(1);
      expect(envA.mainMock.publish).not.toHaveBeenCalled();

      await teardownB();
    });
  });
});
