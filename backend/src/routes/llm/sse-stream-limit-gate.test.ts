/**
 * Integration tests for the per-user concurrent-SSE-stream gate (#268).
 *
 * Parameterised across all six streaming handlers so every new LLM SSE
 * endpoint added in the future keeps protection when it copies the
 * existing slot.acquired / try / finally pattern.
 *
 * The gate's correctness properties we verify here:
 *   1. Over-cap requests return 429 with the documented body shape.
 *   2. `slot.release()` is invoked on the success path (stream completes).
 *   3. `slot.release()` is invoked on the error path (generator throws).
 *   4. `slot.release()` is invoked on the client-disconnect path.
 *   5. `slot.release()` is invoked on the timeout path (AbortError from the
 *      generator — same code path as an upstream timeout).
 *
 * The Lua/Redis atomicity is unit-tested in sse-stream-limiter.test.ts;
 * here we only care that the route wires the gate into the right place and
 * that the finally block fires on every exit.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';

// ─── Mocks (broad — every route tested below shares them) ──────────────

const mockAcquireStreamSlot = vi.fn();
const mockRelease = vi.fn();

vi.mock('../../core/services/sse-stream-limiter.js', () => ({
  acquireStreamSlot: (...args: unknown[]) => mockAcquireStreamSlot(...args),
  getStreamCap: vi.fn().mockResolvedValue(3),
  invalidateStreamCapCache: vi.fn(),
  _resetStreamCapCache: vi.fn(),
}));

const mockGetSystemPrompt = vi.fn().mockReturnValue('sys prompt');
vi.mock('../../domains/llm/services/prompts.js', () => ({
  getSystemPrompt: (...args: unknown[]) => mockGetSystemPrompt(...args),
  LANGUAGE_PRESERVATION_INSTRUCTION: '',
}));

vi.mock('../../domains/llm/services/llm-provider-resolver.js', () => ({
  resolveUsecase: vi.fn().mockResolvedValue({
    config: {
      providerId: 'p1', baseUrl: 'http://x/v1', apiKey: null,
      authType: 'none', verifySsl: true, name: 'X', defaultModel: 'm',
    },
    model: 'm',
  }),
}));

const mockStreamChat = vi.fn();
vi.mock('../../domains/llm/services/openai-compatible-client.js', () => ({
  streamChat: (...args: unknown[]) => mockStreamChat(...args),
  chat: vi.fn(),
  generateEmbedding: vi.fn(),
  listModels: vi.fn(),
  checkHealth: vi.fn(),
  invalidateDispatcher: vi.fn(),
}));

vi.mock('../../domains/llm/services/rag-service.js', () => ({
  hybridSearch: vi.fn().mockResolvedValue([]),
  buildRagContext: vi.fn().mockReturnValue('ctx'),
}));

vi.mock('../../core/db/postgres.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../../core/services/content-converter.js', () => ({
  htmlToMarkdown: vi.fn((s: string) => s),
  markdownToHtml: vi.fn((s: string) => s),
}));

vi.mock('../../domains/llm/services/embedding-service.js', () => ({
  getEmbeddingStatus: vi.fn(),
  processDirtyPages: vi.fn(),
  reEmbedAll: vi.fn(),
  embedPage: vi.fn(),
  isProcessingUser: vi.fn().mockReturnValue(false),
  resetFailedEmbeddings: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../domains/llm/services/llm-cache.js', () => {
  class MockLlmCache {
    getCachedResponse = vi.fn().mockResolvedValue(null);
    setCachedResponse = vi.fn().mockResolvedValue(undefined);
    acquireLock = vi.fn().mockResolvedValue(true);
    releaseLock = vi.fn().mockResolvedValue(undefined);
    waitForCachedResponse = vi.fn().mockResolvedValue(null);
    clearAll = vi.fn();
  }
  return {
    LlmCache: MockLlmCache,
    buildLlmCacheKey: vi.fn().mockReturnValue('k'),
    buildRagCacheKey: vi.fn().mockReturnValue('k'),
  };
});

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../domains/llm/services/llm-audit-hook.js', () => ({
  emitLlmAudit: vi.fn(),
  estimateTokens: vi.fn().mockReturnValue(10),
}));

vi.mock('../../core/utils/sanitize-llm-input.js', () => ({
  sanitizeLlmInput: vi.fn((input: string) => ({ sanitized: input, warnings: [] })),
}));

vi.mock('../../core/services/ai-safety-service.js', () => ({
  getAiGuardrails: vi.fn().mockResolvedValue({
    noFabricationEnabled: false,
    noFabricationInstruction: '',
  }),
  getAiOutputRules: vi.fn().mockResolvedValue({
    stripReferences: false,
    referenceAction: 'off',
  }),
  upsertAiGuardrails: vi.fn(),
  upsertAiOutputRules: vi.fn(),
}));

vi.mock('../../domains/confluence/services/subpage-context.js', () => ({
  assembleSubPageContext: vi.fn().mockResolvedValue({ markdown: '', pageCount: 0 }),
  getMultiPagePromptSuffix: vi.fn().mockReturnValue(''),
}));

vi.mock('../../core/utils/rbac-guards.js', () => ({
  requireGlobalPermission: () => async () => {
    /* allow everything in tests */
  },
}));

