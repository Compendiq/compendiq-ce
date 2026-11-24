/**
 * #2035 — a collaborative Save whose remote phase failed after dispatch.
 *
 * The durable state of a page's own commit, the three latches that raise it
 * while the marker is missing, and the owner's marker procedure, against real
 * PostgreSQL and Redis. The Save route and the rooms are exercised in
 * `routes/knowledge/pages-collab-commit-unknown.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import { type AddressInfo, createConnection, createServer, type Socket } from 'node:net';
import type { PoolClient } from 'pg';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  insertTestRuntime,
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
  waitForDatabaseCondition,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { closePool, getPool, query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';
import { collabDocChannel, createCollabRuntime } from './collab-room-service.js';
import { getRedisClient, setRedisClient } from './redis-cache.js';
import {
  _resetCollabCommitUnknownForTest,
  collabCommitUnknownKey,
  declareCollabCommitUnknown,
  isCollabCommitUnknown,
  lockPageLifecycle,
  pageWriteIntentHoldsDrain,
  processCollabCommitLatches,
  readCollabCommitState,
  reservePageWriteIntent,
  runPageWriteIntentEffect,
  withCollabCommitKnown,
  withPageLifecycleRead,
  withPageWriteTransaction,
  type CollabCommitLatches,
  type CollabCommitRoomLatch,
  type PageWriteIntent,
} from './page-write-admission.js';

const canRun = await isDbAvailable() && await isRedisAvailable();

type CommitKind = 'collab.commit.confluence' | 'collab.commit.confluence.media';

let redis: RedisClientType;
let previousRedis: RedisClientType | null;
let sequence = 0;

async function insertUser(): Promise<string> {
  sequence += 1;
  const result = await query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ($1, $2, 'x', 'user') RETURNING id`,
    [`commit-unknown-${sequence}`, `commit-unknown-${sequence}@test.invalid`],
  );
  return result.rows[0]!.id;
}

async function insertPage(): Promise<number> {
  sequence += 1;
  const result = await query<{ id: number }>(
    `INSERT INTO pages
       (confluence_id, title, body_html, body_storage, body_text, version, source, visibility)
     VALUES ($1, 'Commit state', '<p>body</p>', '<p>body</p>', 'body', 4, 'confluence', 'shared')
     RETURNING id`,
    [`cf-commit-unknown-${sequence}`],
  );
  return result.rows[0]!.id;
}

async function reserveCommit(
  pageId: number,
  actorId: string,
  kind: CommitKind = 'collab.commit.confluence',
): Promise<PageWriteIntent> {
  return reservePageWriteIntent({
    pageIds: [pageId],
    kind,
    actorId,
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
}

/** The Save's publishing phase starts and fails: pending, dispatched, no terminal result. */
async function failAfterDispatch(intent: PageWriteIntent): Promise<void> {
  await expect(runPageWriteIntentEffect(
    intent,
    { kind: 'remote', completesRemoteWork: true },
    async () => { throw new Error('connection reset after the request was sent'); },
  )).rejects.toThrow('connection reset after the request was sent');
}

async function dispatchedCommit(kind: CommitKind = 'collab.commit.confluence'): Promise<{
  pageId: number;
  intent: PageWriteIntent;
}> {
  const pageId = await insertPage();
  const intent = await reserveCommit(pageId, await insertUser(), kind);
  await failAfterDispatch(intent);
  return { pageId, intent };
}

function durableState(pageId: number) {
  return withPageLifecycleRead(pageId, (client) => readCollabCommitState(client, pageId));
}

async function intentRow(intentId: string) {
  const result = await query<{
    status: string;
    marker: Date | null;
    settled_at: Date | null;
    remote_terminal_result: unknown;
    effect_finished_at: Date | null;
  }>(
    `SELECT status, remote_effect_failed_at AS marker, settled_at, remote_terminal_result, effect_finished_at
       FROM page_write_intents WHERE id = $1`,
    [intentId],
  );
  return result.rows[0]!;
}

/** What a fence of a process with these latches decides for the page. */
async function effectiveState(
  pageId: number,
  room: CollabCommitRoomLatch = { unknownCommitIntentId: null },
  latches?: CollabCommitLatches,
): Promise<'known' | 'unknown'> {
  try {
    await withCollabCommitKnown(pageId, room, (assertKnown) => withPageLifecycleRead(pageId, assertKnown), latches);
    return 'known';
  } catch (error) {
    if (isCollabCommitUnknown(error)) return 'unknown';
    throw error;
  }
}

/** Another process: it does not see this process's set. `sharedLatch` is what its Redis read answers. */
function anotherProcess(
  sharedLatch: CollabCommitLatches['sharedLatchNames'] = processCollabCommitLatches.sharedLatchNames,
): CollabCommitLatches {
  return { locallyUnknown: () => false, sharedLatchNames: sharedLatch };
}

/** The intents the page's Redis latch names, read from Redis itself. */
async function latchMembers(pageId: number): Promise<string[]> {
  return (await redis.sMembers(collabCommitUnknownKey(pageId))).sort();
}

async function settleBySql(intentId: string, status = 'reconciled_not_applied'): Promise<void> {
  await query(
    `UPDATE page_write_intents
        SET status = $2, settled_at = NOW(), settlement_reason = 'test settlement', settlement_proof = '{}'::jsonb
      WHERE id = $1`,
    [intentId, status],
  );
}

