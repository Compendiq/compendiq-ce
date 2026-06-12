import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

const mockGetClientForUser = vi.fn();
const mockQuery = vi.fn();
const mockMarkdownToHtml = vi.fn();
const mockHtmlToConfluence = vi.fn();
const mockConfluenceToHtml = vi.fn();
const mockHtmlToText = vi.fn();
const mockLogAuditEvent = vi.fn();
const mockProtectMedia = vi.fn();
const mockRestoreMedia = vi.fn();

// Defensive mock: llm-conversations.ts doesn't call the LLM directly, but
// other route tests might be transitively imported. Safe no-op here.
vi.mock('../../domains/llm/services/llm-provider-resolver.js', () => ({
  resolveUsecase: vi.fn(),
}));
vi.mock('../../domains/llm/services/openai-compatible-client.js', () => ({
  streamChat: vi.fn(),
  chat: vi.fn(),
  generateEmbedding: vi.fn(),
  listModels: vi.fn(),
  checkHealth: vi.fn(),
  invalidateDispatcher: vi.fn(),
}));

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
  confluenceToHtml: (...args: unknown[]) => mockConfluenceToHtml(...args),
  htmlToConfluence: (...args: unknown[]) => mockHtmlToConfluence(...args),
  htmlToText: (...args: unknown[]) => mockHtmlToText(...args),
  markdownToHtml: (...args: unknown[]) => mockMarkdownToHtml(...args),
  protectMedia: (...args: unknown[]) => mockProtectMedia(...args),
  restoreMedia: (...args: unknown[]) => mockRestoreMedia(...args),
  // #781: the apply route derives the layout skeleton and matches the
  // recovery error by instance — keep the class real-ish in the mock.
  extractLayoutSkeleton: vi.fn(() => []),
  LayoutRecoveryError: class LayoutRecoveryError extends Error {},
}));

vi.mock('../../domains/llm/services/embedding-service.js', () => ({
  getEmbeddingStatus: vi.fn(),
  processDirtyPages: vi.fn(),
  reEmbedAll: vi.fn(),
  embedPage: vi.fn(),
  isProcessingUser: vi.fn().mockReturnValue(false),
  resetFailedEmbeddings: vi.fn().mockResolvedValue(0),
  computePageRelationships: vi.fn(),
}));

vi.mock('../../domains/confluence/services/sync-service.js', () => ({
  getClientForUser: (...args: unknown[]) => mockGetClientForUser(...args),
}));

vi.mock('../../domains/llm/services/llm-cache.js', () => {
  class MockLlmCache {
    getCachedResponse = vi.fn().mockResolvedValue(null);
    setCachedResponse = vi.fn();
    acquireLock = vi.fn().mockResolvedValue(true);
    releaseLock = vi.fn().mockResolvedValue(undefined);
    waitForCachedResponse = vi.fn().mockResolvedValue(null);
    clearAll = vi.fn();
  }
  return {
    LlmCache: MockLlmCache,
    buildLlmCacheKey: vi.fn().mockReturnValue('test-cache-key'),
    buildRagCacheKey: vi.fn().mockReturnValue('test-rag-cache-key'),
  };
});

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
}));

vi.mock('../../core/utils/sanitize-llm-input.js', () => ({
  sanitizeLlmInput: vi.fn((input: string) => ({ sanitized: input, warnings: [] })),
}));

vi.mock('../../core/services/redis-cache.js', () => {
  class MockRedisCache {
    invalidate = vi.fn().mockResolvedValue(undefined);
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue(undefined);
  }
  return { RedisCache: MockRedisCache };
});

vi.mock('../../domains/confluence/services/subpage-context.js', () => ({
  assembleSubPageContext: vi.fn(),
  getMultiPagePromptSuffix: vi.fn().mockReturnValue(''),
}));

import { llmConversationRoutes } from './llm-conversations.js';

