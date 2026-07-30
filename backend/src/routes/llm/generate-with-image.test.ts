import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

// Mock prompts module (getSystemPrompt extracted from the legacy ollama-service)
const mockStreamChat = vi.fn();
const mockGetSystemPrompt = vi.fn().mockImplementation((key: string) => `System prompt for: ${key}`);

vi.mock('../../domains/llm/services/prompts.js', () => ({
  getSystemPrompt: (...args: unknown[]) => mockGetSystemPrompt(...args),
  LANGUAGE_PRESERVATION_INSTRUCTION: '',
  // #1154: REQUIRED, even though nothing here asserts on it. The route calls
  // `contentToText` when building its audit payload; omitting it from this mock
  // makes that expression throw *after* streamSSE has hijacked and ended the
  // reply, so the error is swallowed, `inject` still resolves 200, and every
  // test below passes while the whole tail of the handler — audit, cache write,
  // lock release — silently never runs. The real implementation flattens the
  // content-part array; here content is always a bare string.
  contentToText: (content: unknown) =>
    (typeof content === 'string'
      ? content
      : (content as Array<{ type: string; text?: string }>)
          .filter((p) => p.type === 'text').map((p) => p.text).join('\n')),
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
const mockBuildLlmCacheKey = vi.fn().mockReturnValue('test-cache-key');

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
    buildLlmCacheKey: (...args: unknown[]) => mockBuildLlmCacheKey(...args),
    buildRagCacheKey: vi.fn(),
  };
});

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn(),
}));

// Mock _web-search-helper (fetchWebSources hits the MCP docs sidecar over HTTP)
const mockFetchWebSources = vi.fn().mockResolvedValue({ sources: [], injectionWarnings: [] });
const mockFormatWebContext = vi.fn().mockReturnValue('');

vi.mock('./_web-search-helper.js', () => ({
  fetchWebSources: (...args: unknown[]) => mockFetchWebSources(...args),
  formatWebContext: (...args: unknown[]) => mockFormatWebContext(...args),
}));

const mockEmitLlmAudit = vi.fn();
vi.mock('../../domains/llm/services/llm-audit-hook.js', async (importActual) => {
  const actual = await importActual<typeof import('../../domains/llm/services/llm-audit-hook.js')>();
  return {
    ...actual,
    emitLlmAudit: (...args: unknown[]) => mockEmitLlmAudit(...args),
  };
});

const mockSanitizeLlmInput = vi.fn((input: string) => ({ sanitized: input, warnings: [] }));
vi.mock('../../core/utils/sanitize-llm-input.js', () => ({
  sanitizeLlmInput: (...args: unknown[]) => mockSanitizeLlmInput(...args as [string]),
}));

vi.mock('../../domains/confluence/services/subpage-context.js', () => ({
  assembleSubPageContext: vi.fn(),
  getMultiPagePromptSuffix: vi.fn().mockReturnValue(''),
}));

const mockGetVisionCapability = vi.fn();
vi.mock('../../domains/llm/services/model-capabilities.js', () => ({
  getVisionCapability: (...args: unknown[]) => mockGetVisionCapability(...args),
}));

const mockLoadStagedImage = vi.fn();
vi.mock('../../core/services/image-staging.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/services/image-staging.js')>();
  return {
    ...actual,
    loadStagedImage: (...args: unknown[]) => mockLoadStagedImage(...args),
  };
});

import { llmGenerateRoutes } from './llm-generate.js';

const HANDLE = 'a'.repeat(64);

