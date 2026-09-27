import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../core/db/postgres.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { pagesEmbeddingRoutes } from './pages-embeddings.js';
import {
  buildKnowledgeTestApp,
  insertConfluencePage,
  insertEmbeddings,
  insertUser,
} from './pages.test-helpers.js';

const available = await isDbAvailable() && await isRedisAvailable();

async function deleteKeys(redis: RedisClientType, pattern: string): Promise<void> {
  let cursor = '0';
  do {
    const scanned = await redis.scan(cursor, { MATCH: pattern, COUNT: 100 });
    cursor = String(scanned.cursor);
    if (scanned.keys.length > 0) await redis.del(scanned.keys);
  } while (cursor !== '0');
}

describe.skipIf(!available)('pages graph routes — real boundaries', () => {
  let app: FastifyInstance;
  let unauthenticatedApp: FastifyInstance;
  let redis: RedisClientType;
  let readerId: string;
  let visiblePageId: number;
  let hiddenPageId: number;
  const ownedUserIds = new Set<string>();

  beforeAll(async () => {
    await setupTestDb();
    redis = createClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: false, connectTimeout: 1_000 },
    });
    redis.on('error', () => undefined);
    await redis.connect();
    setRedisClient(redis);

    app = await buildKnowledgeTestApp(() => readerId, async (instance) => {
      instance.redis = redis;
      await instance.register(pagesEmbeddingRoutes, { prefix: '/api' });
    });

    unauthenticatedApp = Fastify({ logger: false });
    await unauthenticatedApp.register(sensible);
    unauthenticatedApp.decorate('authenticate', async () => {
      throw unauthenticatedApp.httpErrors.unauthorized('Missing or invalid token');
    });
    unauthenticatedApp.decorate('requireAdmin', async () => {
      throw unauthenticatedApp.httpErrors.forbidden('Admin access required');
    });
    unauthenticatedApp.decorate('redis', redis);
    await unauthenticatedApp.register(pagesEmbeddingRoutes, { prefix: '/api' });
    await unauthenticatedApp.ready();
  });

  afterAll(async () => {
    await Promise.all([app.close(), unauthenticatedApp.close()]);
    for (const userId of ownedUserIds) {
      await deleteKeys(redis, `kb:${userId}:*`);
      await redis.del([
        `kb-cache-generation:pages:user:${userId}`,
        `kb-cache-generation:search:user:${userId}`,
        `rbac:admin:${userId}`,
        `rbac:spaces:${userId}`,
      ]);
    }
    setRedisClient(null);
    if (redis.isOpen) await redis.quit();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    readerId = await insertUser(`graph-reader-${randomUUID()}`);
    ownedUserIds.add(readerId);

    await query(
      `INSERT INTO spaces (space_key, space_name, source, last_synced)
       VALUES ('DEV', 'Development', 'confluence', NOW()),
              ('SECRET', 'Secret', 'confluence', NOW())`,
    );
    await query(
      `WITH reader_role AS (
         INSERT INTO roles (name, display_name, permissions)
         VALUES ($1, 'Graph reader', ARRAY['read'])
         RETURNING id
       )
       INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
       SELECT 'DEV', 'user', $2, id FROM reader_role`,
      [`graph-reader-${randomUUID()}`, readerId],
    );

    visiblePageId = await insertConfluencePage('graph-visible', 'Visible graph page', 'DEV');
    await insertEmbeddings(visiblePageId, 1);
    hiddenPageId = await insertConfluencePage('graph-hidden', 'Hidden graph page', 'SECRET');
    await query(
      `INSERT INTO page_relationships
         (page_id_1, page_id_2, relationship_type, score)
       VALUES ($1, $2, 'label_overlap', 1)`,
      [visiblePageId, hiddenPageId],
    );
  });

  it('requires authentication for the complete graph', async () => {
    const response = await unauthenticatedApp.inject({
      method: 'GET',
      url: '/api/pages/graph',
    });

    expect(response.statusCode).toBe(401);
  });

  it('requires authentication for a local graph', async () => {
    const response = await unauthenticatedApp.inject({
      method: 'GET',
      url: `/api/pages/${visiblePageId}/graph/local`,
    });

    expect(response.statusCode).toBe(401);
  });

  it('requires authentication before an admin graph refresh', async () => {
    const response = await unauthenticatedApp.inject({
      method: 'POST',
      url: '/api/pages/graph/refresh',
    });

    expect(response.statusCode).toBe(401);
  });

  it('does not expose nodes or cross-space edges outside the real RBAC assignment', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/graph',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      nodes: [
        expect.objectContaining({
          id: String(visiblePageId),
          title: 'Visible graph page',
          embeddingCount: 1,
        }),
      ],
      edges: [],
      meta: {
        pagesTotal: 1,
        pagesEmbedded: 1,
        relationshipsTotal: 0,
        relationshipsByType: {},
      },
    });
    expect(response.body).not.toContain('Hidden graph page');
  });

  it('silently drops an explicitly requested space the caller cannot read', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/graph?spaceKey=SECRET',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      nodes: [],
      edges: [],
      meta: {
        pagesTotal: 0,
        pagesEmbedded: 0,
        relationshipsTotal: 0,
        relationshipsByType: {},
      },
    });
  });
});
