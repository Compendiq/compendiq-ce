/**
 * Lifecycle regressions for GET /api/pages/:id/presence (#276).
 *
 * This suite exercises a real listening Fastify server, PostgreSQL ACL rows,
 * and Redis pub/sub. It requires the normal integration PostgreSQL plus a
 * directly reachable, non-TLS Redis endpoint (REDIS_URL defaults to
 * redis://localhost:6379). The auth decorator is the only injected boundary.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createConnection,
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from 'node:net';
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import sensible from '@fastify/sensible';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PageLifecycleEventSchema,
  type PageLifecycleEvent,
} from '@compendiq/contracts';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { query } from '../../core/db/postgres.js';
import {
  initPresenceBus,
} from '../../core/services/presence-service.js';
import {
  setRedisClient,
} from '../../core/services/redis-cache.js';
import { prefixedRedisChannel } from '../../core/utils/prefixed-redis-channel.js';
import {
  insertStandalonePage,
  insertUser,
} from './pages.test-helpers.js';
import { pagesPresenceRoutes } from './pages-presence.js';

const [dbAvailable, redisAvailable] = await Promise.all([
  isDbAvailable(),
  isRedisAvailable(),
]);
const canRun = dbAvailable && redisAvailable;
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const lifecycleChannel = prefixedRedisChannel('page:lifecycle');

interface SseFrame {
  event: string;
  data: unknown;
}

interface SseStream {
  frames: SseFrame[];
  close: () => Promise<void>;
}

interface CapturedResponse {
  closed: Promise<void>;
  lateWrites: () => number;
}

// Bound real cross-process network events; success resolves immediately.
// Fake clocks cannot drive the PostgreSQL/Redis/HTTP processes under test.
async function within<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  const timeout = Promise.withResolvers<T>();
  const timer = setTimeout(
    () => timeout.reject(new Error(`Timed out waiting for ${label}`)),
    milliseconds,
  );
  try {
    return await Promise.race([promise, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

async function eventually(
  predicate: () => boolean,
  label: string,
  milliseconds = 2_000,
): Promise<void> {
  // These are real cross-process integration signals. Polling only yields
  // between Redis/network callbacks; the outer deadline is failure containment.
  await within((async () => {
    while (!predicate()) {
      await nextEventLoopTurn();
    }
  })(), milliseconds, label);
}

function lifecycleFrames(stream: SseStream): PageLifecycleEvent[] {
  const events: PageLifecycleEvent[] = [];
  for (const frame of stream.frames) {
    if (frame.event !== 'page_lifecycle') continue;
    const parsed = PageLifecycleEventSchema.safeParse(frame.data);
    if (parsed.success) events.push(parsed.data);
  }
  return events;
}

/**
 * A transparent TCP proxy used only to hold Redis responses. Commands still
 * reach the real Redis server; pausing the upstream sockets gives the initial
 * ZRANGE snapshot a deterministic, externally controlled network barrier.
 */
class RedisResponseBarrier {
  readonly server: Server;
  readonly upstreams = new Set<Socket>();
  readonly downstreams = new Set<Socket>();
  readonly commandBuffers = new Map<Socket, string>();
  readonly trafficWaiters = new Set<{
    needle: string;
    resolve: () => void;
  }>();
  paused = false;
  url = '';

  private constructor(readonly target: URL) {
    this.server = createServer((downstream) => {
      const upstream = createConnection({
        host: target.hostname,
        port: Number(target.port || 6379),
      });
      this.downstreams.add(downstream);
      this.upstreams.add(upstream);
      this.commandBuffers.set(downstream, '');
      if (this.paused) upstream.pause();

      downstream.on('data', (chunk: Buffer) => {
        const prior = this.commandBuffers.get(downstream) ?? '';
        const next = `${prior}${chunk.toString('utf8')}`.slice(-16_384);
        this.commandBuffers.set(downstream, next);
        for (const waiter of [...this.trafficWaiters]) {
          if (!next.includes(waiter.needle)) continue;
          this.trafficWaiters.delete(waiter);
          waiter.resolve();
        }
      });
      downstream.on('error', () => undefined);
      upstream.on('error', () => downstream.destroy());
      downstream.on('close', () => {
        this.downstreams.delete(downstream);
        this.commandBuffers.delete(downstream);
        upstream.destroy();
      });
      upstream.on('close', () => {
        this.upstreams.delete(upstream);
        downstream.destroy();
      });
      downstream.pipe(upstream);
      upstream.pipe(downstream);
    });
  }

