import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

const mockGetClientForUser = vi.fn();
const mockEmbedPage = vi.fn();
const mockQuery = vi.fn().mockResolvedValue({ rows: [] });

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
  getOllamaCircuitBreakerStatus: vi.fn().mockReturnValue({
    chat: { state: 'CLOSED' },
    embed: { state: 'CLOSED' },
    list: { state: 'CLOSED' },
  }),
  getOpenaiCircuitBreakerStatus: vi.fn().mockReturnValue({
    chat: { state: 'CLOSED' },
    embed: { state: 'CLOSED' },
    list: { state: 'CLOSED' },
  }),
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
  confluenceToHtml: vi.fn((xhtml: string) => `<p>converted: ${xhtml}</p>`),
  htmlToText: vi.fn((html: string) => html),
}));

vi.mock('../../domains/llm/services/embedding-service.js', () => ({
  getEmbeddingStatus: vi.fn(),
  processDirtyPages: vi.fn(),
  reEmbedAll: vi.fn(),
  embedPage: (...args: unknown[]) => mockEmbedPage(...args),
  isProcessingUser: vi.fn().mockReturnValue(false),
  resetFailedEmbeddings: vi.fn().mockResolvedValue(0),
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

import { llmEmbeddingRoutes } from './llm/llm-embeddings.js';

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
  });

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

    // Mock DB query for cached_pages lookup
    mockQuery.mockResolvedValue({
      rows: [{ space_key: 'DEV', body_html: '<p>cached content</p>' }],
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

    // getPage should only be called once (for the root page), not for descendants
    // that already have body.storage.value from the getChildPages expand
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
      rows: [{ space_key: 'DEV', body_html: '<p>cached</p>' }],
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
      rows: [{ space_key: 'DEV', body_html: '<p>leaf</p>' }],
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
});
