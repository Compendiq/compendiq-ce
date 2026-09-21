import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type RedisClientType } from 'redis';
import type { FastifyInstance } from 'fastify';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { query } from '../../core/db/postgres.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { pagesCrudRoutes } from '../knowledge/pages-crud.js';
import {
  buildKnowledgeTestApp,
  insertLocalSpace,
  insertStandalonePage,
  insertUser,
} from '../knowledge/pages.test-helpers.js';

const available = await isDbAvailable() && await isRedisAvailable();

describe.skipIf(!available)('embedding state in page consumers — real persistence', () => {
  let app: FastifyInstance;
  let redis: RedisClientType;
  let userId: string;

  beforeAll(async () => {
    await setupTestDb();
    redis = createClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: false, connectTimeout: 1_000 },
    }) as RedisClientType;
    await redis.connect();
    setRedisClient(redis);
    app = await buildKnowledgeTestApp(() => userId, async (instance) => {
      instance.redis = redis;
      await instance.register(pagesCrudRoutes, { prefix: '/api' });
    });
  });

  afterAll(async () => {
    await app.close();
    if (redis.isOpen) await redis.quit();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    await redis.flushDb();
    userId = await insertUser('embedding_status_reader');
    await insertLocalSpace('DEV', userId);
  });

  it('projects every persisted detail status without inventing an error or timestamp', async () => {
    const embeddedAt = new Date('2026-03-01T12:00:00Z');
    const cases = [
      {
        title: 'Embedded',
        status: 'embedded',
        dirty: false,
        embeddedAt,
        error: null,
      },
      {
        title: 'New',
        status: 'not_embedded',
        dirty: true,
        embeddedAt: null,
        error: null,
      },
      {
        title: 'Processing',
        status: 'embedding',
        dirty: true,
        embeddedAt: null,
        error: null,
      },
      {
        title: 'Failed with detail',
        status: 'failed',
        dirty: true,
        embeddedAt: null,
        error: 'Model bge-m3 not found',
      },
      {
        title: 'Failed without detail',
        status: 'failed',
        dirty: true,
        embeddedAt: null,
        error: null,
      },
    ] as const;

    for (const fixture of cases) {
      const pageId = await insertStandalonePage(fixture.title, 'private', userId, 'DEV', {
        dirty: fixture.dirty,
      });
      await query(
        `UPDATE pages
            SET embedding_status = $2,
                embedded_at = $3,
                embedding_error = $4
          WHERE id = $1`,
        [pageId, fixture.status, fixture.embeddedAt, fixture.error],
      );

      const response = await app.inject({ method: 'GET', url: `/api/pages/${pageId}` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: String(pageId),
        embeddingStatus: fixture.status,
        embeddingDirty: fixture.dirty,
        embeddedAt: fixture.embeddedAt?.toISOString() ?? null,
        embeddingError: fixture.error,
      });
    }
  });

  it('keeps embedding state on list summaries', async () => {
    const embeddedAt = new Date('2026-03-01T12:00:00Z');
    const embedded = await insertStandalonePage('Embedded', 'shared', userId, 'DEV');
    const pending = await insertStandalonePage('Pending', 'shared', userId, 'DEV', { dirty: true });
    await query(
      `UPDATE pages SET embedding_status = 'embedded', embedded_at = $2 WHERE id = $1`,
      [embedded, embeddedAt],
    );

    const response = await app.inject({ method: 'GET', url: '/api/pages' });
    expect(response.statusCode).toBe(200);
    const items = response.json().items as Array<Record<string, unknown>>;
    expect(items.find((item) => item.id === String(embedded))).toMatchObject({
      embeddingStatus: 'embedded',
      embeddingDirty: false,
      embeddedAt: embeddedAt.toISOString(),
    });
    expect(items.find((item) => item.id === String(pending))).toMatchObject({
      embeddingStatus: 'not_embedded',
      embeddingDirty: true,
      embeddedAt: null,
    });
  });

  it('keeps embedding state on tree summaries alongside real parent resolution', async () => {
    const embeddedAt = new Date('2026-03-01T12:00:00Z');
    const root = await insertStandalonePage('Root', 'private', userId, 'DEV');
    const child = await insertStandalonePage('Child', 'private', userId, 'DEV', {
      parentId: String(root),
    });
    await query(
      `UPDATE pages SET embedding_status = 'embedded', embedded_at = $2 WHERE id = $1`,
      [root, embeddedAt],
    );

    const response = await app.inject({ method: 'GET', url: '/api/pages/tree' });
    expect(response.statusCode).toBe(200);
    const items = response.json().items as Array<Record<string, unknown>>;
    expect(items.find((item) => item.id === String(root))).toMatchObject({
      embeddingStatus: 'embedded',
      embeddedAt: embeddedAt.toISOString(),
    });
    expect(items.find((item) => item.id === String(child))?.parentId).toBe(String(root));
  });
});
