/**
 * GET /api/search semantic and hybrid modes reuse RAG retrieval, which stays
 * space-level (ADR-022/ADR-023). The page-search surface itself must still
 * apply page restrictions to the rows it returns. Only the embedding provider
 * boundary is mocked; PostgreSQL and Redis are real.
 */
import type { FastifyInstance } from 'fastify';
import pgvector from 'pgvector';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../../core/db/postgres.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import {
  SEARCH_TERM,
  restrictedLeaks,
  seedRestrictionFixture,
  type RestrictionFixture,
} from './page-restriction.test-helpers.js';
import type * as OpenAiCompatibleClient from '../../domains/llm/services/openai-compatible-client.js';
import type * as LlmProviderResolver from '../../domains/llm/services/llm-provider-resolver.js';
import { flushSearchAnalytics } from '../../domains/llm/services/rag-service.js';
import { buildKnowledgeTestApp } from './pages.test-helpers.js';
import { searchRoutes } from './search.js';

const { queryVector } = vi.hoisted(() => ({
  queryVector: Array.from({ length: 1024 }, (_, i) => Math.sin(i + 1) * 0.01),
}));

vi.mock('../../domains/llm/services/openai-compatible-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof OpenAiCompatibleClient>()),
  generateEmbedding: vi.fn(async () => [queryVector]),
}));
vi.mock('../../domains/llm/services/llm-provider-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof LlmProviderResolver>()),
  resolveUsecase: vi.fn(async () => ({
    config: {
      providerId: 'stub',
      id: 'stub',
      name: 'stub',
      baseUrl: '',
      apiKey: null,
      authType: 'none',
      verifySsl: true,
      defaultModel: 'stub',
    },
    model: 'stub',
  })),
}));

const available = await isDbAvailable() && await isRedisAvailable();

describe.skipIf(!available)('GET /api/search semantic and hybrid modes — page restrictions', () => {
  let app: FastifyInstance;
  let redis: RedisClientType;
  let currentUserId = '';
  let fx: RestrictionFixture;

  async function search(userId: string, mode: 'semantic' | 'hybrid'): Promise<{
    body: string;
    ids: number[];
  }> {
    currentUserId = userId;
    const response = await app.inject({ method: 'GET', url: `/api/search?q=${SEARCH_TERM}&mode=${mode}` });
    expect(response.statusCode, response.body).toBe(200);
    const parsed = response.json<{ mode: string; items: Array<{ id: number }> }>();
    expect(parsed.mode).toBe(mode);
    return { body: response.body, ids: parsed.items.map((item) => item.id) };
  }

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
      await instance.register(searchRoutes, { prefix: '/api' });
    });
  });

  afterAll(async () => {
    await app?.close();
    await flushSearchAnalytics();
    setRedisClient(null);
    if (redis?.isOpen) await redis.quit();
    await truncateAllTables();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await flushSearchAnalytics();
    await truncateAllTables();
    fx = await seedRestrictionFixture();
    const pages = await query<{ id: number; title: string; body_text: string }>(
      'SELECT id, title, body_text FROM pages',
    );
    for (const page of pages.rows) {
      await query(
        `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
         VALUES ($1, 0, $2, $3, $4::jsonb)`,
        [
          page.id,
          page.body_text,
          pgvector.toSql(queryVector),
          JSON.stringify({ page_title: page.title, section_title: page.title, space_key: 'DOCS' }),
        ],
      );
    }
  });

  it.each(['semantic', 'hybrid'] as const)('%s: R gets no restricted row; G and the administrator do', async (mode) => {
    const reader = await search(fx.readerId, mode);
    expect(restrictedLeaks(reader.body)).toEqual([]);
    expect(reader.ids).toContain(fx.pages.visibleChild);
    expect(reader.ids).not.toContain(fx.pages.hushedLeaf);
    expect(reader.ids).not.toContain(fx.pages.hushedParent);

    const group = await search(fx.groupReaderId, mode);
    expect(group.ids).toEqual(expect.arrayContaining([fx.pages.hushedLeaf, fx.pages.hushedParent]));

    const admin = await search(fx.adminId, mode);
    expect(admin.ids).toEqual(expect.arrayContaining([fx.pages.hushedLeaf, fx.pages.hushedParent]));
    expect(admin.ids).not.toContain(fx.pages.readerPrivate);
  });
});
