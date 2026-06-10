import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

// This suite exercises the REAL content-converter (protectMedia / restoreMedia /
// markdownToHtml) through the Accept/apply drop-guard — unlike apply-improvement.test.ts
// which mocks the converter. It verifies that media dropped by the LLM is never
// lost (#723): the drop-guard must re-append it.

const mockQuery = vi.fn();
const mockLogAuditEvent = vi.fn();

vi.mock('../../domains/llm/services/llm-provider-resolver.js', () => ({
  resolveUsecase: vi.fn(),
}));
vi.mock('../../domains/llm/services/openai-compatible-client.js', () => ({
  streamChat: vi.fn(),
  chat: vi.fn(),
  generateEmbedding: vi.fn(),
  listModels: vi.fn(),
  checkHealth: vi.fn(),
  invalidateDispatcher: vi.fn(),
}));

vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../../domains/llm/services/rag-service.js', () => ({
  hybridSearch: vi.fn(),
  buildRagContext: vi.fn(),
}));

// NOTE: content-converter.js is intentionally NOT mocked here.

vi.mock('../../domains/llm/services/embedding-service.js', () => ({
  getEmbeddingStatus: vi.fn(),
  processDirtyPages: vi.fn(),
  reEmbedAll: vi.fn(),
  embedPage: vi.fn(),
  isProcessingUser: vi.fn().mockReturnValue(false),
  resetFailedEmbeddings: vi.fn().mockResolvedValue(0),
  computePageRelationships: vi.fn(),
}));

vi.mock('../../domains/confluence/services/sync-service.js', () => ({
  getClientForUser: vi.fn(),
}));

vi.mock('../../domains/llm/services/llm-cache.js', () => {
  class MockLlmCache {
    getCachedResponse = vi.fn().mockResolvedValue(null);
    setCachedResponse = vi.fn();
    acquireLock = vi.fn().mockResolvedValue(true);
    releaseLock = vi.fn().mockResolvedValue(undefined);
    waitForCachedResponse = vi.fn().mockResolvedValue(null);
    clearAll = vi.fn();
  }
  return {
    LlmCache: MockLlmCache,
    buildLlmCacheKey: vi.fn().mockReturnValue('test-cache-key'),
    buildRagCacheKey: vi.fn().mockReturnValue('test-rag-cache-key'),
  };
});

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
}));

vi.mock('../../core/utils/sanitize-llm-input.js', () => ({
  sanitizeLlmInput: vi.fn((input: string) => ({ sanitized: input, warnings: [] })),
}));

vi.mock('../../core/services/redis-cache.js', () => {
  class MockRedisCache {
    invalidate = vi.fn().mockResolvedValue(undefined);
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue(undefined);
  }
  return { RedisCache: MockRedisCache };
});

vi.mock('../../domains/confluence/services/subpage-context.js', () => ({
  assembleSubPageContext: vi.fn(),
  getMultiPagePromptSuffix: vi.fn().mockReturnValue(''),
}));

import { llmConversationRoutes } from './llm-conversations.js';