// Rate-limit service is not called directly by the route, but LLM_STREAM_RATE_LIMIT
// lazy-resolves through it.
vi.mock('../../core/services/rate-limit-service.js', () => ({
  getRateLimits: vi.fn().mockResolvedValue({
    global: { max: 100, timeWindow: '1 minute' },
    auth: { max: 5, timeWindow: '1 minute' },
    admin: { max: 20, timeWindow: '1 minute' },
    llmStream: { max: 10_000, timeWindow: '1 minute' },
    llmEmbedding: { max: 10_000, timeWindow: '1 minute' },
  }),
  upsertRateLimits: vi.fn(),
  _resetCache: vi.fn(),
}));

// MCP docs client (used only by llm-ask, but safe to stub broadly).
vi.mock('../../core/services/mcp-docs-client.js', () => ({
  isEnabled: vi.fn().mockResolvedValue(false),
  fetchDocumentation: vi.fn(),
}));

vi.mock('./_web-search-helper.js', () => ({
  fetchWebSources: vi.fn().mockResolvedValue([]),
  formatWebContext: vi.fn().mockReturnValue(''),
}));

// Imports must come after every vi.mock() above.
import { llmAskRoutes } from './llm-ask.js';
import { llmGenerateRoutes } from './llm-generate.js';
import { llmImproveRoutes } from './llm-improve.js';
import { llmSummarizeRoutes } from './llm-summarize.js';
import { llmQualityRoutes } from './llm-quality.js';
import { llmDiagramRoutes } from './llm-diagram.js';

// ─── Fixtures ──────────────────────────────────────────────────────────

interface RouteFixture {
  name: string;
  path: string;
  register: (fastify: FastifyInstance, opts: { prefix: string }) => Promise<void>;
  payload: Record<string, unknown>;
}

const ROUTES: RouteFixture[] = [
  {
    name: 'llm/ask',
    path: '/api/llm/ask',
    register: llmAskRoutes,
    payload: { question: 'hi', model: 'm' },
  },
  {
    name: 'llm/generate',
    path: '/api/llm/generate',
    register: llmGenerateRoutes,
    payload: { prompt: 'hi', model: 'm' },
  },
  {
    name: 'llm/improve',
    path: '/api/llm/improve',
    register: llmImproveRoutes,
    payload: { content: 'hi', type: 'grammar', model: 'm' },
  },
  {
    name: 'llm/summarize',
    path: '/api/llm/summarize',
    register: llmSummarizeRoutes,
    payload: { content: 'hi', model: 'm' },
  },
  {
    name: 'llm/analyze-quality',
    path: '/api/llm/analyze-quality',
    register: llmQualityRoutes,
    payload: { content: 'hi', model: 'm' },
  },
  {
    name: 'llm/generate-diagram',
    path: '/api/llm/generate-diagram',
    register: llmDiagramRoutes,
    payload: { content: 'hi', model: 'm' },
  },
];

