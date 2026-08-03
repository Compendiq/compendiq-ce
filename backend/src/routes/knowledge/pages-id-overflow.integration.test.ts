/**
 * Integration tests for the `pages.id` int4 overflow (#1167) against a REAL
 * PostgreSQL.
 *
 * `pages.id` is `SERIAL` (int4, ceiling 2147483647), but three lookups accept
 * an *externally-sourced* identifier and resolved it with
 * `WHERE id = $1::int OR confluence_id = $2`. A Confluence content id above
 * 2^31 overflows that cast. The `confluence_id` arm does NOT rescue it: the
 * cast is evaluated before the OR can short-circuit, so the whole statement
 * aborts with `22003 numeric_value_out_of_range` and the route 500s even
 * though a matching row exists.
 *
 * These tests must run against real Postgres — a mocked `query()` accepts
 * `2200000000` happily and proves nothing at all.
 *
 * Only the real boundaries are stubbed: the Confluence HTTP client (via
 * `getClientForUser`), the Redis cache wrapper, the audit log, and the
 * LLM-touching summary batch. The DB, RBAC and the id resolution under test
 * are all real.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';

/**
 * A Confluence content id above int4. Long-lived Data Center instances and
 * post-Cloud-migration instances hand these out; nothing stops one reaching
 * these routes today.
 */
const BIG_CONFLUENCE_ID = '2200000000';

// --- Boundary mocks (everything else is real) ---

const h = vi.hoisted(() => ({
  client: {
    createPage: vi.fn(),
    addLabels: vi.fn(),
  },
}));

vi.mock('../../core/services/redis-cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/services/redis-cache.js')>()),
  RedisCache: class MockRedisCache {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue(undefined);
    invalidate = vi.fn().mockResolvedValue(undefined);
    invalidateAcrossUsers = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../domains/confluence/services/sync-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../domains/confluence/services/sync-service.js')>()),
  getClientForUser: vi.fn(async () => h.client),
}));

// `regenerateSummary` is pure SQL and runs for real; only the batch runner
// reaches an LLM provider, and the route fires it and forgets it.
vi.mock('../../domains/knowledge/services/summary-worker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../domains/knowledge/services/summary-worker.js')>()),
  runSummaryBatch: vi.fn(async () => ({ processed: 0, errors: 0 })),
}));

const dbAvailable = await isDbAvailable();

// --- Fixtures ---

let userId: string;

async function createAdmin(): Promise<string> {
  const res = await query<{ id: string }>(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id",
    [`overflow-admin-${Date.now()}`],
  );
  return res.rows[0]!.id;
}

async function createSpace(key: string, source: 'confluence' | 'local'): Promise<void> {
  await query(
    'INSERT INTO spaces (space_key, space_name, source) VALUES ($1, $1, $2) ON CONFLICT (space_key) DO NOTHING',
    [key, source],
  );
}