describe('POST /api/llm/improvements/apply — drop-guard with REAL restoreMedia (#723)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async () => {});
    app.decorate('requireAdmin', async () => {});
    app.decorate('redis', {});
    app.decorateRequest('userId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = 'user-123';
      request.userCan = async () => true;
    });
    await app.register(llmConversationRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function captureUpdatedBodyHtml(): string {
    const updateCall = (mockQuery.mock.calls as unknown[][]).find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('UPDATE pages'),
    );
    expect(updateCall).toBeDefined();
    // standalone UPDATE params: [id, title, bodyHtml, bodyText, version, userId]
    return (updateCall as unknown[])[1]![2] as string;
  }

  it('re-appends media the LLM dropped entirely (token missing from improved markdown)', async () => {
    const img =
      '<img src="/api/attachments/42/p$1$&x.png" data-confluence-filename="p.png" data-confluence-image-source="attachment" alt="Photo">';
    const drawio =
      '<div class="confluence-drawio" data-diagram-name="Arch"><img src="/api/attachments/42/Arch.png"></div>';
    const bodyHtmlWithMedia = `<p>Old intro</p>${img}${drawio}`;

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, version, title, space_key, source, confluence_id')) {
        return Promise.resolve({
          rows: [{
            id: 42, version: 5, title: 'My Article', space_key: 'OPS',
            source: 'standalone', confluence_id: null, body_html: bodyHtmlWithMedia,
            // #734: the page-resolve query now returns ownership fields; the
            // test user must own this private standalone page to write it.
            created_by_user_id: 'user-123', visibility: 'private',
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    // The LLM returned plain markdown with NO placeholder tokens at all —
    // i.e. it dropped every media token. The drop-guard must re-append both.
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improvements/apply',
      payload: {
        pageId: '42',
        improvedMarkdown: '## Rewritten\n\nFresh prose, no media tokens.',
        version: 5,
        title: 'My Article',
      },
    });

    expect(response.statusCode).toBe(200);
    const savedHtml = captureUpdatedBodyHtml();
    // Both media survived — the $-laden image must be byte-identical (no
    // replacement-pattern corruption), and the draw.io wrapper preserved.
    expect(savedHtml).toContain('/api/attachments/42/p$1$&amp;x.png');
    expect(savedHtml).toContain('data-confluence-filename="p.png"');
    expect(savedHtml).toContain('class="confluence-drawio"');
    expect(savedHtml).toContain('data-diagram-name="Arch"');
  });

  it('restores in-place when the LLM kept the tokens (no double-append)', async () => {
    const img = '<img src="/api/attachments/42/q.png" alt="Q">';
    const bodyHtmlWithMedia = `<p>Old</p>${img}`;

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, version, title, space_key, source, confluence_id')) {
        return Promise.resolve({
          rows: [{
            id: 42, version: 5, title: 'My Article', space_key: 'OPS',
            source: 'standalone', confluence_id: null, body_html: bodyHtmlWithMedia,
            // #734: owner of the private standalone page (see test above).
            created_by_user_id: 'user-123', visibility: 'private',
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    // The LLM kept the placeholder token (markdown escapes the underscores).
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improvements/apply',
      payload: {
        pageId: '42',
        improvedMarkdown: 'Improved intro\n\nCQ\\_MEDIA\\_PLACEHOLDER\\_0\n',
        version: 5,
        title: 'My Article',
      },
    });

    expect(response.statusCode).toBe(200);
    const savedHtml = captureUpdatedBodyHtml();
    // Image present exactly once — restored in place, not also appended.
    expect(savedHtml.split('/api/attachments/42/q.png').length - 1).toBe(1);
  });
});

describe('POST /api/llm/improvements/apply — layout boundary tokens with REAL markdownToHtml (#765)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async () => {});
    app.decorate('requireAdmin', async () => {});
    app.decorate('redis', {});
    app.decorateRequest('userId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = 'user-123';
      request.userCan = async () => true;
    });
    await app.register(llmConversationRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const layoutBodyHtml =
    '<div class="confluence-layout"><div class="confluence-layout-section" data-layout-type="two_equal">' +
    '<div class="confluence-layout-cell"><p>Left column content</p></div>' +
    '<div class="confluence-layout-cell"><p>Right column content</p></div>' +
    '</div></div>';

  function mockPageWith(bodyHtml: string): void {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, version, title, space_key, source, confluence_id')) {
        return Promise.resolve({
          rows: [{
            id: 42, version: 5, title: 'My Article', space_key: 'OPS',
            source: 'standalone', confluence_id: null, body_html: bodyHtml,
            created_by_user_id: 'user-123', visibility: 'private',
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  function captureUpdatedBodyHtml(): string {
    const updateCall = (mockQuery.mock.calls as unknown[][]).find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('UPDATE pages'),
    );
    expect(updateCall).toBeDefined();
    return (updateCall as unknown[])[1]![2] as string;
  }

  it('rebuilds the layout when the LLM kept the boundary tokens and edited the prose', async () => {
    mockPageWith(layoutBodyHtml);

    const improvedMarkdown = [
      '[[[LAYOUT]]]', '',
      '[[[LAYOUT-SECTION two_equal]]]', '',
      '[[[LAYOUT-CELL]]]', '',
      'Left column content, improved by the model.', '',
      '[[[/LAYOUT-CELL]]]', '',
      '[[[LAYOUT-CELL]]]', '',
      'Right column content stays.', '',
      '[[[/LAYOUT-CELL]]]', '',
      '[[[/LAYOUT-SECTION]]]', '',
      '[[[/LAYOUT]]]',
    ].join('\n');

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improvements/apply',
      payload: { pageId: '42', improvedMarkdown, version: 5, title: 'My Article' },
    });

    expect(response.statusCode).toBe(200);
    const savedHtml = captureUpdatedBodyHtml();
    expect(savedHtml).toContain('class="confluence-layout"');
    expect(savedHtml).toContain('data-layout-type="two_equal"');
    expect((savedHtml.match(/class="confluence-layout-cell"/g) ?? []).length).toBe(2);
    expect(savedHtml).toContain('Left column content, improved by the model.');
    expect(savedHtml).not.toContain('[[[');
  });

  it('drop-guard: mangled tokens flatten gracefully — no raw [[[…]]] and no unbalanced divs', async () => {
    mockPageWith(layoutBodyHtml);

    // The LLM dropped one closing token and lower-cased another.
    const improvedMarkdown = [
      '[[[LAYOUT]]]', '',
      '[[[LAYOUT-SECTION two_equal]]]', '',
      '[[[LAYOUT-CELL]]]', '',
      'Left prose survives.', '',
      '[[[/layout-cell]]]', '',
      '[[[LAYOUT-CELL]]]', '',
      'Right prose survives.', '',
      '[[[/LAYOUT-SECTION]]]', '',
      '[[[/LAYOUT]]]',
    ].join('\n');

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improvements/apply',
      payload: { pageId: '42', improvedMarkdown, version: 5, title: 'My Article' },
    });

    expect(response.statusCode).toBe(200);
    const savedHtml = captureUpdatedBodyHtml();
    expect(savedHtml).not.toContain('[[[');
    expect(savedHtml).not.toContain('confluence-layout');
    expect(savedHtml).toContain('Left prose survives.');
    expect(savedHtml).toContain('Right prose survives.');
    // No dangling open/close divs.
    expect((savedHtml.match(/<div/g) ?? []).length).toBe((savedHtml.match(/<\/div>/g) ?? []).length);
  });
});