interface RedisRelay {
  url: string;
  /** Commands that leave the client are kept here and reach Redis only on `release`. */
  hold: () => void;
  release: () => void;
  /** Every connection is cut and new ones are refused until `comeUp`. */
  goDown: () => void;
  comeUp: () => void;
}

/** A TCP relay in front of the real Redis that can stall or cut a client's connection. */
async function redisRelay(): Promise<RedisRelay> {
  const target = new URL(process.env.REDIS_URL!);
  const pairs = new Set<{ downstream: Socket; upstream: Socket; held: Buffer[] }>();
  let holding = false;
  let down = false;
  const server = createServer((downstream) => {
    if (down) {
      downstream.destroy();
      return;
    }
    const upstream = createConnection({ host: target.hostname, port: Number(target.port || 6379) });
    const pair = { downstream, upstream, held: [] as Buffer[] };
    pairs.add(pair);
    const drop = (): void => {
      pairs.delete(pair);
      downstream.destroy();
      upstream.destroy();
    };
    downstream.on('data', (chunk: Buffer) => {
      if (holding) pair.held.push(chunk);
      else upstream.write(chunk);
    });
    upstream.on('data', (chunk: Buffer) => { downstream.write(chunk); });
    for (const socket of [downstream, upstream]) {
      socket.on('error', drop);
      socket.on('close', drop);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  onTestFinished(async () => {
    for (const pair of [...pairs]) {
      pair.downstream.destroy();
      pair.upstream.destroy();
    }
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  });
  const url = new URL(process.env.REDIS_URL!);
  url.hostname = '127.0.0.1';
  url.port = String((server.address() as AddressInfo).port);
  return {
    url: url.toString(),
    hold: () => { holding = true; },
    release: () => {
      holding = false;
      for (const pair of pairs) {
        for (const chunk of pair.held.splice(0)) pair.upstream.write(chunk);
      }
    },
    goDown: () => {
      down = true;
      for (const pair of [...pairs]) pair.downstream.destroy();
    },
    comeUp: () => { down = false; },
  };
}

/** A Redis client of its own behind the relay; the suite's client is restored afterwards. */
async function relayedClient(relay: RedisRelay): Promise<RedisClientType> {
  const client = createClient({ url: relay.url }) as RedisClientType;
  client.on('error', () => undefined);
  await client.connect();
  // Registered after the relay's own cleanup, so it runs first.
  onTestFinished(async () => {
    setRedisClient(redis);
    client.destroy();
  });
  return client;
}

/**
 * Hold the intent row so the marker UPDATE cannot be recorded. Fences only
 * read that row, so they keep working. Returns the release.
 */
async function blockMarker(intentId: string): Promise<() => Promise<void>> {
  const holder = await getPool().connect();
  await holder.query('BEGIN');
  await holder.query('SELECT 1 FROM page_write_intents WHERE id = $1 FOR UPDATE', [intentId]);
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
  };
  onTestFinished(release);
  return release;
}

function shortMarkerTimings(deadlineMs: number, retryMs: number): void {
  vi.stubEnv('COLLAB_COMMIT_MARKER_DEADLINE_MS', String(deadlineMs));
  vi.stubEnv('COLLAB_COMMIT_MARKER_RETRY_MS', String(retryMs));
}

/**
 * Drop the PostgreSQL answer to the COMMIT of the marker transaction only:
 * the marker commits, but neither CommandComplete nor ReadyForQuery reaches
 * the application. Every other connection passes through untouched.
 */
async function withLostMarkerCommitAcknowledgment(operation: () => Promise<void>): Promise<void> {
  const originalUrl = process.env.POSTGRES_URL!;
  const upstreamUrl = new URL(originalUrl);
  const sockets = new Set<Socket>();
  let dropped = false;
  const proxy = createServer((downstream) => {
    const upstream = createConnection({ host: upstreamUrl.hostname, port: Number(upstreamUrl.port || 5432) });
    sockets.add(downstream);
    sockets.add(upstream);
    let carriesMarker = false;
    let buffered: Buffer = Buffer.alloc(0);
    downstream.on('data', (chunk: Buffer) => {
      if (chunk.includes('SET remote_effect_failed_at = NOW()')) carriesMarker = true;
      upstream.write(chunk);
    });
    upstream.on('data', (chunk: Buffer) => {
      if (!carriesMarker || dropped) {
        downstream.write(chunk);
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 5) {
        const size = 1 + buffered.readUInt32BE(1);
        if (buffered.length < size) break;
        const message = buffered.subarray(0, size);
        buffered = buffered.subarray(size);
        if (message[0] === 0x43 && message.subarray(5).toString() === 'COMMIT\0') {
          dropped = true;
          downstream.destroy();
          upstream.destroy();
          return;
        }
        downstream.write(message);
      }
    });
    downstream.on('error', () => upstream.destroy());
    upstream.on('error', () => downstream.destroy());
    downstream.on('close', () => { sockets.delete(downstream); upstream.destroy(); });
    upstream.on('close', () => { sockets.delete(upstream); downstream.destroy(); });
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', resolve);
  });
  const proxyUrl = new URL(originalUrl);
  proxyUrl.hostname = '127.0.0.1';
  proxyUrl.port = String((proxy.address() as AddressInfo).port);
  try {
    await closePool();
    process.env.POSTGRES_URL = proxyUrl.toString();
    await operation();
    expect(dropped).toBe(true);
  } finally {
    await closePool();
    process.env.POSTGRES_URL = originalUrl;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      proxy.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe.skipIf(!canRun)('unknown collaborative commit — real PostgreSQL and Redis (#2035)', () => {
  beforeAll(async () => {
    await setupTestDb();
    previousRedis = getRedisClient();
    redis = createClient({ url: process.env.REDIS_URL }) as RedisClientType;
    await redis.connect();
    setRedisClient(redis);
  });

  beforeEach(async () => {
    await truncateAllTables();
    await withPageWriteTransaction([], async () => undefined);
  });

  afterEach(async () => {
    await _resetCollabCommitUnknownForTest();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    const leftover = await redis.keys('collab:commit-unknown:*');
    if (leftover.length > 0) await redis.del(leftover);
  });

  afterAll(async () => {
    setRedisClient(previousRedis);
    await redis.quit();
    await teardownTestDb();
  });

  describe('durable state', () => {
    it('is none unless exactly this page has a dispatched collaborative commit without a terminal result', async () => {
      const actor = await insertUser();
      const pageId = await insertPage();
      expect(await durableState(pageId)).toEqual({ state: 'none' });

      // Reserved, never dispatched.
      const reserved = await reserveCommit(pageId, actor);
      expect(await durableState(pageId)).toEqual({ state: 'none' });

      // Another page's failed commit says nothing about this page.
      const other = await dispatchedCommit();
      expect(await durableState(other.pageId)).toMatchObject({ state: 'in_flight', intentId: other.intent.id });
      expect(await durableState(pageId)).toEqual({ state: 'none' });

      // A terminal result was recorded: the outcome is known to the durable row.
      await runPageWriteIntentEffect(
        reserved,
        { kind: 'remote', completesRemoteWork: true, terminalResult: () => ({ accepted: true }) },
        async () => undefined,
      );
      expect((await intentRow(reserved.id)).remote_terminal_result).toEqual({ accepted: true });
      expect(await durableState(pageId)).toEqual({ state: 'none' });
    });

    it('is none for a foreign pending intent of the page, dispatched or not', async () => {
      const actor = await insertUser();
      const pageId = await insertPage();
      const foreign = await reservePageWriteIntent({
        pageIds: [pageId],
        kind: 'pages.update.confluence',
        actorId: actor,
        effect: { effectClass: 'remote' },
      });
      expect(await durableState(pageId)).toEqual({ state: 'none' });
      await expect(runPageWriteIntentEffect(
        foreign,
        { kind: 'remote', completesRemoteWork: true },
        async () => { throw new Error('ordinary save lost its response'); },
      )).rejects.toThrow('ordinary save lost its response');
      expect(await durableState(pageId)).toEqual({ state: 'none' });
    });

    it.each(['collab.commit.confluence', 'collab.commit.confluence.media'] as const)(
      'is in_flight for a %s whose remote phase is running under an active owner',
      async (kind) => {
        const pageId = await insertPage();
        const intent = await reserveCommit(pageId, await insertUser(), kind);
        let during: unknown;
        await runPageWriteIntentEffect(intent, { kind: 'remote', completesRemoteWork: false }, async () => {
          during = await durableState(pageId);
        });
        expect(during).toEqual({ state: 'in_flight', intentId: intent.id });
      },
    );

    it.each([
      ['the owner marked the remote phase failed', async (intent: PageWriteIntent) => {
        await declareCollabCommitUnknown(intent, () => undefined).record();
      }],
      ['a recovery claimed the intent', async (intent: PageWriteIntent) => {
        await query('UPDATE page_write_intents SET recovery_started_at = NOW() WHERE id = $1', [intent.id]);
      }],
      ['the owning runtime is fenced', async (intent: PageWriteIntent) => {
        const fenced = await insertTestRuntime({ fenced: true });
        await query('UPDATE page_write_intents SET runtime_id = $2 WHERE id = $1', [intent.id, fenced]);
      }],
      ['the owning runtime is quiesced', async (intent: PageWriteIntent) => {
        const quiesced = await insertTestRuntime({ quiesced: true });
        await query('UPDATE page_write_intents SET runtime_id = $2 WHERE id = $1', [intent.id, quiesced]);
      }],
    ])('is unknown once %s', async (_cause, apply) => {
      const { pageId, intent } = await dispatchedCommit();
      // Without the marker the failed Save still reads like one in flight.
      expect(await durableState(pageId)).toEqual({ state: 'in_flight', intentId: intent.id });
      await apply(intent);
      expect(await durableState(pageId)).toEqual({ state: 'unknown', intentId: intent.id });
    });

    it.each(['reconciled_applied', 'reconciled_not_applied', 'cancelled'])(
      'is none again once the marked intent is %s',
      async (status) => {
        const { pageId, intent } = await dispatchedCommit();
        await declareCollabCommitUnknown(intent, () => undefined).record();
        expect(await durableState(pageId)).toMatchObject({ state: 'unknown' });
        await query(
          `UPDATE page_write_intents
              SET status = $2, settled_at = NOW(), settlement_reason = 'test settlement',
                  settlement_proof = '{}'::jsonb
            WHERE id = $1`,
          [intent.id, status],
        );
        expect(await durableState(pageId)).toEqual({ state: 'none' });
        // The marker stays on the settled row; nothing reads it there.
        expect((await intentRow(intent.id)).marker).not.toBeNull();
      },
    );

    it('keeps overlapping Saves on one runtime apart: only the failed one is unknown', async () => {
      const actor = await insertUser();
      const failed = await dispatchedCommit();
      const healthyPageId = await insertPage();
      const healthy = await reserveCommit(healthyPageId, actor);
      shortMarkerTimings(150, 60_000);
      const release = await blockMarker(failed.intent.id);

      await runPageWriteIntentEffect(healthy, { kind: 'remote', completesRemoteWork: false }, async () => {
        // Declared, marker not recorded yet: this process's set names the failed intent only.
        await declareCollabCommitUnknown(failed.intent, () => undefined).record();
        expect((await intentRow(failed.intent.id)).marker).toBeNull();
        expect(await effectiveState(failed.pageId)).toBe('unknown');
        expect(await durableState(healthyPageId)).toEqual({ state: 'in_flight', intentId: healthy.id });
        expect(await effectiveState(healthyPageId)).toBe('known');
      });
      await release();
    });
  });

  describe('effective state', () => {
    it('raises a commit in flight to unknown through each latch that names the same intent, and through no other', async () => {
      const { pageId, intent } = await dispatchedCommit();
      const noSharedLatch = anotherProcess(async () => false);
      expect(await durableState(pageId)).toEqual({ state: 'in_flight', intentId: intent.id });
      expect(await effectiveState(pageId, { unknownCommitIntentId: null }, noSharedLatch)).toBe('known');

      // The room latch.
      const latched = { unknownCommitIntentId: intent.id };
      expect(await effectiveState(pageId, latched, noSharedLatch)).toBe('unknown');
      expect(latched.unknownCommitIntentId).toBe(intent.id);
      const foreignLatch: CollabCommitRoomLatch = { unknownCommitIntentId: randomUUID() };
      expect(await effectiveState(pageId, foreignLatch, noSharedLatch)).toBe('known');
      // A latch for another intent is cleared by the durable read.
      expect(foreignLatch.unknownCommitIntentId).toBeNull();

      // The Redis latch, read by a process that has neither other latch.
      await redis.sAdd(collabCommitUnknownKey(pageId), randomUUID());
      expect(await effectiveState(pageId, { unknownCommitIntentId: null }, anotherProcess())).toBe('known');
      await redis.sAdd(collabCommitUnknownKey(pageId), intent.id);
      const room: CollabCommitRoomLatch = { unknownCommitIntentId: null };
      expect(await effectiveState(pageId, room, anotherProcess())).toBe('unknown');
      // A positive read stays as the room latch: the key itself is no longer needed.
      expect(room.unknownCommitIntentId).toBe(intent.id);
      await redis.del(collabCommitUnknownKey(pageId));
      expect(await effectiveState(pageId, room, anotherProcess())).toBe('unknown');

      // The owner's process-local set.
      const release = await blockMarker(intent.id);
      shortMarkerTimings(150, 60_000);
      const declaration = declareCollabCommitUnknown(intent, () => undefined);
      expect(await effectiveState(pageId, { unknownCommitIntentId: null }, {
        locallyUnknown: processCollabCommitLatches.locallyUnknown,
        sharedLatchNames: async () => false,
      })).toBe('unknown');
      await declaration.record();
      await release();

      // Settlement ends every latch: the durable read shows no such intent.
      await query(
        `UPDATE page_write_intents
            SET status = 'cancelled', settled_at = NOW(), settlement_reason = 'test settlement',
                settlement_proof = '{}'::jsonb
          WHERE id = $1`,
        [intent.id],
      );
      await redis.sAdd(collabCommitUnknownKey(pageId), intent.id);
      expect(await effectiveState(pageId, room)).toBe('known');
      expect(room.unknownCommitIntentId).toBeNull();
    });

    it('reads the Redis key outside every transaction and only for a commit in flight without another latch', async () => {
      const pageId = await insertPage();
      const actor = await insertUser();
      const sharedLatch = vi.fn<CollabCommitLatches['sharedLatchNames']>(async (lockedPageId) => {
        // The fenced transaction has ended: its page lifecycle lock is free.
        const probe = await getPool().connect();
        try {
          await probe.query('BEGIN');
          await probe.query("SET LOCAL lock_timeout = '2s'");
          await lockPageLifecycle(probe, [lockedPageId]);
          await probe.query('ROLLBACK');
        } finally {
          probe.release();
        }
        return false;
      });
      const latches = anotherProcess(sharedLatch);

      expect(await effectiveState(pageId, { unknownCommitIntentId: null }, latches)).toBe('known');
      expect(sharedLatch).not.toHaveBeenCalled();

      const intent = await reserveCommit(pageId, actor);
      await failAfterDispatch(intent);
      let applied = 0;
      await withCollabCommitKnown(pageId, { unknownCommitIntentId: null }, (assertKnown) =>
        withPageLifecycleRead(pageId, async (client) => {
          await assertKnown(client);
          applied += 1;
        }), latches);
      // One lookup, and the step ran once: the first transaction ended without an effect.
      expect(sharedLatch).toHaveBeenCalledTimes(1);
      expect(applied).toBe(1);

      // A room latch decides without a lookup.
      expect(await effectiveState(pageId, { unknownCommitIntentId: intent.id }, latches)).toBe('unknown');
      expect(sharedLatch).toHaveBeenCalledTimes(1);

      // So does a durable `unknown`.
      await declareCollabCommitUnknown(intent, () => undefined).record();
      expect(await effectiveState(pageId, { unknownCommitIntentId: null }, latches)).toBe('unknown');
      expect(sharedLatch).toHaveBeenCalledTimes(1);
    });

    it('binds a Redis answer to the intent it was read for: a changed intent starts over', async () => {
      const actor = await insertUser();
      const pageId = await insertPage();
      const first = await reserveCommit(pageId, actor);
      await failAfterDispatch(first);
      let second: PageWriteIntent | undefined;
      const sharedLatch = vi.fn<CollabCommitLatches['sharedLatchNames']>(async (_pageId, askedFor) => {
        if (second) return false;
        // Between the two transactions the first Save settles and a later one is dispatched.
        await query(
          `UPDATE page_write_intents
              SET status = 'reconciled_not_applied', settled_at = NOW(), settlement_reason = 'test settlement',
                  settlement_proof = '{}'::jsonb
            WHERE id = $1`,
          [first.id],
        );
        second = await reserveCommit(pageId, actor);
        await failAfterDispatch(second);
        // The latch still names the first, settled intent, which is what was asked for.
        expect(askedFor).toBe(first.id);
        return true;
      });
      const room: CollabCommitRoomLatch = { unknownCommitIntentId: null };

      expect(await effectiveState(pageId, room, anotherProcess(sharedLatch))).toBe('known');

      // The positive answer for the first intent latched nothing for the second.
      expect(sharedLatch).toHaveBeenCalledTimes(2);
      expect(room.unknownCommitIntentId).toBeNull();
      expect(await durableState(pageId)).toEqual({ state: 'in_flight', intentId: second!.id });
    });

    it.each([
      ['never answers', (relay: RedisRelay) => relay.hold()],
      ['is unreachable', (relay: RedisRelay) => relay.goDown()],
    ])('reads no latch when Redis %s, within its 250 ms bound', async (_name, breakConnection) => {
      const { pageId, intent } = await dispatchedCommit();
      await redis.sAdd(collabCommitUnknownKey(pageId), intent.id);
      const relay = await redisRelay();
      const unreliable = await relayedClient(relay);
      setRedisClient(unreliable);
      // The latch is there and this process reads it while its connection works.
      expect(await effectiveState(pageId, { unknownCommitIntentId: null }, anotherProcess())).toBe('unknown');
      breakConnection(relay);
      const started = performance.now();

      expect(await effectiveState(pageId, { unknownCommitIntentId: null }, anotherProcess())).toBe('known');

      expect(performance.now() - started).toBeLessThan(2_000);
    });
  });

  describe('owner procedure', () => {
    it('latches the process first, then records the marker exactly once and changes nothing else', async () => {
      const { pageId, intent } = await dispatchedCommit();
      const before = await intentRow(intent.id);
      const cue = vi.fn();

      const declaration = declareCollabCommitUnknown(intent, cue);
      // Synchronously: the durable row still reads `in_flight`, this process already fences.
      expect(processCollabCommitLatches.locallyUnknown(intent.id)).toBe(true);
      expect(await durableState(pageId)).toEqual({ state: 'in_flight', intentId: intent.id });
      expect(await effectiveState(pageId)).toBe('unknown');

      await declaration.record();
      const marked = await intentRow(intent.id);
      expect(marked.marker).toBeInstanceOf(Date);
      expect(marked).toMatchObject({
        status: 'pending',
        settled_at: null,
        remote_terminal_result: null,
        effect_finished_at: before.effect_finished_at,
      });
      expect(await durableState(pageId)).toEqual({ state: 'unknown', intentId: intent.id });
      // The proven marker answers for itself; no Redis key was needed.
      expect(processCollabCommitLatches.locallyUnknown(intent.id)).toBe(false);
      expect(await latchMembers(pageId)).toEqual([]);
      expect(cue).not.toHaveBeenCalled();
      declaration.announce();
      expect(cue).toHaveBeenCalledTimes(1);

      // A repeat matches nothing and proves the same committed row.
      await declareCollabCommitUnknown(intent, cue).record();
      expect((await intentRow(intent.id)).marker).toEqual(marked.marker);
    });

    it('records nothing and publishes no cue for an intent whose remote effect never started', async () => {
      const pageId = await insertPage();
      const intent = await reserveCommit(pageId, await insertUser());
      const cue = vi.fn();

      const declaration = declareCollabCommitUnknown(intent, cue);
      await declaration.record();
      declaration.announce();

      expect((await intentRow(intent.id)).marker).toBeNull();
      expect(cue).not.toHaveBeenCalled();
      expect(processCollabCommitLatches.locallyUnknown(intent.id)).toBe(false);
      expect(await effectiveState(pageId)).toBe('known');
    });

    it('records nothing after a durable terminal result', async () => {
      const pageId = await insertPage();
      const intent = await reserveCommit(pageId, await insertUser());
      await runPageWriteIntentEffect(
        intent,
        { kind: 'remote', completesRemoteWork: true, terminalResult: () => ({ accepted: true }) },
        async () => undefined,
      );
      const cue = vi.fn();

      const declaration = declareCollabCommitUnknown(intent, cue);
      await declaration.record();
      declaration.announce();

      expect((await intentRow(intent.id)).marker).toBeNull();
      expect(cue).not.toHaveBeenCalled();
      expect(await durableState(pageId)).toEqual({ state: 'none' });
    });

    it('proves a marker whose COMMIT acknowledgment was lost', async () => {
      const { pageId, intent } = await dispatchedCommit();
      shortMarkerTimings(2_000, 60_000);

      await withLostMarkerCommitAcknowledgment(async () => {
        await declareCollabCommitUnknown(intent, () => undefined).record();
        // Proven by the read of the committed row, in the same attempt: no retry is pending.
        expect(processCollabCommitLatches.locallyUnknown(intent.id)).toBe(false);
      });

      expect((await intentRow(intent.id)).marker).toBeInstanceOf(Date);
      expect(await durableState(pageId)).toEqual({ state: 'unknown', intentId: intent.id });
      expect(await latchMembers(pageId)).toEqual([]);
    });

    it('abandons a stalled attempt at its deadline instead of waiting for it', async () => {
      const { pageId, intent } = await dispatchedCommit();
      shortMarkerTimings(200, 60_000);
      // Every pooled connection is taken, so the attempt cannot even check one
      // out; the pool itself would wait 5 s for each.
      const pool = getPool();
      const taken: PoolClient[] = [];
      while (pool.totalCount < pool.options.max || pool.idleCount > 0) taken.push(await pool.connect());
      const releaseAll = (): void => { for (const client of taken.splice(0)) client.release(); };
      onTestFinished(releaseAll);
      const started = performance.now();

      await declareCollabCommitUnknown(intent, () => undefined).record();

      // Three attempts, each a marker transaction and a proof read of 200 ms.
      expect(performance.now() - started).toBeLessThan(4_000);
      expect(processCollabCommitLatches.locallyUnknown(intent.id)).toBe(true);
      // Without the marker another process learns of it from Redis.
      expect(await latchMembers(pageId)).toEqual([intent.id]);
      releaseAll();
      expect((await intentRow(intent.id)).marker).toBeNull();
    });

    it('keeps retrying an unrecorded marker with a cue per retry, and cleans up after a late success', async () => {
      const { pageId, intent } = await dispatchedCommit();
      shortMarkerTimings(150, 100);
      const release = await blockMarker(intent.id);
      const cue = vi.fn();

      const declaration = declareCollabCommitUnknown(intent, cue);
      await declaration.record();
      expect((await intentRow(intent.id)).marker).toBeNull();
      expect(await latchMembers(pageId)).toEqual([intent.id]);
      // The owner is fenced from its set; a process that reads the key is fenced
      // too; one that cannot read it sees a Save in flight until the marker commits.
      expect(await effectiveState(pageId)).toBe('unknown');
      expect(await effectiveState(pageId, { unknownCommitIntentId: null }, anotherProcess())).toBe('unknown');
      expect(await effectiveState(pageId, { unknownCommitIntentId: null }, anotherProcess(async () => false)))
        .toBe('known');
      expect(cue).not.toHaveBeenCalled();
      declaration.announce();
      expect(cue).toHaveBeenCalledTimes(1);

      // The failure persists: every background retry repeats the cue and changes nothing.
      await vi.waitFor(() => expect(cue.mock.calls.length).toBeGreaterThanOrEqual(4), { timeout: 10_000 });
      expect(await intentRow(intent.id)).toMatchObject({ status: 'pending', marker: null });
      expect(await latchMembers(pageId)).toEqual([intent.id]);
      expect(processCollabCommitLatches.locallyUnknown(intent.id)).toBe(true);

      await release();
      await vi.waitFor(async () => {
        expect((await intentRow(intent.id)).marker).toBeInstanceOf(Date);
      }, { timeout: 10_000 });
      // The process latch goes last, after the compare-and-delete of the key
      // and directly before the one cue that follows a late success.
      await vi.waitFor(() => {
        expect(processCollabCommitLatches.locallyUnknown(intent.id)).toBe(false);
      }, { timeout: 5_000 });
      expect(await latchMembers(pageId)).toEqual([]);
      expect(await durableState(pageId)).toEqual({ state: 'unknown', intentId: intent.id });
      const cuesAtSuccess = cue.mock.calls.length;
      // Real clock on purpose: the retries run on the platform timer against
      // real PostgreSQL. Three retry periods pass without another attempt.
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(cue.mock.calls.length).toBe(cuesAtSuccess);
      expect((await intentRow(intent.id)).status).toBe('pending');
    });

    it('leaves a later intent\'s Redis latch in place when the earlier marker finally commits', async () => {
      const { pageId, intent } = await dispatchedCommit();
      shortMarkerTimings(150, 100);
      const release = await blockMarker(intent.id);
      await declareCollabCommitUnknown(intent, () => undefined).record();
      expect(await latchMembers(pageId)).toEqual([intent.id]);
      // A later failed commit of the same page latched its own intent meanwhile.
      const later = randomUUID();
      await redis.sAdd(collabCommitUnknownKey(pageId), later);

      await release();
      // The process latch goes only after this intent's member was removed.
      await vi.waitFor(() => {
        expect(processCollabCommitLatches.locallyUnknown(intent.id)).toBe(false);
      }, { timeout: 10_000 });
      expect((await intentRow(intent.id)).marker).toBeInstanceOf(Date);

      expect(await latchMembers(pageId)).toEqual([later]);
    });

    it('retires an orphaned finished upload phase only once the marker is proven', async () => {
      const pageId = await insertPage();
      const intent = await reserveCommit(pageId, await insertUser(), 'collab.commit.confluence.media');
      await runPageWriteIntentEffect(intent, { kind: 'remote', completesRemoteWork: false }, async () => undefined);
      // A finished upload keeps its continuation: the runtime's drain waits for it.
      expect(pageWriteIntentHoldsDrain(intent.id)).toBe(true);
      shortMarkerTimings(150, 100);
      const release = await blockMarker(intent.id);

      // The next phase was refused and never ran; the marker cannot be recorded yet.
      await declareCollabCommitUnknown(intent, () => undefined).record();
      expect((await intentRow(intent.id)).marker).toBeNull();
      expect(pageWriteIntentHoldsDrain(intent.id)).toBe(true);

      await release();
      await vi.waitFor(() => expect(pageWriteIntentHoldsDrain(intent.id)).toBe(false), { timeout: 10_000 });
      const row = await intentRow(intent.id);
      expect(row.marker).toBeInstanceOf(Date);
      // Nothing was settled, and the original runtime cannot issue the next phase.
      expect(row.status).toBe('pending');
      const reissued = vi.fn(async () => undefined);
      await expect(runPageWriteIntentEffect(intent, { kind: 'remote', completesRemoteWork: true }, reissued))
        .rejects.toMatchObject({ statusCode: 409, reason: 'intent_outcome_unknown' });
      expect(reissued).not.toHaveBeenCalled();
    });

    it('never touches a running effect', async () => {
      const pageId = await insertPage();
      const intent = await reserveCommit(pageId, await insertUser(), 'collab.commit.confluence.media');
      const finished = vi.fn();

      await runPageWriteIntentEffect(intent, { kind: 'remote', completesRemoteWork: false }, async () => {
        await declareCollabCommitUnknown(intent, () => undefined).record();
        expect((await intentRow(intent.id)).marker).toBeInstanceOf(Date);
        expect(pageWriteIntentHoldsDrain(intent.id)).toBe(true);
        finished();
      });

      // The running phase completed as its own gate decides.
      expect(finished).toHaveBeenCalledTimes(1);
      expect(pageWriteIntentHoldsDrain(intent.id)).toBe(true);
      expect((await intentRow(intent.id)).effect_finished_at).toBeInstanceOf(Date);
    });

    it('writes no marker on a fenced or quiesced epoch, whose row already reads as unknown', async () => {
      const { pageId, intent } = await dispatchedCommit();
      // The owning epoch was fenced while its Save was still pending.
      const fenced = await insertTestRuntime({ fenced: true });
      await query('UPDATE page_write_intents SET runtime_id = $2 WHERE id = $1', [intent.id, fenced]);
      const cue = vi.fn();

      const declaration = declareCollabCommitUnknown({ ...intent, runtimeId: fenced }, cue);
      await declaration.record();

      expect((await intentRow(intent.id)).marker).toBeNull();
      expect(await durableState(pageId)).toEqual({ state: 'unknown', intentId: intent.id });
      expect(await waitForDatabaseCondition(async () => !processCollabCommitLatches.locallyUnknown(intent.id)))
        .toBe(true);
    });

    it('publishes no cue before the gate opens, not from a background retry either, and announces a marker proven meanwhile', async () => {
      const { intent } = await dispatchedCommit();
      shortMarkerTimings(150, 50);
      const release = await blockMarker(intent.id);
      const cue = vi.fn();
      const warn = vi.spyOn(logger, 'warn');
      const failedAttempts = (): number => warn.mock.calls
        .filter((call) => call[1] === 'collab.commit_unknown_marker_failed').length;

      // The route has not attempted its request-admission release yet.
      const declaration = declareCollabCommitUnknown(intent, cue);
      await declaration.record();
      expect(failedAttempts()).toBe(3);
      // Background retries run and fail meanwhile.
      await vi.waitFor(() => expect(failedAttempts()).toBeGreaterThanOrEqual(6), { timeout: 10_000 });
      expect(cue).not.toHaveBeenCalled();

      // A retry proves the marker while the gate is still closed.
      await release();
      await vi.waitFor(() => {
        expect(processCollabCommitLatches.locallyUnknown(intent.id)).toBe(false);
      }, { timeout: 10_000 });
      expect((await intentRow(intent.id)).marker).toBeInstanceOf(Date);
      expect(cue).not.toHaveBeenCalled();

      declaration.announce();
      expect(cue).toHaveBeenCalledTimes(1);
    });

    it('keeps a later intent\'s latch when an earlier intent\'s write reaches Redis late', async () => {
      const relay = await redisRelay();
      const stalled = await relayedClient(relay);
      const actor = await insertUser();
      const pageId = await insertPage();
      const first = await reserveCommit(pageId, actor);
      await failAfterDispatch(first);
      shortMarkerTimings(150, 60_000);
      const releaseFirst = await blockMarker(first.id);

      // The first owner's Redis connection stalls: its latch write leaves the
      // client, gets no further, and is abandoned at its deadline.
      setRedisClient(stalled);
      relay.hold();
      await declareCollabCommitUnknown(first, () => undefined).record();
      expect(await latchMembers(pageId)).toEqual([]);

      // That Save is settled. A later Save of the page fails on another
      // runtime, whose Redis connection works, and latches its own intent.
      await releaseFirst();
      await settleBySql(first.id);
      setRedisClient(redis);
      const second = await reserveCommit(pageId, actor);
      await failAfterDispatch(second);
      await blockMarker(second.id);
      await declareCollabCommitUnknown(second, () => undefined).record();
      expect(await latchMembers(pageId)).toEqual([second.id]);

      // Now the first owner's write arrives.
      relay.release();
      await vi.waitFor(async () => {
        expect(await latchMembers(pageId)).toContain(first.id);
      }, { timeout: 5_000 });

      // It replaced nothing: a pod that missed the cue still reads the later intent's latch.
      expect(await latchMembers(pageId)).toContain(second.id);
      expect(await durableState(pageId)).toEqual({ state: 'in_flight', intentId: second.id });
      expect(await effectiveState(pageId, { unknownCommitIntentId: null }, anotherProcess())).toBe('unknown');
    });

    it('sends neither a latch write nor a cue that expired while Redis was unreachable once it reconnects', async () => {
      const relay = await redisRelay();
      const unreachable = await relayedClient(relay);
      const runtime = await createCollabRuntime(unreachable, 'commit-unknown-unreachable-redis');
      onTestFinished(() => runtime.close());
      const { pageId, intent } = await dispatchedCommit();
      const received: string[] = [];
      const listener = redis.duplicate() as RedisClientType;
      await listener.connect();
      onTestFinished(async () => { await listener.quit(); });
      await listener.subscribe(collabDocChannel(pageId), (message) => { received.push(message); });
      shortMarkerTimings(150, 60_000);
      const release = await blockMarker(intent.id);
      const warn = vi.spyOn(logger, 'warn');
      const logged = (message: string): boolean => warn.mock.calls.some((call) => call[1] === message);

      setRedisClient(unreachable);
      relay.goDown();
      await vi.waitFor(() => expect(unreachable.isReady).toBe(false), { timeout: 5_000 });
      // Both commands wait in the client's queue for the reconnect, and both expire there.
      const declaration = declareCollabCommitUnknown(
        intent,
        () => runtime.announceCommitUnknown(pageId, intent.id),
      );
      await declaration.record();
      expect(logged('collab.commit_unknown_latch_failed')).toBe(true);
      declaration.announce();
      await vi.waitFor(() => {
        expect(logged('collab.commit_unknown_cue_unpublished')).toBe(true);
      }, { timeout: 5_000 });

      // The Save is settled and its declaration withdrawn before Redis is back.
      await release();
      await settleBySql(intent.id);
      await _resetCollabCommitUnknownForTest();
      relay.comeUp();
      await vi.waitFor(() => expect(unreachable.isReady).toBe(true), { timeout: 10_000 });
      // Whatever was still queued has been sent before this answer.
      await unreachable.ping();
      await redis.publish(collabDocChannel(pageId), 'after-reconnect');
      await vi.waitFor(() => expect(received).toContain('after-reconnect'), { timeout: 5_000 });

      expect(await latchMembers(pageId)).toEqual([]);
      expect(received).toEqual(['after-reconnect']);
    });

    it('fences a retry that is running when the declarations are reset', async () => {
      const { intent } = await dispatchedCommit();
      shortMarkerTimings(150, 50);
      const release = await blockMarker(intent.id);
      const cue = vi.fn();
      const declaration = declareCollabCommitUnknown(intent, cue);
      await declaration.record();
      // A background attempt waits long enough for the reset to find it in flight.
      vi.stubEnv('COLLAB_COMMIT_MARKER_DEADLINE_MS', '2000');
      declaration.announce();
      // A background retry published its cue and now waits for the marker.
      await vi.waitFor(() => expect(cue.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
      const cuesAtReset = cue.mock.calls.length;

      // The reset is requested while that attempt is in flight; the attempt
      // then gets through, and the reset waits for it.
      const reset = _resetCollabCommitUnknownForTest();
      await release();
      await reset;

      // The withdrawn retry announced nothing and scheduled nothing.
      expect(cue.mock.calls.length).toBe(cuesAtReset);
      expect(processCollabCommitLatches.locallyUnknown(intent.id)).toBe(false);
      expect((await intentRow(intent.id)).marker).toBeInstanceOf(Date);
    });
  });
});
