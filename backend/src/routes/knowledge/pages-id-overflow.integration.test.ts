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

// Same treatment for the embedding worker the bulk-embed route fires and
// forgets. It is not just an LLM boundary: left real, it races these tests by
// clearing `embedding_dirty` on the rows they just asserted about.
vi.mock('../../domains/llm/services/embedding-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../domains/llm/services/embedding-service.js')>()),
  processDirtyPages: vi.fn(async () => undefined),
  isProcessingUser: vi.fn(() => false),
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

    it('still resolves a zero-padded internal DB id', async () => {
      const parentDbId = await createPage({ title: 'Small parent', confluenceId: 'conf-small' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: {
          spaceKey: 'CONF',
          title: 'Child page',
          bodyHtml: '<p>body</p>',
          parentId: `000${parentDbId}`,
          source: 'confluence',
        },
      });

      expect(response.statusCode).toBe(200);
      // `'007'::int` normalised to 7; text comparison is literal, so without
      // normalising the id arm this silently missed. A missed parent lookup is
      // worse than a 404 here — it forwards the caller's raw input upstream as
      // the Confluence parent id, misplacing the new page.
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

    it('still resolves a zero-padded internal DB id', async () => {
      const parentDbId = await createPage({ title: 'Small parent', confluenceId: 'conf-small' });
      await createPage({ title: 'Kid', confluenceId: 'conf-kid', parentRef: 'conf-small' });

      const response = await app.inject({
        method: 'GET',
        url: `/api/pages/000${parentDbId}/children`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().children).toEqual([
        expect.objectContaining({ title: 'Kid' }),
      ]);
    });

    it('matches confluence_id verbatim, without numeric normalisation', async () => {
      // The normalisation is for the id arm only. A page whose confluence_id is
      // literally '000999888777' must still be found by that exact string — and
      // must NOT be found by its normalised form, which would be a false match.
      // The numeric form is chosen far beyond any serial this suite allocates,
      // so the id arm cannot rescue the lookup and make the assertion vacuous.
      const padded = '000999888777';
      await createPage({ title: 'Padded', confluenceId: padded });
      await createPage({ title: 'Kid', confluenceId: 'conf-kid', parentRef: padded });

      const hit = await app.inject({ method: 'GET', url: `/api/pages/${padded}/children` });
      expect(hit.statusCode).toBe(200);
      expect(hit.json().children).toEqual([expect.objectContaining({ title: 'Kid' })]);

      const miss = await app.inject({ method: 'GET', url: '/api/pages/999888777/children' });
      expect(miss.statusCode).toBe(404);
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

    it('still resolves a zero-padded internal DB id', async () => {
      const dbId = await createPage({ title: 'Small page', confluenceId: 'conf-small' });
      await query("UPDATE pages SET summary_status = 'summarized' WHERE id = $1", [dbId]);

      const response = await app.inject({
        method: 'POST',
        url: `/api/llm/summary-regenerate/000${dbId}`,
      });

      expect(response.statusCode).toBe(200);
      const after = await query<{ summary_status: string }>(
        'SELECT summary_status FROM pages WHERE id = $1',
        [dbId],
      );
      expect(after.rows[0]!.summary_status).toBe('pending');
    });

    it('404s for an unknown id above 2^31 rather than 500ing (site 3)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/llm/summary-regenerate/${BIG_CONFLUENCE_ID}`,
      });

      expect(response.json().error ?? '').not.toMatch(/out of range for type integer/);
      expect(response.statusCode).toBe(404);
    });
  });

  // ── Site 4: bulk selection (core/services/bulk-page-selection.ts) ─────────
  //
  // The array arm was the worst instance of this defect, not a milder one: the
  // text arm used to exclude `/^\d+$/`, so a numeric Confluence id landed in the
  // int[] arm alone with no second arm to rescue it — and `bulkWireId` sends
  // exactly that for every synced page, so the ordinary UI reaches it. (That
  // exclusion is itself removed by the confluence_id addressing PR stacked on
  // this one; the overflow behaviour asserted here is unaffected either way.)
  // Eight call sites share `resolveBulkSelection`; `POST /pages/bulk/embed` is
  // the thinnest.

  describe('POST /api/pages/bulk/embed (bulk selection resolver)', () => {
    it('does not 500 the whole batch on an id above 2^31', async () => {
      await createPage({ title: 'Big', confluenceId: BIG_CONFLUENCE_ID });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/embed',
        payload: { ids: [BIG_CONFLUENCE_ID] },
      });

      expect(response.json().error ?? '').not.toMatch(/out of range for type integer/);
      expect(response.statusCode).toBe(200);
      // With the stacked confluence_id addressing fix the oversized id also
      // *resolves*, not merely fails to 500: an above-int4 Confluence content
      // id is now fully addressable in bulk.
      expect(response.json()).toMatchObject({ succeeded: 1, failed: 0 });
    });

    it('keeps partial success: one oversized id no longer sinks the batch', async () => {
      // The resolvable page is addressed by a NON-numeric confluence_id, which
      // keeps this assertion about the *cast* rather than about the text arm's
      // old `/^\d+$/` exclusion (the separate gap noted in the PR).
      await createPage({ title: 'Fine', confluenceId: 'conf-ok' });
      // No row carries BIG_CONFLUENCE_ID: the oversized id has to be genuinely
      // unresolvable for this to still be a *partial* success. Before the
      // stacked fix a matching row would not have resolved either, so the page
      // that used to sit here proved nothing once numeric ids reached the
      // confluence arm.
      // `embedding_dirty` defaults to TRUE, so clear it first — otherwise the
      // assertion below cannot tell what this request actually marked.
      await query('UPDATE pages SET embedding_dirty = FALSE', []);

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/embed',
        payload: { ids: ['conf-ok', BIG_CONFLUENCE_ID] },
      });

      expect(response.statusCode).toBe(200);
      // Before the fix the int4 cast aborted the statement, so the good page
      // was not embedded either — the entire batch 500ed.
      expect(response.json()).toMatchObject({ succeeded: 1, failed: 1 });

      const embedded = await query<{ confluence_id: string }>(
        'SELECT confluence_id FROM pages WHERE embedding_dirty = TRUE',
      );
      expect(embedded.rows.map((r) => r.confluence_id)).toEqual(['conf-ok']);
    });

    it('resolves a zero-padded internal DB id exactly like the unpadded one', async () => {
      const dbId = await createPage({ title: 'By PK', confluenceId: 'conf-pk' });

      const padded = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/embed',
        payload: { ids: [`000${dbId}`] },
      });
      await query('UPDATE pages SET embedding_dirty = FALSE', []);
      const plain = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/embed',
        payload: { ids: [String(dbId)] },
      });

      expect(padded.statusCode).toBe(200);
      // The id arm resolved the row via its PK despite the zero padding, so the
      // page was eligible and got marked dirty.
      expect(padded.json()).toMatchObject({ succeeded: 1 });
      // Padding must not be the differentiator: whatever the unpadded id does,
      // the padded one does too. Counts only — `notFoundIds` deliberately
      // echoes the caller's original string, so the messages differ. (Both now
      // report the id as found; the double-count that used to make them both
      // report not-found — a synced row mapped back by confluence_id — is
      // fixed by the confluence_id addressing PR that follows this one.)
      const counts = (r: typeof padded) => {
        const { succeeded, failed } = r.json();
        return { succeeded, failed };
      };
      expect(counts(padded)).toEqual(counts(plain));
    });
  });
});
