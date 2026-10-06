import { randomUUID } from 'node:crypto';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
  waitForDatabaseCondition,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { query } from '../../core/db/postgres.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import {
  _resetWebhookEmitHookForTests,
  setWebhookEmitHook,
} from '../../core/services/webhook-emit-hook.js';
import type { WebhookEvent } from '../../core/services/webhook-emit-hook.js';
import { pagesCrudRoutes } from './pages-crud.js';
import {
  buildKnowledgeTestApp,
  insertLocalSpace,
  insertStandalonePage,
  insertUser,
} from './pages.test-helpers.js';

const [dbAvailable, redisAvailable] = await Promise.all([isDbAvailable(), isRedisAvailable()]);

interface PersistedEvent {
  event_type: string;
  payload: Record<string, unknown>;
  status: string;
}

let app: FastifyInstance;
let redis: RedisClientType;
let currentUserId: string;
let subscriptionId: string;

async function persistEvent(event: WebhookEvent): Promise<void> {
  const subscriptions = await query<{ id: string }>(
    `SELECT id
       FROM webhook_subscriptions
      WHERE active = TRUE AND $1 = ANY(event_types)
      ORDER BY id`,
    [event.eventType],
  );
  const payload = JSON.stringify(event.payload);
  const insertSql = `INSERT INTO webhook_outbox
                       (subscription_id, event_type, payload, payload_bytes, status, next_dispatch_at)
                     VALUES ($1, $2, $3::jsonb, $4, 'pending', NOW())`;
  for (const subscription of subscriptions.rows) {
    const params = [
      subscription.id,
      event.eventType,
      payload,
      Buffer.byteLength(payload),
    ];
    if (event.tx) {
      await event.tx.query(insertSql, params);
    } else {
      await query(insertSql, params);
    }
  }
}

async function readEvents(expectedCount: number): Promise<PersistedEvent[]> {
  let rows: PersistedEvent[] = [];
  await waitForDatabaseCondition(async () => {
    const result = await query<PersistedEvent>(
      `SELECT event_type, payload, status
         FROM webhook_outbox
        WHERE subscription_id = $1
        ORDER BY created_at, id`,
      [subscriptionId],
    );
    rows = result.rows;
    return rows.length >= expectedCount;
  });
  return rows;
}

async function persistedPage(pageId: number): Promise<{
  title: string;
  body_html: string;
  deleted_at: Date | null;
} | null> {
  const result = await query<{
    title: string;
    body_html: string;
    deleted_at: Date | null;
  }>('SELECT title, body_html, deleted_at FROM pages WHERE id = $1', [pageId]);
  return result.rows[0] ?? null;
}

