import { randomUUID } from 'node:crypto';
import { createClient, type RedisClientType } from 'redis';
import type { FastifyInstance } from 'fastify';
import type * as Undici from 'undici';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The provider is the only mocked boundary. Provider resolution, encrypted
// credentials, queueing, RBAC, page lookup, and response parsing stay real.
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof Undici>();
  return { ...actual, fetch: vi.fn() };
});

import { fetch as undiciFetch } from 'undici';
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

const PROVIDER_URL = 'https://labels-llm.example.com/v1';
const PROVIDER_MODEL = 'labels-model';
const PROVIDER_KEY = 'labels-provider-secret';
const SPACE_KEY = 'AUTO-TAG';

const [dbAvailable, redisAvailable] = await Promise.all([
  isDbAvailable(),
  isRedisAvailable(),
]);
const dependenciesAvailable = dbAvailable && redisAvailable;
const mockFetch = vi.mocked(undiciFetch);

function completion(content: string, status = 200): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 3 },
  }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function providerRequest(): {
  url: string;
  headers: Record<string, string>;
  body: {
    model: string;
    stream: boolean;
    messages: Array<{ role: string; content: string }>;
  };
} {
  expect(mockFetch).toHaveBeenCalledTimes(1);
  const [rawUrl, rawOptions] = mockFetch.mock.calls[0]!;
  const options = rawOptions as {
    headers: Record<string, string>;
    body: string;
  };
  return {
    url: String(rawUrl),
    headers: options.headers,
    body: JSON.parse(options.body),
  };
}

describe.skipIf(!dependenciesAvailable)('POST /api/pages/:id/auto-tag — real persistence and RBAC', () => {
  let app: FastifyInstance;
  let redis: RedisClientType;
  let userId: string;
  let pageId: number;
  let confluenceId: string;
  let inaccessiblePageId: number;

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
      await instance.register(pagesTagRoutes, { prefix: '/api' });
    });
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
    await teardownTestDb();
  });

  beforeEach(async () => {
    mockFetch.mockReset();
    await truncateAllTables();

    userId = await insertUser(`auto-tag-${randomUUID()}`);
    const otherUserId = await insertUser(`auto-tag-other-${randomUUID()}`);
    await insertLocalSpace(SPACE_KEY, userId);

    const role = await query<{ id: number }>(
      `INSERT INTO roles (name, display_name, is_system, permissions)
       VALUES ('auto-tag-reader', 'Auto-tag reader', FALSE, ARRAY['read'])
       RETURNING id`,
    );
    await query(
      `INSERT INTO space_role_assignments
         (space_key, principal_type, principal_id, role_id)
       VALUES ($1, 'user', $2, $3)`,
      [SPACE_KEY, userId, role.rows[0]!.id],
    );
    await query(
      `INSERT INTO user_settings (user_id, confluence_enabled)
       VALUES ($1, TRUE)`,
      [userId],
    );

    confluenceId = `conf-${randomUUID()}`;
    pageId = await insertConfluencePage(confluenceId, 'Architecture guide', SPACE_KEY);
    await query(
      `UPDATE pages
          SET body_html = '<h1>Architecture</h1><p>Deployment and database guidance.</p>',
              body_text = 'Architecture deployment and database guidance.',
              labels = ARRAY['existing']::text[]
        WHERE id = $1`,
      [pageId],
    );
    inaccessiblePageId = await insertStandalonePage(
      'Private page',
      'private',
      otherUserId,
      SPACE_KEY,
    );

    const provider = await query<{ id: string }>(
      `INSERT INTO llm_providers
         (name, base_url, api_key, auth_type, verify_ssl, default_model, is_default)
       VALUES ('Auto-tag integration', $1, $2, 'bearer', TRUE, $3, TRUE)
       RETURNING id`,
      [PROVIDER_URL, encryptPat(PROVIDER_KEY), PROVIDER_MODEL],
    );
    await query(
      `INSERT INTO llm_usecase_assignments (usecase, provider_id, model)
       VALUES ('auto_tag', $1, $2)`,
      [provider.rows[0]!.id, PROVIDER_MODEL],
    );
  });

  it('returns validated suggestions and existing labels through the configured provider', async () => {
    mockFetch.mockResolvedValueOnce(
      completion('["architecture", "deployment", "architecture", "not-an-allowed-tag"]') as never,
    );

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/auto-tag`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      suggestedTags: ['architecture', 'deployment'],
      existingLabels: ['existing'],
    });

    const outbound = providerRequest();
    expect(outbound.url).toBe(`${PROVIDER_URL}/chat/completions`);
    expect(outbound.headers.Authorization).toBe(`Bearer ${PROVIDER_KEY}`);
    expect(outbound.body).toMatchObject({ model: PROVIDER_MODEL, stream: false });
    expect(outbound.body.messages.at(-1)?.content).toContain('Deployment and database guidance.');
  });

  it('resolves the backward-compatible Confluence ID and sends a caller model override', async () => {
    mockFetch.mockResolvedValueOnce(completion('["database"]') as never);

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${confluenceId}/auto-tag`,
      payload: { model: 'request-selected-model' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      suggestedTags: ['database'],
      existingLabels: ['existing'],
    });
    expect(providerRequest().body.model).toBe('request-selected-model');
  });

  it('does not send inaccessible page content to the provider', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${inaccessiblePageId}/auto-tag`,
      payload: { model: PROVIDER_MODEL },
    });

    expect(response.statusCode).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects an omitted model when no provider assignment or default exists', async () => {
    await query(`DELETE FROM llm_usecase_assignments WHERE usecase = 'auto_tag'`);
    await query(`DELETE FROM llm_providers`);

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/auto-tag`,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('reports a provider HTTP rejection as a bad gateway without persisting labels', async () => {
    mockFetch.mockResolvedValueOnce(completion('provider rejected request', 400) as never);

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/auto-tag`,
      payload: {},
    });

    expect(response.statusCode).toBe(502);
    const stored = await query<{ labels: string[] }>('SELECT labels FROM pages WHERE id = $1', [pageId]);
    expect(stored.rows[0]!.labels).toEqual(['existing']);
  });

  it('reports an unreachable provider as unavailable', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/auto-tag`,
      payload: {},
    });

    expect(response.statusCode).toBe(503);
  });
});
