/**
 * Integration tests for bulk-selection id addressing against a REAL PostgreSQL.
 *
 * `resolveBulkSelection` splits the caller's ids across two arms. The
 * `confluence_id` arm used to be fed `ids.filter((id) => !/^\d+$/.test(id))` —
 * it *excluded* all-digit ids. Confluence DC content ids are numeric strings,
 * so no real one ever reached it, at any magnitude: a synced page was not
 * addressable by its `confluence_id` in any of the six bulk routes. That is the
 * wire shape the UI sends (`bulkWireId` maps every non-standalone row to
 * `confluenceId ?? id`), so the ordinary bulk delete/sync/embed/quality buttons
 * resolved zero rows for synced pages.
 *
 * Feeding numeric ids to both arms makes one string able to name two different
 * pages — one by `pages.id`, another by `confluence_id`. On a path that
 * includes bulk DELETE that must not be guessed at, so the resolver refuses the
 * id (the same call `/move` and `/relocate` make for the identical collision,
 * #1166) and the batch continues without it.
 *
 * These must run against real Postgres: a mocked `query()` returns whatever the
 * test tells it to and cannot demonstrate which rows the predicate matches, nor
 * that a delete stopped where it was supposed to.
 *
 * Only the real boundaries are stubbed — the Confluence HTTP client, Redis,
 * audit log, webhooks, the attachment filesystem and the background workers.
 * The DB, the resolver and the delete path are real.
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
 * A plain Confluence DC content id — all digits, comfortably inside int4. The
 * defect under test is not about magnitude (that was #1167): this id was
 * unreachable because of its *shape*.
 */
const NUMERIC_CONFLUENCE_ID = '12345';

/**
 * The colliding value. One page gets it as its `pages.id`, a different page as
 * its `confluence_id`. Chosen far above any serial this suite allocates so the
 * two never overlap by accident.
 */
const COLLIDING_ID = 777777;

// --- Boundary mocks (everything else is real) ---

const h = vi.hoisted(() => ({
  client: {
    deletePage: vi.fn(),
    addLabels: vi.fn(),
    removeLabel: vi.fn(),
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

vi.mock('../../core/services/webhook-emit-hook.js', () => ({
  emitWebhookEvent: vi.fn(),
}));

vi.mock('../../domains/confluence/services/attachment-handler.js', () => ({
  cleanPageAttachments: vi.fn().mockResolvedValue(undefined),
  syncDrawioAttachments: vi.fn().mockResolvedValue(undefined),
  syncImageAttachments: vi.fn().mockResolvedValue(undefined),
  getMissingAttachments: vi.fn().mockResolvedValue([]),
  writeAttachmentCache: vi.fn().mockResolvedValue(undefined),
}));

// Not merely an LLM boundary: left real, the embedding worker races these tests
// by clearing `embedding_dirty` on the rows they just asserted about.
vi.mock('../../domains/llm/services/embedding-service.js', () => ({
  processDirtyPages: vi.fn().mockResolvedValue(undefined),
  isProcessingUser: vi.fn().mockReturnValue(false),
  computePageRelationships: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../domains/knowledge/services/quality-worker.js', () => ({
  triggerQualityBatch: vi.fn().mockResolvedValue(undefined),
}));

const mockGetUserAccessibleSpaces = vi.fn();
vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: (...args: unknown[]) => mockGetUserAccessibleSpaces(...args),
  invalidateRbacCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../domains/confluence/services/sync-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../domains/confluence/services/sync-service.js')>()),
  getClientForUser: vi.fn(async () => h.client),
}));

const dbAvailable = await isDbAvailable();

// --- Fixtures ---

let userId: string;

/** A Confluence-sourced page in the DEV space. `id` may be forced. */
async function insertSynced(opts: {
  confluenceId: string;
  title?: string;
  id?: number;
}): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO pages (${opts.id !== undefined ? 'id, ' : ''}confluence_id, source, space_key,
                        title, body_text, body_storage, body_html, inherit_perms, version)
     VALUES (${opts.id !== undefined ? `${opts.id}, ` : ''}$1, 'confluence', 'DEV', $2,
             'text', '', '<p>x</p>', TRUE, 1)
     RETURNING id`,
    [opts.confluenceId, opts.title ?? `Synced ${opts.confluenceId}`],
  );
  return res.rows[0]!.id;
}

/** A standalone page owned by `userId`. `id` may be forced. */
async function insertStandalone(opts: { title: string; id?: number }): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO pages (${opts.id !== undefined ? 'id, ' : ''}source, title, body_text,
                        body_storage, body_html, created_by_user_id, visibility, version,
                        page_type, embedding_dirty, embedding_status, last_synced)
     VALUES (${opts.id !== undefined ? `${opts.id}, ` : ''}'standalone', $1, 'text', NULL,
             '<p>x</p>', $2, 'private', 1, 'page', TRUE, 'not_embedded', NOW())
     RETURNING id`,
    [opts.title, userId],
  );
  return res.rows[0]!.id;
}

