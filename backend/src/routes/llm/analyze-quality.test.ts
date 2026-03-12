import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

// Mock ollama-service
const mockStreamChat = vi.fn();
const mockGetSystemPrompt = vi.fn().mockReturnValue('You are a quality analyst');

vi.mock('../../domains/llm/services/ollama-service.js', () => ({
  listModels: vi.fn(),
  checkHealth: vi.fn(),
  streamChat: (...args: unknown[]) => mockStreamChat(...args),
  chat: vi.fn(),
  getSystemPrompt: (...args: unknown[]) => mockGetSystemPrompt(...args),
  generateEmbedding: vi.fn(),
}));

vi.mock('../../core/services/circuit-breaker.js', () => ({
  getOllamaCircuitBreakerStatus: vi.fn().mockReturnValue({
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
  query: vi.fn().mockResolvedValue({ rows: [] }),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../../domains/llm/services/rag-service.js', () => ({
  hybridSearch: vi.fn(),
  buildRagContext: vi.fn(),
}));

vi.mock('../../core/services/content-converter.js', () => ({
  htmlToMarkdown: vi.fn((html: string) => html),
}));

vi.mock('../../domains/llm/services/embedding-service.js', () => ({
  getEmbeddingStatus: vi.fn(),
  processDirtyPages: vi.fn(),
  reEmbedAll: vi.fn(),
  embedPage: vi.fn(),
  isProcessingUser: vi.fn().mockReturnValue(false),
  resetFailedEmbeddings: vi.fn().mockResolvedValue(0),
}));

const mockGetCachedResponse = vi.fn().mockResolvedValue(null);
const mockSetCachedResponse = vi.fn();

vi.mock('../../domains/llm/services/llm-cache.js', () => {
  class MockLlmCache {
    getCachedResponse = mockGetCachedResponse;
    setCachedResponse = mockSetCachedResponse;
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

import { llmChatRoutes } from './llm-chat.js';

describe('POST /api/llm/analyze-quality', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    // Decorate with mock auth and redis
    app.decorate('authenticate', async () => {});
    app.decorate('requireAdmin', async () => {});
    app.decorate('redis', {});
    app.decorateRequest('userId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = 'test-user-123';
    });

    await app.register(llmChatRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCachedResponse.mockResolvedValue(null);
  });

  it('should reject request when content is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/analyze-quality',
      payload: { model: 'llama3' },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('should reject request when model is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/analyze-quality',
      payload: { content: '<p>Some article text</p>' },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('should return 400 when content exceeds max length', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/analyze-quality',
      payload: {
        content: 'x'.repeat(100_001),
        model: 'llama3',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.message).toContain('Content too large');
  });

  it('should stream SSE response for valid request', async () => {
    async function* mockGenerator() {
      yield { content: '## Overall Quality Score: 75/100\n', done: false };
      yield { content: '## Completeness: 80/100\n', done: true };
    }
    mockStreamChat.mockReturnValue(mockGenerator());

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/analyze-quality',
      payload: {
        content: '<p>This is a test article with some content.</p>',
        model: 'llama3',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');

    // Parse SSE data lines
    const lines = response.body.split('\n').filter((l: string) => l.startsWith('data: '));
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const firstChunk = JSON.parse(lines[0].replace('data: ', ''));
    expect(firstChunk.content).toContain('Overall Quality Score');
  });

  it('should use the analyze_quality system prompt', async () => {
    async function* mockGenerator() {
      yield { content: '## Overall Quality Score: 85/100', done: true };
    }
    mockStreamChat.mockReturnValue(mockGenerator());

    await app.inject({
      method: 'POST',
      url: '/api/llm/analyze-quality',
      payload: {
        content: '<p>Article content</p>',
        model: 'llama3',
      },
    });

    expect(mockGetSystemPrompt).toHaveBeenCalledWith('analyze_quality');
  });

  it('should return cached response when available', async () => {
    mockGetCachedResponse.mockResolvedValue({ content: '## Overall Quality Score: 90/100' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/analyze-quality',
      payload: {
        content: '<p>Article</p>',
        model: 'llama3',
      },
    });

    expect(response.statusCode).toBe(200);
    const lines = response.body.split('\n').filter((l: string) => l.startsWith('data: '));
    const data = JSON.parse(lines[0].replace('data: ', ''));
    expect(data.cached).toBe(true);
    expect(data.content).toContain('Overall Quality Score');
    expect(mockStreamChat).not.toHaveBeenCalled();
  });

  it('should accept optional pageId', async () => {
    async function* mockGenerator() {
      yield { content: 'Analysis complete', done: true };
    }
    mockStreamChat.mockReturnValue(mockGenerator());

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/analyze-quality',
      payload: {
        content: '<p>Article</p>',
        model: 'llama3',
        pageId: 'page-123',
      },
    });

    expect(response.statusCode).toBe(200);
  });
});
