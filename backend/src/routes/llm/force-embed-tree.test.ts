import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import type * as RedisCache from '../../core/services/redis-cache.js';

const mockGetClientForUser = vi.fn();
const mockEmbedPage = vi.fn();
const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
const mockIsProcessingUser = vi.fn();
const mockIsEmbeddingLocked = vi.fn();

vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../../domains/llm/services/rag-service.js', () => ({
  hybridSearch: vi.fn(),
  buildRagContext: vi.fn(),
}));

vi.mock('../../core/services/content-converter.js', () => ({
  htmlToMarkdown: vi.fn((html: string) => html),
  confluenceToHtml: vi.fn((xhtml: string) => `<p>converted: ${xhtml}</p>`),
  htmlToText: vi.fn((html: string) => html),
}));

vi.mock('../../domains/llm/services/embedding-service.js', () => ({
  getEmbeddingStatus: vi.fn(),
  processDirtyPages: vi.fn(),
  reEmbedAll: vi.fn(),
  embedPage: (...args: unknown[]) => mockEmbedPage(...args),
  isProcessingUser: (...args: unknown[]) => mockIsProcessingUser(...args),
  resetFailedEmbeddings: vi.fn().mockResolvedValue(0),
  // The route resolves the admin chunk options once per tree (#1265) so both
  // embed paths chunk identically.
  getAdminChunkSettings: vi.fn(async () => ({ chunkSize: 500, chunkOverlap: 50 })),
}));

// Only the lock probe behind conflictMessage() is replaced; the rest of the
// module is the real one.
vi.mock('../../core/services/redis-cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisCache>()),
  isEmbeddingLocked: (...args: unknown[]) => mockIsEmbeddingLocked(...args),
}));

const mockIsConfluenceEnabled = vi.fn();
vi.mock('../../domains/confluence/services/sync-service.js', () => ({
  getClientForUser: (...args: unknown[]) => mockGetClientForUser(...args),
}));

vi.mock('../../core/services/confluence-integration.js', () => ({
  isConfluenceEnabled: (...args: unknown[]) => mockIsConfluenceEnabled(...args),
}));

vi.mock('../../domains/llm/services/llm-cache.js', () => {
  class MockLlmCache {
    getCachedResponse = vi.fn().mockResolvedValue(null);
    setCachedResponse = vi.fn();
    acquireLock = vi.fn().mockResolvedValue('llm-lock-token');
    releaseLock = vi.fn().mockResolvedValue(undefined);
    waitForCachedResponse = vi.fn().mockResolvedValue(null);
    clearAll = vi.fn();
  }
  return {
    LlmCache: MockLlmCache,
    buildLlmCacheKey: vi.fn().mockReturnValue('test-cache-key'),
    buildRagCacheKey: vi.fn(),
  };
});

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn(),
}));

