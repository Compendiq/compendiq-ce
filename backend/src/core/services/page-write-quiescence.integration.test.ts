/**
 * Bounded runtime quiescence (#1934) against real PostgreSQL and Redis.
 *
 * Quiescence closes this process's write gate for the rest of its life, so
 * every test runs on a replica: fresh module instances (its own runtime id,
 * pool, local admissions and gate) loaded after `vi.resetModules()`, exactly
 * like `body-text-backfill.integration.test.ts`. Nothing a test quiesces can
 * reach another test or file.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { createClient, type RedisClientType } from 'redis';
import type { WebSocket } from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { getPool, query } from '../db/postgres.js';
import type * as AdmissionModule from './page-write-admission.js';
import type * as CollabModule from './collab-room-service.js';
import type * as PersistModule from './collab-persistence.js';
import type * as PostgresModule from '../db/postgres.js';
import type * as LoggerModule from '../utils/logger.js';

const canRun = (await isDbAvailable()) && (await isRedisAvailable());

type OwnCommitKind = 'collab.commit.confluence' | 'collab.commit.confluence.media';

type Replica = {
  admission: typeof AdmissionModule;
  collab: typeof CollabModule;
  persist: typeof PersistModule;
  pg: typeof PostgresModule;
  logger: typeof LoggerModule.logger;
  runtime: CollabModule.CollabRuntime;
  runtimeId: string;
};

let main: RedisClientType;
let ADMIN: string;
let WRITER: string;
const replicas: Replica[] = [];
const usedPageIds: number[] = [];

/** Bound timings for the real-time tests; fake-timer tests keep the production defaults. */
const FAST = { bound: 400, budget: 5_000, reclassify: 200 };

async function replica(timing?: typeof FAST): Promise<Replica> {
  // Constants are read at module load: set them first, restore them after.
  vi.stubEnv('COLLAB_EMPTY_ROOM_GRACE_MS', '600000');
  vi.stubEnv('PAGE_WRITER_QUIESCE_OWN_COMMIT_WAIT_MS', timing ? String(timing.bound) : undefined);
  vi.stubEnv('PAGE_WRITER_QUIESCE_CLASSIFY_BUDGET_MS', timing ? String(timing.budget) : undefined);
  vi.stubEnv('PAGE_WRITER_QUIESCE_RECLASSIFY_MS', timing ? String(timing.reclassify) : undefined);
  // Dynamic on purpose: each replica needs fresh module instances.
  vi.resetModules();
  const pg = await import('../db/postgres.js');
  const redisCache = await import('./redis-cache.js');
  const admission = await import('./page-write-admission.js');
  const collab = await import('./collab-room-service.js');
  const persist = await import('./collab-persistence.js');
  const { logger } = await import('../utils/logger.js');
  vi.resetModules();
  vi.unstubAllEnvs();
  // The pool's idle and connect timers would otherwise run on the fake clock
  // and close or time out real connections while a test advances it.
  pg.getPool().options.idleTimeoutMillis = 0;
  pg.getPool().options.connectionTimeoutMillis = 0;
  redisCache.setRedisClient(main);
  const runtime = await collab.createCollabRuntime(main, `quiesce-${randomUUID()}`);
  const created: Replica = {
    admission, collab, persist, pg, logger, runtime, runtimeId: await admission.getPageWriterRuntimeId(),
  };
  replicas.push(created);
  return created;
}

function stubWs(): WebSocket {
  return { readyState: 1, send() {}, close() {} } as unknown as WebSocket;
}

async function insertUser(role: 'admin' | 'user'): Promise<string> {
  const id = randomUUID();
  await query(
    `INSERT INTO users (id, username, email, password_hash, role)
     VALUES ($1, $2, $3, 'x', $4)`,
    [id, `quiesce-${id}`, `quiesce-${id}@test.invalid`, role],
  );
  return id;
}

