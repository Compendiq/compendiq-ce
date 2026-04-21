import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

// --- Mock: ollama-service (streamChat, getSystemPrompt) ---
const mockStreamChat = vi.fn();
const mockGetSystemPrompt = vi.fn().mockReturnValue('You are a helpful knowledge base assistant');

vi.mock('../../domains/llm/services/ollama-service.js', () => ({
  listModels: vi.fn(),
  checkHealth: vi.fn(),
  streamChat: (...args: unknown[]) => mockStreamChat(...args),
  chat: vi.fn(),
  getSystemPrompt: (...args: unknown[]) => mockGetSystemPrompt(...args),
  generateEmbedding: vi.fn(),
  LANGUAGE_PRESERVATION_INSTRUCTION: '',
}));

// --- Mock: llm-provider-resolver (resolveUsecase) ---
const mockResolveUsecase = vi.fn().mockResolvedValue({
  config: {
    providerId: 'p1',
    baseUrl: 'http://x/v1',
    apiKey: null,
    authType: 'none',
    verifySsl: true,
    name: 'X',
    defaultModel: 'm',
  },
  model: 'm',
});

vi.mock('../../domains/llm/services/llm-provider-resolver.js', () => ({
  resolveUsecase: (...args: unknown[]) => mockResolveUsecase(...args),
}));

// --- Mock: openai-compatible-client (streamChat — queue + breakers wrapped inside) ---
const mockStreamChatClient = vi.fn();

vi.mock('../../domains/llm/services/openai-compatible-client.js', () => ({
  streamChat: (...args: unknown[]) => mockStreamChatClient(...args),
  chat: vi.fn(),
  generateEmbedding: vi.fn(),
  listModels: vi.fn(),
  checkHealth: vi.fn(),
  invalidateDispatcher: vi.fn(),
}));

// --- Mock: postgres query ---
// Default returns a row with id so saveConversation INSERT can read rows[0].id.
// Also returns non-openai llm_provider so resolveUserProvider falls back to Ollama.
const mockQuery = vi.fn().mockResolvedValue({ rows: [{ id: 'test-conv-id' }] });

vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

// --- Mock: rag-service (hybridSearch and buildRagContext) ---
const mockHybridSearch = vi.fn();
const mockBuildRagContext = vi.fn().mockReturnValue('Relevant context from the knowledge base.');

vi.mock('../../domains/llm/services/rag-service.js', () => ({
  hybridSearch: (...args: unknown[]) => mockHybridSearch(...args),
  buildRagContext: (...args: unknown[]) => mockBuildRagContext(...args),
}));

// --- Mock: content-converter (htmlToMarkdown used in other routes in same file) ---
vi.mock('../../core/services/content-converter.js', () => ({
  htmlToMarkdown: vi.fn((html: string) => html),
}));

// --- Mock: embedding-service (defensive, not used by ask route directly) ---
vi.mock('../../domains/llm/services/embedding-service.js', () => ({
  getEmbeddingStatus: vi.fn(),
  processDirtyPages: vi.fn(),
  reEmbedAll: vi.fn(),
  embedPage: vi.fn(),
  isProcessingUser: vi.fn().mockReturnValue(false),
  resetFailedEmbeddings: vi.fn().mockResolvedValue(0),
}));

// --- Mock: llm-cache (class-based, matches analyze-quality.test.ts pattern) ---
const mockGetCachedResponse = vi.fn().mockResolvedValue(null);
const mockSetCachedResponse = vi.fn().mockResolvedValue(undefined);

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

// Import the route after all mocks are registered
import { llmAskRoutes } from './llm-ask.js';

// --- Helpers ---

/** Parse SSE body into an array of parsed JSON objects from `data: ` lines. */
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

