import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

// Mock prompts module (getSystemPrompt extracted from the legacy ollama-service)
const mockGetSystemPrompt = vi.fn().mockReturnValue('You are a diagram assistant');

vi.mock('../../domains/llm/services/prompts.js', () => ({
  getSystemPrompt: (...args: unknown[]) => mockGetSystemPrompt(...args),
  LANGUAGE_PRESERVATION_INSTRUCTION: '',
}));

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
const mockStreamChat = vi.fn();

vi.mock('../../domains/llm/services/openai-compatible-client.js', () => ({
  streamChat: (...args: unknown[]) => mockStreamChat(...args),
  chat: vi.fn(),
  generateEmbedding: vi.fn(),
  listModels: vi.fn(),
  checkHealth: vi.fn(),
  invalidateDispatcher: vi.fn(),
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

import { llmDiagramRoutes } from './llm-diagram.js';

describe('POST /api/llm/generate-diagram', () => {
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
      request.userCan = async () => true;
    });

    await app.register(llmDiagramRoutes, { prefix: '/api' });
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
      url: '/api/llm/generate-diagram',
      payload: { model: 'llama3' },
    });

    // Zod .parse() throws ZodError which Fastify returns as 500
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('should reject request when model is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/generate-diagram',
      payload: { content: '<p>Some article text</p>' },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('should return 400 when content exceeds max length', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/generate-diagram',
      payload: {
        content: 'x'.repeat(100_001),
        model: 'llama3',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.message).toContain('Content too large');
  });

  it('should reject invalid diagram type', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/generate-diagram',
      payload: {
        content: '<p>Article</p>',
        model: 'llama3',
        diagramType: 'invalid',
      },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('should stream SSE response for valid request', async () => {
    // Create an async generator that yields diagram content
    async function* mockGenerator() {
      yield { content: 'graph TD\n', done: false };
      yield { content: '  A --> B', done: true };
    }
    mockStreamChat.mockReturnValue(mockGenerator());

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/generate-diagram',
      payload: {
        content: '<p>Step 1: Do A. Step 2: Do B.</p>',
        model: 'llama3',
        diagramType: 'flowchart',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');

    // Parse SSE data lines
    const lines = response.body.split('\n').filter((l: string) => l.startsWith('data: '));
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const firstChunk = JSON.parse(lines[0].replace('data: ', ''));
    expect(firstChunk.content).toContain('graph TD');
  });

  it('should return cached response when available', async () => {
    mockGetCachedResponse.mockResolvedValue({ content: 'graph TD\n  A --> B' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/generate-diagram',
      payload: {
        content: '<p>Article</p>',
        model: 'llama3',
      },
    });

    expect(response.statusCode).toBe(200);
    const lines = response.body.split('\n').filter((l: string) => l.startsWith('data: '));
    const data = JSON.parse(lines[0].replace('data: ', ''));
    expect(data.cached).toBe(true);
    expect(data.content).toContain('graph TD');
    expect(mockStreamChat).not.toHaveBeenCalled();
  });

  it('should default diagramType to flowchart', async () => {
    async function* mockGenerator() {
      yield { content: 'graph TD\n  A --> B', done: true };
    }
    mockStreamChat.mockReturnValue(mockGenerator());

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/generate-diagram',
      payload: {
        content: '<p>Some process</p>',
        model: 'llama3',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mockGetSystemPrompt).toHaveBeenCalledWith('generate_diagram_flowchart');
  });

  it('should use correct system prompt for sequence diagram type', async () => {
    async function* mockGenerator() {
      yield { content: 'sequenceDiagram\n  A->>B: Hello', done: true };
    }
    mockStreamChat.mockReturnValue(mockGenerator());

    await app.inject({
      method: 'POST',
      url: '/api/llm/generate-diagram',
      payload: {
        content: '<p>Service A calls Service B</p>',
        model: 'llama3',
        diagramType: 'sequence',
      },
    });

    expect(mockGetSystemPrompt).toHaveBeenCalledWith('generate_diagram_sequence');
  });
});
