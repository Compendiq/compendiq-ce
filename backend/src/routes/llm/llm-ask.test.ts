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

// --- Mock: llm-provider (issue #217 — spy the per-user and per-usecase stream
// dispatchers so we can assert which branch the route took). ---
const mockProviderStreamChat = vi.fn();
const mockProviderStreamChatForUsecase = vi.fn();
const mockResolveUserProvider = vi.fn().mockResolvedValue({ type: 'ollama' });
vi.mock('../../domains/llm/services/llm-provider.js', () => ({
  providerStreamChat: (...args: unknown[]) => mockProviderStreamChat(...args),
  providerStreamChatForUsecase: (...args: unknown[]) => mockProviderStreamChatForUsecase(...args),
  resolveUserProvider: (...args: unknown[]) => mockResolveUserProvider(...args),
  providerChatForUsecase: vi.fn(),
  providerGenerateEmbedding: vi.fn(),
}));

// --- Mock: admin-settings-service (issue #217 — chat usecase resolver). ---
// Default: no override — route should dispatch via providerStreamChat.
const mockGetUsecaseLlmAssignment = vi.fn().mockResolvedValue({
  provider: 'ollama',
  model: '',
  source: { provider: 'shared', model: 'shared' },
});
vi.mock('../../core/services/admin-settings-service.js', () => ({
  getUsecaseLlmAssignment: (...args: unknown[]) => mockGetUsecaseLlmAssignment(...args),
}));

// --- Mock: circuit-breaker (used internally by ollama-service/llm-provider) ---
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
    // Default query mock: returns row with id for saveConversation INSERT,
    // and empty llm_provider so resolveUserProvider falls back to Ollama
    mockQuery.mockResolvedValue({ rows: [{ id: 'test-conv-id' }] });
    mockBuildRagContext.mockReturnValue('Relevant context from the knowledge base.');
    // Issue #217: default to no chat-usecase override so the route takes the
    // per-user routing branch (providerStreamChat).
    mockGetUsecaseLlmAssignment.mockResolvedValue({
      provider: 'ollama',
      model: '',
      source: { provider: 'shared', model: 'shared' },
    });
    mockResolveUserProvider.mockResolvedValue({ type: 'ollama' });
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
    mockProviderStreamChat.mockReturnValue(singleChunkGenerator('The deployment process uses CI/CD.'));

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
    mockProviderStreamChat.mockReturnValue(singleChunkGenerator('I could not find relevant information.'));

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
    expect(mockProviderStreamChat).not.toHaveBeenCalled();
    expect(mockProviderStreamChatForUsecase).not.toHaveBeenCalled();
  });

  // ─── Empty results test ──────────────────────────────────────────────────

  it('should return 200 and stream LLM response even when hybridSearch returns empty results', async () => {
    // Arrange: no RAG results → buildRagContext returns "no context" message
    mockHybridSearch.mockResolvedValue([]);
    mockBuildRagContext.mockReturnValue('No relevant context found in the knowledge base.');
    mockProviderStreamChat.mockReturnValue(singleChunkGenerator('I do not have enough context to answer.'));

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

  // ─── Issue #217 — chat usecase routing ──────────────────────────────────

  describe('issue #217 — chat usecase routing', () => {
    it('consults getUsecaseLlmAssignment("chat") on every request', async () => {
      mockHybridSearch.mockResolvedValue([]);
      mockProviderStreamChat.mockReturnValue(singleChunkGenerator('answer'));

      await app.inject({
        method: 'POST',
        url: '/api/llm/ask',
        payload: { question: 'hi', model: 'llama3' },
      });

      expect(mockGetUsecaseLlmAssignment).toHaveBeenCalledWith('chat');
    });

    it('routes via providerStreamChatForUsecase when admin set a chat override (both provider and model)', async () => {
      mockHybridSearch.mockResolvedValue([]);
      // Admin has set provider=openai AND model=gpt-4o-mini for chat.
      mockGetUsecaseLlmAssignment.mockResolvedValue({
        provider: 'openai',
        model: 'gpt-4o-mini',
        source: { provider: 'usecase', model: 'usecase' },
      });
      mockProviderStreamChatForUsecase.mockReturnValue(singleChunkGenerator('answer'));

      const response = await app.inject({
        method: 'POST',
        url: '/api/llm/ask',
        payload: { question: 'hi', model: 'llama3' }, // body model ignored
      });

      expect(response.statusCode).toBe(200);
      expect(mockProviderStreamChatForUsecase).toHaveBeenCalledTimes(1);
      expect(mockProviderStreamChat).not.toHaveBeenCalled();

      const [provider, usedModel] = mockProviderStreamChatForUsecase.mock.calls[0] as [
        string,
        string,
      ];
      expect(provider).toBe('openai');
      expect(usedModel).toBe('gpt-4o-mini');
    });

    it('preserves per-user routing when no chat override is set', async () => {
      mockHybridSearch.mockResolvedValue([]);
      mockProviderStreamChat.mockReturnValue(singleChunkGenerator('answer'));
      // Default resolver result (shared source) left from beforeEach.

      const response = await app.inject({
        method: 'POST',
        url: '/api/llm/ask',
        payload: { question: 'hi', model: 'llama3' },
      });

      expect(response.statusCode).toBe(200);
      expect(mockProviderStreamChat).toHaveBeenCalledTimes(1);
      expect(mockProviderStreamChatForUsecase).not.toHaveBeenCalled();

      const [userId, usedModel] = mockProviderStreamChat.mock.calls[0] as [string, string];
      expect(userId).toBe('test-user-123');
      expect(usedModel).toBe('llama3'); // body model preserved
    });

    it('honors body.model when admin pinned only the provider (source.model !== "usecase")', async () => {
      mockHybridSearch.mockResolvedValue([]);
      // Admin set provider=openai but left model inherited (shared/env).
      mockGetUsecaseLlmAssignment.mockResolvedValue({
        provider: 'openai',
        model: 'qwen3.5', // shared fallback
        source: { provider: 'usecase', model: 'shared' },
      });
      mockProviderStreamChatForUsecase.mockReturnValue(singleChunkGenerator('answer'));

      await app.inject({
        method: 'POST',
        url: '/api/llm/ask',
        payload: { question: 'hi', model: 'user-picked-model' },
      });

      expect(mockProviderStreamChatForUsecase).toHaveBeenCalledTimes(1);
      const [provider, usedModel] = mockProviderStreamChatForUsecase.mock.calls[0] as [
        string,
        string,
      ];
      expect(provider).toBe('openai');
      // Q2 decision: body model wins when source.model !== 'usecase'.
      expect(usedModel).toBe('user-picked-model');
    });
  });
});
