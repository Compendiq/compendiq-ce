import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

const mockProviderStreamChat = vi.fn();

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
}));

const mockGetCachedResponse = vi.fn().mockResolvedValue(null);

vi.mock('../../domains/llm/services/llm-cache.js', () => {
  class MockLlmCache {
    getCachedResponse = mockGetCachedResponse;
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

describe('POST /api/llm/improve - instruction field', () => {
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

    await app.register(llmImproveRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCachedResponse.mockResolvedValue(null);
  });

  it('should accept a request without instruction (backward compatible)', async () => {
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
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');
  });

  it('should accept a request with optional instruction', async () => {
    async function* mockGenerator() {
      yield { content: 'Improved text with focus', done: true };
    }
    mockProviderStreamChat.mockReturnValue(mockGenerator());

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improve',
      payload: {
        content: '<p>Original text</p>',
        type: 'grammar',
        model: 'llama3',
        instruction: 'Focus on the introduction paragraph',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');

    // Verify instruction was passed to providerStreamChat in the system prompt
    expect(mockProviderStreamChat).toHaveBeenCalledTimes(1);
    const callArgs = mockProviderStreamChat.mock.calls[0];
    const messages = callArgs[2]; // third argument is messages array
    const systemMessage = messages.find((m: { role: string }) => m.role === 'system');
    expect(systemMessage.content).toContain('ADDITIONAL USER INSTRUCTIONS');
    expect(systemMessage.content).toContain('Focus on the introduction paragraph');
  });

  it('should not include ADDITIONAL USER INSTRUCTIONS when instruction is absent', async () => {
    async function* mockGenerator() {
      yield { content: 'Improved text', done: true };
    }
    mockProviderStreamChat.mockReturnValue(mockGenerator());

    await app.inject({
      method: 'POST',
      url: '/api/llm/improve',
      payload: {
        content: '<p>Original text</p>',
        type: 'clarity',
        model: 'llama3',
      },
    });

    expect(mockProviderStreamChat).toHaveBeenCalledTimes(1);
    const callArgs = mockProviderStreamChat.mock.calls[0];
    const messages = callArgs[2];
    const systemMessage = messages.find((m: { role: string }) => m.role === 'system');
    expect(systemMessage.content).not.toContain('ADDITIONAL USER INSTRUCTIONS');
  });

  it('should strip HTML tags from instruction', async () => {
    async function* mockGenerator() {
      yield { content: 'Improved', done: true };
    }
    mockProviderStreamChat.mockReturnValue(mockGenerator());

    await app.inject({
      method: 'POST',
      url: '/api/llm/improve',
      payload: {
        content: '<p>Text</p>',
        type: 'grammar',
        model: 'llama3',
        instruction: 'Focus on <script>alert("xss")</script> the intro',
      },
    });

    expect(mockProviderStreamChat).toHaveBeenCalledTimes(1);
    const callArgs = mockProviderStreamChat.mock.calls[0];
    const messages = callArgs[2];
    const systemMessage = messages.find((m: { role: string }) => m.role === 'system');
    // HTML tags should be stripped
    expect(systemMessage.content).not.toContain('<script>');
    expect(systemMessage.content).toContain('Focus on');
    expect(systemMessage.content).toContain('the intro');
  });

  it('should reject instruction exceeding 10000 characters via schema validation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improve',
      payload: {
        content: '<p>Text</p>',
        type: 'grammar',
        model: 'llama3',
        instruction: 'x'.repeat(10001),
      },
    });

    // Zod validation should reject this
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('should accept empty string instruction (treated as absent)', async () => {
    async function* mockGenerator() {
      yield { content: 'Improved text', done: true };
    }
    mockProviderStreamChat.mockReturnValue(mockGenerator());

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improve',
      payload: {
        content: '<p>Text</p>',
        type: 'grammar',
        model: 'llama3',
        instruction: '',
      },
    });

    // Empty string passes z.string().max(10000).optional() but is falsy in the handler
    expect(response.statusCode).toBe(200);

    expect(mockProviderStreamChat).toHaveBeenCalledTimes(1);
    const callArgs = mockProviderStreamChat.mock.calls[0];
    const messages = callArgs[2];
    const systemMessage = messages.find((m: { role: string }) => m.role === 'system');
    expect(systemMessage.content).not.toContain('ADDITIONAL USER INSTRUCTIONS');
  });
});
