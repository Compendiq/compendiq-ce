/**
 * #1775 — `POST /api/sync` holds the deployment-global `sync:worker:lock`.
 *
 * PostgreSQL, Redis, the sync pipeline and a real `ConfluenceClient` talking
 * to the HTTP fixture below are real; only authentication is stubbed. The
 * fixture parks every space listing on a gate, which holds a run open at a
 * known point (lock held, status `syncing`) while a case probes the route,
 * the relocate guard and the scheduler. Each seeded user has its own PAT, so a
 * listing the fixture receives names the user whose run sent it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import sensible from '@fastify/sensible';
import { createClient, type RedisClientType } from 'redis';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
  waitForDatabaseCondition,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { getPool, query } from '../../core/db/postgres.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { encryptPat } from '../../core/utils/crypto.js';
import {
  getSyncStatus,
  runScheduledSync,
  setSyncStatus,
} from '../../domains/confluence/services/sync-service.js';
import { syncRoutes } from './sync.js';
import { pagesRelocateRoutes } from '../knowledge/pages-relocate.js';

// The attachment stores resolve ATTACHMENTS_DIR at call time.
const attachmentsRoot = await mkdtemp(join(tmpdir(), 'sync-manual-lock-'));
process.env.ATTACHMENTS_DIR = attachmentsRoot;

const [dbAvailable, redisAvailable] = await Promise.all([isDbAvailable(), isRedisAvailable()]);

const LOCK = 'sync:worker:lock';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `SYNC_LOCK_RENEW_INTERVAL_MS` in sync-service.ts: a third of the 600 s TTL. */
const RENEW_INTERVAL_MS = 200_000;
const SPACES = [
  { key: 'CONF', name: 'Conf', type: 'global', status: 'current' },
  { key: 'OTHER', name: 'Other', type: 'global', status: 'current' },
];

interface SeededUser {
  id: string;
  pat: string;
}

/** Confluence fixture state, reset before every case. */
const fixture = {
  /** Every space listing waits on this until the case resolves it. */
  gate: Promise.withResolvers<void>(),
  listingStatus: 200 as 200 | 401,
  /** `Authorization` header of every space listing, in arrival order. */
  listingAuth: [] as string[],
  listingWaiters: new Map<number, PromiseWithResolvers<void>>(),
};

/** Resolves once the fixture has received its `n`-th space listing. */
function listing(n: number): Promise<void> {
  if (fixture.listingAuth.length >= n) return Promise.resolve();
  let waiter = fixture.listingWaiters.get(n);
  if (!waiter) {
    waiter = Promise.withResolvers<void>();
    fixture.listingWaiters.set(n, waiter);
  }
  return waiter.promise;
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://fixture.test');
  if (request.method === 'GET' && url.pathname === '/rest/api/space') {
    fixture.listingAuth.push(String(request.headers.authorization));
    fixture.listingWaiters.get(fixture.listingAuth.length)?.resolve();
    await fixture.gate.promise;
    if (fixture.listingStatus === 401) {
      json(response, 401, { message: 'PAT rejected' });
      return;
    }
    json(response, 200, { results: SPACES, start: 0, limit: 100, size: SPACES.length, _links: {} });
    return;
  }
  // Full, incremental (CQL) and reconciliation listings of an empty space.
  if (
    request.method === 'GET' &&
    (url.pathname === '/rest/api/content' || url.pathname === '/rest/api/content/search')
  ) {
    json(response, 200, {
      results: [],
      start: 0,
      limit: Number(url.searchParams.get('limit') ?? 50),
      size: 0,
      _links: {},
    });
    return;
  }
  json(response, 404, { message: `Fixture route not found: ${request.method} ${url.pathname}` });
}

const server: Server = createServer((request, response) => {
  void handle(request, response);
});

