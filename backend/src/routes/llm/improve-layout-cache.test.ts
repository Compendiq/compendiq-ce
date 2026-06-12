import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

// Token-loss cache guard: a model response that LOST the layout boundary
// tokens must never be written to the LLM cache. The 422 apply rejection
// tells the user to "run AI Improve again" — with the bad response cached
// for LLM_CACHE_TTL, every retry would serve the same token-less output and
// the user would be stuck in a poisoned-retry loop until the TTL expired
// (observed on the dev stack: three identical cache-hit improves in 12s).

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

const mockProviderStreamChat = vi.fn();

vi.mock('../../domains/llm/services/openai-compatible-client.js', () => ({
  streamChat: (...args: unknown[]) => mockProviderStreamChat(...args),
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

// htmlToMarkdown is identity so the request `content` IS the markdown the
// route sees — tests control token presence directly. The token predicate
// mirrors the real implementation's contract (any recoverable token-ish
// text counts); its real behavior is covered in content-converter.test.ts.
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

const LAYOUT_CONTENT =
  '[[[LAYOUT]]]\n\n[[[LAYOUT-SECTION two_equal]]]\n\n[[[LAYOUT-CELL]]]\n\nLeft prose\n\n[[[/LAYOUT-CELL]]]\n\n' +
  '[[[LAYOUT-CELL]]]\n\nRight prose\n\n[[[/LAYOUT-CELL]]]\n\n[[[/LAYOUT-SECTION]]]\n\n[[[/LAYOUT]]]';

describe('POST /api/llm/improve - layout-token cache guard', () => {
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
  });

  function parseSseEvents(body: string): Array<Record<string, unknown>> {
    return body
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
  }

  async function improve(content: string, modelOutput: string): Promise<{ status: number; finalEvent?: Record<string, unknown> }> {
    async function* mockGenerator() {
      yield { content: modelOutput, done: true };
    }
    mockProviderStreamChat.mockReturnValue(mockGenerator());
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improve',
      payload: { content, type: 'grammar', model: 'llama3' },
    });
    return { status: response.statusCode, finalEvent: parseSseEvents(response.body).find((e) => e.final === true) };
  }

  it('does NOT cache a response that lost the layout tokens', async () => {
    const { status } = await improve(LAYOUT_CONTENT, 'Left prose improved\n\nRight prose improved');
    expect(status).toBe(200);
    expect(mockSetCachedResponse).not.toHaveBeenCalled();
  });

  it('caches a response that kept the layout tokens', async () => {
    const { status } = await improve(LAYOUT_CONTENT, LAYOUT_CONTENT.replace('Left prose', 'Left prose improved'));
    expect(status).toBe(200);
    expect(mockSetCachedResponse).toHaveBeenCalledTimes(1);
  });

  it('caches normally for layout-free pages regardless of output shape', async () => {
    const { status } = await improve('Plain prose without any layout.', 'Improved plain prose.');
    expect(status).toBe(200);
    expect(mockSetCachedResponse).toHaveBeenCalledTimes(1);
  });

  // The frontend's pre-Accept warning prefers this authoritative flag over
  // its own `[[[` heuristic, which cannot recognize mangled-but-recoverable
  // token spellings.
  it('flags layoutTokensLost=true on the final SSE event when the output lost the tokens', async () => {
    const { finalEvent } = await improve(LAYOUT_CONTENT, 'Left prose improved\n\nRight prose improved');
    expect(finalEvent).toBeDefined();
    expect(finalEvent!.layoutTokensLost).toBe(true);
  });

  it('flags layoutTokensLost=false when the output kept the tokens', async () => {
    const { finalEvent } = await improve(LAYOUT_CONTENT, LAYOUT_CONTENT.replace('Left prose', 'Left prose improved'));
    expect(finalEvent!.layoutTokensLost).toBe(false);
  });

  it('flags layoutTokensLost=false for layout-free pages', async () => {
    const { finalEvent } = await improve('Plain prose without any layout.', 'Improved plain prose.');
    expect(finalEvent!.layoutTokensLost).toBe(false);
  });

  it('computes the flag for cached responses too (pre-guard cache entries may be token-less)', async () => {
    mockGetCachedResponse.mockResolvedValue({ content: 'token-less cached output' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improve',
      payload: { content: LAYOUT_CONTENT, type: 'grammar', model: 'llama3' },
    });
    expect(response.statusCode).toBe(200);
    const finalEvent = parseSseEvents(response.body).find((e) => e.final === true);
    expect(finalEvent!.layoutTokensLost).toBe(true);
  });
});
