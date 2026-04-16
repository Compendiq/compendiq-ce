import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

// --- Mock: ollama-service ---
const mockGetSystemPrompt = vi.fn().mockReturnValue('You are a helpful knowledge base assistant');

vi.mock('../../domains/llm/services/ollama-service.js', () => ({
  listModels: vi.fn(),
  checkHealth: vi.fn(),
  streamChat: vi.fn(),
  chat: vi.fn(),
  getSystemPrompt: (...args: unknown[]) => mockGetSystemPrompt(...args),
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

// --- Mock: llm-provider (providerStreamChat) ---
const mockProviderStreamChat = vi.fn();

vi.mock('../../domains/llm/services/llm-provider.js', () => ({
  providerStreamChat: (...args: unknown[]) => mockProviderStreamChat(...args),
  providerGenerateEmbedding: vi.fn(),
  resolveUserProvider: vi.fn().mockResolvedValue({ type: 'ollama' }),
}));

// --- Mock: circuit-breaker ---
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
  CircuitBreakerOpenError: class CircuitBreakerOpenError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'CircuitBreakerOpenError';
    }
  },
}));

// --- Mock: postgres query ---
const mockQuery = vi.fn().mockResolvedValue({ rows: [{ id: 'test-conv-id' }] });

vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

// --- Mock: rag-service ---
const mockHybridSearch = vi.fn().mockResolvedValue([]);
const mockBuildRagContext = vi.fn().mockReturnValue('Relevant context from the knowledge base.');

vi.mock('../../domains/llm/services/rag-service.js', () => ({
  hybridSearch: (...args: unknown[]) => mockHybridSearch(...args),
  buildRagContext: (...args: unknown[]) => mockBuildRagContext(...args),
}));

// --- Mock: content-converter ---
vi.mock('../../core/services/content-converter.js', () => ({
  htmlToMarkdown: vi.fn((html: string) => html),
  confluenceToHtml: vi.fn(),
  htmlToConfluence: vi.fn(),
  htmlToText: vi.fn(),
  markdownToHtml: vi.fn(),
}));

// --- Mock: embedding-service ---
vi.mock('../../domains/llm/services/embedding-service.js', () => ({
  getEmbeddingStatus: vi.fn(),
  processDirtyPages: vi.fn(),
  reEmbedAll: vi.fn(),
  embedPage: vi.fn(),
  isProcessingUser: vi.fn().mockReturnValue(false),
  resetFailedEmbeddings: vi.fn().mockResolvedValue(0),
}));

// --- Mock: llm-cache ---
const mockGetCachedResponse = vi.fn().mockResolvedValue(null);

vi.mock('../../domains/llm/services/llm-cache.js', () => {
  class MockLlmCache {
    getCachedResponse = mockGetCachedResponse;
    setCachedResponse = vi.fn().mockResolvedValue(undefined);
    acquireLock = vi.fn().mockResolvedValue(true);
    releaseLock = vi.fn().mockResolvedValue(undefined);
    waitForCachedResponse = vi.fn().mockResolvedValue(null);
    clearAll = vi.fn();
  }
  return {
    LlmCache: MockLlmCache,
    buildLlmCacheKey: vi.fn().mockReturnValue('test-llm-cache-key'),
    buildRagCacheKey: vi.fn().mockReturnValue('test-rag-cache-key'),
  };
});

// --- Mock: audit-service ---
vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

// --- Mock: sanitize-llm-input ---
vi.mock('../../core/utils/sanitize-llm-input.js', () => ({
  sanitizeLlmInput: vi.fn((input: string) => ({ sanitized: input, warnings: [] })),
}));

// --- Mock: subpage-context ---
vi.mock('../../domains/confluence/services/subpage-context.js', () => ({
  assembleSubPageContext: vi.fn(),
  getMultiPagePromptSuffix: vi.fn().mockReturnValue(''),
}));

// --- Mock: sync-service ---
vi.mock('../../domains/confluence/services/sync-service.js', () => ({
  getClientForUser: vi.fn(),
}));

import { llmAskRoutes } from './llm-ask.js';
import { llmImproveRoutes } from './llm-improve.js';
import { llmSummarizeRoutes } from './llm-summarize.js';
import { llmGenerateRoutes } from './llm-generate.js';