describe.skipIf(!dbAvailable || !redisAvailable)('POST /api/sync and the sync worker lock (#1775)', () => {
  let app: FastifyInstance;
  let redis: RedisClientType;
  let fixtureBaseUrl = '';
  /** Users whose run started in the current case; `afterEach` waits for them. */
  let ranUsers: string[] = [];

  async function seedUser(
    { spaces = [], enabled = true }: { spaces?: string[]; enabled?: boolean } = {},
  ): Promise<SeededUser> {
    const username = `sync-lock-${randomUUID()}`;
    const pat = `pat-${username}`;
    const user = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role)
       VALUES ($1, 'unused', 'user')
       RETURNING id`,
      [username],
    );
    const id = user.rows[0]!.id;
    await query(
      `INSERT INTO user_settings (user_id, confluence_url, confluence_pat, confluence_enabled)
       VALUES ($1, $2, $3, $4)`,
      [id, fixtureBaseUrl, encryptPat(pat), enabled],
    );
    if (spaces.length > 0) {
      const role = await query<{ id: number }>(
        `INSERT INTO roles (name, display_name, permissions)
         VALUES ($1, 'Sync lock reader', ARRAY['read'])
         RETURNING id`,
        [`sync-lock-reader-${randomUUID()}`],
      );
      for (const spaceKey of spaces) {
        await query(
          `INSERT INTO spaces (space_key, space_name) VALUES ($1, $2)
           ON CONFLICT (space_key) DO NOTHING`,
          [spaceKey, spaceKey],
        );
        await query(
          `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
           VALUES ($1, 'user', $2, $3)`,
          [spaceKey, id, role.rows[0]!.id],
        );
      }
    }
    return { id, pat };
  }

  async function postSync(user: SeededUser): Promise<LightMyRequestResponse> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sync',
      headers: { 'x-test-user': user.id },
    });
    if (response.statusCode === 200 && response.json().message === 'Sync started') {
      ranUsers.push(user.id);
    }
    return response;
  }

  async function statusOf(user: SeededUser): Promise<unknown> {
    const response = await app.inject({
      method: 'GET',
      url: '/api/sync/status',
      headers: { 'x-test-user': user.id },
    });
    return response.json();
  }

  async function auditCount(userId: string, action: string): Promise<number> {
    const result = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit_log WHERE user_id = $1 AND action = $2',
      [userId, action],
    );
    return result.rows[0]!.n;
  }

  /** Open the gate and wait until no run of this case is still in flight. */
  async function settle(): Promise<void> {
    fixture.gate.resolve();
    await vi.waitFor(
      async () => {
        expect(await redis.get(LOCK)).toBeNull();
        for (const userId of ranUsers) {
          expect(['idle', 'error']).toContain((await getSyncStatus(userId)).status);
        }
      },
      { timeout: 10_000, interval: 50 },
    );
  }

  beforeAll(async () => {
    await setupTestDb();
    const listening = Promise.withResolvers<void>();
    server.once('error', listening.reject);
    server.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Confluence fixture did not bind TCP');
    fixtureBaseUrl = `http://127.0.0.1:${address.port}`;

    redis = createClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: false, connectTimeout: 1_000 },
    }) as RedisClientType;
    redis.on('error', () => undefined);
    await redis.connect();
    setRedisClient(redis);

    app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate(
      'authenticate',
      async (request: { headers: Record<string, unknown>; userId?: string; userRole?: string; userCan?: unknown }) => {
        request.userId = String(request.headers['x-test-user']);
        request.userRole = 'user';
        request.userCan = async () => true;
      },
    );
    app.decorate('redis', redis);
    await app.register(syncRoutes, { prefix: '/api' });
    await app.register(pagesRelocateRoutes, { prefix: '/api' });
    await app.ready();
  }, 30_000);

  beforeEach(async () => {
    ranUsers = [];
    fixture.gate = Promise.withResolvers<void>();
    fixture.listingStatus = 200;
    fixture.listingAuth = [];
    fixture.listingWaiters.clear();
    await truncateAllTables();
    await redis.flushDb();
  });

  afterEach(async () => {
    vi.useRealTimers();
    setRedisClient(redis);
    await settle();
  });

  afterAll(async () => {
    fixture.gate.resolve();
    await app?.close();
    setRedisClient(null);
    if (redis?.isOpen) await redis.quit();
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close((error) => (error ? closed.reject(error) : closed.resolve()));
    await closed.promise;
    await teardownTestDb();
    await rm(attachmentsRoot, { recursive: true, force: true });
  });

  describe('preserved behaviour', () => {
    it('answers 200 "Confluence integration is disabled" without a status flip, an audit row or a lock claim, even while another run holds the lock', async () => {
      const user = await seedUser({ spaces: ['CONF'], enabled: false });
      await redis.set(LOCK, 'foreign-holder', { EX: 600 });
      try {
        const response = await postSync(user);

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          message: 'Confluence integration is disabled',
          status: { userId: user.id, status: 'idle' },
        });
        expect(await redis.get(LOCK)).toBe('foreign-holder');
        expect(await statusOf(user)).toEqual({ userId: user.id, status: 'idle' });
        expect(await auditCount(user.id, 'SYNC_STARTED')).toBe(0);
        expect(fixture.listingAuth).toEqual([]);
      } finally {
        await redis.del(LOCK);
      }
    });

    it("answers 409 { message, status } on the caller's own syncing status without claiming the lock", async () => {
      const user = await seedUser({ spaces: ['CONF'] });
      await setSyncStatus(user.id, { userId: user.id, status: 'syncing' });

      const response = await postSync(user);

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        message: 'Sync already in progress',
        status: { userId: user.id, status: 'syncing' },
      });
      expect(await redis.get(LOCK)).toBeNull();
      expect(await auditCount(user.id, 'SYNC_STARTED')).toBe(0);
      expect(fixture.listingAuth).toEqual([]);
    });

    it('starts an unlocked run when no Redis client is configured (existing fallback)', async () => {
      const user = await seedUser({ spaces: ['CONF'] });
      setRedisClient(null);
      try {
        const response = await postSync(user);

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          message: 'Sync started',
          status: { userId: user.id, status: 'syncing' },
        });
        await listing(1);
        expect(await redis.get(LOCK)).toBeNull();

        fixture.gate.resolve();
        await vi.waitFor(
          async () => {
            expect((await getSyncStatus(user.id)).status).toBe('idle');
            expect(await auditCount(user.id, 'SYNC_COMPLETED')).toBe(1);
          },
          { timeout: 10_000 },
        );
        expect(await auditCount(user.id, 'SYNC_STARTED')).toBe(1);
      } finally {
        setRedisClient(redis);
      }
    });

    it("answers 200 \"Sync started\" with status syncing, dispatches the caller's run and audits SYNC_STARTED with the request and SYNC_COMPLETED without it", async () => {
      const user = await seedUser({ spaces: ['CONF'] });

      const response = await postSync(user);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        message: 'Sync started',
        status: { userId: user.id, status: 'syncing' },
      });
      await listing(1);
      expect(await statusOf(user)).toEqual({ userId: user.id, status: 'syncing' });
      expect(fixture.listingAuth).toEqual([`Bearer ${user.pat}`]);

      fixture.gate.resolve();
      await vi.waitFor(
        async () => {
          expect((await getSyncStatus(user.id)).status).toBe('idle');
          expect(await auditCount(user.id, 'SYNC_COMPLETED')).toBe(1);
        },
        { timeout: 10_000 },
      );
      const audit = await query<{ action: string; ip_address: string | null }>(
        'SELECT action, ip_address FROM audit_log WHERE user_id = $1 ORDER BY created_at',
        [user.id],
      );
      expect(audit.rows).toEqual([
        { action: 'SYNC_STARTED', ip_address: '127.0.0.1' },
        { action: 'SYNC_COMPLETED', ip_address: null },
      ]);
    });
  });

  describe('worker lock', () => {
    it('answers exactly one of two concurrent manual syncs with 409 and starts one run', async () => {
      const user = await seedUser({ spaces: ['CONF'] });
      // Park both requests between their own-status check and the claim (the
      // window F10 measured): nothing earlier in the request path reads
      // user_settings, and `isConfluenceEnabled` does.
      const blocker = await getPool().connect();
      let committed = false;
      let responses: LightMyRequestResponse[];
      try {
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE user_settings IN ACCESS EXCLUSIVE MODE');
        const pending = [postSync(user), postSync(user)];
        const parked = await waitForDatabaseCondition(async () => {
          const waiting = await query<{ n: number }>(
            `SELECT count(*)::int AS n
               FROM pg_stat_activity
              WHERE datname = current_database()
                AND pid <> pg_backend_pid()
                AND wait_event_type = 'Lock'
                AND query LIKE '%FROM user_settings%'`,
          );
          return waiting.rows[0]!.n === 2;
        });
        await blocker.query('COMMIT');
        committed = true;
        expect(parked).toBe(true);
        responses = await Promise.all(pending);
      } finally {
        if (!committed) await blocker.query('ROLLBACK');
        blocker.release();
      }

      expect(responses.map((response) => response.statusCode).sort((a, b) => a - b)).toEqual([200, 409]);
      const refused = responses.find((response) => response.statusCode === 409)!;
      expect(refused.json()).toEqual({
        message: 'Sync already in progress',
        status: { userId: user.id, status: 'idle' },
      });
      expect(await auditCount(user.id, 'SYNC_STARTED')).toBe(1);
      await listing(1);
      await settle();
      expect(fixture.listingAuth).toEqual([`Bearer ${user.pat}`]);
    });

    it('refuses relocate with 409 while a manual sync holds the worker lock', async () => {
      const user = await seedUser({ spaces: ['CONF'] });
      expect((await postSync(user)).statusCode).toBe(200);
      await listing(1);

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/999999/relocate',
        headers: { 'x-test-user': user.id },
        payload: {
          target: 'confluence',
          spaceKey: 'CONF',
          acknowledgeAccessChange: true,
          acknowledgeDiscardedVersions: 0,
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().message).toContain('sync is currently running');
    });

    it('refuses a manual sync with 409 { message, status } while the scheduled worker holds the lock', async () => {
      const scheduledUser = await seedUser({ spaces: ['CONF'] });
      // Credentials but no space assignment: the scheduler's user query skips it.
      const user = await seedUser();
      ranUsers.push(scheduledUser.id);
      const scheduled = runScheduledSync();
      await listing(1);
      const holder = await redis.get(LOCK);

      const response = await postSync(user);

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        message: 'Sync already in progress',
        status: { userId: user.id, status: 'idle' },
      });
      expect(await redis.get(LOCK)).toBe(holder);
      expect(await statusOf(user)).toEqual({ userId: user.id, status: 'idle' });
      expect(await auditCount(user.id, 'SYNC_STARTED')).toBe(0);

      fixture.gate.resolve();
      await expect(scheduled).resolves.toBe(1);
      expect(await redis.get(LOCK)).toBeNull();
      expect(fixture.listingAuth).toEqual([`Bearer ${scheduledUser.pat}`]);
    });

    it("refuses another user's manual sync while a manual run holds the deployment-global lock", async () => {
      const first = await seedUser({ spaces: ['CONF'] });
      const second = await seedUser({ spaces: ['OTHER'] });
      expect((await postSync(first)).statusCode).toBe(200);
      await listing(1);
      const holder = await redis.get(LOCK);

      const response = await postSync(second);

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        message: 'Sync already in progress',
        status: { userId: second.id, status: 'idle' },
      });
      expect(await statusOf(second)).toEqual({ userId: second.id, status: 'idle' });
      expect(await auditCount(second.id, 'SYNC_STARTED')).toBe(0);
      expect(await redis.get(LOCK)).toBe(holder);

      await settle();
      expect(fixture.listingAuth).toEqual([`Bearer ${first.pat}`]);
    });

    it('holds the lock for the whole manual run and releases it in the background finally after SYNC_COMPLETED', async () => {
      const user = await seedUser({ spaces: ['CONF'] });
      expect((await postSync(user)).statusCode).toBe(200);
      await listing(1);

      expect(await redis.get(LOCK)).toEqual(expect.stringMatching(UUID));
      const ttl = await redis.ttl(LOCK);
      expect(ttl).toBeGreaterThan(590);
      expect(ttl).toBeLessThanOrEqual(600);

      fixture.gate.resolve();
      await vi.waitFor(async () => expect(await redis.get(LOCK)).toBeNull(), { timeout: 10_000 });
      // Release is the run's last step, so the completion row already exists.
      expect(await auditCount(user.id, 'SYNC_COMPLETED')).toBe(1);

      await vi.waitFor(async () => expect((await getSyncStatus(user.id)).status).toBe('idle'), {
        timeout: 10_000,
      });
      expect((await postSync(user)).statusCode).toBe(200);
    });

    it('releases the lock in the background finally when the sync throws', async () => {
      const user = await seedUser({ spaces: ['CONF'] });
      fixture.listingStatus = 401;
      expect((await postSync(user)).statusCode).toBe(200);
      await listing(1);
      expect(await redis.get(LOCK)).toEqual(expect.stringMatching(UUID));

      fixture.gate.resolve();
      await vi.waitFor(async () => expect(await redis.get(LOCK)).toBeNull(), { timeout: 10_000 });
      expect(await getSyncStatus(user.id)).toMatchObject({ status: 'error', error: 'Invalid or expired PAT' });
      expect(await auditCount(user.id, 'SYNC_COMPLETED')).toBe(0);

      fixture.listingStatus = 200;
      expect((await postSync(user)).statusCode).toBe(200);
    });

    it("renews the manual run's lock every SYNC_LOCK_RENEW_INTERVAL_MS and stops renewing once the run settles", async () => {
      const user = await seedUser({ spaces: ['CONF'] });
      // Only the interval timers are faked: Redis, Postgres and HTTP keep their
      // real timers. Nothing below advances the fake clock before the two
      // explicit advances, so the interval is due at exactly RENEW_INTERVAL_MS.
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      try {
        expect((await postSync(user)).statusCode).toBe(200);
        await listing(1);
        const lockId = await redis.get(LOCK);
        expect(lockId).toEqual(expect.stringMatching(UUID));

        // As if most of the TTL had elapsed. The app shares this connection, so
        // a renewal fired by an advance is applied before the next read.
        await redis.pExpire(LOCK, 30_000);
        await vi.advanceTimersByTimeAsync(RENEW_INTERVAL_MS - 1);
        expect(await redis.pTTL(LOCK)).toBeLessThanOrEqual(30_000);
        await vi.advanceTimersByTimeAsync(1);
        expect(await redis.pTTL(LOCK)).toBeGreaterThan(590_000);

        fixture.gate.resolve();
        await vi.waitFor(async () => expect(await redis.get(LOCK)).toBeNull(), { timeout: 10_000 });
        // A heartbeat that outlived the run would re-extend this.
        await redis.set(LOCK, lockId!, { PX: 30_000 });
        await vi.advanceTimersByTimeAsync(2 * RENEW_INTERVAL_MS);
        expect(await redis.pTTL(LOCK)).toBeLessThanOrEqual(30_000);
        await redis.del(LOCK);
      } finally {
        vi.useRealTimers();
      }
    });

    it('refuses with 409 and leaves the status untouched when the claim errors (fail-closed, as the scheduler)', async () => {
      const user = await seedUser({ spaces: ['CONF'] });
      const closed = createClient({
        url: process.env.REDIS_URL,
        socket: { reconnectStrategy: false, connectTimeout: 1_000 },
      }) as RedisClientType;
      closed.on('error', () => undefined);
      await closed.connect();
      await closed.quit();
      setRedisClient(closed);
      try {
        const response = await postSync(user);

        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({
          message: 'Sync already in progress',
          status: { userId: user.id, status: 'idle' },
        });
        expect((await getSyncStatus(user.id)).status).toBe('idle');
        expect(await auditCount(user.id, 'SYNC_STARTED')).toBe(0);
        expect(fixture.listingAuth).toEqual([]);
      } finally {
        setRedisClient(redis);
      }
    });

    it('makes the scheduler skip its cycle while a manual run holds the lock', async () => {
      const user = await seedUser({ spaces: ['CONF'] });
      expect((await postSync(user)).statusCode).toBe(200);
      await listing(1);

      const scheduled = runScheduledSync();
      const first = await Promise.race([
        scheduled.then((synced) => `returned ${synced}`),
        listing(2).then(() => 'second listing'),
      ]);

      expect(first).toBe('returned 0');
      fixture.gate.resolve();
      await scheduled;
      await settle();
      expect(fixture.listingAuth).toEqual([`Bearer ${user.pat}`]);
    });
  });
});
