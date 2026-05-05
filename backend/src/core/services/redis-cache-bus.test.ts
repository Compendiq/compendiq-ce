/**
 * Unit tests for redis-cache-bus.ts — a generic cluster-wide cache-bus
 * abstraction introduced for the v0.4 epic (§3.1). Each subscriber treats
 * received messages as invalidation advice only; payloads carry no state.
 *
 * Covers:
 *   - publish JSON-encodes the payload and writes to the correct channel
 *   - subscribe dispatches to all registered handlers on incoming messages
 *   - unsubscribe stops dispatching
 *   - malformed JSON does not crash the subscriber
 *   - onReconnect fires on subsequent 'ready' events (not the first)
 *   - soft-fail path when subscriber init fails (single-pod mode)
 *   - close() unsubscribes, quits, and unwires the publisher
 *   - second init while alive is a no-op
 *   - re-init after full close works
 *
 * The tests mock the redis client; integration testing with a real Redis
 * is handled at a higher layer (feature-specific tests like
 * `ip-allowlist.multi-instance.test.ts` per the v0.4 epic).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RedisClientType } from 'redis';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  initCacheBus,
  publish,
  subscribe,
  onReconnect,
  close,
  isCacheBusActive,
  type CacheBusChannel,
} from './redis-cache-bus.js';
import { logger } from '../utils/logger.js';

function createMockRedis(opts?: {
  connectRejects?: Error;
  subscribeRejects?: Error;
}) {
  const channelHandlers = new Map<string, (message: string) => void>();
  const readyListeners: Array<() => void> = [];
  const errorListeners: Array<(err: Error) => void> = [];

  const subscriber = {
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      if (event === 'ready') readyListeners.push(fn as () => void);
      if (event === 'error') errorListeners.push(fn as (err: Error) => void);
    }),
    connect: vi.fn(async () => {
      if (opts?.connectRejects) throw opts.connectRejects;
    }),
    subscribe: vi.fn(async (channel: string, handler: (message: string) => void) => {
      if (opts?.subscribeRejects) throw opts.subscribeRejects;
      channelHandlers.set(channel, handler);
    }),
    unsubscribe: vi.fn(async (channel?: string) => {
      if (channel) channelHandlers.delete(channel);
      else channelHandlers.clear();
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
    emit(channel: string, message: string) {
      const handler = channelHandlers.get(channel);
      if (!handler) throw new Error(`no subscriber for channel ${channel}`);
      handler(message);
    },
    emitReady() {
      for (const fn of readyListeners) fn();
    },
    emitError(err: Error) {
      for (const fn of errorListeners) fn(err);
    },
    subscribedChannels: () => Array.from(channelHandlers.keys()),
  };
}

describe('redis-cache-bus', () => {
  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.debug).mockClear();
  });

  afterEach(async () => {
    await close();
  });

  describe('initialization', () => {
    it('duplicates the main client, connects the subscriber, and marks the bus active', async () => {
      const env = createMockRedis();

      await initCacheBus(env.main);

      expect(env.mainMock.duplicate).toHaveBeenCalledTimes(1);
      expect(env.subscriber.connect).toHaveBeenCalledTimes(1);
      expect(isCacheBusActive()).toBe(true);
    });

    it('second init while alive is a no-op — does not duplicate or reconnect', async () => {
      const env = createMockRedis();

      await initCacheBus(env.main);
      await initCacheBus(env.main);

      expect(env.mainMock.duplicate).toHaveBeenCalledTimes(1);
      expect(env.subscriber.connect).toHaveBeenCalledTimes(1);
    });

    it('re-init after close works (simulates transient disconnect + fresh client)', async () => {
      const envA = createMockRedis();
      await initCacheBus(envA.main);
      await close();

      expect(isCacheBusActive()).toBe(false);

      const envB = createMockRedis();
      await initCacheBus(envB.main);

      expect(envB.mainMock.duplicate).toHaveBeenCalledTimes(1);
      expect(isCacheBusActive()).toBe(true);
    });
  });

  describe('publish / subscribe', () => {
    it('publish JSON-encodes the payload and writes to the correct channel on the main client', async () => {
      const env = createMockRedis();
      await initCacheBus(env.main);

      await publish('ip_allowlist:changed', { at: 1_700_000_000_000 });

      expect(env.mainMock.publish).toHaveBeenCalledTimes(1);
      expect(env.mainMock.publish).toHaveBeenCalledWith(
        'ip_allowlist:changed',
        JSON.stringify({ at: 1_700_000_000_000 }),
      );
    });

    it('subscribe registers the channel on the redis subscriber on first handler', async () => {
      const env = createMockRedis();
      await initCacheBus(env.main);

      subscribe('ip_allowlist:changed', () => {});

      expect(env.subscriber.subscribe).toHaveBeenCalledWith(
        'ip_allowlist:changed',
        expect.any(Function),
      );
    });

    it('subscribe does NOT re-register the redis channel when a second handler is added', async () => {
      const env = createMockRedis();
      await initCacheBus(env.main);

      subscribe('ip_allowlist:changed', () => {});
      subscribe('ip_allowlist:changed', () => {});

      expect(env.subscriber.subscribe).toHaveBeenCalledTimes(1);
    });

    it('dispatches incoming messages to all handlers registered for the channel', async () => {
      const env = createMockRedis();
      await initCacheBus(env.main);

      const h1 = vi.fn();
      const h2 = vi.fn();
      subscribe('ip_allowlist:changed', h1);
      subscribe('ip_allowlist:changed', h2);

      env.emit('ip_allowlist:changed', JSON.stringify({ at: 42 }));

      expect(h1).toHaveBeenCalledWith({ at: 42 });
      expect(h2).toHaveBeenCalledWith({ at: 42 });
    });

    it('does not dispatch to handlers on other channels', async () => {
      const env = createMockRedis();
      await initCacheBus(env.main);

      const handler = vi.fn();
      subscribe('ip_allowlist:changed', handler);
      subscribe('license:changed', () => {});

      env.emit('license:changed', JSON.stringify({ at: 1 }));

      expect(handler).not.toHaveBeenCalled();
    });

    it('unsubscribe stops the handler from firing; remaining handlers still fire', async () => {
      const env = createMockRedis();
      await initCacheBus(env.main);

      const h1 = vi.fn();
      const h2 = vi.fn();
      const unsub1 = subscribe('ip_allowlist:changed', h1);
      subscribe('ip_allowlist:changed', h2);

      unsub1();
      env.emit('ip_allowlist:changed', JSON.stringify({ at: 1 }));

      expect(h1).not.toHaveBeenCalled();
      expect(h2).toHaveBeenCalled();
    });

    it('malformed JSON on the channel does not throw — logs a warn', async () => {
      const env = createMockRedis();
      await initCacheBus(env.main);

      const handler = vi.fn();
      subscribe('ip_allowlist:changed', handler);

      expect(() => env.emit('ip_allowlist:changed', 'not-valid-json{')).not.toThrow();
      expect(handler).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('a throwing handler does not prevent other handlers from firing', async () => {
      const env = createMockRedis();
      await initCacheBus(env.main);

      const throwing = vi.fn(() => {
        throw new Error('boom');
      });
      const good = vi.fn();
      subscribe('ip_allowlist:changed', throwing);
      subscribe('ip_allowlist:changed', good);

      expect(() =>
        env.emit('ip_allowlist:changed', JSON.stringify({ at: 1 })),
      ).not.toThrow();
      expect(good).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('onReconnect', () => {
    it('skips the first ready event (initial connect) — onReconnect listeners do not fire', async () => {
      const env = createMockRedis();
      await initCacheBus(env.main);

      const handler = vi.fn();
      onReconnect(handler);

      env.emitReady();

      expect(handler).not.toHaveBeenCalled();
    });

    it('fires registered handlers on a subsequent ready event (post-reconnect)', async () => {
      const env = createMockRedis();
      await initCacheBus(env.main);

      env.emitReady(); // "initial connect" sentinel

      const handler = vi.fn();
      onReconnect(handler);

      env.emitReady(); // reconnect

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('fires multiple reconnect handlers independently; a throwing one does not block others', async () => {
      const env = createMockRedis();
      await initCacheBus(env.main);

      env.emitReady(); // skip initial

      const throwing = vi.fn(() => {
        throw new Error('boom');
      });
      const good = vi.fn();
      onReconnect(throwing);
      onReconnect(good);

      env.emitReady();

      expect(good).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('onReconnect returns an unsubscribe that removes the handler', async () => {
      const env = createMockRedis();
      await initCacheBus(env.main);

      env.emitReady(); // skip initial

      const handler = vi.fn();
      const off = onReconnect(handler);
      off();

      env.emitReady();
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('soft-fail on Redis unavailable', () => {
    it('logs a warn and marks bus inactive when connect() rejects', async () => {
      const env = createMockRedis({ connectRejects: new Error('ECONNREFUSED') });

      await initCacheBus(env.main);

      expect(isCacheBusActive()).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining('single-pod mode'),
      );
    });

    it('publish in single-pod mode is a no-op — does not throw, does not hit Redis', async () => {
      const env = createMockRedis({ connectRejects: new Error('ECONNREFUSED') });
      await initCacheBus(env.main);

      await expect(publish('ip_allowlist:changed', { at: 1 })).resolves.toBeUndefined();
      expect(env.mainMock.publish).not.toHaveBeenCalled();
    });

    it('subscribe in single-pod mode returns a noop unsubscribe — handler never fires', async () => {
      const env = createMockRedis({ subscribeRejects: new Error('NOAUTH') });
      await initCacheBus(env.main);

      const handler = vi.fn();
      const off = subscribe('ip_allowlist:changed', handler);

      // Should be a callable noop
      expect(() => off()).not.toThrow();
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('close', () => {
    it('unsubscribes all channels, quits the subscriber, marks bus inactive', async () => {
      const env = createMockRedis();
      await initCacheBus(env.main);

      subscribe('ip_allowlist:changed', () => {});
      subscribe('license:changed', () => {});

      await close();

      expect(env.subscriber.quit).toHaveBeenCalledTimes(1);
      expect(isCacheBusActive()).toBe(false);
    });

    it('close while not initialised is a safe no-op', async () => {
      await expect(close()).resolves.toBeUndefined();
      expect(isCacheBusActive()).toBe(false);
    });

    it('publish after close is a no-op', async () => {
      const env = createMockRedis();
      await initCacheBus(env.main);
      await close();

      await publish('ip_allowlist:changed', { at: 1 });
      expect(env.mainMock.publish).not.toHaveBeenCalled();
    });
  });

  describe('subscriber error event', () => {
    it('logs subscriber client errors but does not crash', async () => {
      const env = createMockRedis();
      await initCacheBus(env.main);

      env.emitError(new Error('transient redis blip'));

      expect(logger.error).toHaveBeenCalled();
      expect(isCacheBusActive()).toBe(true);
    });
  });

  describe('type narrowing', () => {
    it('CacheBusChannel union accepts every channel named in epic §3.1', () => {
      // Compile-time check — if this file compiles, the type union matches the plan.
      const channels: CacheBusChannel[] = [
        'provider:cache:bump',
        'provider:deleted',
        'admin:llm:settings',
        'ip_allowlist:changed',
        'confluence:allowlist:changed',
        'sync:conflict:policy:changed',
        'license:changed',
      ];
      expect(channels).toHaveLength(7);
    });
  });

  describe('malformed main client', () => {
    // Regression: previously `main.duplicate()` was called outside the try/catch,
    // so a mock client without `duplicate()` threw a TypeError at init time
    // (broke every test in app.test.ts). Init must soft-fail like any other
    // subscriber-setup failure.
    it('soft-fails to single-pod mode when main has no duplicate() method', async () => {
      const bogusMain = { publish: vi.fn() } as unknown as RedisClientType;

      await expect(initCacheBus(bogusMain)).resolves.toBeTypeOf('function');

      expect(isCacheBusActive()).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining('single-pod mode'),
      );
    });

    it('soft-fails when duplicate() itself throws synchronously', async () => {
      const throwingMain = {
        duplicate: vi.fn(() => {
          throw new Error('synchronous boom');
        }),
        publish: vi.fn(),
      } as unknown as RedisClientType;

      await initCacheBus(throwingMain);

      expect(isCacheBusActive()).toBe(false);
    });
  });
});
