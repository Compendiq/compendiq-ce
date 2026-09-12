import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { Response, fetch } from 'undici';
import pgvector from 'pgvector';
import type { PageSource } from '@compendiq/contracts';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { flushSearchAnalytics } from '../../domains/llm/services/rag-service.js';
import { invalidateRagFetchWidthCache } from '../../core/services/admin-settings-service.js';
import { searchRoutes } from './search.js';

// Retrieval and persistence stay real; only the embedding HTTP boundary and auth are controlled.
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: vi.fn(),
}));
vi.mock('../../core/services/rbac-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/services/rbac-service.js')>()),
  getUserAccessibleSpacesMemoized: vi.fn().mockResolvedValue(['DEV']),
  getUserAccessibleSpaces: vi.fn().mockResolvedValue(['DEV']),
}));

const dbAvailable = await isDbAvailable();
const embedding = Array.from({ length: 1024 }, (_, index) => Math.sin(index + 1) * 0.01);

describe.skipIf(!dbAvailable)('search canonical page provenance', () => {
  let app: FastifyInstance;
  let userId: string;
  let expectedSources: Map<number, PageSource>;

  beforeAll(async () => {
    await setupTestDb();
    app = Fastify({ logger: false });
    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = userId;
    });
    await app.register(searchRoutes, { prefix: '/api' });
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await flushSearchAnalytics();
    await app.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await flushSearchAnalytics();
    await truncateAllTables();
    invalidateRagFetchWidthCache();
    vi.mocked(fetch).mockReset();
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({
      data: [{ embedding }],
    }), { headers: { 'Content-Type': 'application/json' } }));
    const user = await query<{ id: string }>(
      "INSERT INTO users (username, email, password_hash, role) VALUES ('origin', 'origin@test', 'x', 'user') RETURNING id",
    );
    userId = user.rows[0]!.id;
    await query("INSERT INTO spaces (space_key, space_name) VALUES ('DEV', 'Development')");
    // A historical external key and a named space must not turn a local page into a Confluence result.
    const pages = await query<{ id: number; source: PageSource }>(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html, visibility, created_by_user_id)
       VALUES ('legacy-local-redis', 'standalone', 'DEV', 'Redis Handbook', 'Redis operations handbook', '', '<p>Redis operations handbook</p>', 'shared', $1),
              ('synced-redis', 'confluence', 'DEV', 'Redis Handbook', 'Redis operations handbook', '', '<p>Redis operations handbook</p>', 'shared', $1)
       RETURNING id, source`,
      [userId],
    );
    expectedSources = new Map(pages.rows.map((page) => [page.id, page.source]));
    const provider = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, default_model)
       VALUES ('search-origin', 'http://search-origin.test/v1', 'none', TRUE, 'origin-embedding') RETURNING id`,
    );
    await query(
      "INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('embedding', $1, 'origin-embedding')",
      [provider.rows[0]!.id],
    );
  });

  async function seedEmbeddings() {
    await query(
      `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
       SELECT id, 0, body_text, $1::vector,
              jsonb_build_object('page_title', title, 'section_title', title, 'space_key', space_key,
                                 'source', CASE WHEN source = 'standalone' THEN 'confluence' ELSE 'standalone' END)
       FROM pages`,
      [pgvector.toSql(embedding)],
    );
  }

  async function expectOrigins(search: string, mode: string) {
    const response = await app.inject({ method: 'GET', url: `/api/search?${search}&includeFacets=false` });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ mode: string; items: Array<{ id: number; source: PageSource; spaceKey: string }> }>();
    expect(body.mode).toBe(mode);
    expect(new Map(body.items.map((item) => [item.id, item.source]))).toEqual(expectedSources);
    expect(body.items.every((item) => item.spaceKey === 'DEV')).toBe(true);
  }

  it('retains the same origin through FTS and fuzzy-only title matches in a named space', async () => {
    await expectOrigins('q=Redis&mode=keyword', 'keyword');
    // No token matches the misspelling, so these rows can only enter through the fuzzy-title branch.
    await expectOrigins('q=Redis%20Handbok&mode=keyword', 'keyword');
  });

  it.each(['semantic', 'hybrid'])('uses canonical page origin in %s, not stale embedding metadata', async (mode) => {
    await seedEmbeddings();
    await expectOrigins(`q=Redis&mode=${mode}`, mode);
  });

  it.each(['semantic', 'hybrid'])('preserves origin when %s falls back to keyword without embeddings', async (mode) => {
    await expectOrigins(`q=Redis&mode=${mode}`, 'keyword');
  });

  it('preserves canonical origin when hybrid loses its embedding provider and uses the lexical leg', async () => {
    await seedEmbeddings();
    vi.mocked(fetch).mockImplementation(async () => new Response('provider unavailable', { status: 503 }));
    await expectOrigins('q=Redis&mode=hybrid', 'hybrid');
  });
});
