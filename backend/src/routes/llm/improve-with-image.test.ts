import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

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

// Mock _web-search-helper (fetchWebSources hits the MCP docs sidecar over HTTP)
const mockFetchWebSources = vi.fn().mockResolvedValue({ sources: [], injectionWarnings: [] });
const mockFormatWebContext = vi.fn().mockReturnValue('');

vi.mock('./_web-search-helper.js', () => ({
  fetchWebSources: (...args: unknown[]) => mockFetchWebSources(...args),
  formatWebContext: (...args: unknown[]) => mockFormatWebContext(...args),
}));

vi.mock('../../domains/confluence/services/sync-service.js', () => ({
  getClientForUser: vi.fn(),
}));

vi.mock('../../domains/confluence/services/subpage-context.js', () => ({
  assembleSubPageContext: vi.fn(),
  getMultiPagePromptSuffix: vi.fn().mockReturnValue(''),
}));

const mockEmitLlmAudit = vi.fn();
vi.mock('../../domains/llm/services/llm-audit-hook.js', async (importActual) => {
  const actual = await importActual<typeof import('../../domains/llm/services/llm-audit-hook.js')>();
  return {
    ...actual,
    emitLlmAudit: (...args: unknown[]) => mockEmitLlmAudit(...args),
  };
});

vi.mock('../../core/utils/sanitize-llm-input.js', () => ({
  sanitizeLlmInput: vi.fn((input: string) => ({ sanitized: input, warnings: [] })),
}));

const mockGetVisionCapability = vi.fn();
vi.mock('../../domains/llm/services/model-capabilities.js', () => ({
  getVisionCapability: (...args: unknown[]) => mockGetVisionCapability(...args),
}));

const mockLoadStagedImage = vi.fn();
vi.mock('../../core/services/image-staging.js', () => ({
  loadStagedImage: (...args: unknown[]) => mockLoadStagedImage(...args),
}));

import { llmImproveRoutes } from './llm-improve.js';

const HANDLE = 'a'.repeat(64);

/**
 * Wiring-only coverage (#1154): the gate and expiry semantics (422 text-only,
 * 422 unknown capability, 410 expired handle, 400 malformed handle) are
 * already asserted once in `resolve-image-part.test.ts` and must not be
 * re-asserted here — this file only proves Improve calls the shared helper
 * and threads its result into the message and cache key the same way
 * Generate does.
 */
function inject(app: ReturnType<typeof Fastify>, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/llm/improve',
    payload,
  });
}

describe('POST /llm/improve with an image (#1154)', () => {
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

    await app.register(llmImproveRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCachedResponse.mockResolvedValue(null);
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

    async function* generator() {
      yield { content: 'Improved text', done: true };
    }
    mockStreamChat.mockReturnValue(generator());
  });

  it('sends the image as a content part on the user message', async () => {
    await inject(app, { content: 'x', type: 'clarity', imageHandle: HANDLE });
    const user = mockStreamChat.mock.calls[0]![2]
      .find((m: { role: string }) => m.role === 'user');
    expect(user.content.some((p: { type: string }) => p.type === 'image_url')).toBe(true);
  });

  it('sends a bare string when no image is attached', async () => {
    await inject(app, { content: 'x', type: 'clarity' });
    const user = mockStreamChat.mock.calls[0]![2]
      .find((m: { role: string }) => m.role === 'user');
    expect(typeof user.content).toBe('string');
  });

  it('propagates the helper refusal as a 422', async () => {
    mockGetVisionCapability.mockResolvedValue(false);
    const res = await inject(app, { content: 'x', type: 'clarity', imageHandle: HANDLE });
    expect(res.statusCode).toBe(422);
  });
});
