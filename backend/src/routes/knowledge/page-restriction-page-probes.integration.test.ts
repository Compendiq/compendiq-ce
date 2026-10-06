/**
 * Page-scoped routes a reader can probe by id must answer a restricted page
 * exactly like a missing one and never return its draft (real PostgreSQL +
 * Redis).
 */
import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../core/db/postgres.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { notificationRoutes } from '../foundation/notifications.js';
import { seedRestrictionFixture, type RestrictionFixture } from './page-restriction.test-helpers.js';
import { pagesCrudRoutes } from './pages-crud.js';
import { pagesPresenceRoutes } from './pages-presence.js';
import { buildKnowledgeTestApp } from './pages.test-helpers.js';

const available = await isDbAvailable() && await isRedisAvailable();
const MISSING_ID = 2_000_000_000;

describe.skipIf(!available)('page probes — restricted pages answer like missing ones', () => {
  let app: FastifyInstance;
  let redis: RedisClientType;
  let currentUserId = '';
  let fx: RestrictionFixture;

  async function probe(userId: string, method: 'GET' | 'POST', url: string, payload?: unknown) {
    currentUserId = userId;
    const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
    return { status: response.statusCode, body: response.body };
  }

  beforeAll(async () => {
    await setupTestDb();
    redis = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false, connectTimeout: 1_000 } });
    redis.on('error', () => undefined);
    await redis.connect();
    setRedisClient(redis);
    app = await buildKnowledgeTestApp(() => currentUserId, async (instance) => {
      instance.redis = redis;
      await instance.register(pagesCrudRoutes, { prefix: '/api' });
      await instance.register(pagesPresenceRoutes, { prefix: '/api' });
      await instance.register(notificationRoutes, { prefix: '/api' });
    });
  });

  afterAll(async () => {
    await app?.close();
    setRedisClient(null);
    if (redis?.isOpen) await redis.quit();
    await truncateAllTables();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    fx = await seedRestrictionFixture();
    await query(
      `UPDATE pages SET draft_body_html = '<p>hushdraft</p>', draft_body_text = 'hushdraft', draft_updated_at = NOW()
        WHERE id = $1`,
      [fx.pages.hushedLeaf],
    );
  });

  it('draft, presence and watch: R gets the missing-page answer, G keeps access', async () => {
    const leaf = fx.pages.hushedLeaf;
    const routes: Array<['GET' | 'POST', (id: number) => string]> = [
      ['GET', (id) => `/api/pages/${id}/draft`],
      ['GET', (id) => `/api/pages/${id}/presence`],
      ['POST', (id) => `/api/pages/${id}/watch`],
    ];
    for (const [method, url] of routes) {
      const restricted = await probe(fx.readerId, method, url(leaf));
      const missing = await probe(fx.readerId, method, url(MISSING_ID));
      expect(restricted, url(leaf)).toEqual(missing);
      expect(restricted.status).toBe(404);
    }
    const draft = await probe(fx.groupReaderId, 'GET', `/api/pages/${leaf}/draft`);
    expect(draft.status).toBe(200);
    expect(draft.body).toContain('hushdraft');
    expect((await probe(fx.groupReaderId, 'POST', `/api/pages/${leaf}/watch`)).status).toBe(200);
  });
});
