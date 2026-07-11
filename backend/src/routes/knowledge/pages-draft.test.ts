import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { pagesCrudRoutes } from './pages-crud.js';

const mockQuery = vi.fn();
const mockTxQuery = vi.fn();
const mockTxClient = { query: (...args: unknown[]) => mockTxQuery(...args), release: vi.fn() };
const mockGetClientForUser = vi.fn();
const mockHtmlToConfluence = vi.fn().mockReturnValue('<p>storage</p>');
const mockConfluenceToHtml = vi.fn().mockReturnValue('<p>converted</p>');
const mockHtmlToText = vi.fn().mockReturnValue('plain text');
const mockLogAuditEvent = vi.fn();

vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  getPool: () => ({ connect: () => Promise.resolve(mockTxClient) }),
}));

vi.mock('../../domains/confluence/services/sync-service.js', () => ({
  getClientForUser: (...args: unknown[]) => mockGetClientForUser(...args),
}));

const mockGetUserAccessibleSpaces = vi.fn();
vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: (...args: unknown[]) => mockGetUserAccessibleSpaces(...args),
}));

vi.mock('../../core/services/content-converter.js', () => ({
  confluenceToHtml: (...args: unknown[]) => mockConfluenceToHtml(...args),
  htmlToConfluence: (...args: unknown[]) => mockHtmlToConfluence(...args),
  htmlToText: (...args: unknown[]) => mockHtmlToText(...args),
}));

const mockCacheInvalidate = vi.fn();
const mockCacheInvalidateAcrossUsers = vi.fn();

vi.mock('../../core/services/redis-cache.js', () => ({
  RedisCache: class MockRedisCache {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue(undefined);
    invalidate = (...args: unknown[]) => mockCacheInvalidate(...args);
    // Publishing a draft to a shared/Confluence page clears every user's cache (#893).
    invalidateAcrossUsers = (...args: unknown[]) => mockCacheInvalidateAcrossUsers(...args);
  },
}));

vi.mock('../../domains/confluence/services/attachment-handler.js', () => ({
  cleanPageAttachments: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
}));

vi.mock('../../domains/knowledge/services/duplicate-detector.js', () => ({
  findDuplicates: vi.fn().mockResolvedValue([]),
  scanAllDuplicates: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../domains/knowledge/services/auto-tagger.js', () => ({
  autoTagPage: vi.fn().mockResolvedValue({ tags: [] }),
  applyTags: vi.fn().mockResolvedValue([]),
  autoTagAllPages: vi.fn().mockResolvedValue(undefined),
  ALLOWED_TAGS: ['architecture', 'howto', 'troubleshooting'],
}));

