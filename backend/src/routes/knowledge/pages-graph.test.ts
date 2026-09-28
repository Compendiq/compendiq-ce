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
import { invalidateRbacCache } from '../../core/services/rbac-service.js';
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
      await redis.del([`rbac:admin:${actorId}`, `rbac:spaces:${actorId}`]);

      await truncateAllTables();
      await query(
        `INSERT INTO users (id, username, email, password_hash, role)
         VALUES ($1, 'graph-user', 'graph-user@test', 'x', 'user')`,
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

    it("omits another user's private standalone page from individual and clustered graphs", async () => {
      const owner = randomUUID();
      await query(
        `INSERT INTO users (id, username, email, password_hash, role)
         VALUES ($1, 'graph-private-owner', 'graph-private-owner@test', 'x', 'user')`,
        [owner],
      );
      const privatePage = await query<{ id: number }>(
        `INSERT INTO pages
           (source, space_key, title, body_html, body_text, visibility,
            embedding_status, created_by_user_id)
         VALUES ('standalone', 'DEV', 'Private foreign article', '<p>private</p>',
                 'private', 'private', 'embedded', $1)
         RETURNING id`,
        [owner],
      );
      const visibleChild = await query<{ id: number }>(
        `INSERT INTO pages
           (source, space_key, title, body_html, body_text, visibility, parent_id,
            embedding_status, created_by_user_id)
         VALUES ('standalone', 'DEV', 'Visible child', '<p>child</p>', 'child',
                 'shared', $1, 'not_embedded', $2)
         RETURNING id`,
        [String(privatePage.rows[0]!.id), owner],
      );

      const individual = await app.inject({
        method: 'GET',
        url: '/api/pages/graph?spaceKey=DEV',
      });
      expect(individual.statusCode, individual.body).toBe(200);
      expect(individual.json().nodes.map((node: { id: string }) => node.id))
        .not.toContain(String(privatePage.rows[0]!.id));
      expect(individual.body).not.toContain('Private foreign article');
      expect(individual.json().nodes).toContainEqual(
        expect.objectContaining({
          id: String(visibleChild.rows[0]!.id),
          parentId: null,
        }),
      );

      const clustered = await app.inject({
        method: 'GET',
        url: '/api/pages/graph?view=clustered&spaceKey=DEV',
      });
      expect(clustered.statusCode, clustered.body).toBe(200);
      expect(clustered.json().nodes.flatMap((node: { pageIds: number[] }) => node.pageIds))
        .not.toContain(privatePage.rows[0]!.id);
      expect(clustered.body).not.toContain('Private foreign article');
    });

    it('keeps standalone graph nodes visible without a local-space RBAC assignment', async () => {
      const individual = await app.inject({
        method: 'GET',
        url: '/api/pages/graph?spaceKey=DEV',
      });
      expect(individual.statusCode, individual.body).toBe(200);
      expect(individual.json().nodes.map((node: { id: string }) => node.id).sort()).toEqual(
        [String(rootId), String(childId)].sort(),
      );

      const clustered = await app.inject({
        method: 'GET',
        url: '/api/pages/graph?view=clustered&spaceKey=DEV',
      });
      expect(clustered.statusCode, clustered.body).toBe(200);
      expect(clustered.json().nodes).toContainEqual(
        expect.objectContaining({
          id: `cluster-${rootId}`,
          pageIds: expect.arrayContaining([rootId, childId]),
        }),
      );
    });

    it('clusters canonical Confluence children through their upstream parent key', async () => {
      await query(
        `WITH reader_role AS (
           INSERT INTO roles (name, display_name, permissions)
           VALUES ($1, 'Graph reader', ARRAY['read'])
           RETURNING id
         )
         INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
         SELECT 'DEV', 'user', $2, id FROM reader_role`,
        [`graph-reader-${randomUUID()}`, actorId],
      );
      await invalidateRbacCache(actorId);
      const parentKey = `canonical-${randomUUID()}`;
      const parent = await query<{ id: number }>(
        `INSERT INTO pages
           (confluence_id, source, space_key, title, body_html, body_text, inherit_perms)
         VALUES ($1, 'confluence', 'DEV', 'Confluence root', '', '', TRUE)
         RETURNING id`,
        [parentKey],
      );
      const parentId = parent.rows[0]!.id;
      const child = await query<{ id: number }>(
        `INSERT INTO pages
           (confluence_id, source, space_key, title, body_html, body_text,
            inherit_perms, parent_id)
         VALUES ($1, 'confluence', 'DEV', 'Confluence child', '', '', TRUE, $2)
         RETURNING id`,
        [`canonical-child-${randomUUID()}`, parentKey],
      );

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/graph?view=clustered&spaceKey=DEV',
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().nodes).toContainEqual(
        expect.objectContaining({
          id: `cluster-${parentId}`,
          pageIds: expect.arrayContaining([parentId, child.rows[0]!.id]),
        }),
      );
    });

    it('re-roots clustered children when a canonical parent key is ambiguous', async () => {
      await query(
        `INSERT INTO pages
           (confluence_id, source, space_key, title, body_html, body_text, inherit_perms)
         VALUES ($1, 'confluence', 'DEV', 'Colliding page', '', '', TRUE)`,
        [String(rootId)],
      );

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/graph?view=clustered&spaceKey=DEV',
      });
      expect(response.statusCode, response.body).toBe(200);
      const clusters = response.json().nodes as Array<{ id: string; pageIds: number[] }>;
      expect(clusters.find((node) => node.id === `cluster-${rootId}`)?.pageIds).toEqual([rootId]);
      expect(clusters).toContainEqual(
        expect.objectContaining({
          id: `cluster-${childId}`,
          pageIds: [childId],
        }),
      );
    });

    it('fences the individual fill and preserves its 300-second TTL', async () => {
      const url = '/api/pages/graph?spaceKey=DEV';
      const first = await app.inject({ method: 'GET', url });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json().nodes[0].title).toBe('Child article');
      const cacheKey = `kb:${actorId}:pages:graph:v3:individual:DEV`;
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