async function createPage(opts: {
  title: string;
  confluenceId?: string | null;
  parentRef?: string | null;
}): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_html,
                        inherit_perms, parent_id, visibility, version)
     VALUES ($1, 'confluence', 'CONF', $2, 'text', '<p>body</p>', TRUE, $3, 'shared', 1)
     RETURNING id`,
    [opts.confluenceId ?? null, opts.title, opts.parentRef ?? null],
  );
  return res.rows[0]!.id;
}

function buildApp() {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: 'Validation failed' });
    }
    return reply.status(error.statusCode ?? 500).send({ error: error.message });
  });
  app.decorate('authenticate', async (request: Record<string, unknown>) => {
    request.userId = userId;
    request.userRole = 'admin';
  });
  app.decorate('requireAdmin', async (request: Record<string, unknown>) => {
    request.userId = userId;
    request.userRole = 'admin';
  });
  app.decorate('redis', {});
  return app;
}

// --- Suite ---

describe.skipIf(!dbAvailable)('pages.id int4 overflow on externally-sourced ids (#1167)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    await setupTestDb();

    app = buildApp();
    await app.register(sensible);
    const { pagesCrudRoutes } = await import('./pages-crud.js');
    const { knowledgeAdminRoutes } = await import('./knowledge-admin.js');
    await app.register(pagesCrudRoutes, { prefix: '/api' });
    await app.register(knowledgeAdminRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await truncateAllTables();
    h.client.createPage.mockReset().mockResolvedValue({
      id: '999111',
      title: 'Child page',
      version: { number: 1 },
      body: { storage: { value: '<p>body</p>' } },
    });
    h.client.addLabels.mockReset().mockResolvedValue(undefined);

    userId = await createAdmin();
    await createSpace('CONF', 'confluence');
  });

  // ── Site 1: POST /api/pages — parent resolution (pages-crud.ts) ───────────

  describe('POST /api/pages parent resolution', () => {
    it('resolves a parent whose Confluence id exceeds 2^31 instead of raising 22003', async () => {
      await createPage({ title: 'Big parent', confluenceId: BIG_CONFLUENCE_ID });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: {
          spaceKey: 'CONF',
          title: 'Child page',
          bodyHtml: '<p>body</p>',
          parentId: BIG_CONFLUENCE_ID,
          source: 'confluence',
        },
      });

      // Before the fix this was a 500 carrying
      // `value "2200000000" is out of range for type integer`.
      expect(response.json().error ?? '').not.toMatch(/out of range for type integer/);
      expect(response.statusCode).toBe(200);
      // The parent resolved, so the create went upstream under it.
      expect(h.client.createPage).toHaveBeenCalledWith(
        'CONF',
        'Child page',
        expect.any(String),
        BIG_CONFLUENCE_ID,
      );
    });

    it('still maps an internal DB id to the parent confluence_id', async () => {
      const parentDbId = await createPage({ title: 'Small parent', confluenceId: 'conf-small' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: {
          spaceKey: 'CONF',
          title: 'Child page',
          bodyHtml: '<p>body</p>',
          parentId: String(parentDbId),
          source: 'confluence',
        },
      });

      expect(response.statusCode).toBe(200);
      // The `id` arm must keep resolving: the frontend sends internal DB ids.
      expect(h.client.createPage).toHaveBeenCalledWith(
        'CONF',
        'Child page',
        expect.any(String),
        'conf-small',
      );
    });
  });

  // ── Site 2: GET /api/pages/:id/children (pages-crud.ts) ──────────────────

  describe('GET /api/pages/:id/children', () => {
    it('resolves a page whose Confluence id exceeds 2^31 instead of raising 22003', async () => {
      await createPage({ title: 'Big parent', confluenceId: BIG_CONFLUENCE_ID });
      await createPage({ title: 'Kid', confluenceId: 'conf-kid', parentRef: BIG_CONFLUENCE_ID });

      const response = await app.inject({
        method: 'GET',
        url: `/api/pages/${BIG_CONFLUENCE_ID}/children`,
      });

      expect(response.json().error ?? '').not.toMatch(/out of range for type integer/);
      expect(response.statusCode).toBe(200);
      expect(response.json().children).toEqual([
        expect.objectContaining({ title: 'Kid', confluenceId: 'conf-kid' }),
      ]);
    });

    it('still resolves a page by its internal DB id', async () => {
      const parentDbId = await createPage({ title: 'Small parent', confluenceId: 'conf-small' });
      await createPage({ title: 'Kid', confluenceId: 'conf-kid', parentRef: 'conf-small' });

      const response = await app.inject({
        method: 'GET',
        url: `/api/pages/${parentDbId}/children`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().children).toEqual([
        expect.objectContaining({ title: 'Kid' }),
      ]);
    });
  });

  // ── Site 3: POST /api/llm/summary-regenerate/:pageId (knowledge-admin.ts) ─

  describe('POST /api/llm/summary-regenerate/:pageId', () => {
    it('resolves a page whose Confluence id exceeds 2^31 instead of raising 22003', async () => {
      const dbId = await createPage({ title: 'Big page', confluenceId: BIG_CONFLUENCE_ID });
      await query("UPDATE pages SET summary_status = 'summarized' WHERE id = $1", [dbId]);

      const response = await app.inject({
        method: 'POST',
        url: `/api/llm/summary-regenerate/${BIG_CONFLUENCE_ID}`,
      });

      expect(response.json().error ?? '').not.toMatch(/out of range for type integer/);
      expect(response.statusCode).toBe(200);
      // The route resolved the row and reset it — proving the lookup matched
      // via `confluence_id` rather than aborting on the cast.
      const after = await query<{ summary_status: string }>(
        'SELECT summary_status FROM pages WHERE id = $1',
        [dbId],
      );
      expect(after.rows[0]!.summary_status).toBe('pending');
    });

    it('still resolves a page by its internal DB id', async () => {
      const dbId = await createPage({ title: 'Small page', confluenceId: 'conf-small' });
      await query("UPDATE pages SET summary_status = 'summarized' WHERE id = $1", [dbId]);

      const response = await app.inject({
        method: 'POST',
        url: `/api/llm/summary-regenerate/${dbId}`,
      });

      expect(response.statusCode).toBe(200);
      const after = await query<{ summary_status: string }>(
        'SELECT summary_status FROM pages WHERE id = $1',
        [dbId],
      );
      expect(after.rows[0]!.summary_status).toBe('pending');
    });

    it('404s for an unknown id above 2^31 rather than 500ing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/llm/summary-regenerate/${BIG_CONFLUENCE_ID}`,
      });

      expect(response.json().error ?? '').not.toMatch(/out of range for type integer/);
      expect(response.statusCode).toBe(404);
    });
  });
});
