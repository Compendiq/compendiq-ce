import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { createClient, type RedisClientType } from 'redis';
import { ZodError } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../core/db/postgres.js';
import {
  invalidateGraphCache,
  RedisCache,
  setRedisClient,
} from '../../core/services/redis-cache.js';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { pagesEmbeddingRoutes, __testHelpers } from './pages-embeddings.js';

const [dbAvailable, redisAvailable] = await Promise.all([
  isDbAvailable(),
  isRedisAvailable(),
]);
const actorId = randomUUID();

describe.skipIf(!dbAvailable || !redisAvailable)(
  'knowledge graph cache — real PostgreSQL and Redis',
  () => {
    let app: FastifyInstance;
    let redis: RedisClientType;
    let rootId: number;
    let childId: number;

    beforeAll(async () => {
      await setupTestDb();
      redis = createClient({
        url: process.env.REDIS_URL,
        socket: { reconnectStrategy: false },
      });
      redis.on('error', () => undefined);
      await redis.connect();
      setRedisClient(redis);

      app = Fastify({ logger: false });
      await app.register(sensible);
      app.decorate('authenticate', async (request: { userId: string }) => {
        request.userId = actorId;
      });
      app.decorate('requireAdmin', async (request: { userId: string }) => {
        request.userId = actorId;
      });
      app.decorate('redis', redis);
      app.setErrorHandler((error, _request, reply) => {
        if (error instanceof ZodError) {
          reply.status(400).send({
            error: 'ValidationError',
            message: error.issues.map((issue) => issue.message).join('; '),
            statusCode: 400,
          });
          return;
        }
        reply.status(error.statusCode ?? 500).send({
          error: error.message,
          statusCode: error.statusCode ?? 500,
        });
      });
      await app.register(pagesEmbeddingRoutes, { prefix: '/api' });
      await app.ready();
    });

    beforeEach(async () => {
      let cursor = '0';
      do {
        const scanned = await redis.scan(cursor, {
          MATCH: `kb:${actorId}:pages:*`,
          COUNT: 100,
        });
        cursor = String(scanned.cursor);
        if (scanned.keys.length > 0) await redis.del(scanned.keys);
      } while (cursor !== '0');

      await truncateAllTables();
      await query(
        `INSERT INTO users (id, username, email, password_hash, role)
         VALUES ($1, 'graph-admin', 'graph-admin@test', 'x', 'admin')`,
        [actorId],
      );
      await query(
        `INSERT INTO spaces (space_key, space_name, source)
         VALUES ('DEV', 'Development', 'local'),
                ('SECRET', 'Secret', 'local')`,
      );
      const root = await query<{ id: number }>(
        `INSERT INTO pages
           (source, space_key, title, body_html, body_text, labels,
            embedding_status, created_by_user_id)
         VALUES ('standalone', 'DEV', 'Root article', '<p>Root</p>', 'Root',
                 ARRAY['architecture'], 'embedded', $1)
         RETURNING id`,
        [actorId],
      );
      rootId = root.rows[0]!.id;
      const child = await query<{ id: number }>(
        `INSERT INTO pages
           (source, space_key, title, body_html, body_text, labels, parent_id,
            embedding_status, created_by_user_id)
         VALUES ('standalone', 'DEV', 'Child article', '<p>Child</p>', 'Child',
                 ARRAY['howto'], $2, 'not_embedded', $1)
         RETURNING id`,
        [actorId, String(rootId)],
      );
      childId = child.rows[0]!.id;
      const secret = await query<{ id: number }>(
        `INSERT INTO pages
           (source, space_key, title, body_html, body_text, labels,
            embedding_status, created_by_user_id)
         VALUES ('standalone', 'SECRET', 'Secret article', '<p>Secret</p>', 'Secret',
                 ARRAY[]::text[], 'not_embedded', $1)
         RETURNING id`,
        [actorId],
      );
      await query(
        `INSERT INTO page_relationships
           (page_id_1, page_id_2, relationship_type, score)
         VALUES ($1, $2, 'label_overlap', 1),
                ($1, $3, 'label_overlap', 1)`,
        [rootId, childId, secret.rows[0]!.id],
      );
    });

    afterAll(async () => {
      setRedisClient(null);
      if (app) await app.close();
      if (redis?.isOpen) {
        await redis.del([
          `kb-cache-generation:pages:user:${actorId}`,
          `kb-cache-generation:search:user:${actorId}`,
        ]);
        await redis.quit();
      }
      await teardownTestDb();
    });

    it('builds the individual graph from authorized PostgreSQL rows', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/graph?spaceKey=DEV',
      });

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json();
      expect(body.nodes.map((node: { id: string }) => node.id).sort()).toEqual(
        [String(rootId), String(childId)].sort(),
      );
      expect(body.edges).toEqual([
        expect.objectContaining({
          source: String(rootId),
          target: String(childId),
          type: 'label_overlap',
          score: 1,
        }),
      ]);
      expect(body.meta).toEqual({
        pagesTotal: 2,
        pagesEmbedded: 0,
        relationshipsTotal: 1,
        relationshipsByType: { label_overlap: 1 },
      });
    });

    it('fences the individual fill and preserves its 300-second TTL', async () => {
      const url = '/api/pages/graph?spaceKey=DEV';
      const first = await app.inject({ method: 'GET', url });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json().nodes[0].title).toBe('Child article');
      const cacheKey = `kb:${actorId}:pages:graph:individual:DEV`;
      const ttl = await redis.ttl(cacheKey);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(300);

      await query("UPDATE pages SET title = 'Changed child' WHERE id = $1", [childId]);
      const cached = await app.inject({ method: 'GET', url });
      expect(cached.json().nodes[0].title).toBe('Child article');

      await new RedisCache(redis).invalidate(actorId, 'pages');
      const refreshed = await app.inject({ method: 'GET', url });
      expect(refreshed.json().nodes[0].title).toBe('Changed child');
    });

    it('fences the clustered fill independently through the same pages namespace', async () => {
      const url = '/api/pages/graph?view=clustered&spaceKey=DEV';
      const first = await app.inject({ method: 'GET', url });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json().nodes).toEqual([
        expect.objectContaining({
          id: `cluster-${rootId}`,
          title: 'Root article',
          articleCount: 2,
          pageIds: expect.arrayContaining([rootId, childId]),
        }),
      ]);

      await query("UPDATE pages SET title = 'Changed root' WHERE id = $1", [rootId]);
      const cached = await app.inject({ method: 'GET', url });
      expect(cached.json().nodes[0].title).toBe('Root article');

      await invalidateGraphCache();
      const refreshed = await app.inject({ method: 'GET', url });
      expect(refreshed.json().nodes[0].title).toBe('Changed root');
    });

    it('rejects an unsupported graph view at the HTTP boundary', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/graph?view=unknown',
      });
      expect(response.statusCode).toBe(400);
    });

    it('retains the documented corpus-size similarity tiers', () => {
      expect(__testHelpers.tieredMinScoreForCorpus(0)).toBe(0.4);
      expect(__testHelpers.tieredMinScoreForCorpus(499)).toBe(0.4);
      expect(__testHelpers.tieredMinScoreForCorpus(500)).toBe(0.6);
      expect(__testHelpers.tieredMinScoreForCorpus(1999)).toBe(0.6);
      expect(__testHelpers.tieredMinScoreForCorpus(2000)).toBe(0.7);
      expect(__testHelpers.tieredMinScoreForCorpus(50_000)).toBe(0.7);
    });
  },
);
