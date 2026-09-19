import { randomUUID } from 'node:crypto';
import { createClient, type RedisClientType } from 'redis';
import type { FastifyInstance } from 'fastify';
import type * as Undici from 'undici';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Confluence REST is the only mocked dependency. The client factory, PAT
// decryption, RBAC, admission lifecycle, persistence, and Redis invalidation
// all execute as production code.
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof Undici>();
  return { ...actual, request: vi.fn() };
});

import { request } from 'undici';
import { query } from '../../core/db/postgres.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { encryptPat } from '../../core/utils/crypto.js';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import {
  buildKnowledgeTestApp,
  insertConfluencePage,
  insertLocalSpace,
  insertStandalonePage,
  insertUser,
} from './pages.test-helpers.js';
import { pagesTagRoutes } from './pages-tags.js';

const CONFLUENCE_URL = 'https://confluence-labels.example.com';
const CONFLUENCE_PAT = 'real-encrypted-label-test-pat';
const LOCAL_SPACE = 'LABEL-LOCAL';
const SYNC_SPACE = 'LABEL-SYNC';

const [dbAvailable, redisAvailable] = await Promise.all([
  isDbAvailable(),
  isRedisAvailable(),
]);
const dependenciesAvailable = dbAvailable && redisAvailable;
const mockRequest = vi.mocked(request);

function emptyResponse(statusCode = 204) {
  return {
    statusCode,
    headers: {},
    body: { text: async () => '' },
  } as never;
}

async function labelsFor(pageId: number): Promise<string[]> {
  const result = await query<{ labels: string[] }>(
    'SELECT labels FROM pages WHERE id = $1',
    [pageId],
  );
  return result.rows[0]!.labels;
}

