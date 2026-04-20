import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

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

// --- Mock: llm-cache ---
const mockGetCachedResponse = vi.fn().mockResolvedValue(null);
const mockReleaseLock = vi.fn().mockResolvedValue(undefined);

vi.mock('../../domains/llm/services/llm-cache.js', () => {
  class MockLlmCache {
    getCachedResponse = mockGetCachedResponse;
    setCachedResponse = vi.fn().mockResolvedValue(undefined);
    acquireLock = vi.fn().mockResolvedValue(true);
    releaseLock = mockReleaseLock;
    waitForCachedResponse = vi.fn().mockResolvedValue(null);
    clearAll = vi.fn();
  }
  return {
    LlmCache: MockLlmCache,
    buildLlmCacheKey: vi.fn().mockReturnValue('test-cache-key'),
  };
});

// --- Mock: _web-search-helper ---
const mockFetchWebSources = vi.fn().mockResolvedValue([]);
const mockFormatWebContext = vi.fn().mockReturnValue('');

vi.mock('./_web-search-helper.js', () => ({
  fetchWebSources: (...args: unknown[]) => mockFetchWebSources(...args),
  formatWebContext: (...args: unknown[]) => mockFormatWebContext(...args),
}));

// --- Mock: audit-service ---
const mockLogAuditEvent = vi.fn().mockResolvedValue(undefined);

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
}));

// --- Mock: _helpers ---
const mockAssembleContextIfNeeded = vi.fn().mockResolvedValue({ markdown: 'test content', multiPageSuffix: '' });
const mockResolveSystemPrompt = vi.fn().mockResolvedValue('You are a summarizer');
const mockCheckCacheWithLock = vi.fn().mockResolvedValue({ cached: null, lockAcquired: true });
const mockSendCachedSSE = vi.fn();
const mockStreamSSE = vi.fn().mockResolvedValue(undefined);
const mockSanitizeLlmInput = vi.fn((input: string) => ({ sanitized: input, warnings: [] }));
const mockBuildOutputPostProcessor = vi.fn().mockResolvedValue((text: string) => text);

vi.mock('./_helpers.js', () => ({
  assembleContextIfNeeded: (...args: unknown[]) => mockAssembleContextIfNeeded(...args),
  resolveSystemPrompt: (...args: unknown[]) => mockResolveSystemPrompt(...args),
  checkCacheWithLock: (...args: unknown[]) => mockCheckCacheWithLock(...args),
  sendCachedSSE: (...args: unknown[]) => mockSendCachedSSE(...args),
  streamSSE: (...args: unknown[]) => mockStreamSSE(...args),
  sanitizeLlmInput: (...args: unknown[]) => mockSanitizeLlmInput(...args),
  buildOutputPostProcessor: (...args: unknown[]) => mockBuildOutputPostProcessor(...args),
  LLM_STREAM_RATE_LIMIT: {},
  MAX_INPUT_LENGTH: 100_000,
}));

import { llmSummarizeRoutes } from './llm-summarize.js';

// =============================================================================
// Test Suite 1: Auth-required tests
// =============================================================================

describe('POST /api/llm/summarize - auth required', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.decorate('authenticate', async () => {
      throw app.httpErrors.unauthorized('Missing or invalid token');
    });
    app.decorate('requireAdmin', async () => {});
    app.decorate('redis', {});
    app.decorateRequest('userId', '');

    await app.register(llmSummarizeRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should return 401 when no auth token is provided', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/summarize',
      payload: { content: 'Some article text', model: 'llama3' },
    });

    expect(response.statusCode).toBe(401);
  });
});

// =============================================================================
// Test Suite 2: Validation, caching, streaming, and business logic
// =============================================================================