async function insertPage(): Promise<number> {
  const page = await query<{ id: number }>(
    `INSERT INTO pages (title, body_html, body_text, source, visibility, created_by_user_id)
     VALUES ('Quiescence', '<p>seed</p>', 'seed', 'standalone', 'shared', $1)
     RETURNING id`,
    [WRITER],
  );
  usedPageIds.push(page.rows[0]!.id);
  return page.rows[0]!.id;
}

/**
 * The issue's probe: a collaborative Save reserves its page's own commit and
 * its provider call fails after dispatch. For `.media` an image upload
 * completed first, then `updatePage` failed.
 */
async function failedOwnCommit(
  r: Replica,
  pageId: number,
  kind: OwnCommitKind = 'collab.commit.confluence',
): Promise<AdmissionModule.PageWriteIntent> {
  const intent = await r.admission.reservePageWriteIntent({
    pageIds: [pageId],
    kind,
    actorId: WRITER,
    effect: {
      effectClass: 'remote',
      pageId,
      confluenceId: `cf-${pageId}`,
      expectedRemoteVersion: '4',
      intendedStateDigest: 'a'.repeat(64),
      ...(kind === 'collab.commit.confluence.media'
        ? { images: [{ filename: 'pasted.png', mimeType: 'image/png', size: 4, contentSha256: 'b'.repeat(64) }] }
        : {}),
    },
  });
  if (kind === 'collab.commit.confluence.media') {
    await r.admission.runPageWriteIntentEffect(
      intent,
      { kind: 'remote', completesRemoteWork: false },
      async () => ({ attachmentId: 'att-uploaded' }),
    );
  }
  await expect(r.admission.runPageWriteIntentEffect(
    intent,
    { kind: 'remote', completesRemoteWork: true },
    async () => { throw new Error('Confluence answered 503 after dispatch'); },
  )).rejects.toThrow('Confluence answered 503 after dispatch');
  return intent;
}

async function activePurposes(pageId: number): Promise<string[]> {
  const rows = await query<{ purpose: string }>(
    `SELECT purpose FROM page_runtime_admissions WHERE page_id = $1 AND released_at IS NULL ORDER BY purpose`,
    [pageId],
  );
  return rows.rows.map((row) => row.purpose);
}

async function intentState(intentId: string) {
  const rows = await query<{ status: string; remote_started: boolean; terminal: boolean }>(
    `SELECT status, remote_effect_started_at IS NOT NULL AS remote_started,
            remote_terminal_result IS NOT NULL AS terminal
       FROM page_write_intents WHERE id = $1`,
    [intentId],
  );
  return rows.rows[0];
}

async function acknowledgment(runtimeId: string) {
  const rows = await query<{ quiesced: boolean; ack: string | null; fenced: boolean }>(
    `SELECT quiesced_at IS NOT NULL AS quiesced, quiescence_ack AS ack, fenced_at IS NOT NULL AS fenced
       FROM page_writer_runtimes WHERE runtime_id = $1`,
    [runtimeId],
  );
  return rows.rows[0];
}

function quiesce(r: Replica) {
  const outcome: { settled: boolean; value?: unknown; error?: unknown } = { settled: false };
  const promise = r.admission.quiescePageWriterRuntime({
    actorId: ADMIN,
    reason: 'Retire this runtime so its unknown Save can be reconciled',
  }).then(
    (value) => { outcome.settled = true; outcome.value = value; },
    (error: unknown) => { outcome.settled = true; outcome.error = error; },
  );
  return { outcome, promise };
}

/**
 * Poll in real time. `vi.waitFor` advances fake timers on every check, which
 * would move the very deadlines these tests measure; `setImmediate` is not
 * faked here and still lets real database I/O complete.
 */
async function until(check: () => unknown | Promise<unknown>, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (performance.now() > deadline) throw error;
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    }
  }
}

async function parked(r: Replica, count = 1): Promise<void> {
  await until(() => {
    expect(r.admission._pageWriterQuiescenceWaitersForTest(), 'quiescence request parked').toBe(count);
  });
}

async function assertGateClosed(r: Replica): Promise<void> {
  await expect(r.admission.withPageWriterOperation(async () => 'ran'))
    .rejects.toMatchObject({ statusCode: 409, reason: 'runtime_quiescing' });
}