describe.skipIf(!dependenciesAvailable)('PUT /api/pages/:id/labels — real persistence and synchronization', () => {
  let app: FastifyInstance;
  let redis: RedisClientType;
  let userId: string;
  let standalonePageId: number;
  let integerPageId: number;
  let confluenceLookupPageId: number;
  let confluenceLookupId: string;
  let inaccessiblePageId: number;

  beforeAll(async () => {
    await setupTestDb();
    redis = createClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: false, connectTimeout: 1_000 },
    }) as RedisClientType;
    await redis.connect();
    setRedisClient(redis);
    await truncateAllTables();

    userId = await insertUser(`page-labels-${randomUUID()}`);
    const otherUserId = await insertUser(`page-labels-other-${randomUUID()}`);
    await insertLocalSpace(LOCAL_SPACE, userId);
    await insertLocalSpace(SYNC_SPACE, userId);

    const role = await query<{ id: number }>(
      `INSERT INTO roles (name, display_name, is_system, permissions)
       VALUES ('page-label-editor', 'Page label editor', FALSE, ARRAY['read', 'write'])
       RETURNING id`,
    );
    await query(
      `INSERT INTO space_role_assignments
         (space_key, principal_type, principal_id, role_id)
       VALUES ($1, 'user', $2, $3)`,
      [SYNC_SPACE, userId, role.rows[0]!.id],
    );

    await query(
      `INSERT INTO user_settings
         (user_id, confluence_url, confluence_pat, confluence_enabled)
       VALUES ($1, $2, $3, TRUE)`,
      [userId, CONFLUENCE_URL, encryptPat(CONFLUENCE_PAT)],
    );

    standalonePageId = await insertStandalonePage(
      'Standalone labels',
      'private',
      userId,
      LOCAL_SPACE,
    );
    await query(
      `UPDATE pages SET labels = ARRAY['existing', 'remove-me']::text[] WHERE id = $1`,
      [standalonePageId],
    );

    integerPageId = await insertConfluencePage(
      'labels-integer-conf-id',
      'Integer URL labels',
      SYNC_SPACE,
    );
    await query(
      `UPDATE pages SET labels = ARRAY['existing', 'remove-me']::text[] WHERE id = $1`,
      [integerPageId],
    );

    confluenceLookupId = 'labels-by-confluence-id';
    confluenceLookupPageId = await insertConfluencePage(
      confluenceLookupId,
      'Confluence URL labels',
      SYNC_SPACE,
    );
    await query(
      `UPDATE pages SET labels = ARRAY['legacy']::text[] WHERE id = $1`,
      [confluenceLookupPageId],
    );

    inaccessiblePageId = await insertStandalonePage(
      'Another user private labels',
      'private',
      otherUserId,
      LOCAL_SPACE,
    );
    await query(
      `UPDATE pages SET labels = ARRAY['private']::text[] WHERE id = $1`,
      [inaccessiblePageId],
    );

    app = await buildKnowledgeTestApp(() => userId, async (instance) => {
      instance.redis = redis;
      await instance.register(pagesTagRoutes, { prefix: '/api' });
    });
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
    await teardownTestDb();
  });

  beforeEach(() => {
    mockRequest.mockReset();
  });

  it('adds, removes, and deduplicates labels on a standalone page without egress', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${standalonePageId}/labels`,
      payload: {
        addLabels: ['existing', 'standalone-new', 'standalone-new'],
        removeLabels: ['remove-me'],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ labels: ['existing', 'standalone-new'] });
    expect(await labelsFor(standalonePageId)).toEqual(['existing', 'standalone-new']);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('resolves an integer internal ID, persists labels, and synchronizes only the remote delta', async () => {
    mockRequest.mockResolvedValue(emptyResponse());

    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${integerPageId}/labels`,
      payload: {
        addLabels: ['existing', 'remote-new'],
        removeLabels: ['remove-me'],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ labels: ['existing', 'remote-new'] });
    expect(await labelsFor(integerPageId)).toEqual(['existing', 'remote-new']);

    const storedCredentials = await query<{ confluence_pat: string }>(
      'SELECT confluence_pat FROM user_settings WHERE user_id = $1',
      [userId],
    );
    expect(storedCredentials.rows[0]!.confluence_pat).not.toBe(CONFLUENCE_PAT);

    expect(mockRequest).toHaveBeenCalledTimes(2);
    const [addUrl, addOptions] = mockRequest.mock.calls[0]!;
    const [removeUrl, removeOptions] = mockRequest.mock.calls[1]!;
    expect(new URL(String(addUrl)).pathname).toBe('/rest/api/content/labels-integer-conf-id/label');
    expect(addOptions).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(addOptions?.body))).toEqual([
      { prefix: 'global', name: 'remote-new' },
    ]);
    expect((addOptions?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${CONFLUENCE_PAT}`,
    );
    expect(new URL(String(removeUrl)).pathname).toBe(
      '/rest/api/content/labels-integer-conf-id/label/remove-me',
    );
    expect(removeOptions).toMatchObject({ method: 'DELETE' });
  });

  it('resolves a Confluence ID and persists the synchronized result on its internal row', async () => {
    mockRequest.mockResolvedValue(emptyResponse());

    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${confluenceLookupId}/labels`,
      payload: { addLabels: ['from-confluence-id'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ labels: ['legacy', 'from-confluence-id'] });
    expect(await labelsFor(confluenceLookupPageId)).toEqual(['legacy', 'from-confluence-id']);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(new URL(String(mockRequest.mock.calls[0]![0])).pathname).toBe(
      `/rest/api/content/${confluenceLookupId}/label`,
    );
  });

  it('rejects an empty label change without mutating persistence or calling Confluence', async () => {
    const before = await labelsFor(standalonePageId);

    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${standalonePageId}/labels`,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(await labelsFor(standalonePageId)).toEqual(before);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('conceals an inaccessible page and leaves its labels unchanged', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${inaccessiblePageId}/labels`,
      payload: { addLabels: ['must-not-land'] },
    });

    expect(response.statusCode).toBe(404);
    expect(await labelsFor(inaccessiblePageId)).toEqual(['private']);
    expect(mockRequest).not.toHaveBeenCalled();
  });
});