vi.mock('../../core/utils/sanitize-llm-input.js', () => ({
  sanitizeLlmInput: vi.fn((input: string) => ({ sanitized: input, warnings: [] })),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { llmEmbeddingRoutes } from './llm-embeddings.js';

/** One local `pages` row as the route's lookups see it, keyed by the Confluence id it carries. */
interface LocalRow {
  confluenceId: string;
  source: 'confluence' | 'standalone';
  trashed: boolean;
  id: number;
  title: string;
  spaceKey: string;
  bodyHtml: string | null;
  contentRevision: string;
}

/** A live Confluence-sourced row; override any column. */
function localRow(confluenceId: string, id: number, overrides: Partial<LocalRow> = {}): LocalRow {
  return {
    confluenceId,
    source: 'confluence',
    trashed: false,
    id,
    title: `Local ${confluenceId}`,
    spaceKey: 'DEV',
    bodyHtml: `<p>LOCAL ${confluenceId}</p>`,
    contentRevision: String(id),
    ...overrides,
  };
}

/**
 * Stands in for the route's `pages` lookups: applies whichever of the
 * `source = 'confluence'`, `deleted_at IS NULL` and `deleted_at IS NOT NULL`
 * predicates the statement carries, as the table would. The predicates
 * themselves are proven on PostgreSQL in force-embed-tree.db.test.ts.
 */
function pagesTable(rows: LocalRow[]) {
  return async (sql: string, params: unknown[]) => {
    const confluenceOnly = /source\s*=\s*'confluence'/.test(sql);
    const liveOnly = /deleted_at\s+IS\s+NULL/i.test(sql);
    const trashedOnly = /deleted_at\s+IS\s+NOT\s+NULL/i.test(sql);
    return {
      rows: rows
        .filter((row) => row.confluenceId === params[0]
          && (!confluenceOnly || row.source === 'confluence')
          && (!liveOnly || !row.trashed)
          && (!trashedOnly || row.trashed))
        .map((row) => ({
          id: row.id,
          title: row.title,
          space_key: row.spaceKey,
          body_html: row.bodyHtml,
          content_revision: row.contentRevision,
        })),
    };
  };
}

interface RemotePage { id: string; title: string; storage: string; listedWithoutStorage?: boolean }

/**
 * Confluence double for one tree, root first. `getPage` answers as Confluence
 * does (body.storage expanded); the descendant listing carries body.storage
 * unless `listedWithoutStorage`.
 */
function confluenceTree(root: RemotePage, ...descendants: RemotePage[]) {
  const pages = new Map([root, ...descendants].map((page) => [page.id, {
    id: page.id,
    title: page.title,
    ancestors: [],
    version: { number: 1, when: '2025-01-01' },
    body: { storage: { value: page.storage } },
  }]));
  return {
    getPage: vi.fn(async (id: string) => pages.get(id)!),
    getDescendantPages: vi.fn(async () => descendants.map((page) => (
      page.listedWithoutStorage ? { ...pages.get(page.id)!, body: undefined } : pages.get(page.id)!
    ))),
  };
}

type SseEvent = Record<string, unknown>;

/** The per-page progress events: embedding phase, naming a page. */
function pageEvents(events: SseEvent[]): SseEvent[] {
  return events.filter((event) => event.phase === 'embedding' && 'currentPage' in event);
}

describe('POST /api/embeddings/force-embed-tree', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.decorate('authenticate', async () => {});
    app.decorate('requireAdmin', async () => {});
    app.decorate('redis', {});
    app.decorateRequest('userId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = 'test-user-123';
    });

    await app.register(llmEmbeddingRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
    // Default: the integration is on, which is what every case below assumes.
    mockIsConfluenceEnabled.mockResolvedValue(true);
    // Default: no embedding run holds the caller's lock or the reembed-all lock.
    mockIsProcessingUser.mockResolvedValue(false);
    mockIsEmbeddingLocked.mockResolvedValue(false);
  });

  async function forceEmbed(pageId = 'root-1') {
    const response = await app.inject({
      method: 'POST',
      url: '/api/embeddings/force-embed-tree',
      payload: { pageId },
    });
    const events: SseEvent[] = response.body.split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)));
    return { response, events };
  }

  it('should return 400 when Confluence credentials are not configured', async () => {
    mockGetClientForUser.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: '/api/embeddings/force-embed-tree',
      payload: { pageId: 'page-123' },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.message).toContain('Confluence credentials not configured');
  });

  // #1623 — the route walks the REMOTE tree, so with the integration off it
  // refuses by naming the integration rather than asking for credentials that
  // are still stored.
  it('should return 400 naming the disabled integration when Confluence is off', async () => {
    mockIsConfluenceEnabled.mockResolvedValue(false);

    const response = await app.inject({
      method: 'POST',
      url: '/api/embeddings/force-embed-tree',
      payload: { pageId: 'page-123' },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.message).toBe('Confluence integration is disabled');
    expect(body.message).not.toContain('credentials');
    expect(mockGetClientForUser).not.toHaveBeenCalled();
  });

  it('should reject request when pageId is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/embeddings/force-embed-tree',
      payload: {},
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('should stream SSE progress for a page with descendants', async () => {
    const mockClient = {
      getPage: vi.fn().mockResolvedValue({
        id: 'root-1',
        title: 'Root Page',
        body: { storage: { value: '<p>Root content</p>' } },
        ancestors: [{ id: 'space-home', title: 'Space Home' }],
        version: { number: 1, when: '2025-01-01' },
      }),
      getDescendantPages: vi.fn().mockResolvedValue([
        {
          id: 'child-1',
          title: 'Child Page 1',
          body: { storage: { value: '<p>Child 1</p>' } },
          ancestors: [{ id: 'root-1', title: 'Root Page' }],
          version: { number: 1, when: '2025-01-01' },
        },
      ]),
    };

    mockGetClientForUser.mockResolvedValue(mockClient);
    mockEmbedPage.mockResolvedValue(5);

    // Mock DB query for pages lookup (includes id for embedPage integer param)
    mockQuery.mockResolvedValue({
      rows: [{ id: 101, title: 'Cached title', space_key: 'DEV', body_html: '<p>cached content</p>', content_revision: '7' }],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/embeddings/force-embed-tree',
      payload: { pageId: 'root-1' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');

    // Parse SSE events
    const lines = response.body.split('\n').filter((l: string) => l.startsWith('data: '));
    expect(lines.length).toBeGreaterThanOrEqual(3); // discovering + embedding progress + complete

    const events = lines.map((l: string) => JSON.parse(l.replace('data: ', '')));

    // First event should be discovering
    expect(events[0].phase).toBe('discovering');

    // Should include an embedding phase event
    const embeddingEvents = events.filter((e: { phase: string }) => e.phase === 'embedding');
    expect(embeddingEvents.length).toBeGreaterThanOrEqual(1);
    expect(embeddingEvents[0].total).toBe(2); // root + 1 child

    // Last event should be complete
    const lastEvent = events[events.length - 1];
    expect(lastEvent.phase).toBe('complete');
    expect(lastEvent.done).toBe(true);
    expect(lastEvent.total).toBe(2);
    expect(lastEvent.completed).toBe(2);
    expect(mockEmbedPage).toHaveBeenCalledWith(
      expect.any(String), 101, 'Cached title', 'DEV', '<p>cached content</p>',
      expect.objectContaining({ contentRevision: '7' }),
    );

    // Confluence is discovery only (#1717): the root getPage is the one page
    // fetch, whatever the descendant listing carried.
    expect(mockClient.getPage).toHaveBeenCalledTimes(1);
    expect(mockClient.getPage).toHaveBeenCalledWith('root-1');
  });

  it('should handle per-page embedding errors gracefully', async () => {
    const mockClient = {
      getPage: vi.fn().mockResolvedValue({
        id: 'root-1',
        title: 'Root Page',
        body: { storage: { value: '<p>Root content</p>' } },
        ancestors: [],
        version: { number: 1, when: '2025-01-01' },
      }),
      getDescendantPages: vi.fn().mockResolvedValue([
        {
          id: 'child-1',
          title: 'Failing Child',
          body: { storage: { value: '<p>Child 1</p>' } },
          ancestors: [],
          version: { number: 1, when: '2025-01-01' },
        },
      ]),
    };

    mockGetClientForUser.mockResolvedValue(mockClient);

    // First embedPage call succeeds, second fails
    mockEmbedPage
      .mockResolvedValueOnce(5)
      .mockRejectedValueOnce(new Error('Embedding failed'));

    mockQuery.mockResolvedValue({
      rows: [{ id: 101, title: 'Cached title', space_key: 'DEV', body_html: '<p>cached</p>', content_revision: '7' }],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/embeddings/force-embed-tree',
      payload: { pageId: 'root-1' },
    });

    expect(response.statusCode).toBe(200);

    const lines = response.body.split('\n').filter((l: string) => l.startsWith('data: '));
    const events = lines.map((l: string) => JSON.parse(l.replace('data: ', '')));

    const lastEvent = events[events.length - 1];
    expect(lastEvent.phase).toBe('complete');
    expect(lastEvent.errors).toBe(1);
    expect(lastEvent.completed).toBe(2); // Both counted as completed
  });

  it('should skip a page not in local DB (not yet synced) with a warning SSE event', async () => {
    const mockClient = {
      getPage: vi.fn().mockResolvedValue({
        id: 'unsynced-1',
        title: 'Unsynced Page',
        body: { storage: { value: '<p>Unsynced content</p>' } },
        ancestors: [],
        version: { number: 1, when: '2025-01-01' },
      }),
      getDescendantPages: vi.fn().mockResolvedValue([]),
    };

    mockGetClientForUser.mockResolvedValue(mockClient);

    // DB query returns empty rows (page not yet synced to local DB)
    mockQuery.mockResolvedValue({ rows: [] });

    const response = await app.inject({
      method: 'POST',
      url: '/api/embeddings/force-embed-tree',
      payload: { pageId: 'unsynced-1' },
    });

    expect(response.statusCode).toBe(200);

    // embedPage should NOT have been called
    expect(mockEmbedPage).not.toHaveBeenCalled();

    const lines = response.body.split('\n').filter((l: string) => l.startsWith('data: '));
    const events = lines.map((l: string) => JSON.parse(l.replace('data: ', '')));

    // Should have a warning event for the skipped page
    const warningEvents = events.filter((e: { warning?: string }) => e.warning);
    expect(warningEvents.length).toBeGreaterThanOrEqual(1);
    expect(warningEvents[0].warning).toContain('not yet synced');

    // Final event should be complete with 1 completed (counted even though skipped)
    const lastEvent = events[events.length - 1];
    expect(lastEvent.phase).toBe('complete');
    expect(lastEvent.total).toBe(1);
    expect(lastEvent.completed).toBe(1);
    expect(lastEvent.errors).toBe(0);
  });

  it('should embed a single page (no children) successfully', async () => {
    const mockClient = {
      getPage: vi.fn().mockResolvedValue({
        id: 'leaf-1',
        title: 'Leaf Page',
        body: { storage: { value: '<p>Leaf content</p>' } },
        ancestors: [],
        version: { number: 1, when: '2025-01-01' },
      }),
      getDescendantPages: vi.fn().mockResolvedValue([]),
    };

    mockGetClientForUser.mockResolvedValue(mockClient);
    mockEmbedPage.mockResolvedValue(3);

    mockQuery.mockResolvedValue({
      rows: [{ id: 101, title: 'Leaf Page', space_key: 'DEV', body_html: '<p>leaf</p>', content_revision: '7' }],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/embeddings/force-embed-tree',
      payload: { pageId: 'leaf-1' },
    });

    expect(response.statusCode).toBe(200);

    const lines = response.body.split('\n').filter((l: string) => l.startsWith('data: '));
    const events = lines.map((l: string) => JSON.parse(l.replace('data: ', '')));

    const lastEvent = events[events.length - 1];
    expect(lastEvent.phase).toBe('complete');
    expect(lastEvent.total).toBe(1);
    expect(lastEvent.completed).toBe(1);
    expect(lastEvent.errors).toBe(0);
  });

  describe('local rows only, Confluence for discovery (#1717)', () => {
    const ROOT: RemotePage = { id: 'root-1', title: 'Root', storage: '<p>REMOTE root</p>' };

    it('makes no getPage call beyond the root, even for a descendant listed without body.storage', async () => {
      const client = confluenceTree(
        ROOT,
        { id: 'child-1', title: 'Listed with storage', storage: '<p>REMOTE child-1</p>' },
        { id: 'child-2', title: 'Listed without storage', storage: '<p>REMOTE child-2</p>', listedWithoutStorage: true },
      );
      mockGetClientForUser.mockResolvedValue(client);
      mockQuery.mockImplementation(pagesTable([localRow('root-1', 101), localRow('child-1', 102), localRow('child-2', 103)]));
      mockEmbedPage.mockResolvedValue(4);

      const { response, events } = await forceEmbed();

      expect(response.statusCode).toBe(200);
      expect(client.getPage.mock.calls).toEqual([['root-1']]);
      expect(client.getDescendantPages.mock.calls).toEqual([['root-1']]);
      expect(mockEmbedPage.mock.calls.map((call) => call[1])).toEqual([101, 102, 103]);
      expect(events.at(-1)).toMatchObject({ phase: 'complete', total: 3, completed: 3, errors: 0 });
    });

    it('hands embedPage the live local row (id, title, space_key, body_html, content_revision), never the remote body', async () => {
      mockGetClientForUser.mockResolvedValue(confluenceTree(
        { id: 'root-1', title: 'Remote root title', storage: '<p>REMOTE root body</p>' },
        { id: 'child-1', title: 'Remote child title', storage: '' },
      ));
      mockQuery.mockImplementation(pagesTable([
        localRow('root-1', 101, { title: 'Local root', spaceKey: 'DEV', bodyHtml: '<p>LOCAL root body</p>', contentRevision: '11' }),
        localRow('child-1', 102, { title: 'Local child', spaceKey: 'OPS', bodyHtml: '<p>LOCAL child body</p>', contentRevision: '12' }),
      ]));
      mockEmbedPage.mockResolvedValue(2);

      await forceEmbed();

      expect(mockEmbedPage.mock.calls).toEqual([
        ['test-user-123', 101, 'Local root', 'DEV', '<p>LOCAL root body</p>', { chunkSize: 500, chunkOverlap: 50, contentRevision: '11' }],
        ['test-user-123', 102, 'Local child', 'OPS', '<p>LOCAL child body</p>', { chunkSize: 500, chunkOverlap: 50, contentRevision: '12' }],
      ]);
      expect(JSON.stringify(mockEmbedPage.mock.calls)).not.toContain('REMOTE');
    });

    it('skips a discovered page whose local row is in the trash with one trash-warning event', async () => {
      mockGetClientForUser.mockResolvedValue(confluenceTree(
        ROOT,
        { id: 'trashed-1', title: 'Trashed child', storage: '<p>REMOTE trashed</p>' },
      ));
      mockQuery.mockImplementation(pagesTable([localRow('root-1', 101), localRow('trashed-1', 102, { trashed: true })]));
      mockEmbedPage.mockResolvedValue(3);

      const { events } = await forceEmbed();

      expect(mockEmbedPage.mock.calls.map((call) => call[1])).toEqual([101]);
      expect(pageEvents(events).filter((event) => event.currentPage === 'Trashed child')).toEqual([{
        phase: 'embedding',
        total: 2,
        completed: 2,
        errors: 0,
        currentPage: 'Trashed child',
        warning: 'Page is in the trash, skipping',
        done: false,
      }]);
      expect(events.at(-1)).toMatchObject({ phase: 'complete', total: 2, completed: 2, errors: 0 });
    });

    it('treats a standalone row carrying the historical confluence_id as not yet synced, trashed or not', async () => {
      mockGetClientForUser.mockResolvedValue(confluenceTree(
        ROOT,
        { id: 'moved-1', title: 'Moved to local', storage: '<p>REMOTE moved-1</p>' },
        { id: 'moved-2', title: 'Moved then trashed', storage: '<p>REMOTE moved-2</p>' },
      ));
      mockQuery.mockImplementation(pagesTable([
        localRow('root-1', 101),
        localRow('moved-1', 102, { source: 'standalone' }),
        localRow('moved-2', 103, { source: 'standalone', trashed: true }),
      ]));
      mockEmbedPage.mockResolvedValue(3);

      const { events } = await forceEmbed();

      expect(mockEmbedPage.mock.calls.map((call) => call[1])).toEqual([101]);
      expect(pageEvents(events).slice(1).map(({ currentPage, warning }) => ({ currentPage, warning }))).toEqual([
        { currentPage: 'Moved to local', warning: 'Page not yet synced to local DB, skipping' },
        { currentPage: 'Moved then trashed', warning: 'Page not yet synced to local DB, skipping' },
      ]);
    });

    it('emits exactly one event per discovered page and completes with completed === total on every branch', async () => {
      mockGetClientForUser.mockResolvedValue(confluenceTree(
        { id: 'p1', title: 'Embedded', storage: '<p>REMOTE</p>' },
        { id: 'p2', title: 'Nothing published', storage: '<p>REMOTE</p>' },
        { id: 'p3', title: 'No cached body', storage: '<p>REMOTE</p>' },
        { id: 'p4', title: 'Trashed', storage: '<p>REMOTE</p>' },
        { id: 'p5', title: 'Not synced', storage: '<p>REMOTE</p>' },
        { id: 'p6', title: 'Failing', storage: '<p>REMOTE</p>' },
      ));
      mockQuery.mockImplementation(pagesTable([
        localRow('p1', 101),
        localRow('p2', 102),
        localRow('p3', 103, { bodyHtml: null }),
        localRow('p4', 104, { trashed: true }),
        localRow('p6', 106),
      ]));
      mockEmbedPage.mockImplementation(async (_userId: string, id: number) => {
        if (id === 106) throw new Error('Embedding failed');
        return id === 102 ? 0 : 5;
      });

      const { events } = await forceEmbed('p1');

      expect(pageEvents(events).map(({ currentPage, completed, errors, warning }) => ({ currentPage, completed, errors, warning }))).toEqual([
        { currentPage: 'Embedded', completed: 1, errors: 0, warning: undefined },
        { currentPage: 'Nothing published', completed: 2, errors: 0, warning: 'No new embeddings published (blocked, deferred, or no work)' },
        { currentPage: 'No cached body', completed: 3, errors: 0, warning: 'Page has no cached body, skipping (sync first)' },
        { currentPage: 'Trashed', completed: 4, errors: 0, warning: 'Page is in the trash, skipping' },
        { currentPage: 'Not synced', completed: 5, errors: 0, warning: 'Page not yet synced to local DB, skipping' },
        { currentPage: 'Failing', completed: 6, errors: 1, warning: undefined },
      ]);
      expect(events.at(-1)).toEqual({ phase: 'complete', total: 6, completed: 6, errors: 1, done: true });
    });
  });

  describe('per-user embedding lock (#1717)', () => {
    it.each([
      { lock: "the caller's own", reembedAll: false, message: 'Embedding processing is already in progress for this user' },
      {
        lock: 'the reembed-all',
        reembedAll: true,
        message: 'A global re-embed is in progress — per-user triggers are temporarily disabled. Try again in a few minutes.',
      },
    ])('answers 409 with conflictMessage() before any SSE byte while $lock lock is held', async ({ reembedAll, message }) => {
      const client = confluenceTree({ id: 'root-1', title: 'Root', storage: '<p>REMOTE root</p>' });
      mockGetClientForUser.mockResolvedValue(client);
      // Busy for the caller only: checking any other id would let the run start.
      mockIsProcessingUser.mockImplementation(async (userId: string) => userId === 'test-user-123');
      mockIsEmbeddingLocked.mockImplementation(async (lockUser: string) => reembedAll && lockUser === '__reembed_all__');

      const { response } = await forceEmbed();

      expect(response.statusCode).toBe(409);
      expect(response.headers['content-type']).not.toContain('text/event-stream');
      expect(response.json()).toMatchObject({ message });
      expect(client.getPage).not.toHaveBeenCalled();
      expect(client.getDescendantPages).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockEmbedPage).not.toHaveBeenCalled();
    });

    it('streams as before when only another user is processing', async () => {
      mockGetClientForUser.mockResolvedValue(confluenceTree({ id: 'root-1', title: 'Root', storage: '<p>REMOTE root</p>' }));
      mockQuery.mockImplementation(pagesTable([localRow('root-1', 101)]));
      mockEmbedPage.mockResolvedValue(3);
      mockIsProcessingUser.mockImplementation(async (userId: string) => userId !== 'test-user-123');

      const { response, events } = await forceEmbed();

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/event-stream');
      expect(events.at(-1)).toMatchObject({ phase: 'complete', total: 1, completed: 1, errors: 0 });
    });

    it.each([
      { refusal: 'integration-disabled', enabled: false, message: 'Confluence integration is disabled' },
      { refusal: 'missing-credentials', enabled: true, message: 'Confluence credentials not configured' },
    ])('still answers the $refusal 400 first, whatever the lock says', async ({ enabled, message }) => {
      mockIsConfluenceEnabled.mockResolvedValue(enabled);
      mockGetClientForUser.mockResolvedValue(null);
      mockIsProcessingUser.mockResolvedValue(true);

      const { response } = await forceEmbed();

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ message });
      expect(mockIsProcessingUser).not.toHaveBeenCalled();
    });
  });
});