/** Ids of every row still visible to the app (all readers filter `deleted_at`). */
async function liveIds(): Promise<number[]> {
  const res = await query<{ id: number }>(
    'SELECT id FROM pages WHERE deleted_at IS NULL ORDER BY id',
  );
  return res.rows.map((r) => r.id);
}

/** Confluence ids of the rows this request marked for re-embedding. */
async function dirtyConfluenceIds(): Promise<string[]> {
  const res = await query<{ confluence_id: string }>(
    'SELECT confluence_id FROM pages WHERE embedding_dirty = TRUE ORDER BY confluence_id',
  );
  return res.rows.map((r) => r.confluence_id);
}

async function clearDirty(): Promise<void> {
  await query('UPDATE pages SET embedding_dirty = FALSE');
}

// --- Suite ---

describe.skipIf(!dbAvailable)('bulk selection addressing by confluence_id', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    await setupTestDb();

    app = Fastify({ logger: false });
    await app.register(sensible);
    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed' });
      }
      return reply.status(error.statusCode ?? 500).send({ error: error.message });
    });
    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = userId;
    });
    app.decorate('requireAdmin', async (request: { userId: string }) => {
      request.userId = userId;
    });
    app.decorate('redis', {});
    const { pagesCrudRoutes } = await import('./pages-crud.js');
    await app.register(pagesCrudRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await truncateAllTables();
    h.client.deletePage.mockReset().mockResolvedValue(undefined);
    h.client.addLabels.mockReset().mockResolvedValue(undefined);
    h.client.removeLabel.mockReset().mockResolvedValue(undefined);

    const res = await query<{ id: string }>(
      "INSERT INTO users (username, password_hash, role) VALUES ('bulk_id_user', 'x', 'admin') RETURNING id",
    );
    userId = res.rows[0]!.id;
    await query(
      "INSERT INTO spaces (space_key, space_name, source) VALUES ('DEV', 'DEV', 'confluence') ON CONFLICT (space_key) DO NOTHING",
    );
    mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
  });

  // ── The fix: a numeric confluence_id resolves ────────────────────────────

  describe('a synced page addressed by its numeric confluence_id', () => {
    it('resolves on POST /pages/bulk/embed', async () => {
      await insertSynced({ confluenceId: NUMERIC_CONFLUENCE_ID });
      await clearDirty();

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/embed',
        payload: { ids: [NUMERIC_CONFLUENCE_ID] },
      });

      expect(response.statusCode).toBe(200);
      // Before the fix: the all-digit id was excluded from the confluence arm
      // and compared against `pages.id` instead, so it matched nothing —
      // `{ succeeded: 0, failed: 1, errors: ['Page 12345 not found'] }`.
      expect(response.json()).toMatchObject({ succeeded: 1, failed: 0, errors: [] });
      expect(await dirtyConfluenceIds()).toEqual([NUMERIC_CONFLUENCE_ID]);
    });

    it('resolves on POST /pages/bulk/delete and deletes exactly that page', async () => {
      const target = await insertSynced({ confluenceId: NUMERIC_CONFLUENCE_ID });
      const bystander = await insertSynced({ confluenceId: '54321' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: [NUMERIC_CONFLUENCE_ID] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ succeeded: 1, failed: 0, errors: [] });
      // Upstream was asked to delete that page and only that page.
      expect(h.client.deletePage.mock.calls).toEqual([[NUMERIC_CONFLUENCE_ID]]);
      // Confluence-sourced bulk delete is a hard delete once upstream succeeds.
      expect(await liveIds()).toEqual([bystander]);
      expect(target).not.toBe(bystander);
    });

    it('is still addressable by its PK, and no longer double-counted', async () => {
      // The old row→id reverse map assumed a synced row could only have been
      // named by `confluence_id`, so addressing one by PK acted on it and
      // *still* reported it in `failed`/`errors`.
      const pk = await insertSynced({ confluenceId: NUMERIC_CONFLUENCE_ID });
      await clearDirty();

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/embed',
        payload: { ids: [String(pk)] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ succeeded: 1, failed: 0, errors: [] });
      expect(await dirtyConfluenceIds()).toEqual([NUMERIC_CONFLUENCE_ID]);
    });

    it('counts a page named twice, by both of its identifiers, once', async () => {
      const pk = await insertSynced({ confluenceId: NUMERIC_CONFLUENCE_ID });
      const other = await insertSynced({ confluenceId: '54321' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: [String(pk), NUMERIC_CONFLUENCE_ID] },
      });

      expect(response.statusCode).toBe(200);
      // One page, one delete — not two successes and not two upstream calls.
      expect(response.json()).toMatchObject({ succeeded: 1, failed: 0, errors: [] });
      expect(h.client.deletePage.mock.calls).toEqual([[NUMERIC_CONFLUENCE_ID]]);
      expect(await liveIds()).toEqual([other]);
    });

    it('treats a page whose PK equals its own confluence_id as one target', async () => {
      // Both arms hit, but they hit the SAME row — that is not a conflict.
      await insertSynced({ id: COLLIDING_ID, confluenceId: String(COLLIDING_ID) });
      await clearDirty();

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/embed',
        payload: { ids: [String(COLLIDING_ID)] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ succeeded: 1, failed: 0, errors: [] });
    });
  });

  // ── The hazard the fix creates, and its resolution ───────────────────────

  describe('an id naming two different pages', () => {
    /**
     * A standalone page with `id = 777777` and a synced page with
     * `confluence_id = '777777'`. Indistinguishable to every reader — the exact
     * collision `/move` refuses with 409 (#1166).
     */
    async function seedCollision(): Promise<{ byPk: number; byConfluenceId: number }> {
      const byPk = await insertStandalone({ title: 'Standalone 777777', id: COLLIDING_ID });
      const byConfluenceId = await insertSynced({ confluenceId: String(COLLIDING_ID) });
      return { byPk, byConfluenceId };
    }

    it('is refused rather than resolved to either page', async () => {
      const { byPk, byConfluenceId } = await seedCollision();
      await clearDirty();

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/embed',
        payload: { ids: [String(COLLIDING_ID)] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ succeeded: 0, failed: 1 });
      // Named as ambiguous, not as "not found" — the pages plainly exist, and
      // telling the caller otherwise invites a destructive retry elsewhere.
      expect(response.json().errors).toEqual([
        `Page ${COLLIDING_ID}: ambiguous identifier — it is one page's id and another page's Confluence id; no action taken`,
      ]);
      // Neither candidate was touched.
      expect(await dirtyConfluenceIds()).toEqual([]);
      expect(await liveIds()).toEqual([byConfluenceId, byPk].sort((a, b) => a - b));
    });

    it('is refused on bulk delete, leaving both pages live and untouched', async () => {
      const { byPk, byConfluenceId } = await seedCollision();

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: [String(COLLIDING_ID)] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ succeeded: 0, failed: 1 });
      expect(response.json().errors[0]).toMatch(/ambiguous identifier/);
      // The two failure modes this refusal exists to prevent: deleting both,
      // and deleting the wrong one while reporting success.
      expect(h.client.deletePage).not.toHaveBeenCalled();
      expect(await liveIds()).toEqual([byConfluenceId, byPk].sort((a, b) => a - b));
    });

    it('does not sink the rest of the batch (#1167 partial success holds)', async () => {
      const { byPk, byConfluenceId } = await seedCollision();
      const doomed = await insertSynced({ confluenceId: '54321' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: [String(COLLIDING_ID), '54321'] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ succeeded: 1, failed: 1 });
      expect(h.client.deletePage.mock.calls).toEqual([['54321']]);
      expect(await liveIds()).toEqual([byConfluenceId, byPk].sort((a, b) => a - b));
      expect(doomed).not.toBe(byPk);
    });

    it('is not triggered by a soft-deleted competitor', async () => {
      // Divergence from #1166, which deliberately counts trashed rows: the
      // `parent_id` it writes outlives the request and a restore puts the
      // trashed row back in contention. Here the resolver acts within the
      // request and every bulk route filters `deleted_at IS NULL`, so a trashed
      // row can never be a target — vetoing on it would be a refusal with no
      // hazard behind it.
      await insertStandalone({ title: 'Trashed 777777', id: COLLIDING_ID });
      await query('UPDATE pages SET deleted_at = NOW() WHERE id = $1', [COLLIDING_ID]);
      const live = await insertSynced({ confluenceId: String(COLLIDING_ID) });
      await clearDirty();

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/embed',
        payload: { ids: [String(COLLIDING_ID)] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ succeeded: 1, failed: 0, errors: [] });
      expect(await liveIds()).toEqual([live]);
    });

    it('is not triggered by a competitor outside the caller\'s RBAC scope', async () => {
      // Same reasoning, plus: refusing here would disclose that a page the
      // caller cannot see exists.
      await query(
        "INSERT INTO spaces (space_key, space_name, source) VALUES ('SECRET', 'SECRET', 'confluence') ON CONFLICT (space_key) DO NOTHING",
      );
      await query(
        `INSERT INTO pages (id, confluence_id, source, space_key, title, body_text,
                            body_storage, body_html, inherit_perms, version)
         VALUES ($1, 'conf-secret', 'confluence', 'SECRET', 'Hidden', 'text', '', '<p>x</p>', TRUE, 1)`,
        [COLLIDING_ID],
      );
      const visible = await insertSynced({ confluenceId: String(COLLIDING_ID) });
      await clearDirty();

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/embed',
        payload: { ids: [String(COLLIDING_ID)] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ succeeded: 1, failed: 0, errors: [] });
      expect(await dirtyConfluenceIds()).toEqual([String(COLLIDING_ID)]);
      expect(visible).not.toBe(COLLIDING_ID);
    });
  });

  // ── Blast radius of the widened predicate, on delete specifically ────────

  describe('bulk delete blast radius', () => {
    it('deletes exactly the named pages and nothing adjacent', async () => {
      // A deliberately hostile fixture: every row here is reachable by *some*
      // id in the request under a sloppier predicate.
      const namedSynced = await insertSynced({ confluenceId: NUMERIC_CONFLUENCE_ID });
      const namedStandalone = await insertStandalone({ title: 'Mine' });
      // Same digits as the synced page's PK, in the other id space.
      const decoyByConfluenceId = await insertSynced({
        confluenceId: String(namedStandalone),
        title: 'Decoy',
      });
      const untouchedSynced = await insertSynced({ confluenceId: '99999' });
      const untouchedStandalone = await insertStandalone({ title: 'Also mine' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        // Exactly the wire shape `bulkWireId` produces: confluence_id for the
        // synced page, PK for the standalone one.
        payload: { ids: [NUMERIC_CONFLUENCE_ID, String(namedStandalone)] },
      });

      expect(response.statusCode).toBe(200);
      // `String(namedStandalone)` is ambiguous — it is that page's PK *and* the
      // decoy's confluence_id — so it is refused, not applied to both.
      expect(response.json()).toMatchObject({ succeeded: 1, failed: 1 });
      expect(response.json().errors).toEqual([
        `Page ${namedStandalone}: ambiguous identifier — it is one page's id and another page's Confluence id; no action taken`,
      ]);

      // One upstream delete, for the one unambiguous synced page.
      expect(h.client.deletePage.mock.calls).toEqual([[NUMERIC_CONFLUENCE_ID]]);
      expect(await liveIds()).toEqual(
        [namedStandalone, decoyByConfluenceId, untouchedSynced, untouchedStandalone].sort(
          (a, b) => a - b,
        ),
      );
      expect(namedSynced).not.toBe(decoyByConfluenceId);
    });

    it('resolves at most one page per supplied id', async () => {
      // The property that bounds the widening: the predicate now matches more
      // *rows* across the table, but each input id still contributes at most
      // one target, so a request can never delete more pages than it names.
      await insertSynced({ confluenceId: NUMERIC_CONFLUENCE_ID });
      await insertSynced({ confluenceId: '54321' });
      const standalone = await insertStandalone({ title: 'Mine' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: [NUMERIC_CONFLUENCE_ID, '54321', String(standalone)] },
      });

      expect(response.statusCode).toBe(200);
      const { succeeded, failed } = response.json();
      expect(succeeded + failed).toBe(3);
      expect(await liveIds()).toEqual([]);
    });
  });

  // ── The narrower surface stays narrow ────────────────────────────────────

  describe("idMode 'numeric-only' is unchanged", () => {
    it('still refuses to address a page by confluence_id on POST /pages/bulk/tag', async () => {
      // `/bulk/tag` and `/bulk/replace-tags` key their work by `String(row.id)`
      // and write `WHERE id = $1`; nothing in the app addresses them by
      // `confluence_id`, so they keep the narrower surface — and with it, no
      // ambiguity case at all.
      const pk = await insertSynced({ confluenceId: NUMERIC_CONFLUENCE_ID });

      const byConfluenceId = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/tag',
        payload: { ids: [NUMERIC_CONFLUENCE_ID], addTags: ['x'] },
      });
      const byPk = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/tag',
        payload: { ids: [String(pk)], addTags: ['y'] },
      });

      expect(byConfluenceId.json()).toMatchObject({ succeeded: 0, failed: 1 });
      expect(byConfluenceId.json().errors).toEqual([`Page ${NUMERIC_CONFLUENCE_ID} not found`]);
      expect(byPk.json()).toMatchObject({ succeeded: 1, failed: 0 });

      const labels = await query<{ labels: string[] }>('SELECT labels FROM pages WHERE id = $1', [
        pk,
      ]);
      expect(labels.rows[0]!.labels).toEqual(['y']);
    });
  });
});
