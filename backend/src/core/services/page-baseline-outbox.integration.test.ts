import { randomUUID } from 'node:crypto';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PageLifecycleEventSchema, type PageLifecycleEvent } from '@compendiq/contracts';
import { getPool, query } from '../db/postgres.js';
import { PAGE_WRITE_INVALIDATION_LOCK_ID } from '../db/advisory-locks.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { prefixedRedisChannel } from '../utils/prefixed-redis-channel.js';
import { RedisCache, setRedisClient } from './redis-cache.js';
import {
  enqueuePageLifecycleEvent,
  initPageBaselineOutbox,
  pollPageLifecycleOutbox,
  setPageLifecycleWebhookDelivery,
} from './page-baseline-outbox.js';
import { enqueuePageWriteInvalidation } from './page-write-invalidation.js';

const [dbAvailable, redisAvailable] = await Promise.all([isDbAvailable(), isRedisAvailable()]);

describe.skipIf(!dbAvailable || !redisAvailable)('durable page lifecycle delivery — real PostgreSQL and Redis', () => {
  let producer: RedisClientType;
  let observer: RedisClientType;
  let subscriber: RedisClientType;
  let pageId: number;
  let initialLifecycleRevision: string;
  const actorId = randomUUID();

  beforeAll(async () => {
    await setupTestDb();
    producer = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false } });
    observer = producer.duplicate();
    subscriber = producer.duplicate();
    await Promise.all([producer.connect(), observer.connect(), subscriber.connect()]);
    setRedisClient(producer);
  });

  beforeEach(async () => {
    await truncateAllTables();
    await query(
      "INSERT INTO users (id, username, email, password_hash) VALUES ($1, 'outbox-owner', 'outbox-owner@test', 'x')",
      [actorId],
    );
    const page = await query<{ id: number; lifecycle_revision: string }>(
      `INSERT INTO pages (source, title, body_html, body_text, created_by_user_id)
       VALUES ('standalone', 'Outbox article', '<p>Original</p>', 'Original', $1)
       RETURNING id, lifecycle_revision::text`, [actorId],
    );
    pageId = page.rows[0]!.id;
    initialLifecycleRevision = page.rows[0]!.lifecycle_revision;
    await pollPageLifecycleOutbox();
  });

  afterAll(async () => {
    await subscriber.unsubscribe();
    await Promise.all([producer, observer, subscriber].filter((client) => client.isOpen).map((client) => client.quit()));
    await teardownTestDb();
  });

  it('retries a committed event after a real closed-client failure and invalidates both caches across users only once after success', async () => {
    const nextRevision = (BigInt(initialLifecycleRevision) + 1n).toString();
    const event: PageLifecycleEvent = {
      type: 'page_lifecycle', pageId, lifecycleRevision: nextRevision, isFrozen: false, baselineId: null,
    };
    const pageKey = `kb:${actorId}:pages:article:${pageId}`;
    const otherUserPageKey = `kb:${randomUUID()}:pages:tree`;
    const searchKey = `kb:${actorId}:search:query`;
    const unrelatedKey = `baseline-outbox-test:${randomUUID()}`;
    await observer.mSet({ [pageKey]: 'old page', [otherUserPageKey]: 'old tree', [searchKey]: 'old results', [unrelatedKey]: 'keep' });
    const seen: PageLifecycleEvent[] = [];
    let observeEvent!: (event: PageLifecycleEvent) => void;
    const eventReceived = new Promise<PageLifecycleEvent>((resolve) => { observeEvent = resolve; });
    const lifecycleCache = new RedisCache(producer);
    const lifecycleFillReceipt = await lifecycleCache.getWithGeneration(
      actorId,
      'pages',
      `lifecycle-fill:${pageId}`,
    );
    await subscriber.subscribe(prefixedRedisChannel('page:lifecycle'), (message) => {
      const received = PageLifecycleEventSchema.parse(JSON.parse(message));
      seen.push(received);
      observeEvent(received);
    });
    const client = await getPool().connect();
    let deliveryId: string;
    try {
      await client.query('BEGIN');
      await client.query('UPDATE pages SET lifecycle_revision = lifecycle_revision + 1 WHERE id = $1', [pageId]);
      deliveryId = await enqueuePageLifecycleEvent(client, event);
      expect(await enqueuePageLifecycleEvent(client, event)).toBe(deliveryId);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    await producer.quit();
    await expect(pollPageLifecycleOutbox()).rejects.toThrow();
    expect((await query('SELECT lifecycle_revision::text FROM pages WHERE id = $1', [pageId])).rows)
      .toEqual([{ lifecycle_revision: nextRevision }]);
    const failed = await query<{ delivered_at: Date | null; last_error: string | null }>(
      'SELECT delivered_at, last_error FROM page_lifecycle_outbox WHERE id = $1', [deliveryId],
    );
    expect(failed.rows[0]?.delivered_at).toBeNull();
    expect(failed.rows[0]?.last_error).toBeTruthy();
    expect(await observer.mGet([pageKey, otherUserPageKey, searchKey])).toEqual(['old page', 'old tree', 'old results']);

    producer = observer.duplicate();
    await producer.connect();
    setRedisClient(producer);
    // Make the persisted retry due without a guessed sleep or mocked clock.
    await query("UPDATE page_lifecycle_outbox SET next_attempt_at = 'epoch'::timestamptz WHERE id = $1", [deliveryId]);
    expect(await pollPageLifecycleOutbox()).toBe(1);
    expect(await eventReceived).toEqual(event);
    expect(await observer.mGet([pageKey, otherUserPageKey, searchKey, unrelatedKey])).toEqual([null, null, null, 'keep']);
    expect(await pollPageLifecycleOutbox()).toBe(0);
    expect(seen).toEqual([event]);
    expect(await new RedisCache(producer).setIfCurrent(
      actorId,
      'pages',
      `lifecycle-fill:${pageId}`,
      lifecycleFillReceipt.generation,
      { lifecycleRevision: initialLifecycleRevision },
    )).toBe(false);
    const delivered = await query<{ delivered_at: Date | null; last_error: string | null; attempt_count: number }>(
      'SELECT delivered_at, last_error, attempt_count FROM page_lifecycle_outbox WHERE id = $1', [deliveryId],
    );
    expect(delivered.rows[0]).toMatchObject({ last_error: null, attempt_count: 2 });
    expect(delivered.rows[0]?.delivered_at).not.toBeNull();
    await observer.del(unrelatedKey);
    await subscriber.unsubscribe();
  });

  it('keeps another user cacheable when a per-user namespace is invalidated', async () => {
    const otherUserId = randomUUID();
    const identifier = `scope:${randomUUID()}`;
    const cache = new RedisCache(producer);
    const ownerReceipt = await cache.getWithGeneration<{ title: string }>(
      actorId,
      'pages',
      identifier,
    );
    const otherReceipt = await cache.getWithGeneration<{ title: string }>(
      otherUserId,
      'pages',
      identifier,
    );
    expect(await cache.setIfCurrent(
      actorId,
      'pages',
      identifier,
      ownerReceipt.generation,
      { title: 'owner' },
    )).toBe(true);
    expect(await cache.setIfCurrent(
      otherUserId,
      'pages',
      identifier,
      otherReceipt.generation,
      { title: 'other' },
    )).toBe(true);

    await cache.invalidate(actorId, 'pages');

    expect((await cache.getWithGeneration<{ title: string }>(
      actorId,
      'pages',
      identifier,
    )).value).toBeNull();
    expect((await cache.getWithGeneration<{ title: string }>(
      otherUserId,
      'pages',
      identifier,
    )).value).toEqual({ title: 'other' });
    await observer.del(`kb:${otherUserId}:pages:${identifier}`);
  });

  it('retains a failed body-write cache delivery and retries it through the lifecycle poller', async () => {
    const intentId = randomUUID();
    const runtimeId = `outbox-runtime-${randomUUID()}`;
    await query(
      `INSERT INTO page_writer_runtimes (runtime_id, deployment_identity)
       VALUES ($1, $2::jsonb)`,
      [runtimeId, JSON.stringify({ host: 'outbox-integration-test' })],
    );
    await query(
      `INSERT INTO page_write_intents
         (id, runtime_id, kind, actor_id, page_ids, revisions, recovery_mode, effect)
       VALUES ($1, $2, 'page.ai_apply', $3, ARRAY[$4]::integer[], '{}'::jsonb,
               'remote_conditional', $5::jsonb)`,
      [
        intentId,
        runtimeId,
        actorId,
        pageId,
        JSON.stringify({
          effectClass: 'remote',
          pageId,
          confluenceId: `outbox-${pageId}`,
          expectedRemoteVersion: '1',
          intendedStateDigest: '0'.repeat(64),
        }),
      ],
    );
    const pageKey = `kb:${actorId}:pages:article:${pageId}`;
    const searchKey = `kb:${randomUUID()}:search:body-write`;
    const unrelatedKey = `body-write-outbox-test:${randomUUID()}`;
    const cacheBeforePublication = new RedisCache(producer);
    const pageFillReceipt = await cacheBeforePublication.getWithGeneration(
      actorId,
      'pages',
      `body-write-recovery:${pageId}`,
    );
    const searchFillReceipt = await cacheBeforePublication.getWithGeneration(
      actorId,
      'search',
      `body-write-recovery:${pageId}`,
    );
    await observer.mSet({
      [pageKey]: 'stale page',
      [searchKey]: 'stale search',
      [unrelatedKey]: 'keep',
    });

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await enqueuePageWriteInvalidation(client, intentId);
      await client.query(
        `UPDATE page_write_intents
            SET status = 'completed',
                settled_at = NOW(),
                settlement_reason = 'integration_test_completion',
                settlement_proof = '{}'::jsonb
          WHERE id = $1`,
        [intentId],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    await producer.quit();
    await expect(pollPageLifecycleOutbox()).rejects.toThrow();
    expect(
      (await query<{ cache_invalidation_pending: boolean }>(
        'SELECT cache_invalidation_pending FROM page_write_intents WHERE id = $1',
        [intentId],
      )).rows[0]?.cache_invalidation_pending,
    ).toBe(true);
    expect(await observer.mGet([pageKey, searchKey])).toEqual(['stale page', 'stale search']);

    producer = observer.duplicate();
    await producer.connect();
    setRedisClient(producer);
    expect(await pollPageLifecycleOutbox()).toBe(0);
    expect(await observer.mGet([pageKey, searchKey, unrelatedKey])).toEqual([null, null, 'keep']);
    const recoveredCache = new RedisCache(producer);
    expect(await recoveredCache.setIfCurrent(
      actorId,
      'pages',
      `body-write-recovery:${pageId}`,
      pageFillReceipt.generation,
      { title: 'stale page' },
    )).toBe(false);
    expect(await recoveredCache.setIfCurrent(
      actorId,
      'search',
      `body-write-recovery:${pageId}`,
      searchFillReceipt.generation,
      { titles: ['stale page'] },
    )).toBe(false);
    expect(
      (await query<{ cache_invalidation_pending: boolean }>(
        'SELECT cache_invalidation_pending FROM page_write_intents WHERE id = $1',
        [intentId],
      )).rows[0]?.cache_invalidation_pending,
    ).toBe(false);
    expect(
      (await query<{ count: string }>('SELECT COUNT(*)::text AS count FROM page_lifecycle_outbox'))
        .rows[0]?.count,
    ).toBe('0');
    await observer.del(unrelatedKey);
  });

  it('rejects old pages and search fills after durable publication invalidation', async () => {
    const intentId = randomUUID();
    const runtimeId = `stale-fill-runtime-${randomUUID()}`;
    const pageIdentifier = `graph:individual:${randomUUID()}`;
    const searchIdentifier = `query:${randomUUID()}`;
    const cache = new RedisCache(producer);
    const pageReceipt = await cache.getWithGeneration<{ title: string }>(
      actorId,
      'pages',
      pageIdentifier,
    );
    const searchReceipt = await cache.getWithGeneration<{ titles: string[] }>(
      actorId,
      'search',
      searchIdentifier,
    );
    const beforePublication = await query<{ title: string }>(
      'SELECT title FROM pages WHERE id = $1',
      [pageId],
    );
    expect(beforePublication.rows[0]?.title).toBe('Outbox article');

    await query(
      `INSERT INTO page_writer_runtimes (runtime_id, deployment_identity)
       VALUES ($1, $2::jsonb)`,
      [runtimeId, JSON.stringify({ host: 'stale-fill-integration-test' })],
    );
    await query(
      `INSERT INTO page_write_intents
         (id, runtime_id, kind, actor_id, page_ids, revisions, recovery_mode, effect)
       VALUES ($1, $2, 'page.ai_apply', $3, ARRAY[$4]::integer[], '{}'::jsonb,
               'remote_conditional', $5::jsonb)`,
      [
        intentId,
        runtimeId,
        actorId,
        pageId,
        JSON.stringify({
          effectClass: 'remote',
          pageId,
          confluenceId: `stale-fill-${pageId}`,
          expectedRemoteVersion: '1',
          intendedStateDigest: '1'.repeat(64),
        }),
      ],
    );
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE pages SET title = 'Published article' WHERE id = $1", [pageId]);
      await enqueuePageWriteInvalidation(client, intentId);
      await client.query(
        `UPDATE page_write_intents
            SET status = 'completed',
                settled_at = NOW(),
                settlement_reason = 'stale_fill_test_completion',
                settlement_proof = '{}'::jsonb
          WHERE id = $1`,
        [intentId],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    expect(await pollPageLifecycleOutbox()).toBe(0);
    expect(
      await cache.setIfCurrent(
        actorId,
        'pages',
        pageIdentifier,
        pageReceipt.generation,
        { title: beforePublication.rows[0]!.title },
      ),
    ).toBe(false);
    expect(
      await cache.setIfCurrent(
        actorId,
        'search',
        searchIdentifier,
        searchReceipt.generation,
        { titles: [beforePublication.rows[0]!.title] },
      ),
    ).toBe(false);

    const currentPageReceipt = await cache.getWithGeneration<{ title: string }>(
      actorId,
      'pages',
      pageIdentifier,
    );
    const currentSearchReceipt = await cache.getWithGeneration<{ titles: string[] }>(
      actorId,
      'search',
      searchIdentifier,
    );
    expect(currentPageReceipt.value).toBeNull();
    expect(currentSearchReceipt.value).toBeNull();
    const afterPublication = await query<{ title: string }>(
      'SELECT title FROM pages WHERE id = $1',
      [pageId],
    );
    expect(
      await cache.setIfCurrent(
        actorId,
        'pages',
        pageIdentifier,
        currentPageReceipt.generation,
        { title: afterPublication.rows[0]!.title },
      ),
    ).toBe(true);
    expect(
      await cache.setIfCurrent(
        actorId,
        'search',
        searchIdentifier,
        currentSearchReceipt.generation,
        { titles: [afterPublication.rows[0]!.title] },
      ),
    ).toBe(true);
    expect((await cache.getWithGeneration<{ title: string }>(
      actorId,
      'pages',
      pageIdentifier,
    )).value).toEqual({ title: 'Published article' });
    expect((await cache.getWithGeneration<{ titles: string[] }>(
      actorId,
      'search',
      searchIdentifier,
    )).value).toEqual({ titles: ['Published article'] });
    await observer.del([
      `kb:${actorId}:pages:${pageIdentifier}`,
      `kb:${actorId}:search:${searchIdentifier}`,
    ]);
  });

  it('rejects an old public cache fill after a coalesced privacy write commits', async () => {
    await query("UPDATE pages SET title = 'Queued article', visibility = 'shared' WHERE id = $1", [pageId]);
    const writer = await getPool().connect();
    let deliverySettled = false;
    let delivery: Promise<{ error: unknown }> | undefined;
    try {
      await writer.query('BEGIN');
      const writerPid = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      await writer.query("UPDATE pages SET visibility = 'private' WHERE id = $1", [pageId]);
      delivery = pollPageLifecycleOutbox().then(
        () => { deliverySettled = true; return { error: null }; },
        (error: unknown) => { deliverySettled = true; return { error }; },
      );
      await expect.poll(async () => {
        if (deliverySettled) return true;
        const waiting = await query<{ blocked: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database()
                AND $1::integer = ANY(pg_blocking_pids(pid))
           ) AS blocked`,
          [writerPid],
        );
        return waiting.rows[0]!.blocked;
      }).toBe(true);

      const otherUser = randomUUID();
      const cache = new RedisCache(observer);
      const identifier = `coalesced-privacy:${pageId}`;
      const fill = await cache.getWithGeneration(otherUser, 'pages', identifier);
      const oldVisibleRows = await query<{ title: string }>(
        "SELECT title FROM pages WHERE id = $1 AND visibility = 'shared'",
        [pageId],
      );
      expect(oldVisibleRows.rows).toEqual([{ title: 'Queued article' }]);
      await writer.query('COMMIT');
      expect(await delivery).toEqual({ error: null });
      await pollPageLifecycleOutbox();

      expect(await cache.setIfCurrent(
        otherUser, 'pages', identifier, fill.generation, oldVisibleRows.rows,
      )).toBe(false);
      expect((await cache.getWithGeneration(otherUser, 'pages', identifier)).value).toBeNull();
      expect((await query("SELECT id FROM pages WHERE id = $1 AND visibility = 'shared'", [pageId])).rows)
        .toEqual([]);
      expect((await query('SELECT page_id FROM page_cache_invalidation_queue WHERE page_id = $1', [pageId])).rows)
        .toEqual([]);
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
      await delivery;
    }
  });

  it('retries a SQL-only privacy change and rejects cache fills captured before publication', async () => {
    await query("UPDATE pages SET visibility = 'shared' WHERE id = $1", [pageId]);
    await pollPageLifecycleOutbox();
    const otherUserId = randomUUID();
    const cache = new RedisCache(observer);
    const identifier = `privacy:${pageId}`;
    const old = await cache.getWithGeneration(otherUserId, 'pages', identifier);
    await cache.setIfCurrent(otherUserId, 'pages', identifier, old.generation, { title: 'Outbox article' });

    await producer.quit();
    await query("UPDATE pages SET visibility = 'private' WHERE id = $1", [pageId]);
    await expect(pollPageLifecycleOutbox()).rejects.toThrow();
    expect((await query('SELECT visibility FROM pages WHERE id = $1', [pageId])).rows)
      .toEqual([{ visibility: 'private' }]);
    expect((await query('SELECT page_id FROM page_cache_invalidation_queue')).rows)
      .toEqual([{ page_id: pageId }]);

    producer = observer.duplicate();
    await producer.connect();
    setRedisClient(producer);
    await pollPageLifecycleOutbox();
    expect((await cache.getWithGeneration(otherUserId, 'pages', identifier)).value).toBeNull();
    expect(await cache.setIfCurrent(otherUserId, 'pages', identifier, old.generation, { title: 'Outbox article' }))
      .toBe(false);
    expect((await query('SELECT page_id FROM page_cache_invalidation_queue')).rows).toEqual([]);
  });

  it('retains deletion publication after the page itself no longer exists', async () => {
    const cache = new RedisCache(observer);
    const identifier = `deleted:${pageId}`;
    const old = await cache.getWithGeneration(actorId, 'pages', identifier);
    await cache.setIfCurrent(actorId, 'pages', identifier, old.generation, { title: 'Outbox article' });
    await query('DELETE FROM pages WHERE id = $1', [pageId]);
    expect((await query('SELECT page_id FROM page_cache_invalidation_queue')).rows)
      .toEqual([{ page_id: pageId }]);
    await pollPageLifecycleOutbox();
    expect((await cache.getWithGeneration(actorId, 'pages', identifier)).value).toBeNull();
    expect((await query('SELECT page_id FROM page_cache_invalidation_queue')).rows).toEqual([]);
  });

  it('stops while PostgreSQL publication is locked without a late queue settlement', async () => {
    await query("UPDATE pages SET title = 'Queued before shutdown' WHERE id = $1", [pageId]);
    const blocker = await getPool().connect();
    const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await blocker.query('SELECT pg_advisory_lock($1)', [PAGE_WRITE_INVALIDATION_LOCK_ID]);
    const teardown = await initPageBaselineOutbox({ pollIntervalMs: 60_000 });
    let stop: Promise<void> | undefined;
    let stopped = false;
    let blockedPid: number | undefined;
    try {
      await expect.poll(async () => {
        const waiting = await query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity
            WHERE $1::integer = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock'`,
          [blockerPid],
        );
        blockedPid = waiting.rows[0]?.pid;
        return blockedPid !== undefined;
      }).toBe(true);
      stop = teardown().then(() => { stopped = true; });
      await expect.poll(() => stopped, { timeout: 5_000 }).toBe(true);
    } finally {
      await blocker.query('SELECT pg_advisory_unlock($1)', [PAGE_WRITE_INVALIDATION_LOCK_ID]);
      blocker.release();
      await (stop ?? teardown());
    }
    await expect.poll(async () =>
      (await query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [blockedPid])).rowCount,
    ).toBe(0);
    expect((await query('SELECT page_id FROM page_cache_invalidation_queue')).rows)
      .toEqual([{ page_id: pageId }]);
    await pollPageLifecycleOutbox();
    expect((await query('SELECT page_id FROM page_cache_invalidation_queue')).rows).toEqual([]);
  });

  it('abandons a queued pool checkout without starting SQL after shutdown', async () => {
    await query("UPDATE pages SET title = 'Waiting for a publisher' WHERE id = $1", [pageId]);
    const pool = getPool();
    const leases = await Promise.all(Array.from({ length: pool.options.max ?? 10 }, () => pool.connect()));
    const teardown = await initPageBaselineOutbox({ pollIntervalMs: 60_000 });
    let stop: Promise<void> | undefined;
    let stopped = false;
    try {
      await expect.poll(() => pool.waitingCount).toBe(1);
      stop = teardown().then(() => { stopped = true; });
      await expect.poll(() => stopped, { timeout: 5_000 }).toBe(true);
    } finally {
      for (const lease of leases) lease.release();
      await (stop ?? teardown());
    }
    await expect.poll(() => pool.idleCount).toBe(pool.options.max ?? 10);
    expect((await query('SELECT page_id FROM page_cache_invalidation_queue')).rows)
      .toEqual([{ page_id: pageId }]);
    await pollPageLifecycleOutbox();
    expect((await query('SELECT page_id FROM page_cache_invalidation_queue')).rows).toEqual([]);
  });

  it('cancels teardown while an optional webhook remains unsettled and retains the row', async () => {
    const nextRevision = (BigInt(initialLifecycleRevision) + 1n).toString();
    const event: PageLifecycleEvent = {
      type: 'page_lifecycle',
      pageId,
      lifecycleRevision: nextRevision,
      isFrozen: true,
      baselineId: randomUUID(),
    };
    const client = await getPool().connect();
    let deliveryId: string;
    try {
      await client.query('BEGIN');
      deliveryId = await enqueuePageLifecycleEvent(client, event);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    let webhookStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      webhookStarted = resolve;
    });
    setPageLifecycleWebhookDelivery(async () => {
      webhookStarted();
      await new Promise<void>(() => undefined);
    });
    const teardown = await initPageBaselineOutbox({ pollIntervalMs: 60_000 });
    try {
      await started;
      await teardown();
    } finally {
      setPageLifecycleWebhookDelivery(null);
    }

    const retained = await query<{
      delivered_at: Date | null;
      claimed_at: Date | null;
    }>(
      'SELECT delivered_at, claimed_at FROM page_lifecycle_outbox WHERE id = $1',
      [deliveryId],
    );
    expect(retained.rows[0]?.delivered_at).toBeNull();
    expect(retained.rows[0]?.claimed_at).not.toBeNull();
  });

  it('publishes nothing and leaves caches intact when the lifecycle transaction rolls back', async () => {
    const pageKey = `kb:${actorId}:pages:article:${pageId}`;
    await observer.set(pageKey, 'original cached page');
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE pages SET lifecycle_revision = lifecycle_revision + 1 WHERE id = $1', [pageId]);
      await enqueuePageLifecycleEvent(client, {
        type: 'page_lifecycle', pageId, lifecycleRevision: (BigInt(initialLifecycleRevision) + 1n).toString(),
        isFrozen: false, baselineId: null,
      });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await pollPageLifecycleOutbox()).toBe(0);
    expect(await observer.get(pageKey)).toBe('original cached page');
    expect((await query('SELECT lifecycle_revision::text FROM pages WHERE id = $1', [pageId])).rows)
      .toEqual([{ lifecycle_revision: initialLifecycleRevision }]);
    await observer.del(pageKey);
  });
});