  static async start(rawTarget: string): Promise<RedisResponseBarrier> {
    const target = new URL(rawTarget);
    if (target.protocol !== 'redis:') {
      throw new Error('pages-presence lifecycle integration requires a redis:// REDIS_URL');
    }
    const barrier = new RedisResponseBarrier(target);
    const listening = Promise.withResolvers<void>();
    barrier.server.once('error', listening.reject);
    barrier.server.listen(0, '127.0.0.1', () => {
      barrier.server.off('error', listening.reject);
      listening.resolve();
    });
    await listening.promise;
    const address = barrier.server.address();
    if (!address || typeof address === 'string') throw new Error('Redis proxy did not bind');
    const proxy = new URL(target.toString());
    proxy.hostname = '127.0.0.1';
    proxy.port = String((address as AddressInfo).port);
    barrier.url = proxy.toString();
    return barrier;
  }

  pauseResponses(): void {
    this.paused = true;
    for (const upstream of this.upstreams) upstream.pause();
  }

  resumeResponses(): void {
    this.paused = false;
    for (const upstream of this.upstreams) upstream.resume();
  }

  waitForClientTraffic(needle: string): Promise<void> {
    const traffic = Promise.withResolvers<void>();
    this.trafficWaiters.add({ needle, resolve: traffic.resolve });
    return traffic.promise;
  }

  async close(): Promise<void> {
    this.resumeResponses();
    for (const socket of this.downstreams) socket.destroy();
    for (const socket of this.upstreams) socket.destroy();
    if (!this.server.listening) return;
    const closed = Promise.withResolvers<void>();
    this.server.close(() => closed.resolve());
    await closed.promise;
  }
}