describe('POST /api/llm/summarize - functionality', () => {
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
      // Mock userCan: grant all permissions (individual tests don't exercise RBAC)
      request.userCan = async () => true;
    });

    await app.register(llmSummarizeRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset defaults
    mockAssembleContextIfNeeded.mockResolvedValue({ markdown: 'test content', multiPageSuffix: '' });
    mockResolveSystemPrompt.mockResolvedValue('You are a summarizer');
    mockCheckCacheWithLock.mockResolvedValue({ cached: null, lockAcquired: true });
    mockSanitizeLlmInput.mockImplementation((input: string) => ({ sanitized: input, warnings: [] }));
    mockBuildOutputPostProcessor.mockResolvedValue((text: string) => text);
    mockStreamSSE.mockResolvedValue(undefined);
    mockFetchWebSources.mockResolvedValue([]);
    mockStreamChatClient.mockReturnValue((async function* () {
      yield { content: 'Summary text', done: true };
    })());
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

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  it('should return 400 when content is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/summarize',
      payload: { model: 'llama3' },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('should return 400 when model is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/summarize',
      payload: { content: 'Some text to summarize' },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('should return 400 when content exceeds MAX_INPUT_LENGTH', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/summarize',
      payload: {
        content: 'x'.repeat(100_001),
        model: 'llama3',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.message).toContain('Content too large');
  });

  // ---------------------------------------------------------------------------
  // Cache hit
  // ---------------------------------------------------------------------------

  it('should return cached SSE response when cache has a hit', async () => {
    mockCheckCacheWithLock.mockResolvedValue({
      cached: { content: 'Cached summary result' },
      lockAcquired: false,
    });

    await app.inject({
      method: 'POST',
      url: '/api/llm/summarize',
      payload: { content: 'Some text', model: 'llama3' },
    });

    expect(mockSendCachedSSE).toHaveBeenCalledOnce();
    expect(mockSendCachedSSE).toHaveBeenCalledWith(
      expect.anything(),
      'Cached summary result',
    );
    // streamSSE should NOT be called on cache hit
    expect(mockStreamSSE).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Successful stream
  // ---------------------------------------------------------------------------

  it('should return 200 with SSE stream for valid request', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/llm/summarize',
      payload: { content: 'Some article text to summarize', model: 'llama3' },
    });

    // streamSSE was called (it handles writing the response)
    expect(mockStreamSSE).toHaveBeenCalledOnce();
    expect(mockStreamChatClient).toHaveBeenCalledOnce();

    // Verify streamChat was called with the resolved provider config + model + messages
    const [cfg, model, messages] = mockStreamChatClient.mock.calls[0] as [
      { providerId: string }, string, Array<{ role: string; content: string }>,
    ];
    expect(cfg.providerId).toBe('p1');
    expect(model).toBe('m');
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('should release lock in finally block after streaming', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/llm/summarize',
      payload: { content: 'Some text', model: 'llama3' },
    });

    expect(mockReleaseLock).toHaveBeenCalledWith('test-cache-key');
  });

  it('should not release lock when lockAcquired is false (cache hit)', async () => {
    mockCheckCacheWithLock.mockResolvedValue({
      cached: { content: 'Cached' },
      lockAcquired: false,
    });

    await app.inject({
      method: 'POST',
      url: '/api/llm/summarize',
      payload: { content: 'Some text', model: 'llama3' },
    });

    expect(mockReleaseLock).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Length parameter
  // ---------------------------------------------------------------------------

  it('should use "short" length instruction in system prompt', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/llm/summarize',
      payload: { content: 'Some text', model: 'llama3', length: 'short' },
    });

    const [, , messages] = mockStreamChatClient.mock.calls[0] as [unknown, string, Array<{ role: string; content: string }>];
    expect(messages[0].content).toContain('brief 2-3 sentence');
  });

  it('should use "medium" length instruction by default', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/llm/summarize',
      payload: { content: 'Some text', model: 'llama3' },
    });

    const [, , messages] = mockStreamChatClient.mock.calls[0] as [unknown, string, Array<{ role: string; content: string }>];
    expect(messages[0].content).toContain('1-2 paragraphs');
  });

  it('should use "detailed" length instruction in system prompt', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/llm/summarize',
      payload: { content: 'Some text', model: 'llama3', length: 'detailed' },
    });

    const [, , messages] = mockStreamChatClient.mock.calls[0] as [unknown, string, Array<{ role: string; content: string }>];
    expect(messages[0].content).toContain('detailed summary covering all important points');
  });

  // ---------------------------------------------------------------------------
  // Sanitization warnings trigger audit event
  // ---------------------------------------------------------------------------

  it('should log audit event when sanitization finds warnings', async () => {
    mockSanitizeLlmInput.mockImplementation((input: string) => ({
      sanitized: input,
      warnings: ['Suspicious pattern detected'],
    }));

    await app.inject({
      method: 'POST',
      url: '/api/llm/summarize',
      payload: { content: 'Some suspicious text', model: 'llama3' },
    });

    expect(mockLogAuditEvent).toHaveBeenCalledOnce();
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      'test-user-123',
      'PROMPT_INJECTION_DETECTED',
      'llm',
      undefined,
      { warnings: ['Suspicious pattern detected'], route: '/llm/summarize' },
      expect.anything(), // request object
    );
  });

  it('should not log audit event when sanitization has no warnings', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/llm/summarize',
      payload: { content: 'Normal text', model: 'llama3' },
    });

    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Web search integration
  // ---------------------------------------------------------------------------

  it('should fetch web sources when searchWeb is true', async () => {
    mockFetchWebSources.mockResolvedValue([
      { title: 'Web Result', url: 'https://example.com', snippet: 'Some info' },
    ]);
    mockFormatWebContext.mockReturnValue('\n\n---\nReference: Web Result\n');

    await app.inject({
      method: 'POST',
      url: '/api/llm/summarize',
      payload: {
        content: 'Some text',
        model: 'llama3',
        searchWeb: true,
        searchQuery: 'test query',
      },
    });

    expect(mockFetchWebSources).toHaveBeenCalledWith('test query', 'test-user-123');
    expect(mockFormatWebContext).toHaveBeenCalledOnce();

    // streamSSE should receive extras with sources
    const streamCall = mockStreamSSE.mock.calls[0] as unknown[];
    const extras = streamCall[3] as { sources: Array<Record<string, unknown>> };
    expect(extras).toBeDefined();
    expect(extras.sources).toHaveLength(1);
    expect(extras.sources[0].spaceKey).toBe('Web');
    expect(extras.sources[0].confluenceId).toBe('https://example.com');
  });

  it('should not fetch web sources when searchWeb is not set', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/llm/summarize',
      payload: { content: 'Some text', model: 'llama3' },
    });

    expect(mockFetchWebSources).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // assembleContextIfNeeded integration
  // ---------------------------------------------------------------------------

  it('should pass includeSubPages to assembleContextIfNeeded', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/llm/summarize',
      payload: {
        content: 'Some text',
        model: 'llama3',
        pageId: 'page-123',
        includeSubPages: true,
      },
    });

    expect(mockAssembleContextIfNeeded).toHaveBeenCalledWith(
      'test-user-123',
      'page-123',
      'Some text',
      true,
    );
  });

  it('should include multiPageSuffix in system prompt', async () => {
    mockAssembleContextIfNeeded.mockResolvedValue({
      markdown: 'multi-page content',
      multiPageSuffix: ' (includes 3 sub-pages)',
    });

    await app.inject({
      method: 'POST',
      url: '/api/llm/summarize',
      payload: {
        content: 'Some text',
        model: 'llama3',
        pageId: 'page-123',
        includeSubPages: true,
      },
    });

    const [, , messages] = mockStreamChatClient.mock.calls[0] as [unknown, string, Array<{ role: string; content: string }>];
    expect(messages[0].content).toContain('(includes 3 sub-pages)');
  });

  // ---------------------------------------------------------------------------
  // summary use-case resolution
  // ---------------------------------------------------------------------------

  it('consults resolveUsecase("summary") on every request', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/llm/summarize',
      payload: { content: 'Some text', model: 'llama3' },
    });

    expect(mockResolveUsecase).toHaveBeenCalledWith('summary');
  });

  it('streams via the resolved provider config + model', async () => {
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

    await app.inject({
      method: 'POST',
      url: '/api/llm/summarize',
      payload: { content: 'Some text', model: 'ignored-body-model' },
    });

    expect(mockStreamChatClient).toHaveBeenCalledOnce();
    const [cfg, usedModel] = mockStreamChatClient.mock.calls[0] as [
      { providerId: string }, string,
    ];
    expect(cfg.providerId).toBe('provider-openai');
    expect(usedModel).toBe('gpt-4o-mini');
  });
});