/** Parse SSE body into an array of parsed JSON objects from `data:` lines. */
function parseSseBody(body: string): unknown[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.replace('data: ', '')));
}

/** A simple async generator that yields one content chunk then signals done. */
async function* singleChunkGenerator(content: string) {
  yield { content, done: true };
}

// =============================================================================
// Test Suite 1: Auth-required tests (no authenticate hook bypass)
// =============================================================================

describe('POST /api/llm/ask - auth required', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    // Decorate authenticate to REJECT (simulate missing/invalid token)
    app.decorate('authenticate', async () => {
      throw app.httpErrors.unauthorized('Missing or invalid token');
    });
    app.decorate('requireAdmin', async () => {});
    app.decorate('redis', {});
    app.decorateRequest('userId', '');

    await app.register(llmAskRoutes, { prefix: '/api' });
    await app.register(llmImproveRoutes, { prefix: '/api' });
    await app.register(llmSummarizeRoutes, { prefix: '/api' });
    await app.register(llmGenerateRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should return 401 when no auth token is provided', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/ask',
      payload: { question: 'What is Kubernetes?', model: 'llama3' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('should return 401 for /llm/improve without auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improve',
      payload: { content: '<p>test</p>', type: 'grammar', model: 'llama3' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('should return 401 for /llm/summarize without auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/summarize',
      payload: { content: '<p>test</p>', model: 'llama3' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('should return 401 for /llm/generate without auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/generate',
      payload: { prompt: 'Write about testing', model: 'llama3' },
    });

    expect(response.statusCode).toBe(401);
  });
});

// =============================================================================
// Test Suite 2: Happy path and validation tests
// =============================================================================

describe('POST /api/llm/ask - SSE streaming', () => {
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
      request.userCan = async () => true;
    });

    await app.register(llmAskRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCachedResponse.mockResolvedValue(null);
    mockGetSystemPrompt.mockReturnValue('You are a helpful knowledge base assistant');
    mockQuery.mockResolvedValue({ rows: [{ id: 'test-conv-id' }] });
    mockBuildRagContext.mockReturnValue('Relevant context from the knowledge base.');
    mockHybridSearch.mockResolvedValue([]);
  });

  it('should return 400 when question is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/ask',
      payload: { model: 'llama3' },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('should return 400 when model is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/ask',
      payload: { question: 'What is Docker?' },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('should return SSE stream with valid question and model', async () => {
    const fakeResults = [
      {
        pageId: 1,
        confluenceId: 'page-1',
        chunkText: 'Docker is a container runtime.',
        pageTitle: 'Docker Guide',
        sectionTitle: 'Overview',
        spaceKey: 'DEV',
        score: 0.92,
      },
    ];
    mockHybridSearch.mockResolvedValue(fakeResults);
    mockProviderStreamChat.mockReturnValue(singleChunkGenerator('Docker is a container platform.'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/ask',
      payload: { question: 'What is Docker?', model: 'llama3' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');

    const events = parseSseBody(response.body);
    expect(events.length).toBeGreaterThanOrEqual(2);

    // Final event should contain sources
    const finalEvent = events.find((e: unknown) => (e as Record<string, unknown>).final === true) as Record<string, unknown>;
    expect(finalEvent).toBeDefined();
    expect(finalEvent!.done).toBe(true);
    expect(finalEvent!.conversationId).toBe('test-conv-id');

    const sources = finalEvent!.sources as Array<Record<string, unknown>>;
    expect(Array.isArray(sources)).toBe(true);
    expect(sources).toHaveLength(1);
    expect(sources[0].pageId).toBe(1);
    expect(sources[0].confluenceId).toBe('page-1');
  });

  it('should return 400 when question exceeds maximum length', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/ask',
      payload: {
        question: 'x'.repeat(100_001),
        model: 'llama3',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.message).toContain('Question too large');
  });

  it('should create a new conversation when conversationId is not provided', async () => {
    mockHybridSearch.mockResolvedValue([]);
    mockProviderStreamChat.mockReturnValue(singleChunkGenerator('No relevant context found.'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/ask',
      payload: { question: 'Hello', model: 'llama3' },
    });

    expect(response.statusCode).toBe(200);

    // Verify an INSERT INTO llm_conversations was called
    const insertCall = mockQuery.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO llm_conversations'),
    );
    expect(insertCall).toBeDefined();
  });
});