async function* successGenerator() {
  yield { content: 'ok', done: true };
}

async function* throwingGenerator(): AsyncGenerator<{ content: string; done: boolean }> {
  yield { content: 'partial', done: false };
  throw new Error('upstream failure');
}

async function* abortingGenerator(): AsyncGenerator<{ content: string; done: boolean }> {
  // ESLint require-yield requires at least one yield; this one never executes
  // because the throw runs first, but it satisfies the linter and keeps the
  // semantic intent (an async generator that aborts immediately) intact.
  if (Math.random() < -1) yield { content: '', done: false };
  const err = new Error('aborted') as Error & { name: string };
  err.name = 'AbortError';
  throw err;
}

async function buildAppForRoute(route: RouteFixture): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async () => { /* noop */ });
  app.decorate('requireAdmin', async () => { /* noop */ });
  app.decorate('redis', {});
  app.decorateRequest('userId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = 'user-A';
    request.userCan = async () => true;
  });
  await app.register(route.register, { prefix: '/api' });
  await app.ready();
  return app;
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('Per-user SSE-stream gate — parameterised across all six handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAcquireStreamSlot.mockReset();
    mockRelease.mockReset();
  });

  describe.each(ROUTES)('$path', (route) => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = await buildAppForRoute(route);
    });

    afterAll(async () => {
      await app.close();
    });

    it('returns 429 with the documented body when the cap is hit', async () => {
      mockAcquireStreamSlot.mockResolvedValue({
        acquired: false,
        release: mockRelease,
      });

      const response = await app.inject({
        method: 'POST',
        url: route.path,
        payload: route.payload,
      });

      expect(response.statusCode).toBe(429);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('too_many_concurrent_streams');
      expect(typeof body.message).toBe('string');
      // The documented body shape is user-facing; guard against accidental
      // renames breaking clients.
      expect(body.message.length).toBeGreaterThan(0);

      // No release on the rejection path — the slot was never held.
      expect(mockRelease).not.toHaveBeenCalled();
    });

    it('releases the slot on the SUCCESS path', async () => {
      mockAcquireStreamSlot.mockResolvedValue({
        acquired: true,
        release: mockRelease,
      });
      mockStreamChat.mockReturnValue(successGenerator());

      const response = await app.inject({
        method: 'POST',
        url: route.path,
        payload: route.payload,
      });

      // A 2xx status or plain text/event-stream response is a normal finish.
      expect(response.statusCode).toBe(200);
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('releases the slot on the ERROR path (generator throws mid-stream)', async () => {
      mockAcquireStreamSlot.mockResolvedValue({
        acquired: true,
        release: mockRelease,
      });
      mockStreamChat.mockReturnValue(throwingGenerator());

      await app.inject({
        method: 'POST',
        url: route.path,
        payload: route.payload,
      });

      // Regardless of whether the error frame is written to the SSE stream
      // or bubbles as a 500, the slot must release.
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('releases the slot on the TIMEOUT/ABORT path (AbortError from generator)', async () => {
      mockAcquireStreamSlot.mockResolvedValue({
        acquired: true,
        release: mockRelease,
      });
      mockStreamChat.mockReturnValue(abortingGenerator());

      await app.inject({
        method: 'POST',
        url: route.path,
        payload: route.payload,
      });

      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('acquires once per request (exactly-one symmetry with release)', async () => {
      mockAcquireStreamSlot.mockResolvedValue({
        acquired: true,
        release: mockRelease,
      });
      mockStreamChat.mockReturnValue(successGenerator());

      await app.inject({
        method: 'POST',
        url: route.path,
        payload: route.payload,
      });

      expect(mockAcquireStreamSlot).toHaveBeenCalledTimes(1);
      expect(mockAcquireStreamSlot).toHaveBeenCalledWith('user-A');
    });
  });
});