describe.skipIf(!canRun)('page presence lifecycle SSE — real PostgreSQL and Redis', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let barrier: RedisResponseBarrier;
  let presenceRedis: RedisClientType;
  let rbacRedis: RedisClientType;
  let publisher: RedisClientType;
  let teardownPresence: () => Promise<void>;

  async function openStream(pageId: number, userId: string): Promise<SseStream> {
    const frames: SseFrame[] = [];
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/pages/${pageId}/presence`, {
      headers: { authorization: `Bearer ${userId}` },
      signal: controller.signal,
    });
    if (response.status !== 200 || !response.body) {
      throw new Error(`SSE connection failed with ${response.status}`);
    }

    const done = (async () => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      try {
        for (;;) {
          const { done: ended, value } = await reader.read();
          if (ended) return;
          buffered += decoder.decode(value, { stream: true });
          const complete = buffered.split('\n\n');
          buffered = complete.pop() ?? '';
          for (const raw of complete) {
            const lines = raw.split('\n');
            const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
            const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
            if (!event || data === undefined) continue;
            try {
              frames.push({ event, data: JSON.parse(data) });
            } catch {
              frames.push({ event, data });
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      }
    })();

    const stream: SseStream = {
      frames,
      close: async () => {
        controller.abort();
        await within(done, 2_000, 'SSE reader shutdown');
      },
    };
    await eventually(
      () => frames.some((frame) => frame.event === 'presence'),
      `initial presence frame for page ${pageId}`,
    );
    return stream;
  }

  async function publishLifecycle(event: PageLifecycleEvent): Promise<void> {
    const parsed = PageLifecycleEventSchema.parse(event);
    await publisher.publish(lifecycleChannel, JSON.stringify(parsed));
  }

  beforeAll(async () => {
    await setupTestDb();
    barrier = await RedisResponseBarrier.start(redisUrl);
    presenceRedis = createClient({
      url: barrier.url,
      socket: { reconnectStrategy: false },
    });
    rbacRedis = createClient({
      url: redisUrl,
      socket: { reconnectStrategy: false },
    });
    publisher = createClient({
      url: redisUrl,
      socket: { reconnectStrategy: false },
    });
    for (const client of [presenceRedis, rbacRedis, publisher]) {
      client.on('error', () => undefined);
    }
    await Promise.all([
      presenceRedis.connect(),
      rbacRedis.connect(),
      publisher.connect(),
    ]);
    setRedisClient(rbacRedis);
    teardownPresence = await initPresenceBus(presenceRedis);

    app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorateRequest('userId', '');
    app.decorate('authenticate', async (request: FastifyRequest) => {
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith('Bearer ')) {
        throw app.httpErrors.unauthorized();
      }
      request.userId = authorization.slice('Bearer '.length);
    });
    await app.register(pagesPresenceRoutes, { prefix: '/api' });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Fastify did not bind');
    baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
  }, 60_000);

  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await app?.close();
    await teardownPresence?.();
    setRedisClient(null);
    await Promise.all(
      [presenceRedis, rbacRedis, publisher]
        .filter((client) => client?.isOpen)
        .map((client) => client.quit()),
    );
    await barrier?.close();
    await teardownTestDb();
  });

  it('forwards only valid named lifecycle events for the readable page and rechecks visibility before disclosing baseline state', async () => {
    const ownerId = await insertUser(`presence-owner-${randomUUID()}`);
    const readerId = await insertUser(`presence-reader-${randomUUID()}`);
    const pageA = await insertStandalonePage('Lifecycle A', 'shared', ownerId, 'LOCAL-A');
    const pageB = await insertStandalonePage('Lifecycle B', 'shared', ownerId, 'LOCAL-B');
    const streamA = await openStream(pageA, readerId);
    const streamB = await openStream(pageB, readerId);
    const ownerStreamA = await openStream(pageA, ownerId);

    try {
      const baselineA = randomUUID();
      await publishLifecycle({
        type: 'page_lifecycle',
        pageId: pageA,
        lifecycleRevision: '1',
        isFrozen: true,
        baselineId: baselineA,
      });
      await eventually(
        () => lifecycleFrames(streamA).some((event) => event.baselineId === baselineA),
        'page A lifecycle event',
      );

      const baselineB = randomUUID();
      await publishLifecycle({
        type: 'page_lifecycle',
        pageId: pageB,
        lifecycleRevision: '2',
        isFrozen: true,
        baselineId: baselineB,
      });
      await eventually(
        () => lifecycleFrames(streamB).some((event) => event.baselineId === baselineB),
        'page B lifecycle event',
      );
      expect(lifecycleFrames(streamA).some((event) => event.pageId === pageB)).toBe(false);
      expect(lifecycleFrames(streamB).some((event) => event.pageId === pageA)).toBe(false);
      expect(streamA.frames.find((frame) => frame.event === 'page_lifecycle')).toMatchObject({
        event: 'page_lifecycle',
      });

      const invalidBaseline = 'not-a-baseline-uuid';
      await publisher.publish(lifecycleChannel, JSON.stringify({
        type: 'page_lifecycle',
        pageId: pageA,
        lifecycleRevision: '3',
        isFrozen: true,
        baselineId: invalidBaseline,
      }));
      await publishLifecycle({
        type: 'page_lifecycle',
        pageId: pageA,
        lifecycleRevision: '4',
        isFrozen: false,
        baselineId: null,
      });
      await eventually(
        () => lifecycleFrames(streamA).some((event) => event.lifecycleRevision === '4'),
        'valid event following an invalid payload',
      );
      expect(streamA.frames.some((frame) => JSON.stringify(frame.data).includes(invalidBaseline))).toBe(false);

      await query(
        "UPDATE pages SET visibility = 'private' WHERE id = $1",
        [pageA],
      );
      const denied = await fetch(`${baseUrl}/api/pages/${pageA}/presence`, {
        headers: { authorization: `Bearer ${readerId}` },
      });
      expect(denied.status).toBe(403);
      await denied.arrayBuffer();

      const revokedBaseline = randomUUID();
      await publishLifecycle({
        type: 'page_lifecycle',
        pageId: pageA,
        lifecycleRevision: '5',
        isFrozen: true,
        baselineId: revokedBaseline,
      });
      await eventually(
        () => lifecycleFrames(ownerStreamA).some((event) => event.baselineId === revokedBaseline),
        'same-page owner delivery after reader visibility revocation',
      );
      // The denied reader callback was registered first for this same event.
      // Yield once after the still-authorized owner's real ACL read and write.
      await nextEventLoopTurn();
      expect(streamA.frames.some((frame) => JSON.stringify(frame.data).includes(revokedBaseline))).toBe(false);
      expect(lifecycleFrames(streamA).some((event) => event.lifecycleRevision === '5')).toBe(false);
    } finally {
      await Promise.all([streamA.close(), streamB.close(), ownerStreamA.close()]);
    }
  }, 15_000);

  it('disconnects during the real Redis viewer snapshot without a later write to the closed response', async () => {
    const ownerId = await insertUser(`presence-pending-owner-${randomUUID()}`);
    const readerId = await insertUser(`presence-pending-reader-${randomUUID()}`);
    const pendingPage = await insertStandalonePage('Pending snapshot', 'shared', ownerId, 'LOCAL-PENDING');
    const control = await openStream(pendingPage, readerId);
    const requestPath = `/api/pages/${pendingPage}/presence`;

    const captureGate = Promise.withResolvers<CapturedResponse>();
    const capturedResponse = captureGate.promise;
    const capture = (request: IncomingMessage, response: ServerResponse): void => {
      if (request.url !== requestPath) return;
      let transportClosed = false;
      let lateWriteCount = 0;
      const closeGate = Promise.withResolvers<void>();
      const closed = closeGate.promise;
      const originalWrite = response.write;
      response.write = function instrumentedWrite(
        this: ServerResponse,
        ...args: Parameters<ServerResponse['write']>
      ): boolean {
        if (transportClosed || response.destroyed) lateWriteCount += 1;
        return Reflect.apply(originalWrite, this, args) as boolean;
      } as ServerResponse['write'];
      response.once('close', () => {
        transportClosed = true;
        closeGate.resolve();
      });
      captureGate.resolve({
        closed,
        lateWrites: () => lateWriteCount,
      });
    };
    app.server.on('request', capture);

    barrier.pauseResponses();
    const snapshotCommand = barrier.waitForClientTraffic(`presence:viewers:${pendingPage}`);
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Fastify server is not listening');
    const socket = createConnection({ host: '127.0.0.1', port: (address as AddressInfo).port });
    socket.on('error', () => undefined);

    try {
      const connected = Promise.withResolvers<void>();
      socket.once('connect', connected.resolve);
      await within(connected.promise, 2_000, 'HTTP connection');
      socket.write([
        `GET ${requestPath} HTTP/1.1`,
        'Host: 127.0.0.1',
        `Authorization: Bearer ${readerId}`,
        'Connection: keep-alive',
        '',
        '',
      ].join('\r\n'));

      const captured = await within(capturedResponse, 2_000, 'captured streaming response');
      await within(snapshotCommand, 2_000, 'blocked Redis viewer snapshot');
      socket.destroy();
      await within(captured.closed, 2_000, 'server-side response close');

      barrier.resumeResponses();
      // PING is queued behind the blocked viewer read on the same Redis
      // connection, so its reply proves the initial snapshot has settled.
      await presenceRedis.ping();
      await publishLifecycle({
        type: 'page_lifecycle',
        pageId: pendingPage,
        lifecycleRevision: '7',
        isFrozen: true,
        baselineId: randomUUID(),
      });
      await eventually(
        () => lifecycleFrames(control).some((event) => event.lifecycleRevision === '7'),
        'same-page lifecycle event after releasing the Redis barrier',
      );
      // The surviving same-page stream proves Redis dispatched this event to
      // the listener set; a stale closed-response listener would run beside it.
      await nextEventLoopTurn();
      expect(captured.lateWrites()).toBe(0);
    } finally {
      barrier.resumeResponses();
      socket.destroy();
      app.server.off('request', capture);
      await control.close();
    }
  }, 15_000);
});
