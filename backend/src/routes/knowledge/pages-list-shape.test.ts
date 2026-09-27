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
import { pagesCrudRoutes } from './pages-crud.js';
import {
  buildKnowledgeTestApp,
  insertUser,
} from './pages.test-helpers.js';

const available = await isDbAvailable() && await isRedisAvailable();

async function grantRead(userId: string, spaceKey: string): Promise<void> {
  const role = await query<{ id: number }>(
    `INSERT INTO roles (name, display_name, is_system, permissions)
     VALUES ('list-shape-reader', 'List shape reader', FALSE, ARRAY['read'])
     ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions
     RETURNING id`,
  );
  await query(
    `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     VALUES ($1, 'user', $2, $3)`,
    [spaceKey, userId, role.rows[0]!.id],
  );
}

describe.skipIf(!available)('page list and detail response shapes — real persistence', () => {
  let app: FastifyInstance;
  let redis: RedisClientType;
  let userId: string;
  let pageId: number;

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
    userId = await insertUser('list_shape_reader');
    await query(
      `INSERT INTO spaces (space_key, space_name, source, last_synced)
       VALUES ('DEV', 'DEV', 'confluence', NOW())`,
    );
    await grantRead(userId, 'DEV');
    const inserted = await query<{ id: number }>(
      `INSERT INTO pages (
         confluence_id, source, space_key, title, body_storage, body_html, body_text,
         version, parent_id, labels, author, last_modified_at, last_synced,
         embedding_dirty, embedding_status, visibility, created_by_user_id
       ) VALUES (
         'page-1', 'confluence', 'DEV', 'Test Page', '<p>XHTML storage content</p>',
         '<p>Clean HTML content</p>', 'Plain text searchable-token', 1, NULL,
         ARRAY['howto'], 'Alice', '2025-01-15T00:00:00Z', '2025-01-16T00:00:00Z',
         FALSE, 'embedded', 'shared', NULL
       ) RETURNING id`,
    );
    pageId = inserted.rows[0]!.id;
  });

  it('keeps authored bodies out of list rows while retaining summary provenance', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/pages' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    expect(item.id).toBe(String(pageId));
    expect(item).toMatchObject({
      confluenceId: 'page-1',
      spaceKey: 'DEV',
      title: 'Test Page',
      version: 1,
      labels: ['howto'],
      author: 'Alice',
      source: 'confluence',
      visibility: 'shared',
      embeddingDirty: false,
    });
    expect(item).not.toHaveProperty('bodyHtml');
    expect(item).not.toHaveProperty('bodyText');
    expect(item).not.toHaveProperty('bodyStorage');
  });

  it('can search body text without exposing any body representation in the result', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/pages?search=searchable-token' });
    expect(response.statusCode).toBe(200);
    const item = response.json().items[0];
    expect(item.id).toBe(String(pageId));
    expect(item).not.toHaveProperty('bodyHtml');
    expect(item).not.toHaveProperty('bodyText');
    expect(item).not.toHaveProperty('bodyStorage');
  });

  it('returns real pagination metadata', async () => {
    for (const title of ['Second', 'Third']) {
      await query(
        `INSERT INTO pages (source, space_key, title, body_html, body_text, visibility, created_by_user_id)
         VALUES ('standalone', 'DEV', $1, '<p>x</p>', 'x', 'shared', $2)`,
        [title, userId],
      );
    }

    const response = await app.inject({ method: 'GET', url: '/api/pages?page=1&limit=2' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ total: 3, page: 1, limit: 2, totalPages: 2 });
    expect(response.json().items).toHaveLength(2);
  });

  it('returns authored body representations only from detail', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/pages/${pageId}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: String(pageId),
      confluenceId: 'page-1',
      source: 'confluence',
      visibility: 'shared',
      createdByUserId: null,
      bodyHtml: '<p>Clean HTML content</p>',
      bodyText: 'Plain text searchable-token',
    });
  });
});