describe('POST /api/llm/improvements/apply', () => {
  let app: ReturnType<typeof Fastify>;

  const mockClient = {
    updatePage: vi.fn(),
  };

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.decorate('authenticate', async () => {});
    app.decorate('requireAdmin', async () => {});
    app.decorate('redis', {});
    app.decorateRequest('userId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = 'user-123';
      request.userCan = async () => true;
    });

    await app.register(llmConversationRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: Confluence client available
    mockGetClientForUser.mockResolvedValue(mockClient);

    // Default: page exists in DB with version 5 (Confluence source)
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, version, title, space_key, source, confluence_id')) {
        return Promise.resolve({ rows: [{ id: 42, version: 5, title: 'My Article', space_key: 'OPS', source: 'confluence', confluence_id: 'page-1', body_html: '<p>Old content</p>' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    // Default: content-converter mocks
    mockMarkdownToHtml.mockResolvedValue('<p>Improved HTML content</p>');
    mockHtmlToConfluence.mockReturnValue('<p class="confluence">Improved XHTML</p>');
    mockConfluenceToHtml.mockReturnValue('<p>Improved HTML content</p>');
    mockHtmlToText.mockReturnValue('Improved HTML content');

    // Default: protectMedia returns empty media (no media to protect)
    mockProtectMedia.mockReturnValue({ html: '<p>Old content</p>', media: [] });
    // Default: restoreMedia is a passthrough
    mockRestoreMedia.mockImplementation((html: string) => html);

    // Default: Confluence updatePage returns new version
    mockClient.updatePage.mockResolvedValue({
      version: { number: 6 },
      body: { storage: { value: '<p class="confluence">Improved XHTML</p>' } },
    });
  });

  it('returns 400 when Confluence is not configured for Confluence pages', async () => {
    mockGetClientForUser.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improvements/apply',
      payload: {
        pageId: 'page-1',
        improvedMarkdown: '## Improved content\n\nThis is better.',
        version: 5,
        title: 'My Article',
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 404 when page does not exist in local cache', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, version, title, space_key, source, confluence_id FROM pages')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improvements/apply',
      payload: {
        pageId: 'nonexistent-page',
        improvedMarkdown: '## Better',
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it('falls back to the Confluence id when a numeric pageId matches no internal id', async () => {
    const selects: string[] = [];
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, version, title, space_key, source, confluence_id')) {
        selects.push(sql);
        if (sql.includes('WHERE id = $1')) return Promise.resolve({ rows: [] });
        // Standalone page owned by the requester — local-update path, no Confluence push.
        return Promise.resolve({ rows: [{ id: 7, version: 2, title: 'Standalone', space_key: 'LOCAL', source: 'standalone', confluence_id: '1146884', body_html: '<p>Old</p>', created_by_user_id: 'user-123', visibility: 'private' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improvements/apply',
      payload: { pageId: '1146884', improvedMarkdown: '## Better' },
    });

    expect(response.statusCode).toBe(200);
    expect(selects[0]).toContain('WHERE id = $1');
    expect(selects[1]).toContain('WHERE confluence_id = $1');
  });

  it('skips the int4 cast for numeric ids longer than 9 digits (404, not a cast error)', async () => {
    const selects: string[] = [];
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, version, title, space_key, source, confluence_id')) {
        selects.push(sql);
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improvements/apply',
      payload: { pageId: '123456789012', improvedMarkdown: '## Better' },
    });

    expect(response.statusCode).toBe(404);
    expect(selects.some((sql) => sql.includes('WHERE id = $1'))).toBe(false);
    expect(selects.some((sql) => sql.includes('WHERE confluence_id = $1'))).toBe(true);
  });

  it('returns 409 on version conflict', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, version, title, space_key, source, confluence_id')) {
        return Promise.resolve({ rows: [{ id: 42, version: 10, title: 'My Article', space_key: 'OPS', source: 'confluence', confluence_id: 'page-1', body_html: '<p>Old</p>' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improvements/apply',
      payload: {
        pageId: 'page-1',
        improvedMarkdown: '## Outdated edit',
        version: 5, // stale — server has version 10
      },
    });

    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body);
    expect(body.message).toMatch(/modified since you loaded/i);
  });

  it('converts markdown to HTML, pushes to Confluence, and updates local cache', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improvements/apply',
      payload: {
        pageId: 'page-1',
        improvedMarkdown: '## Improved\n\nBetter content.',
        version: 5,
        title: 'My Article',
      },
    });

    expect(response.statusCode).toBe(200);

    // Markdown → HTML conversion
    expect(mockMarkdownToHtml).toHaveBeenCalledWith(
      '## Improved\n\nBetter content.',
      { layoutSkeleton: [] }, // #781: skeleton from the page's current body
    );

    // HTML → Confluence XHTML conversion
    expect(mockHtmlToConfluence).toHaveBeenCalledWith('<p>Improved HTML content</p>');

    // Confluence push
    expect(mockClient.updatePage).toHaveBeenCalledWith(
      'page-1',
      'My Article',
      '<p class="confluence">Improved XHTML</p>',
      5,
    );

    expect(mockConfluenceToHtml).toHaveBeenCalledWith(
      '<p class="confluence">Improved XHTML</p>',
      'page-1',
      'OPS',
    );

    // Local cache update (UPDATE pages)
    const updateCall = (mockQuery.mock.calls as unknown[][]).find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('UPDATE pages'),
    );
    expect(updateCall).toBeDefined();

    // Response shape
    const body = JSON.parse(response.body);
    expect(body.id).toBe(42);
    expect(body.title).toBe('My Article');
    expect(body.version).toBe(6);
  });

  it('uses existing title when title is not provided in request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improvements/apply',
      payload: {
        pageId: 'page-1',
        improvedMarkdown: '## Better',
        // no title field
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mockClient.updatePage).toHaveBeenCalledWith(
      'page-1', // uses confluence_id from DB, not the raw pageId param
      'My Article',
      expect.any(String),
      5,
    );
  });

  it('marks the improvement record as applied', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/llm/improvements/apply',
      payload: {
        pageId: 'page-1',
        improvedMarkdown: '## Better',
        version: 5,
      },
    });

    const applyCall = (mockQuery.mock.calls as unknown[][]).find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes("SET status = 'applied'"),
    );
    expect(applyCall).toBeDefined();
  });

  it('logs audit event for page update', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/llm/improvements/apply',
      payload: {
        pageId: 'page-1',
        improvedMarkdown: '## Better',
        version: 5,
      },
    });

    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      'user-123',
      'PAGE_UPDATED',
      'page',
      '42',
      expect.objectContaining({ source: 'ai_improvement' }),
      expect.any(Object),
    );
  });

  it('returns 400 when pageId is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improvements/apply',
      payload: {
        improvedMarkdown: '## Better',
      },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('returns 400 when improvedMarkdown is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improvements/apply',
      payload: {
        pageId: 'page-1',
      },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('preserves drawio + image through improve→apply even if the LLM only kept the tokens (#723)', async () => {
    const drawio = '<div class="confluence-drawio" data-diagram-name="Arch"><img src="/api/attachments/42/Arch.png"></div>';
    const img = '<img src="/api/attachments/42/p.png" data-confluence-filename="p.png" data-confluence-image-source="attachment">';
    const bodyHtmlWithMedia = `<p>Old</p>${drawio}${img}`;
    const improvedHtmlFromMarkdown = '<p>Improved intro</p>\n<p>CQ_MEDIA_PLACEHOLDER_0</p>\n<p>CQ_MEDIA_PLACEHOLDER_1</p>\n';
    const restoredHtml = `<p>Improved intro</p>\n${drawio}\n${img}\n`;

    // The page has media in body_html
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, version, title, space_key, source, confluence_id')) {
        return Promise.resolve({ rows: [{ id: 42, version: 5, title: 'My Article', space_key: 'OPS', source: 'confluence', confluence_id: 'page-1', body_html: bodyHtmlWithMedia }] });
      }
      return Promise.resolve({ rows: [] });
    });

    // protectMedia returns media entries matching the page's body_html
    const mediaEntries = [
      { token: 'CQ_MEDIA_PLACEHOLDER_0', html: drawio },
      { token: 'CQ_MEDIA_PLACEHOLDER_1', html: img },
    ];
    mockProtectMedia.mockReturnValue({ html: 'protected', media: mediaEntries });
    // markdownToHtml returns HTML with placeholder tokens (simulating LLM kept tokens)
    mockMarkdownToHtml.mockResolvedValue(improvedHtmlFromMarkdown);
    // restoreMedia injects the original media back
    mockRestoreMedia.mockReturnValue(restoredHtml);
    mockHtmlToConfluence.mockReturnValue('<p>Improved XHTML</p>');
    mockConfluenceToHtml.mockReturnValue(restoredHtml);
    mockHtmlToText.mockReturnValue('Improved intro');

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improvements/apply',
      payload: {
        pageId: 'page-1',
        improvedMarkdown: 'Improved intro\n\nCQ_MEDIA_PLACEHOLDER_0\n\nCQ_MEDIA_PLACEHOLDER_1\n',
        version: 5,
        title: 'My Article',
      },
    });

    expect(response.statusCode).toBe(200);
    // protectMedia was called with the page's current body_html
    expect(mockProtectMedia).toHaveBeenCalledWith(bodyHtmlWithMedia);
    // restoreMedia was called after markdownToHtml
    expect(mockRestoreMedia).toHaveBeenCalledWith(improvedHtmlFromMarkdown, mediaEntries);
    // The final HTML passed to htmlToConfluence includes media
    expect(mockHtmlToConfluence).toHaveBeenCalledWith(restoredHtml);
  });
});
