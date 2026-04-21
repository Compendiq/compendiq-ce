import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

// Mock prompts module (getSystemPrompt extracted from the legacy ollama-service)
const mockStreamChat = vi.fn();
const mockGetSystemPrompt = vi.fn().mockImplementation((key: string) => `System prompt for: ${key}`);

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
vi.mock('../../domains/llm/services/openai-compatible-client.js', () => ({
  streamChat: (...args: unknown[]) => mockStreamChat(...args),
  chat: vi.fn(),
  generateEmbedding: vi.fn(),
  listModels: vi.fn(),
  checkHealth: vi.fn(),
  invalidateDispatcher: vi.fn(),
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

const mockSanitizeLlmInput = vi.fn((input: string) => ({ sanitized: input, warnings: [] }));
vi.mock('../../core/utils/sanitize-llm-input.js', () => ({
  sanitizeLlmInput: (...args: unknown[]) => mockSanitizeLlmInput(...args as [string]),
}));

vi.mock('../../domains/confluence/services/subpage-context.js', () => ({
  assembleSubPageContext: vi.fn(),
  getMultiPagePromptSuffix: vi.fn().mockReturnValue(''),
}));

import { llmGenerateRoutes } from './llm-generate.js';

describe('POST /api/llm/generate with pdfText', () => {
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

    await app.register(llmGenerateRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCachedResponse.mockResolvedValue(null);
    mockSanitizeLlmInput.mockImplementation((input: string) => ({ sanitized: input, warnings: [] }));
  });

  it('should use generate_from_pdf system prompt when pdfText is provided', async () => {
    async function* mockGenerator() {
      yield { content: '# Article\n\nGenerated content.', done: true };
    }
    mockStreamChat.mockReturnValue(mockGenerator());

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/generate',
      payload: {
        prompt: 'Create a runbook from this document',
        model: 'llama3',
        pdfText: 'Extracted PDF text content here',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');
    expect(mockGetSystemPrompt).toHaveBeenCalledWith('generate_from_pdf');
  });

  it('should include PDF text in user message with proper formatting', async () => {
    async function* mockGenerator() {
      yield { content: '# Result', done: true };
    }
    mockStreamChat.mockReturnValue(mockGenerator());

    await app.inject({
      method: 'POST',
      url: '/api/llm/generate',
      payload: {
        prompt: 'Summarize this',
        model: 'llama3',
        pdfText: 'PDF document content',
      },
    });

    // Check the messages passed to streamChat
    const callArgs = mockStreamChat.mock.calls[0];
    const messages = callArgs[2]; // userId, model, messages
    const userMessage = messages.find((m: { role: string }) => m.role === 'user');

    expect(userMessage.content).toContain('## Source Document');
    expect(userMessage.content).toContain('PDF document content');
    expect(userMessage.content).toContain('## Instructions');
    expect(userMessage.content).toContain('Summarize this');
  });

  it('should sanitize pdfText before sending to LLM', async () => {
    async function* mockGenerator() {
      yield { content: 'Result', done: true };
    }
    mockStreamChat.mockReturnValue(mockGenerator());

    await app.inject({
      method: 'POST',
      url: '/api/llm/generate',
      payload: {
        prompt: 'Create article',
        model: 'llama3',
        pdfText: 'Some PDF text',
      },
    });

    // sanitizeLlmInput should be called for both prompt and pdfText
    expect(mockSanitizeLlmInput).toHaveBeenCalledWith('Create article');
    expect(mockSanitizeLlmInput).toHaveBeenCalledWith('Some PDF text');
  });

  it('should use template-specific prompt even with pdfText', async () => {
    async function* mockGenerator() {
      yield { content: '# Runbook', done: true };
    }
    mockStreamChat.mockReturnValue(mockGenerator());

    await app.inject({
      method: 'POST',
      url: '/api/llm/generate',
      payload: {
        prompt: 'Create runbook',
        model: 'llama3',
        template: 'runbook',
        pdfText: 'Some PDF text',
      },
    });

    expect(mockGetSystemPrompt).toHaveBeenCalledWith('generate_runbook');
  });

  it('should use default generate prompt when no pdfText and no template', async () => {
    async function* mockGenerator() {
      yield { content: '# Article', done: true };
    }
    mockStreamChat.mockReturnValue(mockGenerator());

    await app.inject({
      method: 'POST',
      url: '/api/llm/generate',
      payload: {
        prompt: 'Write about Docker',
        model: 'llama3',
      },
    });

    expect(mockGetSystemPrompt).toHaveBeenCalledWith('generate');
  });

  it('should log audit event when pdfText contains injection patterns', async () => {
    async function* mockGenerator() {
      yield { content: 'Result', done: true };
    }
    mockStreamChat.mockReturnValue(mockGenerator());

    mockSanitizeLlmInput.mockImplementation((input: string) => {
      if (input === 'Malicious PDF content') {
        return { sanitized: 'Cleaned content', warnings: ['Injection detected'] };
      }
      return { sanitized: input, warnings: [] };
    });

    const { logAuditEvent } = await import('../../core/services/audit-service.js');

    await app.inject({
      method: 'POST',
      url: '/api/llm/generate',
      payload: {
        prompt: 'Create article',
        model: 'llama3',
        pdfText: 'Malicious PDF content',
      },
    });

    expect(logAuditEvent).toHaveBeenCalledWith(
      'test-user-123',
      'PROMPT_INJECTION_DETECTED',
      'llm',
      undefined,
      expect.objectContaining({ field: 'pdfText' }),
      expect.anything(),
    );
  });

  it('should truncate pdfText when it exceeds MAX_PDF_TEXT_FOR_LLM', async () => {
    async function* mockGenerator() {
      yield { content: '# Result', done: true };
    }
    mockStreamChat.mockReturnValue(mockGenerator());

    const longPdf = 'A'.repeat(90_000);

    await app.inject({
      method: 'POST',
      url: '/api/llm/generate',
      payload: { prompt: 'Summarize this', model: 'llama3', pdfText: longPdf },
    });

    const callArgs = mockStreamChat.mock.calls[0];
    const messages = callArgs[2];
    const userMessage = messages.find((m: { role: string }) => m.role === 'user');

    expect(userMessage.content).toContain('[Document truncated');
    expect(userMessage.content.length).toBeLessThan(longPdf.length);
  });
});