describe.skipIf(!dbAvailable || !redisAvailable)(
  'pages CRUD webhook outbox behavior — real PostgreSQL and Redis',
  () => {
    beforeAll(async () => {
      await setupTestDb();
      redis = createClient({
        url: process.env.REDIS_URL,
        socket: { reconnectStrategy: false, connectTimeout: 1_000 },
      });
      redis.on('error', () => undefined);
      await redis.connect();
      setRedisClient(redis);
      app = await buildKnowledgeTestApp(() => currentUserId, async (instance) => {
        instance.redis = redis;
        await instance.register(pagesCrudRoutes, { prefix: '/api' });
      });
    });

    afterAll(async () => {
      _resetWebhookEmitHookForTests();
      await app.close();
      setRedisClient(null as unknown as RedisClientType);
      if (redis.isOpen) await redis.quit();
      await teardownTestDb();
    });

    beforeEach(async () => {
      await truncateAllTables();
      await redis.flushDb();
      currentUserId = await insertUser(`webhook-route-${randomUUID()}`);
      await insertLocalSpace('LOCAL', currentUserId);
      const subscription = await query<{ id: string }>(
        `INSERT INTO webhook_subscriptions
           (user_id, label, url, secret_enc, event_types, active)
         VALUES ($1, 'route integration', 'https://receiver.example.test/hooks', $2,
                 ARRAY['page.created', 'page.updated', 'page.deleted'], TRUE)
         RETURNING id`,
        [currentUserId, Buffer.from('encrypted-test-secret')],
      );
      subscriptionId = subscription.rows[0]!.id;
      _resetWebhookEmitHookForTests();
      setWebhookEmitHook(persistEvent);
    });

    it('persists page.created only after the standalone page exists', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: {
          title: 'Created article',
          bodyHtml: '<p>Hello</p>',
          source: 'standalone',
          spaceKey: 'LOCAL',
          visibility: 'private',
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      const pageId = response.json<{ id: number }>().id;
      expect(await persistedPage(pageId)).toMatchObject({
        title: 'Created article',
        body_html: '<p>Hello</p>',
        deleted_at: null,
      });
      const events = await readEvents(1);
      expect(events).toEqual([{
        event_type: 'page.created',
        status: 'pending',
        payload: expect.objectContaining({
          pageId,
          title: 'Created article',
          spaceKey: 'LOCAL',
          isLocal: true,
          createdAt: expect.any(String),
        }),
      }]);
    });

    it('does not persist page.created when validation or parent validation refuses the mutation', async () => {
      const invalid = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: { bodyHtml: '<p>Missing title</p>', source: 'standalone' },
      });
      const missingParent = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: {
          title: 'Child',
          bodyHtml: '<p>Child</p>',
          source: 'standalone',
          spaceKey: 'LOCAL',
          parentId: '999999',
        },
      });

      expect(invalid.statusCode).toBe(400);
      expect(missingParent.statusCode).toBe(400);
      const events = await query('SELECT 1 FROM webhook_outbox WHERE subscription_id = $1', [subscriptionId]);
      const pages = await query("SELECT 1 FROM pages WHERE title = 'Child'");
      expect(events.rowCount).toBe(0);
      expect(pages.rowCount).toBe(0);
    });

    it('persists page.updated with the committed title and body', async () => {
      const pageId = await insertStandalonePage('Before', 'private', currentUserId, 'LOCAL');

      const response = await app.inject({
        method: 'PUT',
        url: `/api/pages/${pageId}`,
        payload: { title: 'After', bodyHtml: '<p>After body</p>', version: 1 },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(await persistedPage(pageId)).toMatchObject({
        title: 'After',
        body_html: '<p>After body</p>',
        deleted_at: null,
      });
      const events = await readEvents(1);
      expect(events).toEqual([{
        event_type: 'page.updated',
        status: 'pending',
        payload: expect.objectContaining({
          pageId,
          title: 'After',
          spaceKey: 'LOCAL',
          updatedAt: expect.any(String),
        }),
      }]);
    });

    it('does not persist page.updated for a version conflict', async () => {
      const pageId = await insertStandalonePage('Current', 'private', currentUserId, 'LOCAL');
      await query('UPDATE pages SET version = 10 WHERE id = $1', [pageId]);

      const response = await app.inject({
        method: 'PUT',
        url: `/api/pages/${pageId}`,
        payload: { title: 'Stale', bodyHtml: '<p>Stale</p>', version: 3 },
      });

      expect(response.statusCode).toBe(409);
      expect(await persistedPage(pageId)).toMatchObject({
        title: 'Current',
        body_html: '<p>x</p>',
        deleted_at: null,
      });
      const events = await query('SELECT 1 FROM webhook_outbox WHERE subscription_id = $1', [subscriptionId]);
      expect(events.rowCount).toBe(0);
    });

    it('persists one page.deleted event per row after a standalone cascade commits', async () => {
      const parent = await insertStandalonePage('Parent', 'private', currentUserId, 'LOCAL');
      const child = await insertStandalonePage(
        'Child',
        'shared',
        currentUserId,
        'LOCAL',
        { parentId: String(parent) },
      );

      const response = await app.inject({ method: 'DELETE', url: `/api/pages/${parent}` });

      expect(response.statusCode, response.body).toBe(200);
      expect((await persistedPage(parent))?.deleted_at).toBeInstanceOf(Date);
      expect((await persistedPage(child))?.deleted_at).toBeInstanceOf(Date);
      const events = await readEvents(2);
      expect(events.map((event) => event.event_type)).toEqual(['page.deleted', 'page.deleted']);
      expect(
        events
          .map((event) => event.payload)
          .sort((left, right) => Number(left.pageId) - Number(right.pageId)),
      ).toEqual([
        { pageId: parent, isHardDelete: false },
        { pageId: child, isHardDelete: false },
      ]);
    });

    it('does not persist page.deleted when a non-owner is refused', async () => {
      const owner = await insertUser(`webhook-owner-${randomUUID()}`);
      const pageId = await insertStandalonePage('Not mine', 'private', owner, 'LOCAL');

      const response = await app.inject({ method: 'DELETE', url: `/api/pages/${pageId}` });

      expect(response.statusCode).toBe(403);
      expect(await persistedPage(pageId)).toMatchObject({ deleted_at: null });
      const events = await query('SELECT 1 FROM webhook_outbox WHERE subscription_id = $1', [subscriptionId]);
      expect(events.rowCount).toBe(0);
    });
  },
);
