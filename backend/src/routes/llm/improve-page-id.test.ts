/**
 * Regression tests for issue #418: first-click 500 error on /api/llm/improve.
 *
 * Specifically tests that:
 * 1. The INSERT uses page_id (resolved via pages.confluence_id subquery), not the old confluence_id column.
 * 2. When the INSERT returns 0 rows (page not yet synced), improvementId is undefined and
 *    no UPDATE is attempted — the SSE stream still completes successfully with status 200.
 * 3. The response Content-Type is text/event-stream (SSE streaming works correctly).
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

const mockProviderStreamChat = vi.fn();
const mockQuery = vi.fn();

vi.mock('../../domains/llm/services/ollama-service.js', () => ({
  listModels: vi.fn(),
  checkHealth: vi.fn(),
  streamChat: vi.fn(),
  chat: vi.fn(),
  getSystemPrompt: vi.fn().mockReturnValue('You are a technical writing assistant.'),
  generateEmbedding: vi.fn(),
  isLlmVerifySslEnabled: vi.fn().mockReturnValue(true),
  getLlmAuthType: vi.fn().mockReturnValue('bearer'),
  getActiveProviderType: vi.fn().mockReturnValue('ollama'),
  getProvider: vi.fn().mockReturnValue({
    listModels: vi.fn().mockResolvedValue([]),
    checkHealth: vi.fn().mockResolvedValue({ connected: true }),
  }),
  LANGUAGE_PRESERVATION_INSTRUCTION: 'Keep the text in its ORIGINAL language.',
}));

vi.mock('../../domains/llm/services/llm-provider.js', () => ({
  providerStreamChat: (...args: unknown[]) => mockProviderStreamChat(...args),
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
  confluenceToHtml: vi.fn(),
  htmlToConfluence: vi.fn(),
  htmlToText: vi.fn(),
  markdownToHtml: vi.fn(),
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
  logAuditEvent: vi.fn(),
}));

vi.mock('../../domains/confluence/services/sync-service.js', () => ({
  getClientForUser: vi.fn(),
}));

vi.mock('../../domains/confluence/services/subpage-context.js', () => ({
  assembleSubPageContext: vi.fn(),
  getMultiPagePromptSuffix: vi.fn().mockReturnValue(''),
}));

vi.mock('../../core/utils/sanitize-llm-input.js', () => ({
  sanitizeLlmInput: vi.fn((input: string) => ({ sanitized: input, warnings: [] })),
}));

import { llmImproveRoutes } from './llm-improve.js';

describe('POST /api/llm/improve — page_id resolution (regression: issue #418)', () => {
  let app: ReturnType<typeof Fastify>;

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

    await app.register(llmImproveRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('first-click: INSERT uses page_id subquery (not confluence_id column) when pageId is provided', async () => {
    // Arrange: INSERT returns a valid improvement id (page exists in DB)
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO llm_improvements')) {
        return Promise.resolve({ rows: [{ id: 'improvement-1' }] });
      }
      // user_settings for custom prompt lookup
      if (sql.includes('SELECT custom_prompts FROM user_settings')) {
        return Promise.resolve({ rows: [] });
      }
      // SELECT title FROM pages (assembleContextIfNeeded without includeSubPages returns early)
      return Promise.resolve({ rows: [] });
    });

    async function* mockGenerator() {
      yield { content: 'Improved content', done: true };
    }
    mockProviderStreamChat.mockReturnValue(mockGenerator());

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improve',
      payload: {
        content: '<p>Original content</p>',
        type: 'grammar',
        model: 'llama3',
        pageId: 'conf-123',
      },
    });

    // Assert: response is 200 SSE stream (no 500)
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');

    // Assert: INSERT uses page_id with the SELECT subquery pattern (not confluence_id column directly)
    const insertCall = (mockQuery.mock.calls as unknown[][]).find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('INSERT INTO llm_improvements'),
    );
    expect(insertCall).toBeDefined();
    const insertSql = insertCall![0] as string;
    expect(insertSql).toContain('page_id');
    expect(insertSql).toContain('FROM pages p WHERE p.confluence_id');
    expect(insertSql).not.toContain('confluence_id,'); // should not insert directly into confluence_id column
  });

  it('first-click: page not yet synced — INSERT returns 0 rows, no UPDATE attempted, stream returns 200', async () => {
    // Arrange: INSERT returns 0 rows (page not in pages table yet — not yet synced from Confluence)
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO llm_improvements')) {
        return Promise.resolve({ rows: [] }); // 0 rows = page not found
      }
      if (sql.includes('SELECT custom_prompts FROM user_settings')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    async function* mockGenerator() {
      yield { content: 'Some improvement', done: true };
    }
    mockProviderStreamChat.mockReturnValue(mockGenerator());

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improve',
      payload: {
        content: '<p>Some content</p>',
        type: 'clarity',
        model: 'llama3',
        pageId: 'conf-not-synced',
      },
    });

    // Assert: response is still 200 — the missing page row is handled gracefully
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');

    // Assert: no UPDATE was attempted because improvementId is undefined
    const updateCall = (mockQuery.mock.calls as unknown[][]).find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes("SET improved_content"),
    );
    expect(updateCall).toBeUndefined();
  });

  it('when no pageId provided, no INSERT is attempted at all', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT custom_prompts FROM user_settings')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    async function* mockGenerator() {
      yield { content: 'Improved text', done: true };
    }
    mockProviderStreamChat.mockReturnValue(mockGenerator());

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improve',
      payload: {
        content: '<p>Original text</p>',
        type: 'grammar',
        model: 'llama3',
        // no pageId
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');

    // No INSERT into llm_improvements should have been called
    const insertCall = (mockQuery.mock.calls as unknown[][]).find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('INSERT INTO llm_improvements'),
    );
    expect(insertCall).toBeUndefined();
  });
});