/** Every classification read on this replica's pool, observed on the real client. */
function observeClassifications(r: Replica): { reads: () => number } {
  const pool = r.pg.getPool();
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => Promise<PoolClient> | undefined;
  const wrapped = new WeakSet<PoolClient>();
  let reads = 0;
  vi.spyOn(pool, 'connect').mockImplementation(((...args: unknown[]) => {
    // `pool.query` checks out with a callback; only promise checkouts classify.
    if (args.length > 0) return connect(...args);
    return connect()!.then((client) => {
      if (!wrapped.has(client)) {
        wrapped.add(client);
        const original = client.query.bind(client) as (...queryArgs: unknown[]) => unknown;
        client.query = ((...queryArgs: unknown[]) => {
          if (typeof queryArgs[0] === 'string' && queryArgs[0].includes('LEFT JOIN page_write_intents i')) reads += 1;
          return original(...queryArgs);
        }) as PoolClient['query'];
      }
      return client;
    });
  }) as unknown as typeof pool.connect);
  return { reads: () => reads };
}

describe.skipIf(!canRun)('bounded runtime quiescence (#1934)', () => {
  beforeAll(async () => {
    await setupTestDb();
    main = createClient({ url: process.env.REDIS_URL }) as RedisClientType;
    main.on('error', () => { /* assertions surface failures */ });
    await main.connect();
  });

  beforeEach(async () => {
    await truncateAllTables();
    ADMIN = await insertUser('admin');
    WRITER = await insertUser('user');
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const r of replicas.splice(0)) {
      await r.runtime.close();
      await r.pg.closePool();
    }
    if (usedPageIds.length > 0) {
      await main.del(usedPageIds.splice(0).map((id) => `collab:active:${id}`));
    }
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await main.quit();
    await teardownTestDb();
  });

  describe('the issue probe through a real collaborative room', () => {
    it.each(['collab.commit.confluence', 'collab.commit.confluence.media'] as const)(
      '%s: answers 409 within the bound naming the intent and keeps intent, admission and gate as they were',
      async (kind) => {
        const r = await replica(FAST);
        const pageId = await insertPage();
        const joined = await r.runtime.attachSocket(pageId, { id: 'a1', ws: stubWs(), userId: WRITER, writable: true });
        expect(joined.writable).toBe(true);
        const intent = await failedOwnCommit(r, pageId, kind);
        await r.runtime.detachSocket(pageId, 'a1');
        expect(await activePurposes(pageId)).toEqual(['collab_room']);
        const warn = vi.spyOn(r.logger, 'warn');

        for (const attempt of [1, 2]) {
          const started = performance.now();
          const { outcome, promise } = quiesce(r);
          await promise;
          const elapsed = performance.now() - started;
          expect(outcome.error, `attempt ${attempt}`).toBeInstanceOf(r.admission.RuntimeQuiesceBlockedError);
          expect(outcome.error).toMatchObject({
            statusCode: 409,
            reason: 'runtime_quiesce_blocked_by_collab_commit',
            blockingIntents: [{ intentId: intent.id, kind, pageIds: [pageId] }],
          });
          expect(elapsed).toBeGreaterThanOrEqual(FAST.bound - 5);
          expect(elapsed).toBeLessThan(FAST.bound + FAST.budget);
          expect(r.admission._pageWriterQuiescenceWaitersForTest()).toBe(0);
        }

        expect(await intentState(intent.id)).toEqual({ status: 'pending', remote_started: true, terminal: false });
        expect(await activePurposes(pageId)).toEqual(['collab_room']);
        expect(await acknowledgment(r.runtimeId)).toEqual({ quiesced: false, ack: null, fenced: false });
        await assertGateClosed(r);
        expect(warn).toHaveBeenCalledWith(
          { runtimeId: r.runtimeId, blockingIntents: [{ intentId: intent.id, kind, pageIds: [pageId] }] },
          'page-writer quiescence refused: room admissions held by their own unknown-outcome collaborative commit',
        );
      },
    );

    it('no-room control: the same failed Save on a runtime without the page\'s room still acknowledges', async () => {
      const r = await replica(FAST);
      const pageId = await insertPage();
      const intent = await failedOwnCommit(r, pageId);
      const { outcome, promise } = quiesce(r);
      await promise;
      expect(outcome.error).toBeUndefined();
      const ack = await acknowledgment(r.runtimeId);
      expect(outcome.value).toMatchObject({ runtimeId: r.runtimeId, acknowledgmentId: ack!.ack });
      expect(ack).toMatchObject({ quiesced: true, fenced: false });
      expect(await intentState(intent.id)).toEqual({ status: 'pending', remote_started: true, terminal: false });
    });

    it('an ordinary flush error on a page that also has its own unknown commit still answers 409', async () => {
      const r = await replica(FAST);
      const pageId = await insertPage();
      await r.runtime.attachSocket(pageId, { id: 'a1', ws: stubWs(), userId: WRITER, writable: true });
      const intent = await failedOwnCommit(r, pageId);
      const warn = vi.spyOn(r.logger, 'warn');
      vi.spyOn(r.persist, 'flushCollabPersist').mockRejectedValueOnce(new Error('disk full'));
      await r.runtime.detachSocket(pageId, 'a1');
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ pageId }),
        'collab: disconnect flush failed; admission retained',
      );
      const { outcome, promise } = quiesce(r);
      await promise;
      expect(outcome.error).toMatchObject({
        statusCode: 409,
        blockingIntents: [{ intentId: intent.id, kind: 'collab.commit.confluence', pageIds: [pageId] }],
      });
      expect(await activePurposes(pageId)).toEqual(['collab_room']);
    });
  });

  describe('timing with fake timers and the production constants', () => {
    const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    /** A held room admission on a page whose own Save failed after dispatch. */
    async function qualifyingAdmission(r: Replica) {
      const pageId = await insertPage();
      const admission = await r.admission.admitPageRuntime(pageId, WRITER, 'collab_room');
      const intent = await failedOwnCommit(r, pageId);
      return { pageId, admission, intent };
    }

    it('settles at the bound, never later; a repeated request settles within the bound again and leaves no waiter', async () => {
      const r = await replica();
      expect([
        r.admission.PAGE_WRITER_QUIESCE_OWN_COMMIT_WAIT_MS,
        r.admission.PAGE_WRITER_QUIESCE_CLASSIFY_BUDGET_MS,
        r.admission.PAGE_WRITER_QUIESCE_RECLASSIFY_MS,
      ]).toEqual([30_000, 10_000, 5_000]);
      const { pageId, intent } = await qualifyingAdmission(r);
      fakeTimers();
      for (const attempt of [1, 2]) {
        const { outcome } = quiesce(r);
        await parked(r);
        await vi.advanceTimersByTimeAsync(30_000 - 1);
        expect(outcome.settled, `attempt ${attempt} before the bound`).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        // No further fake time: a responsive database answers at the bound.
        await until(() => expect(outcome.settled).toBe(true));
        expect(outcome.error).toMatchObject({
          statusCode: 409,
          blockingIntents: [{ intentId: intent.id, kind: 'collab.commit.confluence', pageIds: [pageId] }],
        });
        expect(r.admission._pageWriterQuiescenceWaitersForTest()).toBe(0);
      }
      await assertGateClosed(r);
      expect(await acknowledgment(r.runtimeId)).toEqual({ quiesced: false, ack: null, fenced: false });
    });

    it('a drain at the classification deadline acknowledges instead of answering 503', async () => {
      const r = await replica();
      const { admission } = await qualifyingAdmission(r);
      fakeTimers();
      const { outcome } = quiesce(r);
      await parked(r);
      const pool = r.pg.getPool();
      const connect = pool.connect.bind(pool) as () => Promise<PoolClient>;
      let lease!: (client: PoolClient) => void;
      const stalled = vi.spyOn(pool, 'connect').mockImplementationOnce(
        (() => new Promise<PoolClient>((resolve) => { lease = resolve; })) as unknown as typeof pool.connect,
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await until(() => expect(stalled).toHaveBeenCalled());
      // Another release path drains the runtime while the classifier is stuck.
      await r.admission.releasePageRuntime(admission);
      await vi.advanceTimersByTimeAsync(10_000);
      await until(() => expect(outcome.settled).toBe(true));
      expect(outcome.error).toBeUndefined();
      expect(outcome.value).toMatchObject({ acknowledgmentId: (await acknowledgment(r.runtimeId))!.ack });
      // The lease that arrives after the deadline runs no SQL.
      const late = await connect();
      const lateQuery = vi.spyOn(late, 'query');
      lease(late);
      await until(() => expect(pool.idleCount).toBeGreaterThan(0));
      expect(lateQuery).not.toHaveBeenCalled();
    });

    it('an empty admission set never yields the 409: a running local operation alone keeps today\'s wait', async () => {
      const r = await replica();
      const pageId = await insertPage();
      await failedOwnCommit(r, pageId);
      let finish!: () => void;
      const running = r.admission.withPageWriterOperation(() => new Promise<void>((resolve) => { finish = resolve; }));
      fakeTimers();
      const { outcome } = quiesce(r);
      await parked(r);
      await vi.advanceTimersByTimeAsync(30_000 + 3 * 5_000 + 10_000);
      expect(outcome.settled).toBe(false);
      finish();
      await running;
      await until(() => expect(outcome.settled).toBe(true));
      expect(outcome.error).toBeUndefined();
      expect(await acknowledgment(r.runtimeId)).toMatchObject({ quiesced: true });
    });

    it.each([
      ['before the bound', 20_000],
      ['after the bound and two re-classification intervals', 30_000 + 2 * 5_000 + 1],
    ] as const)('with a running local operation the 409 follows only its drain (drain %s)', async (_when, drainAt) => {
      const r = await replica();
      const { intent } = await qualifyingAdmission(r);
      let finish!: () => void;
      const running = r.admission.withPageWriterOperation(() => new Promise<void>((resolve) => { finish = resolve; }));
      fakeTimers();
      const { outcome } = quiesce(r);
      await parked(r);
      await vi.advanceTimersByTimeAsync(drainAt);
      expect(outcome.settled).toBe(false);
      finish();
      await running;
      if (drainAt < 30_000) {
        await vi.advanceTimersByTimeAsync(30_000 - drainAt - 1);
        expect(outcome.settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
      }
      await until(() => expect(outcome.settled).toBe(true));
      expect(outcome.error).toMatchObject({ statusCode: 409, blockingIntents: [expect.objectContaining({ intentId: intent.id })] });
    });

    it('a foreign pending intent keeps the room admission without a 409; the interval re-reads durable state', async () => {
      const r = await replica();
      const foreign = await replica();
      const own = await qualifyingAdmission(r);
      const otherPage = await insertPage();
      await r.runtime.attachSocket(otherPage, { id: 'b1', ws: stubWs(), userId: WRITER, writable: true });
      const labels = await foreign.admission.reservePageWriteIntent({
        pageIds: [otherPage], kind: 'page.labels', actorId: WRITER, effect: { effectClass: 'remote' },
      });
      await r.runtime.detachSocket(otherPage, 'b1');
      expect(await activePurposes(otherPage)).toEqual(['collab_room']);
      const classifications = observeClassifications(r);
      fakeTimers();
      const { outcome } = quiesce(r);
      await parked(r);
      await vi.advanceTimersByTimeAsync(30_000);
      await until(() => expect(classifications.reads()).toBe(1));
      await parked(r);
      // A durable change on another runtime; nothing changes in this process.
      await foreign.admission.cancelPageWriteIntentBeforeEffect(labels);
      await vi.advanceTimersByTimeAsync(5_000 - 1);
      expect(classifications.reads()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await until(() => expect(classifications.reads()).toBe(2));
      await parked(r);
      expect(outcome.settled).toBe(false);
      expect(await activePurposes(otherPage)).toEqual(['collab_room']);
      expect(await acknowledgment(r.runtimeId)).toEqual({ quiesced: false, ack: null, fenced: false });
      // The room's next drop flushes and releases; the generation signal re-classifies at once.
      await r.runtime.dropRoom(otherPage);
      expect(await activePurposes(otherPage)).toEqual([]);
      await until(() => expect(outcome.settled).toBe(true));
      expect(outcome.error).toMatchObject({
        statusCode: 409,
        blockingIntents: [{ intentId: own.intent.id, kind: 'collab.commit.confluence', pageIds: [own.pageId] }],
      });
    });

    it('a transient flush failure on a page without such an intent keeps the admission and today\'s wait', async () => {
      const r = await replica();
      const pageId = await insertPage();
      await r.runtime.attachSocket(pageId, { id: 'a1', ws: stubWs(), userId: WRITER, writable: true });
      vi.spyOn(r.persist, 'flushCollabPersist').mockRejectedValueOnce(new Error('connection reset'));
      await r.runtime.detachSocket(pageId, 'a1');
      expect(await activePurposes(pageId)).toEqual(['collab_room']);
      fakeTimers();
      const { outcome } = quiesce(r);
      await parked(r);
      // Step through the bound and three re-classifications, each reading the database.
      for (const step of [30_000, 5_000, 5_000, 5_000]) {
        await vi.advanceTimersByTimeAsync(step);
        await parked(r);
      }
      expect(outcome.settled).toBe(false);
      expect(await activePurposes(pageId)).toEqual(['collab_room']);
      // A successful retry drains the runtime, which then acknowledges.
      await r.runtime.dropRoom(pageId);
      await until(() => expect(outcome.settled).toBe(true));
      expect(outcome.error).toBeUndefined();
      expect(await acknowledgment(r.runtimeId)).toMatchObject({ quiesced: true });
    });

    it('no lost wake-up: a release during the classifier read discards that result and re-classifies at once', async () => {
      const r = await replica();
      const own = await qualifyingAdmission(r);
      const plainPage = await insertPage();
      const plain = await r.admission.admitPageRuntime(plainPage, WRITER, 'collab_room');
      fakeTimers();
      const { outcome } = quiesce(r);
      await parked(r);
      const pool = r.pg.getPool();
      const connect = pool.connect.bind(pool) as () => Promise<PoolClient>;
      let readDone = false;
      let openCommit!: () => void;
      const commitGate = new Promise<void>((resolve) => { openCommit = resolve; });
      vi.spyOn(pool, 'connect').mockImplementationOnce((async () => {
        const client = await connect();
        const original = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
        client.query = (async (...args: unknown[]) => {
          if (args[0] === 'COMMIT') {
            readDone = true;
            await commitGate;
            client.query = original as PoolClient['query'];
          }
          return original(...args);
        }) as PoolClient['query'];
        return client;
      }) as unknown as typeof pool.connect);
      // The request is parked: the next checkout is the classification's.
      await vi.advanceTimersByTimeAsync(30_000);
      await until(() => expect(readDone).toBe(true));
      // The read saw the plain admission (not qualifying). It is released now.
      await r.admission.releasePageRuntime(plain);
      openCommit();
      // No further fake time: the generation change alone re-classifies.
      await until(() => expect(outcome.settled).toBe(true));
      expect(outcome.error).toMatchObject({
        statusCode: 409,
        blockingIntents: [{ intentId: own.intent.id, kind: 'collab.commit.confluence', pageIds: [own.pageId] }],
      });
    });

    it.each(['checkout', 'administrator lock', 'COMMIT'] as const)(
      'a database stall at %s answers 503 at bound + budget without ids, acknowledgment or a late effect',
      async (stall) => {
        const r = await replica();
        const own = await qualifyingAdmission(r);
        fakeTimers();
        const { outcome } = quiesce(r);
        await parked(r);
        const pool = r.pg.getPool();
        const connect = pool.connect.bind(pool) as () => Promise<PoolClient>;
        let reached = false;
        let lease: ((client: PoolClient) => void) | undefined;
        let openCommit: (() => void) | undefined;
        let blocker: PoolClient | undefined;
        if (stall === 'checkout') {
          vi.spyOn(pool, 'connect').mockImplementationOnce((() => new Promise<PoolClient>((resolve) => {
            reached = true;
            lease = resolve;
          })) as unknown as typeof pool.connect);
        } else if (stall === 'COMMIT') {
          const gate = new Promise<void>((resolve) => { openCommit = resolve; });
          vi.spyOn(pool, 'connect').mockImplementationOnce((async () => {
            const client = await connect();
            const original = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
            client.query = (async (...args: unknown[]) => {
              if (args[0] === 'COMMIT') {
                reached = true;
                await gate;
              }
              return original(...args);
            }) as PoolClient['query'];
            return client;
          }) as unknown as typeof pool.connect);
        } else {
          blocker = await getPool().connect();
          await blocker.query('BEGIN');
          await blocker.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [ADMIN]);
        }
        // Stalls are installed once the request is parked, after its audit.
        await vi.advanceTimersByTimeAsync(30_000);
        if (stall === 'administrator lock') {
          await until(async () => {
            const waiting = await query(
              `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%FOR SHARE%'`,
            );
            expect(waiting.rows).toHaveLength(1);
          });
        } else {
          await until(() => expect(reached).toBe(true));
        }
        await vi.advanceTimersByTimeAsync(10_000 - 1);
        expect(outcome.settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await until(() => expect(outcome.settled).toBe(true));
        expect(outcome.error).toBeInstanceOf(r.admission.PageWriteError);
        expect(outcome.error).toMatchObject({ statusCode: 503, reason: 'runtime_quiesce_classification_unavailable' });
        expect(outcome.error).not.toHaveProperty('blockingIntents');
        expect(outcome.error).not.toHaveProperty('message', expect.stringContaining(own.intent.id));
        expect(r.admission._pageWriterQuiescenceWaitersForTest()).toBe(0);

        // Let the abandoned classification finish late: it changes nothing.
        if (lease) {
          const late = await connect();
          const lateQuery = vi.spyOn(late, 'query');
          lease(late);
          await until(() => expect(pool.idleCount).toBeGreaterThan(0));
          expect(lateQuery).not.toHaveBeenCalled();
        }
        openCommit?.();
        if (blocker) {
          await blocker.query('ROLLBACK');
          blocker.release();
        }
        expect(await acknowledgment(r.runtimeId)).toEqual({ quiesced: false, ack: null, fenced: false });
        expect(await intentState(own.intent.id)).toEqual({ status: 'pending', remote_started: true, terminal: false });
        expect(await activePurposes(own.pageId)).toEqual(['collab_room']);
        expect(r.admission._pageWriterQuiescenceWaitersForTest()).toBe(0);
        await assertGateClosed(r);
      },
    );

    it.each([
      ['role removed', "UPDATE users SET role = 'user' WHERE id = $1"],
      ['user deactivated', 'UPDATE users SET deactivated_at = NOW() WHERE id = $1'],
    ] as const)('%s between the audit and the answer: 403 without ids, gate stays closed', async (_case, revoke) => {
      const r = await replica();
      const own = await qualifyingAdmission(r);
      fakeTimers();
      const { outcome } = quiesce(r);
      await parked(r);
      await query(revoke, [ADMIN]);
      await vi.advanceTimersByTimeAsync(30_000);
      await until(() => expect(outcome.settled).toBe(true));
      expect(outcome.error).toMatchObject({ statusCode: 403, reason: 'recovery_admin_required' });
      expect(outcome.error).not.toHaveProperty('blockingIntents');
      expect(outcome.error).not.toHaveProperty('message', expect.stringContaining(own.intent.id));
      expect(r.admission._pageWriterQuiescenceWaitersForTest()).toBe(0);
      expect(await acknowledgment(r.runtimeId)).toEqual({ quiesced: false, ack: null, fenced: false });
      await assertGateClosed(r);
    });
  });
});