describe('POST /api/llm/ask', () => {
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

    await app.register(llmAskRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to defaults after clearAllMocks
    mockGetCachedResponse.mockResolvedValue(null);
    mockSetCachedResponse.mockResolvedValue(undefined);
    mockGetSystemPrompt.mockReturnValue('You are a helpful knowledge base assistant');
    // Default query mock: returns row with id for saveConversation INSERT
    mockQuery.mockResolvedValue({ rows: [{ id: 'test-conv-id' }] });
    mockBuildRagContext.mockReturnValue('Relevant context from the knowledge base.');
    // Default resolveUsecase: provider 'p1' with model 'm'
    mockResolveUsecase.mockResolvedValue({
      config: {
        providerId: 'p1',
        baseUrl: 'http://x/v1',
        apiKey: null,
        authType: 'none',
        verifySsl: true,
        name: 'X',
        defaultModel: 'm',
      },
      model: 'm',
    });
  });

  // ─── Validation tests ────────────────────────────────────────────────────

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
      payload: { question: 'What is the deployment process?' },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
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

  // ─── Streaming tests ─────────────────────────────────────────────────────

  it('should return 200 with text/event-stream and sources array including pageId in final event', async () => {
    // Arrange
    const fakeResults = [
      {
        pageId: 42,
        confluenceId: 'page-abc',
        chunkText: 'Deployment is done via CI/CD pipeline.',
        pageTitle: 'Deployment Guide',
        sectionTitle: 'Overview',
        spaceKey: 'OPS',
        score: 0.9,
      },
    ];
    mockHybridSearch.mockResolvedValue(fakeResults);
    mockStreamChatClient.mockReturnValue(singleChunkGenerator('The deployment process uses CI/CD.'));

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/ask',
      payload: {
        question: 'What is the deployment process?',
        model: 'llama3',
      },
    });

    // Assert: HTTP metadata
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');

    // Assert: SSE events
    const events = parseSseBody(response.body);
    expect(events.length).toBeGreaterThanOrEqual(2); // at least one content chunk + final event

    // Final event should contain sources with pageId
    const finalEvent = events.find((e: unknown) => (e as Record<string, unknown>).final === true) as Record<string, unknown>;
    expect(finalEvent).toBeDefined();
    expect(finalEvent!.done).toBe(true);

    const sources = finalEvent!.sources as Array<Record<string, unknown>>;
    expect(Array.isArray(sources)).toBe(true);
    expect(sources).toHaveLength(1);
    expect(sources[0].pageId).toBe(42);
    expect(sources[0].confluenceId).toBe('page-abc');
    expect(sources[0].pageTitle).toBe('Deployment Guide');
    expect(sources[0].score).toBe(0.9);

    // conversationId should be set from the INSERT
    expect(finalEvent!.conversationId).toBe('test-conv-id');
  });

  it('should call hybridSearch with the user question', async () => {
    mockHybridSearch.mockResolvedValue([]);
    mockBuildRagContext.mockReturnValue('No relevant context found in the knowledge base.');
    mockStreamChatClient.mockReturnValue(singleChunkGenerator('I could not find relevant information.'));

    await app.inject({
      method: 'POST',
      url: '/api/llm/ask',
      payload: { question: 'How do I reset my password?', model: 'llama3' },
    });

    expect(mockHybridSearch).toHaveBeenCalledWith('test-user-123', 'How do I reset my password?');
  });

  // ─── Cache hit test ──────────────────────────────────────────────────────

  it('should return cached response with sources array including pageId when cache hit', async () => {
    // Arrange
    const fakeResults = [
      {
        pageId: 77,
        confluenceId: 'page-xyz',
        chunkText: 'Password reset instructions are in the docs.',
        pageTitle: 'Password Reset Guide',
        sectionTitle: 'Instructions',
        spaceKey: 'HR',
        score: 0.85,
      },
    ];
    mockHybridSearch.mockResolvedValue(fakeResults);
    mockGetCachedResponse.mockResolvedValue({ content: 'Go to Settings > Security > Reset Password.' });

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/ask',
      payload: {
        question: 'How do I reset my password?',
        model: 'llama3',
      },
    });

    // Assert
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');

    const events = parseSseBody(response.body);

    // First event: cached content
    const cachedEvent = events.find((e: unknown) => (e as Record<string, unknown>).cached === true) as Record<string, unknown>;
    expect(cachedEvent).toBeDefined();
    expect(cachedEvent!.content).toContain('Reset Password');

    // Second event: extras with sources and pageId
    const finalEvent = events.find((e: unknown) => (e as Record<string, unknown>).final === true) as Record<string, unknown>;
    expect(finalEvent).toBeDefined();
    const sources = finalEvent!.sources as Array<Record<string, unknown>>;
    expect(Array.isArray(sources)).toBe(true);
    expect(sources[0].pageId).toBe(77);
    expect(sources[0].confluenceId).toBe('page-xyz');

    // The LLM should NOT have been called
    expect(mockStreamChatClient).not.toHaveBeenCalled();
  });

  // ─── Empty results test ──────────────────────────────────────────────────

  it('should return 200 and stream LLM response even when hybridSearch returns empty results', async () => {
    // Arrange: no RAG results → buildRagContext returns "no context" message
    mockHybridSearch.mockResolvedValue([]);
    mockBuildRagContext.mockReturnValue('No relevant context found in the knowledge base.');
    mockStreamChatClient.mockReturnValue(singleChunkGenerator('I do not have enough context to answer.'));

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/ask',
      payload: {
        question: 'What is the meaning of life?',
        model: 'llama3',
      },
    });

    // Assert: 200 with SSE — the LLM still streams even with no context
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');

    const events = parseSseBody(response.body);
    expect(events.length).toBeGreaterThanOrEqual(2);

    const contentEvents = events.filter((e: unknown) => (e as Record<string, unknown>).content !== undefined);
    expect(contentEvents.length).toBeGreaterThan(0);

    // Sources should be empty array
    const finalEvent = events.find((e: unknown) => (e as Record<string, unknown>).final === true) as Record<string, unknown>;
    expect(finalEvent).toBeDefined();
    const sources = finalEvent!.sources as Array<unknown>;
    expect(Array.isArray(sources)).toBe(true);
    expect(sources).toHaveLength(0);
  });

  // ─── Use-case resolution ─────────────────────────────────────────────────

  describe('chat use-case resolution', () => {
    it('consults resolveUsecase("chat") on every request', async () => {
      mockHybridSearch.mockResolvedValue([]);
      mockStreamChatClient.mockReturnValue(singleChunkGenerator('answer'));

      await app.inject({
        method: 'POST',
        url: '/api/llm/ask',
        payload: { question: 'hi', model: 'llama3' },
      });

      expect(mockResolveUsecase).toHaveBeenCalledWith('chat');
    });

    it('streams via the resolved provider config + model', async () => {
      mockHybridSearch.mockResolvedValue([]);
      mockResolveUsecase.mockResolvedValue({
        config: {
          providerId: 'provider-openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
          authType: 'bearer',
          verifySsl: true,
          name: 'OpenAI',
          defaultModel: 'gpt-4o-mini',
        },
        model: 'gpt-4o-mini',
      });
      mockStreamChatClient.mockReturnValue(singleChunkGenerator('answer'));

      const response = await app.inject({
        method: 'POST',
        url: '/api/llm/ask',
        payload: { question: 'hi', model: 'ignored-body-model' },
      });

      expect(response.statusCode).toBe(200);
      expect(mockStreamChatClient).toHaveBeenCalledTimes(1);
      const [cfg, usedModel] = mockStreamChatClient.mock.calls[0] as [
        { providerId: string },
        string,
      ];
      expect(cfg.providerId).toBe('provider-openai');
      expect(usedModel).toBe('gpt-4o-mini');
    });
  });
});
