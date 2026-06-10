import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';

// --- Mock: rbac-service ---
const mockGetUserAccessibleSpaces = vi.fn();
vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: (...args: unknown[]) => mockGetUserAccessibleSpaces(...args),
}));

// --- Mock: postgres query ---
const mockQueryFn = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

// --- Mock: version-tracker ---
const mockGetVersionHistory = vi.fn();
const mockGetVersion = vi.fn();
const mockGetSemanticDiff = vi.fn();
const mockSaveVersionSnapshotByPageId = vi.fn();
const mockRestoreVersion = vi.fn();
vi.mock('../../domains/knowledge/services/version-tracker.js', () => ({
  getVersionHistory: (...args: unknown[]) => mockGetVersionHistory(...args),
  getVersion: (...args: unknown[]) => mockGetVersion(...args),
  getSemanticDiff: (...args: unknown[]) => mockGetSemanticDiff(...args),
  saveVersionSnapshotByPageId: (...args: unknown[]) => mockSaveVersionSnapshotByPageId(...args),
  restoreVersion: (...args: unknown[]) => mockRestoreVersion(...args),
}));

// --- Mock: confluence client (HTTP boundary) ---
const mockUpdatePage = vi.fn();
const mockGetClientForUser = vi.fn();
vi.mock('../../domains/confluence/services/sync-service.js', () => ({
  getClientForUser: (...args: unknown[]) => mockGetClientForUser(...args),
}));

// --- Mock: content converter ---
const mockHtmlToConfluence = vi.fn().mockReturnValue('<p>storage</p>');
vi.mock('../../core/services/content-converter.js', () => ({
  htmlToConfluence: (...args: unknown[]) => mockHtmlToConfluence(...args),
}));

// --- Mock: version-backfill ---
const mockBackfillVersionHistory = vi.fn().mockResolvedValue({ imported: 0 });
const mockGetHistoricalBody = vi.fn();
vi.mock('../../domains/confluence/services/version-backfill.js', () => ({
  backfillVersionHistory: (...args: unknown[]) => mockBackfillVersionHistory(...args),
  getHistoricalBody: (...args: unknown[]) => mockGetHistoricalBody(...args),
}));

// --- Mock: audit + webhook + cache ---
const mockLogAuditEvent = vi.fn();
vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
}));
const mockEmitWebhookEvent = vi.fn();
vi.mock('../../core/services/webhook-emit-hook.js', () => ({
  emitWebhookEvent: (...args: unknown[]) => mockEmitWebhookEvent(...args),
}));
vi.mock('../../core/services/redis-cache.js', () => ({
  RedisCache: class MockRedisCache {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue(undefined);
    invalidate = vi.fn().mockResolvedValue(undefined);
  },
}));

import { pagesVersionRoutes } from './pages-versions.js';

const TEST_USER = 'test-user-id';

