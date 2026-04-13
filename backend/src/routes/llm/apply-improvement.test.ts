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

vi.mock('../../domains/llm/services/ollama-service.js', () => ({
  listModels: vi.fn(),
  checkHealth: vi.fn(),
  streamChat: vi.fn(),
  chat: vi.fn(),
  getSystemPrompt: vi.fn().mockReturnValue('system prompt'),
  generateEmbedding: vi.fn(),
  isLlmVerifySslEnabled: vi.fn().mockReturnValue(true),
  getLlmAuthType: vi.fn().mockReturnValue('bearer'),
  getActiveProviderType: vi.fn().mockReturnValue('ollama'),
  getProvider: vi.fn().mockReturnValue({
    listModels: vi.fn().mockResolvedValue([]),
    checkHealth: vi.fn().mockResolvedValue({ connected: true }),
  }),
}));

vi.mock('../../domains/llm/services/llm-provider.js', () => ({
  providerStreamChat: vi.fn(),
  providerGenerateEmbedding: vi.fn(),
}));

vi.mock('../../core/services/circuit-breaker.js', () => ({
  getOllamaCircuitBreakerStatus: vi.fn().mockReturnValue({ chat: { state: 'CLOSED' }, embed: { state: 'CLOSED' }, list: { state: 'CLOSED' } }),
  getOpenaiCircuitBreakerStatus: vi.fn().mockReturnValue({ chat: { state: 'CLOSED' }, embed: { state: 'CLOSED' }, list: { state: 'CLOSED' } }),
  ollamaBreakers: {
    chat: { execute: vi.fn((fn: () => unknown) => fn()) },
    embed: { execute: vi.fn((fn: () => unknown) => fn()) },
    list: { execute: vi.fn((fn: () => unknown) => fn()) },
  },
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
      if (sql.includes('SELECT id, version, title, space_key, source, confluence_id FROM pages')) {
        return Promise.resolve({ rows: [{ id: 42, version: 5, title: 'My Article', space_key: 'OPS', source: 'confluence', confluence_id: 'page-1' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    // Default: content-converter mocks
    mockMarkdownToHtml.mockResolvedValue('<p>Improved HTML content</p>');
    mockHtmlToConfluence.mockReturnValue('<p class="confluence">Improved XHTML</p>');
    mockConfluenceToHtml.mockReturnValue('<p>Improved HTML content</p>');
    mockHtmlToText.mockReturnValue('Improved HTML content');

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

  it('returns 409 on version conflict', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, version, title, space_key, source, confluence_id FROM pages')) {
        return Promise.resolve({ rows: [{ id: 42, version: 10, title: 'My Article', space_key: 'OPS', source: 'confluence', confluence_id: 'page-1' }] });
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
    expect(mockMarkdownToHtml).toHaveBeenCalledWith('## Improved\n\nBetter content.');

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
});