vi.mock('../../domains/knowledge/services/version-tracker.js', () => ({
  getVersionHistory: vi.fn().mockResolvedValue([]),
  getVersion: vi.fn().mockResolvedValue(null),
  getSemanticDiff: vi.fn().mockResolvedValue(''),
  saveVersionSnapshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../domains/llm/services/embedding-service.js', () => ({
  processDirtyPages: vi.fn().mockResolvedValue({ processed: 0, errors: 0 }),
  isProcessingUser: vi.fn().mockResolvedValue(false),
  computePageRelationships: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const TEST_USER = 'user-1';
const OTHER_USER = 'user-2';

describe('Draft-while-published routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = TEST_USER;
    });
    app.decorate('requireAdmin', async () => {});
    app.decorate('redis', {});
    app.decorateRequest('userId', '');

    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', details: error.errors });
      }
      const statusCode = error.statusCode ?? 500;
      return reply.status(statusCode).send({ error: error.message });
    });

    await app.register(pagesCrudRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockHtmlToText.mockReturnValue('plain text');
    mockHtmlToConfluence.mockReturnValue('<p>storage</p>');
    // Default: user can reach DEV/OPS. Confluence-branch tests override per case.
    mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);
  });

  // ---------- PUT /api/pages/:id/draft ----------

  describe('PUT /api/pages/:id/draft', () => {
    it('saves a draft for a standalone page owned by the user', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, source')) {
          return Promise.resolve({
            rows: [{
              id: 10, source: 'standalone', created_by_user_id: TEST_USER,
              visibility: 'private', deleted_at: null,
            }],
          });
        }
        // UPDATE
        return Promise.resolve({ rows: [], rowCount: 1 });
      });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/10/draft',
        payload: { title: 'Test Page', bodyHtml: '<p>draft content</p>' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(10);
      expect(body.hasDraft).toBe(true);
      expect(body.draftUpdatedAt).toBeDefined();
    });

    it('saves a draft for a shared standalone page by non-owner', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, source')) {
          return Promise.resolve({
            rows: [{
              id: 10, source: 'standalone', created_by_user_id: OTHER_USER,
              visibility: 'shared', deleted_at: null,
            }],
          });
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/10/draft',
        payload: { title: 'Test Page', bodyHtml: '<p>draft by another user</p>' },
      });

      expect(response.statusCode).toBe(200);
    });

    it('returns 403 for a private standalone page not owned by the user', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, source')) {
          return Promise.resolve({
            rows: [{
              id: 10, source: 'standalone', created_by_user_id: OTHER_USER,
              visibility: 'private', deleted_at: null,
            }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/10/draft',
        payload: { title: 'Sneaky Title', bodyHtml: '<p>sneaky draft</p>' },
      });

      expect(response.statusCode).toBe(403);
    });

    it('returns 404 for a nonexistent page', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/999/draft',
        payload: { title: 'Draft Title', bodyHtml: '<p>draft</p>' },
      });

      expect(response.statusCode).toBe(404);
    });

    it('validates the request body (empty bodyHtml)', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/10/draft',
        payload: { bodyHtml: '' },
      });

      // Zod validation: bodyHtml must be min(1)
      expect(response.statusCode).toBe(400);
    });
  });

  // ---------- GET /api/pages/:id/draft ----------

  describe('GET /api/pages/:id/draft', () => {
    it('returns draft content when a draft exists', async () => {
      mockQuery.mockResolvedValue({
        rows: [{
          id: 10, source: 'standalone', created_by_user_id: TEST_USER,
          visibility: 'private', draft_body_html: '<p>my draft</p>',
          draft_body_text: 'my draft', draft_updated_at: new Date('2026-01-01'),
          draft_updated_by: TEST_USER,
        }],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/10/draft',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.bodyHtml).toBe('<p>my draft</p>');
      expect(body.bodyText).toBe('my draft');
      expect(body.updatedBy).toBe(TEST_USER);
    });

    it('returns 404 when no draft exists', async () => {
      mockQuery.mockResolvedValue({
        rows: [{
          id: 10, source: 'standalone', created_by_user_id: TEST_USER,
          visibility: 'private', draft_body_html: null,
          draft_body_text: null, draft_updated_at: null,
          draft_updated_by: null,
        }],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/10/draft',
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 404 for a private page not owned by the user', async () => {
      mockQuery.mockResolvedValue({
        rows: [{
          id: 10, source: 'standalone', created_by_user_id: OTHER_USER,
          visibility: 'private', draft_body_html: '<p>secret draft</p>',
          draft_body_text: 'secret', draft_updated_at: new Date(),
          draft_updated_by: OTHER_USER,
        }],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/10/draft',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // ---------- POST /api/pages/:id/draft/publish ----------

  describe('POST /api/pages/:id/draft/publish', () => {
    it('publishes a draft: saves version, swaps content, clears draft', async () => {
      const txCalls: string[] = [];
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, version, title')) {
          return Promise.resolve({
            rows: [{
              id: 10, version: 3, title: 'My Article',
              body_html: '<p>live content</p>', body_text: 'live content',
              body_storage: null, source: 'standalone',
              created_by_user_id: TEST_USER, visibility: 'private',
              confluence_id: null, draft_body_html: '<p>draft content</p>',
              draft_body_storage: null,
            }],
          });
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      });
      mockTxQuery.mockImplementation((sql: string) => {
        txCalls.push(sql.trim().substring(0, 30));
        return Promise.resolve({ rows: [], rowCount: 1 });
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/10/draft/publish',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(10);
      expect(body.version).toBe(4);
      expect(body.published).toBe(true);

      // Verify transaction on dedicated client: BEGIN, INSERT, UPDATE, COMMIT
      expect(txCalls).toContain('BEGIN');
      expect(txCalls.some(c => c.includes('INSERT INTO page_version'))).toBe(true);
      expect(txCalls.some(c => c.includes('UPDATE pages SET'))).toBe(true);
      expect(txCalls).toContain('COMMIT');
      expect(mockTxClient.release).toHaveBeenCalled();
    });

    it('returns 400 when no draft exists', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, version, title')) {
          return Promise.resolve({
            rows: [{
              id: 10, version: 3, title: 'My Article',
              body_html: '<p>live</p>', body_text: 'live',
              body_storage: null, source: 'standalone',
              created_by_user_id: TEST_USER, visibility: 'private',
              confluence_id: null, draft_body_html: null,
              draft_body_storage: null,
            }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/10/draft/publish',
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 403 for a private page not owned by the user', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, version, title')) {
          return Promise.resolve({
            rows: [{
              id: 10, version: 3, title: 'Secret Article',
              body_html: '<p>live</p>', body_text: 'live',
              body_storage: null, source: 'standalone',
              created_by_user_id: OTHER_USER, visibility: 'private',
              confluence_id: null, draft_body_html: '<p>draft</p>',
              draft_body_storage: null,
            }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/10/draft/publish',
      });

      expect(response.statusCode).toBe(403);
    });

    it('rolls back on transaction failure', async () => {
      let insertCalled = false;
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, version, title')) {
          return Promise.resolve({
            rows: [{
              id: 10, version: 3, title: 'My Article',
              body_html: '<p>live</p>', body_text: 'live',
              body_storage: null, source: 'standalone',
              created_by_user_id: TEST_USER, visibility: 'private',
              confluence_id: null, draft_body_html: '<p>draft</p>',
              draft_body_storage: null,
            }],
          });
        }
        return Promise.resolve({ rows: [] });
      });
      mockTxQuery.mockImplementation((sql: string) => {
        if (sql === 'BEGIN') return Promise.resolve({ rows: [] });
        if (sql.includes('INSERT INTO page_versions')) {
          insertCalled = true;
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('UPDATE pages SET') && insertCalled) {
          return Promise.reject(new Error('simulated DB error'));
        }
        if (sql === 'ROLLBACK') return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [] });
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/10/draft/publish',
      });

      expect(response.statusCode).toBe(500);
      expect(mockTxQuery).toHaveBeenCalledWith('ROLLBACK');
      expect(mockTxClient.release).toHaveBeenCalled();
    });

    it('pushes to Confluence for confluence-sourced pages (best-effort)', async () => {
      const mockUpdatePage = vi.fn().mockResolvedValue({
        version: { number: 5 },
        body: { storage: { value: '<p>updated</p>' } },
      });
      mockGetClientForUser.mockResolvedValue({ updatePage: mockUpdatePage });

      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, version, title')) {
          return Promise.resolve({
            rows: [{
              id: 10, version: 3, title: 'Confluence Article',
              body_html: '<p>live</p>', body_text: 'live',
              body_storage: '<p>storage</p>', source: 'confluence',
              created_by_user_id: null, visibility: 'shared',
              confluence_id: 'conf-123', space_key: 'DEV',
              draft_body_html: '<p>draft</p>',
              draft_body_storage: null,
            }],
          });
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      });
      mockTxQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/10/draft/publish',
      });

      expect(response.statusCode).toBe(200);
      expect(mockHtmlToConfluence).toHaveBeenCalledWith('<p>draft</p>');
      // updatePage() increments internally, so it must receive the *previous*
      // live version (page.version = 3), not page.version + 1 (4). Passing 4
      // makes Confluence receive version 5 while it holds 3 → silent 409 (#863).
      expect(mockUpdatePage).toHaveBeenCalledWith('conf-123', 'Confluence Article', '<p>storage</p>', 3);
      // Trust the API-returned version (5) over the local bump (4)
      expect(response.json().version).toBe(5);
      // The API version is persisted back so local `version` can't drift
      const persistCall = mockQuery.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('version = $3') && c[0].includes('last_synced'),
      );
      expect(persistCall).toBeDefined();
      expect(persistCall![1]).toEqual([10, '<p>storage</p>', 5]);
    });

    // #893 review follow-up: publishing a draft writes new live content — the
    // same mutation class as PUT /pages/:id — so shared/Confluence pages must
    // clear every user's cached lists/trees, not just the publisher's.
    describe('cache invalidation (#893)', () => {
      function mockPublishablePage(overrides: Record<string, unknown> = {}) {
        mockQuery.mockImplementation((sql: string) => {
          if (sql.includes('SELECT id, version, title')) {
            return Promise.resolve({
              rows: [{
                id: 10, version: 3, title: 'My Article',
                body_html: '<p>live</p>', body_text: 'live',
                body_storage: null, source: 'standalone',
                created_by_user_id: TEST_USER, visibility: 'private',
                confluence_id: null, space_key: null,
                draft_body_html: '<p>draft</p>', draft_body_storage: null,
                ...overrides,
              }],
            });
          }
          return Promise.resolve({ rows: [], rowCount: 1 });
        });
        mockTxQuery.mockResolvedValue({ rows: [], rowCount: 1 });
      }

      it('invalidates the pages cache across all users when publishing on a Confluence page', async () => {
        mockGetClientForUser.mockResolvedValue({ updatePage: vi.fn().mockResolvedValue({}) });
        mockPublishablePage({
          source: 'confluence', created_by_user_id: null, visibility: 'shared',
          confluence_id: 'conf-123', space_key: 'DEV', body_storage: '<p>storage</p>',
        });

        const response = await app.inject({
          method: 'POST',
          url: '/api/pages/10/draft/publish',
        });

        expect(response.statusCode).toBe(200);
        expect(mockCacheInvalidateAcrossUsers).toHaveBeenCalledWith('pages');
        expect(mockCacheInvalidate).not.toHaveBeenCalledWith(TEST_USER, 'pages');
      });

      it('invalidates across users when publishing on a shared standalone page', async () => {
        mockPublishablePage({ visibility: 'shared' });

        const response = await app.inject({
          method: 'POST',
          url: '/api/pages/10/draft/publish',
        });

        expect(response.statusCode).toBe(200);
        expect(mockCacheInvalidateAcrossUsers).toHaveBeenCalledWith('pages');
      });

      it('keeps per-user invalidation when publishing on a private standalone page', async () => {
        mockPublishablePage();

        const response = await app.inject({
          method: 'POST',
          url: '/api/pages/10/draft/publish',
        });

        expect(response.statusCode).toBe(200);
        expect(mockCacheInvalidateAcrossUsers).not.toHaveBeenCalled();
        expect(mockCacheInvalidate).toHaveBeenCalledWith(TEST_USER, 'pages');
      });
    });
  });

  // ---------- DELETE /api/pages/:id/draft ----------

  describe('DELETE /api/pages/:id/draft', () => {
    it('discards the draft and clears all draft columns', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, source')) {
          return Promise.resolve({
            rows: [{
              id: 10, source: 'standalone', created_by_user_id: TEST_USER,
              visibility: 'private',
            }],
          });
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/pages/10/draft',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(10);
      expect(body.hasDraft).toBe(false);

      // Verify the UPDATE nullifies all draft columns
      const updateCall = mockQuery.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('draft_body_html = NULL'),
      );
      expect(updateCall).toBeDefined();
    });

    it('returns 404 for a nonexistent page', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/pages/999/draft',
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 403 for a private page not owned by the user', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, source')) {
          return Promise.resolve({
            rows: [{
              id: 10, source: 'standalone', created_by_user_id: OTHER_USER,
              visibility: 'private',
            }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/pages/10/draft',
      });

      expect(response.statusCode).toBe(403);
    });
  });

  // ---------- GET /api/pages/:id includes hasDraft ----------

  describe('GET /api/pages/:id (draft fields)', () => {
    it('includes hasDraft=true and draftUpdatedAt when a draft exists', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('cp.id, cp.confluence_id')) {
          return Promise.resolve({
            rows: [{
              id: 10, confluence_id: null, space_key: null,
              title: 'Test Page', body_storage: '', body_html: '<p>live</p>',
              body_text: 'live', version: 2, parent_id: null,
              labels: [], author: null, last_modified_at: null,
              last_synced: new Date(), embedding_dirty: false,
              embedding_status: 'embedded', embedded_at: null,
              embedding_error: null, has_children: false,
              quality_score: null, quality_status: null,
              quality_completeness: null, quality_clarity: null,
              quality_structure: null, quality_accuracy: null,
              quality_readability: null, quality_summary: null,
              quality_analyzed_at: null, quality_error: null,
              summary_html: null, summary_status: 'pending',
              summary_generated_at: null, summary_model: null,
              summary_error: null,
              source: 'standalone', visibility: 'shared',
              created_by_user_id: TEST_USER,
              has_draft: true,
              draft_updated_at: new Date('2026-03-01T12:00:00Z'),
            }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/10',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.hasDraft).toBe(true);
      expect(body.draftUpdatedAt).toBe('2026-03-01T12:00:00.000Z');
    });

    it('includes hasDraft=false when no draft exists', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('cp.id, cp.confluence_id')) {
          return Promise.resolve({
            rows: [{
              id: 10, confluence_id: null, space_key: null,
              title: 'Test Page', body_storage: '', body_html: '<p>live</p>',
              body_text: 'live', version: 2, parent_id: null,
              labels: [], author: null, last_modified_at: null,
              last_synced: new Date(), embedding_dirty: false,
              embedding_status: 'embedded', embedded_at: null,
              embedding_error: null, has_children: false,
              quality_score: null, quality_status: null,
              quality_completeness: null, quality_clarity: null,
              quality_structure: null, quality_accuracy: null,
              quality_readability: null, quality_summary: null,
              quality_analyzed_at: null, quality_error: null,
              summary_html: null, summary_status: 'pending',
              summary_generated_at: null, summary_model: null,
              summary_error: null,
              source: 'standalone', visibility: 'shared',
              created_by_user_id: TEST_USER,
              has_draft: false,
              draft_updated_at: null,
            }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/10',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.hasDraft).toBe(false);
      expect(body.draftUpdatedAt).toBeNull();
    });
  });

  // ---------- Confluence-page RBAC space access (IDOR fix) ----------
  // Confluence-sourced drafts must be gated on getUserAccessibleSpaces, exactly
  // like GET /pages/:id and DELETE /pages/:id. Without this, any authenticated
  // user could read/overwrite/publish/discard the draft of a page in a space
  // they have no RBAC assignment in.

  describe('Confluence-page RBAC space access', () => {
    // PUT /draft — overwrite the draft
    it('PUT /draft returns 403 for a Confluence page in an inaccessible space', async () => {
      mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, source')) {
          return Promise.resolve({
            rows: [{
              id: 10, source: 'confluence', created_by_user_id: null,
              visibility: 'shared', space_key: 'HR', deleted_at: null,
            }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/10/draft',
        payload: { title: 'Sneaky', bodyHtml: '<p>sneaky draft</p>' },
      });

      expect(response.statusCode).toBe(403);
      expect(mockGetUserAccessibleSpaces).toHaveBeenCalledWith(TEST_USER);
      // The draft UPDATE must never run.
      const updateCall = mockQuery.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('draft_body_html = $1'),
      );
      expect(updateCall).toBeUndefined();
    });

    it('PUT /draft saves the draft for a Confluence page in an accessible space', async () => {
      mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, source')) {
          return Promise.resolve({
            rows: [{
              id: 10, source: 'confluence', created_by_user_id: null,
              visibility: 'shared', space_key: 'DEV', deleted_at: null,
            }],
          });
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/10/draft',
        payload: { title: 'OK', bodyHtml: '<p>authorized draft</p>' },
      });

      expect(response.statusCode).toBe(200);
    });

    // GET /draft — read the draft (404, no existence oracle)
    it('GET /draft returns 404 for a Confluence page in an inaccessible space', async () => {
      mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);
      mockQuery.mockResolvedValue({
        rows: [{
          id: 10, source: 'confluence', created_by_user_id: null,
          visibility: 'shared', space_key: 'HR',
          draft_body_html: '<p>secret draft</p>', draft_body_text: 'secret',
          draft_updated_at: new Date(), draft_updated_by: 'someone',
        }],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/10/draft',
      });

      expect(response.statusCode).toBe(404);
      expect(mockGetUserAccessibleSpaces).toHaveBeenCalledWith(TEST_USER);
    });

    it('GET /draft returns the draft for a Confluence page in an accessible space', async () => {
      mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);
      mockQuery.mockResolvedValue({
        rows: [{
          id: 10, source: 'confluence', created_by_user_id: null,
          visibility: 'shared', space_key: 'OPS',
          draft_body_html: '<p>visible draft</p>', draft_body_text: 'visible',
          draft_updated_at: new Date('2026-01-01'), draft_updated_by: 'author',
        }],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/10/draft',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().bodyHtml).toBe('<p>visible draft</p>');
    });

    // POST /draft/publish — promote the draft to live
    it('POST /draft/publish returns 403 for a Confluence page in an inaccessible space', async () => {
      mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);
      const txCalls: string[] = [];
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, version, title')) {
          return Promise.resolve({
            rows: [{
              id: 10, version: 3, title: 'Secret Article',
              body_html: '<p>live</p>', body_text: 'live',
              body_storage: '<p>storage</p>', source: 'confluence',
              created_by_user_id: null, visibility: 'shared',
              confluence_id: 'conf-123', space_key: 'HR',
              draft_body_html: '<p>draft</p>', draft_body_storage: null,
            }],
          });
        }
        return Promise.resolve({ rows: [] });
      });
      mockTxQuery.mockImplementation((sql: string) => {
        txCalls.push(sql.trim().substring(0, 30));
        return Promise.resolve({ rows: [], rowCount: 1 });
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/10/draft/publish',
      });

      expect(response.statusCode).toBe(403);
      expect(mockGetUserAccessibleSpaces).toHaveBeenCalledWith(TEST_USER);
      // No content swap may occur for an unauthorized space.
      expect(txCalls).not.toContain('BEGIN');
    });

    it('POST /draft/publish publishes for a Confluence page in an accessible space', async () => {
      mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);
      mockGetClientForUser.mockResolvedValue({ updatePage: vi.fn().mockResolvedValue({}) });
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, version, title')) {
          return Promise.resolve({
            rows: [{
              id: 10, version: 3, title: 'Authorized Article',
              body_html: '<p>live</p>', body_text: 'live',
              body_storage: '<p>storage</p>', source: 'confluence',
              created_by_user_id: null, visibility: 'shared',
              confluence_id: 'conf-123', space_key: 'OPS',
              draft_body_html: '<p>draft</p>', draft_body_storage: null,
            }],
          });
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      });
      mockTxQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/10/draft/publish',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().published).toBe(true);
    });

    // DELETE /draft — discard the draft
    it('DELETE /draft returns 403 for a Confluence page in an inaccessible space', async () => {
      mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, source')) {
          return Promise.resolve({
            rows: [{
              id: 10, source: 'confluence', created_by_user_id: null,
              visibility: 'shared', space_key: 'HR',
            }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/pages/10/draft',
      });

      expect(response.statusCode).toBe(403);
      expect(mockGetUserAccessibleSpaces).toHaveBeenCalledWith(TEST_USER);
      // The discard UPDATE must never run.
      const updateCall = mockQuery.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('draft_body_html = NULL'),
      );
      expect(updateCall).toBeUndefined();
    });

    it('DELETE /draft discards the draft for a Confluence page in an accessible space', async () => {
      mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, source')) {
          return Promise.resolve({
            rows: [{
              id: 10, source: 'confluence', created_by_user_id: null,
              visibility: 'shared', space_key: 'DEV',
            }],
          });
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/pages/10/draft',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().hasDraft).toBe(false);
    });

    // A Confluence page with no space_key is unreachable (defensive): treated as denied.
    it('PUT /draft returns 403 for a Confluence page with a null space_key', async () => {
      mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, source')) {
          return Promise.resolve({
            rows: [{
              id: 10, source: 'confluence', created_by_user_id: null,
              visibility: 'shared', space_key: null, deleted_at: null,
            }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/10/draft',
        payload: { title: 'X', bodyHtml: '<p>x</p>' },
      });

      expect(response.statusCode).toBe(403);
    });
  });
});