/** Build a ready Fastify app with the version routes and a stub auth decorator. */
async function buildVersionApp(opts: { authed?: boolean } = { authed: true }) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: 'Validation failed' });
    }
    reply.status(error.statusCode ?? 500).send({ error: error.message });
  });
  if (opts.authed) {
    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = TEST_USER;
    });
  } else {
    app.decorate('authenticate', async () => {
      throw app.httpErrors.unauthorized('Missing or invalid token');
    });
  }
  app.decorate('redis', {});
  app.decorateRequest('userId', '');
  await app.register(pagesVersionRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

/**
 * Mock the page-resolution query (`SELECT id, confluence_id, space_key, ...`)
 * plus the current-version queries. `kind` chooses the page shape.
 */
function mockResolvedPage(page: {
  id: number;
  confluence_id?: string | null;
  space_key?: string | null;
  source?: string;
  visibility?: string;
  created_by_user_id?: string | null;
  version?: number;
  body_html?: string;
  body_text?: string;
  title?: string;
}) {
  const row = {
    id: page.id,
    confluence_id: page.confluence_id ?? null,
    space_key: page.space_key ?? null,
    source: page.source ?? 'confluence',
    visibility: page.visibility ?? 'shared',
    created_by_user_id: page.created_by_user_id ?? null,
    version: page.version ?? 3,
  };
  mockQueryFn.mockImplementation((sql: string) => {
    if (typeof sql === 'string' && sql.includes('confluence_id, space_key, source, visibility, created_by_user_id, version')) {
      return Promise.resolve({ rows: [row] });
    }
    if (typeof sql === 'string' && sql.includes('version, title, last_modified_at')) {
      return Promise.resolve({ rows: [{ version: row.version, title: page.title ?? 'Test Page', last_modified_at: new Date('2026-03-01') }] });
    }
    if (typeof sql === 'string' && sql.includes('version, title, body_html, body_text')) {
      return Promise.resolve({ rows: [{ version: row.version, title: page.title ?? 'Test Page', body_html: page.body_html ?? '<p>current</p>', body_text: page.body_text ?? 'current' }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

// =============================================================================
// Auth
// =============================================================================

describe('pages-versions routes - auth required', () => {
  let app: ReturnType<typeof Fastify>;
  beforeAll(async () => { app = await buildVersionApp({ authed: false }); });
  afterAll(async () => { await app.close(); });

  it('401 for GET /versions', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/pages/page-1/versions' });
    expect(r.statusCode).toBe(401);
  });
  it('401 for GET /versions/:version', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/pages/page-1/versions/1' });
    expect(r.statusCode).toBe(401);
  });
  it('401 for POST /versions/semantic-diff', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/pages/page-1/versions/semantic-diff', payload: { v1: 1, v2: 2 } });
    expect(r.statusCode).toBe(401);
  });
  it('401 for POST /versions/:version/restore', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/pages/page-1/versions/2/restore' });
    expect(r.statusCode).toBe(401);
  });
});

// =============================================================================
// GET /versions
// =============================================================================

describe('GET /api/pages/:id/versions', () => {
  let app: ReturnType<typeof Fastify>;
  beforeAll(async () => { app = await buildVersionApp(); });
  afterAll(async () => { await app.close(); });
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);
  });

  it('returns history with the current version included', async () => {
    mockResolvedPage({ id: 7, confluence_id: 'page-1', space_key: 'DEV', version: 5 });
    mockGetVersionHistory.mockResolvedValue([
      { versionNumber: 4, title: 'v4', syncedAt: new Date('2026-02-15'), editedAt: null, author: null, message: null },
      { versionNumber: 3, title: 'v3', syncedAt: new Date('2026-02-01'), editedAt: null, author: null, message: null },
    ]);

    const r = await app.inject({ method: 'GET', url: '/api/pages/page-1/versions' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.pageId).toBe('page-1');
    expect(body.versions).toHaveLength(3);
    expect(body.versions[0].isCurrent).toBe(true);
    expect(body.versions[0].versionNumber).toBe(5);
    // version-tracker queried by internal page_id, not confluence_id
    expect(mockGetVersionHistory).toHaveBeenCalledWith(7);
  });

  it('resolves a NUMERIC page id (the id the frontend uses) to history', async () => {
    mockResolvedPage({ id: 42, confluence_id: 'abc', space_key: 'DEV', version: 2 });
    mockGetVersionHistory.mockResolvedValue([]);

    const r = await app.inject({ method: 'GET', url: '/api/pages/42/versions' });
    expect(r.statusCode).toBe(200);
    expect(mockGetVersionHistory).toHaveBeenCalledWith(42);
  });

  it('de-duplicates a snapshot row that matches the live version', async () => {
    mockResolvedPage({ id: 7, confluence_id: 'page-1', space_key: 'DEV', version: 5 });
    mockGetVersionHistory.mockResolvedValue([
      { versionNumber: 5, title: 'dup', syncedAt: new Date(), editedAt: null, author: null, message: null },
      { versionNumber: 4, title: 'v4', syncedAt: new Date(), editedAt: null, author: null, message: null },
    ]);
    const r = await app.inject({ method: 'GET', url: '/api/pages/page-1/versions' });
    const body = r.json();
    // current(5) + historical(4) only — the duplicate 5 is dropped
    expect(body.versions.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([5, 4]);
  });

  it('403 for a page in an inaccessible space', async () => {
    mockResolvedPage({ id: 9, confluence_id: 'restricted', space_key: 'HR', version: 1 });
    const r = await app.inject({ method: 'GET', url: '/api/pages/restricted/versions' });
    expect(r.statusCode).toBe(403);
  });

  it('returns empty list (not 500) when the page is missing', async () => {
    mockQueryFn.mockResolvedValue({ rows: [] });
    const r = await app.inject({ method: 'GET', url: '/api/pages/nope/versions' });
    expect(r.statusCode).toBe(200);
    expect(r.json().versions).toEqual([]);
  });

  it('allows the owner of a private standalone page', async () => {
    mockResolvedPage({ id: 11, source: 'standalone', visibility: 'private', created_by_user_id: TEST_USER, version: 1 });
    mockGetVersionHistory.mockResolvedValue([]);
    const r = await app.inject({ method: 'GET', url: '/api/pages/11/versions' });
    expect(r.statusCode).toBe(200);
  });

  it('403 for a private standalone page owned by another user', async () => {
    mockResolvedPage({ id: 12, source: 'standalone', visibility: 'private', created_by_user_id: 'other', version: 1 });
    const r = await app.inject({ method: 'GET', url: '/api/pages/12/versions' });
    expect(r.statusCode).toBe(403);
  });

  it('returns real edited_at/author/message for historical rows (#722)', async () => {
    mockResolvedPage({ id: 7, confluence_id: 'page-1', space_key: 'DEV', version: 5 });
    mockGetClientForUser.mockResolvedValue({ updatePage: vi.fn() });
    mockGetVersionHistory.mockResolvedValue([
      {
        versionNumber: 4,
        title: 'v4',
        syncedAt: new Date('2026-03-01'),
        editedAt: new Date('2026-02-28T10:00:00Z'),
        author: 'alice',
        message: 'Updated intro',
      },
    ]);

    const r = await app.inject({ method: 'GET', url: '/api/pages/page-1/versions' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    const v4 = body.versions.find((v: { versionNumber: number }) => v.versionNumber === 4);
    expect(v4.editedAt).toBe('2026-02-28T10:00:00.000Z');
    expect(v4.author).toBe('alice');
    expect(v4.message).toBe('Updated intro');
  });

  it('current row has editedAt:null when last_modified_at is null — no page-load time (#724)', async () => {
    mockQueryFn.mockImplementation((sql: string) => {
      if (sql.includes('confluence_id, space_key, source, visibility, created_by_user_id, version')) {
        return Promise.resolve({ rows: [{ id: 7, confluence_id: null, space_key: null, source: 'standalone', visibility: 'shared', created_by_user_id: TEST_USER, version: 1 }] });
      }
      if (sql.includes('version, title, last_modified_at')) {
        return Promise.resolve({ rows: [{ version: 1, title: 'Fresh Page', last_modified_at: null }] });
      }
      return Promise.resolve({ rows: [] });
    });
    mockGetVersionHistory.mockResolvedValue([]);

    const r = await app.inject({ method: 'GET', url: '/api/pages/7/versions' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.versions[0].editedAt).toBeNull();
    expect(body.versions[0].syncedAt).toBeNull();
  });

  it('triggers backfill for Confluence-sourced pages on open (#722)', async () => {
    mockResolvedPage({ id: 7, confluence_id: 'page-1', space_key: 'DEV', version: 5 });
    const mockClient = {};
    mockGetClientForUser.mockResolvedValue(mockClient);
    mockBackfillVersionHistory.mockResolvedValue({ imported: 3 });
    mockGetVersionHistory.mockResolvedValue([]);

    const r = await app.inject({ method: 'GET', url: '/api/pages/page-1/versions' });
    expect(r.statusCode).toBe(200);
    expect(mockBackfillVersionHistory).toHaveBeenCalledWith(7, 'page-1', mockClient);
  });

  it('backfill failure is swallowed — dialog still opens (#722)', async () => {
    mockResolvedPage({ id: 7, confluence_id: 'page-1', space_key: 'DEV', version: 5 });
    mockGetClientForUser.mockResolvedValue({});
    mockBackfillVersionHistory.mockRejectedValue(new Error('Confluence down'));
    mockGetVersionHistory.mockResolvedValue([]);

    const r = await app.inject({ method: 'GET', url: '/api/pages/page-1/versions' });
    expect(r.statusCode).toBe(200);
  });

  // ── #763: backfillStatus — distinguish "complete" / "never ran" / "failed" ──

  it('reports backfillStatus "ok" when the backfill ran (#763)', async () => {
    mockResolvedPage({ id: 7, confluence_id: 'page-1', space_key: 'DEV', version: 5 });
    mockGetClientForUser.mockResolvedValue({});
    mockBackfillVersionHistory.mockResolvedValue({ imported: 2 });
    mockGetVersionHistory.mockResolvedValue([]);

    const r = await app.inject({ method: 'GET', url: '/api/pages/page-1/versions' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.backfillStatus).toBe('ok');
    expect(body.backfillDetail).toBeUndefined();
  });

  it('reports "skipped_no_credentials" AND still returns the current row when the user has no PAT (#763)', async () => {
    mockResolvedPage({ id: 7, confluence_id: 'page-1', space_key: 'DEV', version: 5 });
    mockGetClientForUser.mockResolvedValue(null); // no stored Confluence credentials
    mockGetVersionHistory.mockResolvedValue([]);

    const r = await app.inject({ method: 'GET', url: '/api/pages/page-1/versions' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.backfillStatus).toBe('skipped_no_credentials');
    expect(body.backfillDetail).toMatch(/Settings/);
    // The synthetic current row is still returned — the list is never empty
    // for a resolvable page.
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0]).toMatchObject({ versionNumber: 5, isCurrent: true });
    expect(mockBackfillVersionHistory).not.toHaveBeenCalled();
  });

  it('reports "failed" AND still returns the current row when the backfill throws (#763)', async () => {
    mockResolvedPage({ id: 7, confluence_id: 'page-1', space_key: 'DEV', version: 5 });
    mockGetClientForUser.mockResolvedValue({});
    mockBackfillVersionHistory.mockRejectedValue(new Error('Confluence down'));
    mockGetVersionHistory.mockResolvedValue([]);

    const r = await app.inject({ method: 'GET', url: '/api/pages/page-1/versions' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.backfillStatus).toBe('failed');
    expect(body.backfillDetail).toMatch(/incomplete/i);
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0]).toMatchObject({ versionNumber: 5, isCurrent: true });
  });

  it('omits backfillStatus for standalone pages — no Confluence backfill applies (#763)', async () => {
    mockResolvedPage({ id: 11, source: 'standalone', visibility: 'shared', created_by_user_id: TEST_USER, version: 1 });
    mockGetVersionHistory.mockResolvedValue([]);

    const r = await app.inject({ method: 'GET', url: '/api/pages/11/versions' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.backfillStatus).toBeUndefined();
    expect(body.backfillDetail).toBeUndefined();
    expect(mockGetClientForUser).not.toHaveBeenCalled();
  });
});

// =============================================================================
// GET /versions/:version
// =============================================================================

describe('GET /api/pages/:id/versions/:version', () => {
  let app: ReturnType<typeof Fastify>;
  beforeAll(async () => { app = await buildVersionApp(); });
  afterAll(async () => { await app.close(); });
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
  });

  it('returns the current version when the number matches', async () => {
    mockResolvedPage({ id: 7, confluence_id: 'page-1', space_key: 'DEV', version: 3, body_html: '<p>current</p>' });
    const r = await app.inject({ method: 'GET', url: '/api/pages/page-1/versions/3' });
    expect(r.statusCode).toBe(200);
    expect(r.json().isCurrent).toBe(true);
    expect(r.json().bodyHtml).toBe('<p>current</p>');
  });

  it('returns a historical version from the tracker', async () => {
    mockResolvedPage({ id: 7, confluence_id: 'page-1', space_key: 'DEV', version: 5 });
    mockGetVersion.mockResolvedValue({
      confluenceId: 'page-1', versionNumber: 2, title: 'v2',
      bodyHtml: '<p>old</p>', bodyText: 'old', syncedAt: new Date('2026-01-15'),
      editedAt: null, author: null, message: null,
    });
    const r = await app.inject({ method: 'GET', url: '/api/pages/page-1/versions/2' });
    expect(r.statusCode).toBe(200);
    expect(r.json().isCurrent).toBe(false);
    expect(r.json().versionNumber).toBe(2);
    expect(mockGetVersion).toHaveBeenCalledWith(7, 2);
  });

  it('404 when the version does not exist', async () => {
    mockResolvedPage({ id: 7, confluence_id: 'page-1', space_key: 'DEV', version: 5 });
    mockGetVersion.mockResolvedValue(null);
    const r = await app.inject({ method: 'GET', url: '/api/pages/page-1/versions/99' });
    expect(r.statusCode).toBe(404);
  });

  it('fetches body lazily when body_html is null for a Confluence page (#722)', async () => {
    mockResolvedPage({ id: 7, confluence_id: 'page-1', space_key: 'DEV', version: 5 });
    mockGetVersion.mockResolvedValue({
      confluenceId: 'page-1', versionNumber: 2, title: 'v2',
      bodyHtml: null, bodyText: null, syncedAt: new Date('2026-01-15'),
      editedAt: null, author: null, message: null,
    });
    const mockClient = {};
    mockGetClientForUser.mockResolvedValue(mockClient);
    mockGetHistoricalBody.mockResolvedValue({ bodyHtml: '<p>fetched</p>', bodyText: 'fetched' });

    const r = await app.inject({ method: 'GET', url: '/api/pages/page-1/versions/2' });
    expect(r.statusCode).toBe(200);
    expect(r.json().bodyHtml).toBe('<p>fetched</p>');
    expect(mockGetHistoricalBody).toHaveBeenCalledWith(7, 'page-1', 2, mockClient);
  });
});

// =============================================================================
// POST /versions/semantic-diff
// =============================================================================

describe('POST /api/pages/:id/versions/semantic-diff', () => {
  let app: ReturnType<typeof Fastify>;
  beforeAll(async () => { app = await buildVersionApp(); });
  afterAll(async () => { await app.close(); });
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
  });

  it('returns a semantic diff between two versions and passes the Confluence client for lazy body resolution (#722/#724)', async () => {
    mockResolvedPage({ id: 7, confluence_id: 'page-1', space_key: 'DEV', version: 3 });
    mockSaveVersionSnapshotByPageId.mockResolvedValue(undefined);
    mockGetSemanticDiff.mockResolvedValue('Section A was updated.');
    const mockClient = {};
    mockGetClientForUser.mockResolvedValue(mockClient);
    const r = await app.inject({ method: 'POST', url: '/api/pages/page-1/versions/semantic-diff', payload: { v1: 1, v2: 2 } });
    expect(r.statusCode).toBe(200);
    expect(r.json().diff).toContain('updated');
    // Combined contract (#718/#725 + #722/#724): with no `model` in the body the
    // route must NOT inject a hardcoded legacy model — it passes `undefined` so
    // getSemanticDiff resolves the `chat` use-case server-side (ADR-021) — AND it
    // forwards the confluenceId + resolved client so backfilled rows resolve.
    expect(mockGetSemanticDiff).toHaveBeenCalledWith(7, 1, 2, undefined, 'page-1', mockClient);
  });

  it('does not force the hardcoded qwen3:32b model when none is supplied', async () => {
    mockResolvedPage({ id: 7, confluence_id: 'page-1', space_key: 'DEV', version: 3 });
    mockSaveVersionSnapshotByPageId.mockResolvedValue(undefined);
    mockGetSemanticDiff.mockResolvedValue('diff');
    await app.inject({ method: 'POST', url: '/api/pages/page-1/versions/semantic-diff', payload: { v1: 1, v2: 2 } });
    const modelArg = mockGetSemanticDiff.mock.calls[0]?.[3];
    expect(modelArg).not.toBe('qwen3:32b');
  });

  it('passes an explicit client-supplied model through as an override', async () => {
    mockResolvedPage({ id: 7, confluence_id: 'page-1', space_key: 'DEV', version: 3 });
    mockSaveVersionSnapshotByPageId.mockResolvedValue(undefined);
    mockGetSemanticDiff.mockResolvedValue('diff');
    const mockClient = {};
    mockGetClientForUser.mockResolvedValue(mockClient);
    const r = await app.inject({ method: 'POST', url: '/api/pages/page-1/versions/semantic-diff', payload: { v1: 1, v2: 2, model: 'custom-model' } });
    expect(r.statusCode).toBe(200);
    // Explicit override forwarded untouched, alongside the lazy-body-resolution args.
    expect(mockGetSemanticDiff).toHaveBeenCalledWith(7, 1, 2, 'custom-model', 'page-1', mockClient);
  });

  it('403 (not 500) when the user lacks access — no service calls', async () => {
    mockResolvedPage({ id: 7, confluence_id: 'page-1', space_key: 'FINANCE', version: 3 });
    const r = await app.inject({ method: 'POST', url: '/api/pages/page-1/versions/semantic-diff', payload: { v1: 1, v2: 2 } });
    expect(r.statusCode).toBe(403);
    expect(mockSaveVersionSnapshotByPageId).not.toHaveBeenCalled();
    expect(mockGetSemanticDiff).not.toHaveBeenCalled();
  });

  it('400 when version numbers are missing', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/pages/page-1/versions/semantic-diff', payload: {} });
    expect(r.statusCode).toBe(400);
  });
});

// =============================================================================
// POST /versions/:version/restore
// =============================================================================

describe('POST /api/pages/:id/versions/:version/restore', () => {
  let app: ReturnType<typeof Fastify>;
  beforeAll(async () => { app = await buildVersionApp(); });
  afterAll(async () => { await app.close(); });
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
    mockHtmlToConfluence.mockReturnValue('<p>storage</p>');
  });

  it('restores a Confluence page, pushes upstream, and emits audit + webhook', async () => {
    mockResolvedPage({ id: 7, confluence_id: 'page-1', space_key: 'DEV', version: 5 });
    mockRestoreVersion.mockResolvedValue({
      pageId: 7, title: 'Old Title', newVersion: 6,
      bodyHtml: '<p>old</p>', bodyText: 'old',
    });
    // Confluence reports version 8 — different from our local bump (6) — to
    // prove the route trusts the API-returned version (defends against drift).
    mockUpdatePage.mockResolvedValue({ version: { number: 8 } });
    mockGetClientForUser.mockResolvedValue({ updatePage: mockUpdatePage });

    const r = await app.inject({ method: 'POST', url: '/api/pages/page-1/versions/2/restore', payload: { version: 5 } });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    // Response reports the API-returned version (8), not the local bump (6).
    expect(body).toMatchObject({ id: 7, version: 8, restoredFrom: 2, source: 'confluence', pushedToConfluence: true });

    expect(mockRestoreVersion).toHaveBeenCalledWith(7, 2);
    // Pushes the PREVIOUS live version (newVersion-1 = 5); client.updatePage bumps internally.
    expect(mockUpdatePage).toHaveBeenCalledWith('page-1', 'Old Title', '<p>storage</p>', 5);
    // On successful push, local body_storage + the API version are persisted and
    // local-edit markers cleared.
    const storageUpdate = mockQueryFn.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('body_storage = $2') && sql.includes('version = $3') && sql.includes('local_modified_at = NULL'),
    );
    expect(storageUpdate).toBeDefined();
    expect((storageUpdate as [string, unknown[]])[1]).toEqual([7, '<p>storage</p>', 8]);
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      TEST_USER, 'PAGE_VERSION_RESTORED', 'page', '7',
      expect.objectContaining({ restoredFrom: 2, newVersion: 8, pushedToConfluence: true }),
      expect.anything(),
    );
    expect(mockEmitWebhookEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'page.updated' }));
  });

  it('restores a standalone page WITHOUT calling Confluence', async () => {
    mockResolvedPage({ id: 20, source: 'standalone', visibility: 'shared', created_by_user_id: TEST_USER, version: 4 });
    mockRestoreVersion.mockResolvedValue({
      pageId: 20, title: 'Local Old', newVersion: 5,
      bodyHtml: '<p>x</p>', bodyText: 'x',
    });

    const r = await app.inject({ method: 'POST', url: '/api/pages/20/versions/1/restore', payload: { version: 4 } });

    expect(r.statusCode).toBe(200);
    expect(r.json().pushedToConfluence).toBe(false);
    expect(mockGetClientForUser).not.toHaveBeenCalled();
    expect(mockEmitWebhookEvent).toHaveBeenCalled();
  });

  it('still succeeds (pushedToConfluence=false) when the Confluence push fails', async () => {
    mockResolvedPage({ id: 7, confluence_id: 'page-1', space_key: 'DEV', version: 5 });
    mockRestoreVersion.mockResolvedValue({
      pageId: 7, title: 'Old', newVersion: 6, bodyHtml: '<p>old</p>', bodyText: 'old',
    });
    mockUpdatePage.mockRejectedValue(new Error('Confluence 500'));
    mockGetClientForUser.mockResolvedValue({ updatePage: mockUpdatePage });

    const r = await app.inject({ method: 'POST', url: '/api/pages/page-1/versions/2/restore', payload: { version: 5 } });
    expect(r.statusCode).toBe(200);
    expect(r.json().pushedToConfluence).toBe(false);
  });

  it('409 when the page advanced past the client-supplied version (optimistic guard)', async () => {
    mockResolvedPage({ id: 7, confluence_id: 'page-1', space_key: 'DEV', version: 6 });
    const r = await app.inject({ method: 'POST', url: '/api/pages/page-1/versions/2/restore', payload: { version: 5 } });
    expect(r.statusCode).toBe(409);
    expect(mockRestoreVersion).not.toHaveBeenCalled();
  });

  it('400 when attempting to restore the current version', async () => {
    mockResolvedPage({ id: 7, confluence_id: 'page-1', space_key: 'DEV', version: 5 });
    const r = await app.inject({ method: 'POST', url: '/api/pages/page-1/versions/5/restore', payload: {} });
    expect(r.statusCode).toBe(400);
    expect(mockRestoreVersion).not.toHaveBeenCalled();
  });

  it('404 when the target snapshot does not exist', async () => {
    mockResolvedPage({ id: 7, confluence_id: 'page-1', space_key: 'DEV', version: 5 });
    mockRestoreVersion.mockResolvedValue(null);
    const r = await app.inject({ method: 'POST', url: '/api/pages/page-1/versions/99/restore', payload: {} });
    expect(r.statusCode).toBe(404);
  });

  it('403 when the user lacks space access — restore is never attempted', async () => {
    mockResolvedPage({ id: 7, confluence_id: 'page-1', space_key: 'SECRET', version: 5 });
    const r = await app.inject({ method: 'POST', url: '/api/pages/page-1/versions/2/restore', payload: {} });
    expect(r.statusCode).toBe(403);
    expect(mockRestoreVersion).not.toHaveBeenCalled();
  });

  it('403 when a non-owner restores a private standalone page', async () => {
    mockResolvedPage({ id: 20, source: 'standalone', visibility: 'private', created_by_user_id: 'other', version: 4 });
    const r = await app.inject({ method: 'POST', url: '/api/pages/20/versions/1/restore', payload: {} });
    expect(r.statusCode).toBe(403);
    expect(mockRestoreVersion).not.toHaveBeenCalled();
  });

  it('404 when the page does not exist', async () => {
    mockQueryFn.mockResolvedValue({ rows: [] });
    const r = await app.inject({ method: 'POST', url: '/api/pages/nope/versions/1/restore', payload: {} });
    expect(r.statusCode).toBe(404);
  });

  it('lazy-fetches the historical body BEFORE restoring when the target row body is NULL (#722/#724 data-loss)', async () => {
    // Page resolution + a target page_versions row whose body_html IS NULL
    // (a backfilled, never-previewed version).
    mockQueryFn.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('confluence_id, space_key, source, visibility, created_by_user_id, version')) {
        return Promise.resolve({ rows: [{ id: 7, confluence_id: 'page-1', space_key: 'DEV', source: 'confluence', visibility: 'shared', created_by_user_id: null, version: 5 }] });
      }
      // The new pre-restore "is the target body NULL?" probe.
      if (typeof sql === 'string' && sql.includes('SELECT body_html FROM page_versions')) {
        return Promise.resolve({ rows: [{ body_html: null }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const mockClient = { updatePage: vi.fn().mockResolvedValue({ version: { number: 7 } }) };
    mockGetClientForUser.mockResolvedValue(mockClient);
    mockGetHistoricalBody.mockResolvedValue({ bodyHtml: '<p>fetched</p>', bodyText: 'fetched' });
    mockRestoreVersion.mockResolvedValue({
      pageId: 7, title: 'Old', newVersion: 6, bodyHtml: '<p>fetched</p>', bodyText: 'fetched',
    });

    const r = await app.inject({ method: 'POST', url: '/api/pages/page-1/versions/2/restore', payload: { version: 5 } });

    expect(r.statusCode).toBe(200);
    // The body was lazily fetched + persisted BEFORE the restore ran.
    expect(mockGetHistoricalBody).toHaveBeenCalledWith(7, 'page-1', 2, mockClient);
    const fetchOrder = mockGetHistoricalBody.mock.invocationCallOrder[0]!;
    const restoreOrder = mockRestoreVersion.mock.invocationCallOrder[0]!;
    expect(fetchOrder).toBeLessThan(restoreOrder);
    expect(mockRestoreVersion).toHaveBeenCalledWith(7, 2);
  });

  it('does NOT lazy-fetch when the target row already has a body', async () => {
    mockQueryFn.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('confluence_id, space_key, source, visibility, created_by_user_id, version')) {
        return Promise.resolve({ rows: [{ id: 7, confluence_id: 'page-1', space_key: 'DEV', source: 'confluence', visibility: 'shared', created_by_user_id: null, version: 5 }] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT body_html FROM page_versions')) {
        return Promise.resolve({ rows: [{ body_html: '<p>already here</p>' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    mockGetClientForUser.mockResolvedValue({ updatePage: vi.fn().mockResolvedValue({ version: { number: 6 } }) });
    mockRestoreVersion.mockResolvedValue({
      pageId: 7, title: 'Old', newVersion: 6, bodyHtml: '<p>already here</p>', bodyText: 'already here',
    });

    const r = await app.inject({ method: 'POST', url: '/api/pages/page-1/versions/2/restore', payload: { version: 5 } });

    expect(r.statusCode).toBe(200);
    expect(mockGetHistoricalBody).not.toHaveBeenCalled();
  });
});