describe('POST /llm/generate with an image (#1154)', () => {
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

  function inject(payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/api/llm/generate',
      payload: { model: 'llama3', ...payload },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildLlmCacheKey.mockReturnValue('test-cache-key');
    mockGetCachedResponse.mockResolvedValue(null);
    mockSanitizeLlmInput.mockImplementation((input: string) => ({ sanitized: input, warnings: [] }));
    mockFetchWebSources.mockResolvedValue({ sources: [], injectionWarnings: [] });
    mockFormatWebContext.mockReturnValue('');
    mockResolveUsecase.mockResolvedValue({
      config: {
        providerId: 'p1', baseUrl: 'http://x/v1', apiKey: null,
        authType: 'none', verifySsl: true, name: 'X', defaultModel: 'm',
      },
      model: 'm',
    });
    mockGetVisionCapability.mockReset().mockResolvedValue(true);
    mockLoadStagedImage.mockReset().mockResolvedValue({
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), format: 'png',
    });

    async function* mockGenerator() {
      yield { content: 'Generated content', done: true };
    }
    mockStreamChat.mockReturnValue(mockGenerator());
  });

  it('sends the image as a content part on the user message', async () => {
    await inject({ prompt: 'describe this', imageHandle: HANDLE });

    const messages = mockStreamChat.mock.calls[0]![2];
    const user = messages.find((m: { role: string }) => m.role === 'user');
    expect(Array.isArray(user.content)).toBe(true);
    expect(user.content.some((p: { type: string }) => p.type === 'image_url')).toBe(true);
  });

  it('keeps the system message a plain string', async () => {
    await inject({ prompt: 'x', imageHandle: HANDLE });
    const messages = mockStreamChat.mock.calls[0]![2];
    expect(typeof messages.find((m: { role: string }) => m.role === 'system').content).toBe('string');
  });

  it('sends a bare string when no image is attached', async () => {
    await inject({ prompt: 'x' });
    const messages = mockStreamChat.mock.calls[0]![2];
    expect(typeof messages.find((m: { role: string }) => m.role === 'user').content).toBe('string');
  });

  it('422s when the resolved model is text-only', async () => {
    mockGetVisionCapability.mockResolvedValue(false);
    const res = await inject({ prompt: 'x', imageHandle: HANDLE });
    expect(res.statusCode).toBe(422);
  });

  /** Fail closed: unknown is refused, not attempted. */
  it('422s when capability is unknown', async () => {
    mockGetVisionCapability.mockResolvedValue(null);
    const res = await inject({ prompt: 'x', imageHandle: HANDLE });
    expect(res.statusCode).toBe(422);
  });

  it('does not call the provider when the gate refuses', async () => {
    mockGetVisionCapability.mockResolvedValue(false);
    await inject({ prompt: 'x', imageHandle: HANDLE });
    expect(mockStreamChat).not.toHaveBeenCalled();
  });

  it('410s when the handle has expired', async () => {
    mockLoadStagedImage.mockResolvedValue(null);
    const res = await inject({ prompt: 'x', imageHandle: HANDLE });
    expect(res.statusCode).toBe(410);
  });

  it('rejects a malformed handle at the schema before any lookup', async () => {
    // Zod .parse() throws ZodError, which this isolated route harness (unlike
    // the full app.ts) has no handler to map to exactly 400 — see the same
    // note in generate-diagram.test.ts. The security property under test is
    // that the malformed handle never reaches loadStagedImage.
    const res = await inject({ prompt: 'x', imageHandle: 'not-a-handle' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(mockLoadStagedImage).not.toHaveBeenCalled();
  });

  it('does not check capability when no image is attached', async () => {
    await inject({ prompt: 'x' });
    expect(mockGetVisionCapability).not.toHaveBeenCalled();
  });

  /**
   * Two different images behind one prompt must not collide in the response
   * cache. `llm-cache.test.ts` proves the key function separates them; this
   * proves the route actually hands it the hash.
   */
  it('folds the image hash into the cache key', async () => {
    await inject({ prompt: 'x', imageHandle: HANDLE });
    expect(mockBuildLlmCacheKey).toHaveBeenCalledWith(
      'm', expect.any(String), expect.any(String), 'p1',
      expect.objectContaining({ imageHash: HANDLE }),
    );
  });

  it('leaves the image hash out of the cache key when no image is attached', async () => {
    await inject({ prompt: 'x' });
    expect(mockBuildLlmCacheKey).toHaveBeenCalledWith(
      'm', expect.any(String), expect.any(String), 'p1',
      expect.objectContaining({ imageHash: undefined }),
    );
  });

  /**
   * Guards the whole tail of the handler. Everything above asserts on state
   * captured *before* streaming, so a throw between `streamSSE` and the end of
   * the handler is invisible to them: the reply is already hijacked and ended,
   * so `inject` still resolves 200. That is exactly what an incomplete
   * `prompts.js` mock used to cause here — see the note on that mock.
   */
  it('reaches the audit call on the image path', async () => {
    await inject({ prompt: 'x', imageHandle: HANDLE });
    expect(mockEmitLlmAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'generate', status: 'success' }),
    );
  });

  /** Image parts contribute no text, so the audit must not count them as content. */
  it('audits the text length, not the content-part count', async () => {
    await inject({ prompt: 'describe this', imageHandle: HANDLE });
    const { inputMessages } = mockEmitLlmAudit.mock.calls[0]![0];
    const user = inputMessages.find((m: { role: string }) => m.role === 'user');
    expect(user.contentLength).toBeGreaterThan(2);
  });
});
