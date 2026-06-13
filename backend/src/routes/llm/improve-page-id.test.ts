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

const mockQuery = vi.fn();

// Mock llm-provider-resolver (resolveUsecase)
const mockResolveUsecase = vi.fn().mockResolvedValue({
  config: {
    providerId: 'p1', baseUrl: 'http://x/v1', apiKey: null,
    authType: 'none', verifySsl: true, name: 'X', defaultModel: 'm',
  },
  model: 'm',
});

vi.mock('../../domains/llm/services/llm-provider-resolver.js', () => ({
  resolveUsecase: (...args: unknown[]) => mockResolveUsecase(...args),
}));

// Mock openai-compatible-client (streamChat — queue + breakers wrapped inside)
const mockProviderStreamChat = vi.fn();

vi.mock('../../domains/llm/services/openai-compatible-client.js', () => ({
  streamChat: (...args: unknown[]) => mockProviderStreamChat(...args),
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
  confluenceToHtml: vi.fn(),
  htmlToConfluence: vi.fn(),
  htmlToText: vi.fn(),
  markdownToHtml: vi.fn(),
  protectMedia: vi.fn((html: string) => ({ html, media: [] })),
  restoreMedia: vi.fn((html: string) => html),
  hasRecoverableLayoutTokens: vi.fn((md: string) => /\[\[\[/.test(md)),
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

// Shared cache mock so individual tests can force a cache hit (#704).
const mockGetCachedResponse = vi.fn().mockResolvedValue(null);
vi.mock('../../domains/llm/services/llm-cache.js', () => {
  class MockLlmCache {
    getCachedResponse = (...args: unknown[]) => mockGetCachedResponse(...args);
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

const mockEmitLlmAudit = vi.fn();
vi.mock('../../domains/llm/services/llm-audit-hook.js', async (importActual) => {
  const actual = await importActual<typeof import('../../domains/llm/services/llm-audit-hook.js')>();
  return {
    ...actual,
    emitLlmAudit: (...args: unknown[]) => mockEmitLlmAudit(...args),
  };
});

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

/** Parse an SSE response body into the JSON payloads of each `data:` line. */
function parseSseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

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
    mockGetCachedResponse.mockResolvedValue(null);
    mockResolveUsecase.mockResolvedValue({
      config: {
        providerId: 'p1', baseUrl: 'http://x/v1', apiKey: null,
        authType: 'none', verifySsl: true, name: 'X', defaultModel: 'm',
      },
      model: 'm',
    });
  });

  it('first-click: pageId resolves to the pages row and the INSERT carries its internal id', async () => {
    // Arrange: page resolution finds the row; INSERT returns a valid id.
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO llm_improvements')) {
        return Promise.resolve({ rows: [{ id: 'improvement-1' }] });
      }
      if (sql.includes('SELECT id, confluence_id, title FROM pages')) {
        return Promise.resolve({ rows: [{ id: 42, confluence_id: 'conf-123', title: 'T' }] });
      }
      // user_settings for custom prompt lookup
      if (sql.includes('SELECT custom_prompts FROM user_settings')) {
        return Promise.resolve({ rows: [] });
      }
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

    // Assert: INSERT writes page_id with the RESOLVED internal id (the
    // route resolves both id forms up front — see resolvePageRef).
    const insertCall = (mockQuery.mock.calls as unknown[][]).find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('INSERT INTO llm_improvements'),
    );
    expect(insertCall).toBeDefined();
    const insertSql = insertCall![0] as string;
    expect(insertSql).toContain('page_id');
    expect(insertSql).not.toContain('confluence_id,'); // never the confluence_id column
    expect((insertCall![1] as unknown[])[1]).toBe(42);
  });

  it('resolves a NUMERIC pageId as the internal pages.id first (what the frontend routes pass)', async () => {
    const selects: Array<{ sql: string; params: unknown[] }> = [];
    mockQuery.mockImplementation((sql: string, params: unknown[]) => {
      if (sql.includes('SELECT id, confluence_id, title FROM pages')) {
        selects.push({ sql, params });
        if (sql.includes('WHERE id = $1')) {
          return Promise.resolve({ rows: [{ id: 11, confluence_id: '917505', title: 'Layout page' }] });
        }
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO llm_improvements')) {
        return Promise.resolve({ rows: [{ id: 'improvement-2' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    async function* mockGenerator() {
      yield { content: 'Improved content', done: true };
    }
    mockProviderStreamChat.mockReturnValue(mockGenerator());

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improve',
      payload: { content: '<p>x</p>', type: 'grammar', model: 'llama3', pageId: '11' },
    });
    expect(response.statusCode).toBe(200);

    expect(selects[0]!.sql).toContain('WHERE id = $1');
    expect(selects[0]!.params).toEqual([11]);
    const insertCall = (mockQuery.mock.calls as unknown[][]).find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('INSERT INTO llm_improvements'),
    );
    expect((insertCall![1] as unknown[])[1]).toBe(11);
  });

  it('persists and audits the resolved provider id and model, not the request model', async () => {
    mockResolveUsecase.mockResolvedValue({
      config: {
        providerId: 'custom-provider',
        baseUrl: 'http://custom/v1',
        apiKey: null,
        authType: 'none',
        verifySsl: true,
        name: 'Custom Provider',
        defaultModel: 'resolved-model',
      },
      model: 'resolved-model',
    });
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO llm_improvements')) {
        return Promise.resolve({ rows: [{ id: 'improvement-1' }] });
      }
      if (sql.includes('SELECT id, confluence_id, title FROM pages')) {
        return Promise.resolve({ rows: [{ id: 42, confluence_id: 'conf-123', title: 'T' }] });
      }
      if (sql.includes('SELECT custom_prompts FROM user_settings')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    async function* mockGenerator() {
      yield { content: 'Improved content', done: true };
    }
    mockProviderStreamChat.mockReturnValue(mockGenerator());

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improve',
      payload: {
        content: '<p>Original content</p>',
        type: 'grammar',
        model: 'ignored-body-model',
        pageId: 'conf-123',
      },
    });

    expect(response.statusCode).toBe(200);

    const insertCall = (mockQuery.mock.calls as unknown[][]).find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('INSERT INTO llm_improvements'),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1]).toEqual([
      'user-123',
      42,
      'grammar',
      'resolved-model',
      '<p>Original content</p>',
    ]);
    expect(mockEmitLlmAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'improve',
        model: 'resolved-model',
        provider: 'custom-provider',
      }),
    );
  });

  it('first-click: page not yet synced — resolution finds no row, no INSERT/UPDATE attempted, stream returns 200', async () => {
    // Arrange: page resolution finds nothing (not yet synced from Confluence)
    mockQuery.mockImplementation((sql: string) => {
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

    // Assert: neither INSERT nor UPDATE was attempted
    const insertCall = (mockQuery.mock.calls as unknown[][]).find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('INSERT INTO llm_improvements'),
    );
    expect(insertCall).toBeUndefined();
    const updateCall = (mockQuery.mock.calls as unknown[][]).find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes("SET improved_content"),
    );
    expect(updateCall).toBeUndefined();
  });

  it('#704: echoes the original markdown (what the model was fed) in the final SSE event', async () => {
    // htmlToMarkdown is mocked to echo its input, so the markdown baseline the
    // backend feeds the model equals the request content. The final SSE event
    // must carry that markdown so the frontend can diff like-for-like.
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO llm_improvements')) {
        return Promise.resolve({ rows: [{ id: 'improvement-1' }] });
      }
      if (sql.includes('SELECT custom_prompts FROM user_settings')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    async function* mockGenerator() {
      yield { content: '# Heading\n\nImproved markdown body', done: true };
    }
    mockProviderStreamChat.mockReturnValue(mockGenerator());

    const original = '# Heading\n\nOriginal markdown body';
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improve',
      payload: {
        content: original,
        type: 'grammar',
        model: 'llama3',
        pageId: 'conf-123',
      },
    });

    expect(response.statusCode).toBe(200);

    // The final SSE event (done + final) must include originalMarkdown.
    const finalEvent = parseSseEvents(response.body).find((e) => e.final === true);
    expect(finalEvent).toBeDefined();
    expect(finalEvent!.originalMarkdown).toBe(original);
  });

  it('#704: cached responses also echo the original markdown', async () => {
    // Force a cache hit: getCachedResponse returns content so the route takes
    // the sendCachedSSE path, which must still emit originalMarkdown.
    mockGetCachedResponse.mockResolvedValue({ content: 'cached improved markdown' });

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT custom_prompts FROM user_settings')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const original = '# Heading\n\nOriginal markdown body';
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improve',
      payload: {
        content: original,
        type: 'grammar',
        model: 'llama3',
        pageId: 'conf-123',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');

    const finalEvent = parseSseEvents(response.body).find((e) => e.final === true);
    expect(finalEvent).toBeDefined();
    expect(finalEvent!.originalMarkdown).toBe(original);
    // The cached content must still stream through.
    expect(response.body).toContain('cached improved markdown');
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
