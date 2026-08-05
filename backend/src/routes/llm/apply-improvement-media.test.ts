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

  it('#1221: an expand section inside a table cell rides the freeze through apply', async () => {
    // A constrained section cannot use boundary tokens (markdownToHtml's token
    // normalization would rip it out of the cell), so it stays opaquely frozen
    // and the #723 drop-guard is what preserves it when the model drops the
    // placeholder entirely.
    const expand =
      '<details data-macro-name="expand"><summary>Runbook</summary><p>step one</p></details>';
    const bodyHtmlWithExpand =
      `<p>Old intro</p><table><tbody><tr><td>${expand}</td></tr></tbody></table>`;

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, version, title, space_key, source, confluence_id')) {
        return Promise.resolve({
          rows: [{
            id: 42, version: 5, title: 'My Article', space_key: 'OPS',
            source: 'standalone', confluence_id: null, body_html: bodyHtmlWithExpand,
            created_by_user_id: 'user-123', visibility: 'private',
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improvements/apply',
      payload: {
        pageId: '42',
        improvedMarkdown: '## Rewritten\n\nFresh prose, no tokens at all.',
        version: 5,
        title: 'My Article',
      },
    });

    expect(response.statusCode).toBe(200);
    const savedHtml = captureUpdatedBodyHtml();
    // The whole section came back — identity stamp, summary and body — exactly
    // once, and it is still a <details>, not flattened prose.
    expect(savedHtml).toContain(expand);
    expect(savedHtml.split('data-macro-name="expand"').length - 1).toBe(1);
  });
});

describe('POST /api/llm/improvements/apply — EXPAND boundary tokens (#1221 stage 2)', () => {
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

  function findUpdateCall(): unknown[] | undefined {
    return (mockQuery.mock.calls as unknown[][]).find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('UPDATE pages'),
    );
  }

  function captureUpdatedBodyHtml(): string {
    const updateCall = findUpdateCall();
    expect(updateCall).toBeDefined();
    return (updateCall as unknown[])[1]![2] as string;
  }

  async function apply(improvedMarkdown: string): Promise<Awaited<ReturnType<typeof app.inject>>> {
    return app.inject({
      method: 'POST',
      url: '/api/llm/improvements/apply',
      payload: { pageId: '42', improvedMarkdown, version: 5, title: 'My Article' },
    });
  }

  it('rewrites the body of an unconstrained expand while keeping the macro', async () => {
    mockPageWith(
      '<p>Old intro</p>' +
      '<details data-macro-name="expand"><summary>Runbook</summary><p>step one</p></details>',
    );

    const response = await apply([
      '[[[EXPAND name=expand open=0 title=Runbook params=]]]', '',
      'Step one, rewritten far more clearly.', '',
      '[[[/EXPAND]]]',
    ].join('\n'));

    expect(response.statusCode).toBe(200);
    const savedHtml = captureUpdatedBodyHtml();
    expect(savedHtml).toContain('<details data-macro-name="expand">');
    expect(savedHtml).toContain('<summary>Runbook</summary>');
    // The body really was improved — this is the whole point of stage 2.
    expect(savedHtml).toContain('Step one, rewritten far more clearly.');
    expect(savedHtml).not.toContain('step one');
    expect(savedHtml).not.toContain('[[[');
    expect(savedHtml.split('<details').length - 1).toBe(1);
  });

  it('preserves ui-expand identity, open state and parameters through a full apply', async () => {
    mockPageWith(
      '<details data-macro-name="ui-expand" open data-macro-params="{&quot;class&quot;:&quot;team&quot;}">' +
      '<summary>Dev Team</summary><p>owns platform services</p></details>',
    );

    const response = await apply([
      '[[[EXPAND name=ui-expand open=1 title=Dev%20Team params=%7B%22class%22%3A%22team%22%7D]]]', '',
      'Owns the platform services end to end.', '',
      '[[[/EXPAND]]]',
    ].join('\n'));

    expect(response.statusCode).toBe(200);
    const savedHtml = captureUpdatedBodyHtml();
    expect(savedHtml).toContain('data-macro-name="ui-expand"');
    expect(savedHtml).not.toContain('data-macro-name="expand"');
    expect(savedHtml).toContain('<summary>Dev Team</summary>');
    expect(savedHtml).toMatch(/<details[^>]*\bopen\b/);
    expect(savedHtml).toContain('data-macro-params="{&quot;class&quot;:&quot;team&quot;}"');
    // The identity was preserved by REBUILDING the section around improved
    // prose, not by re-appending a frozen copy beside it: the old body is gone
    // and there is exactly one section.
    expect(savedHtml).not.toContain('owns platform services');
    expect(savedHtml.split('<details').length - 1).toBe(1);
    const improvedAt = savedHtml.indexOf('Owns the platform services end to end.');
    expect(improvedAt).toBeGreaterThan(savedHtml.indexOf('</summary>'));
    expect(improvedAt).toBeLessThan(savedHtml.indexOf('</details>'));
  });

  it('rejects an unrecoverable EXPAND mangling with 422 instead of flattening the page', async () => {
    // Two sections (so the single-slot wrap cannot disambiguate), every token
    // dropped, and both bodies reworded so no anchor survives. This 422 is the
    // property that makes stage 2 safe at all: without it, a mangled token
    // would be the silent macro deletion #1221 exists to prevent.
    mockPageWith(
      '<details data-macro-name="expand"><summary>One</summary><p>alpha body</p></details>' +
      '<details data-macro-name="expand"><summary>Two</summary><p>beta body</p></details>',
    );

    const response = await apply(
      'Abschnitt eins: voellig neu formuliert.\n\nAbschnitt zwei: ebenfalls neu formuliert.',
    );

    expect(response.statusCode).toBe(422);
    expect(response.json().message).toContain('could not be recovered');
    // Predictable failure: NO page write happened, so nothing flattened can be
    // saved locally or pushed back to Confluence.
    expect(findUpdateCall()).toBeUndefined();
  });

  it('recovers a case-mangled EXPAND close token against the page skeleton', async () => {
    mockPageWith(
      '<details data-macro-name="expand"><summary>Runbook</summary><p>step one</p></details>',
    );

    const response = await apply([
      '[[[EXPAND name=expand open=0 title=Runbook params=]]]', '',
      'Step one, clarified.', '',
      '[[[/expand]]]',
    ].join('\n'));

    expect(response.statusCode).toBe(200);
    const savedHtml = captureUpdatedBodyHtml();
    expect(savedHtml).toContain('<details data-macro-name="expand">');
    expect(savedHtml).toContain('<summary>Runbook</summary>');
    expect(savedHtml).toContain('Step one, clarified.');
    expect(savedHtml).not.toContain('[[[');
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

  it('#781: mangled tokens are recovered against the page skeleton — layout survives (was silently flattened)', async () => {
    mockPageWith(layoutBodyHtml);

    // The LLM dropped one closing token and lower-cased another — the exact
    // failure mode #781 reported from real local models.
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
    // The layout is rebuilt from the page's own skeleton, not flattened.
    expect(savedHtml).toContain('class="confluence-layout"');
    expect(savedHtml).toContain('data-layout-type="two_equal"');
    expect((savedHtml.match(/class="confluence-layout-cell"/g) ?? []).length).toBe(2);
    expect(savedHtml).toContain('Left prose survives.');
    expect(savedHtml).toContain('Right prose survives.');
    expect((savedHtml.match(/<div/g) ?? []).length).toBe((savedHtml.match(/<\/div>/g) ?? []).length);
  });

  it('#781: unrecoverable token loss rejects the apply with 422 — the page is NOT modified or pushed', async () => {
    mockPageWith(layoutBodyHtml);

    // The model rewrote the markers in German prose — nothing to align.
    const improvedMarkdown = [
      'Beginn des Seitenlayouts.', '',
      'Linke Spalte: Left prose.', '',
      'Rechte Spalte: Right prose.', '',
      'Ende des Seitenlayouts.',
    ].join('\n');

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improvements/apply',
      payload: { pageId: '42', improvedMarkdown, version: 5, title: 'My Article' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().message).toContain('column layout');
    // Predictable failure: NO page write happened — flattened content can
    // never be saved locally nor pushed back to Confluence.
    const updateCall = (mockQuery.mock.calls as unknown[][]).find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('UPDATE pages'),
    );
    expect(updateCall).toBeUndefined();
  });

  it('#785: single-cell layout page applies even when the LLM dropped every token (unambiguous wrap recovery)', async () => {
    mockPageWith(
      '<div class="confluence-layout"><div class="confluence-layout-section" data-layout-type="single">' +
      '<div class="confluence-layout-cell"><p>Full width content</p></div>' +
      '</div></div>',
    );

    // Token-free echo: with exactly ONE prose-bearing cell there is no
    // ambiguity — the apply must succeed with the prose wrapped in the cell.
    const improvedMarkdown = '## Improved heading\n\nFresh single-column prose, no tokens at all.';

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/improvements/apply',
      payload: { pageId: '42', improvedMarkdown, version: 5, title: 'My Article' },
    });

    expect(response.statusCode).toBe(200);
    const savedHtml = captureUpdatedBodyHtml();
    expect(savedHtml).not.toContain('[[[');
    expect(savedHtml).toContain('data-layout-type="single"');
    expect((savedHtml.match(/class="confluence-layout-cell"/g) ?? []).length).toBe(1);
    // The prose landed INSIDE the cell (before the layout's closing divs),
    // not at top level after an empty rebuilt layout.
    const proseIdx = savedHtml.indexOf('Fresh single-column prose');
    expect(proseIdx).toBeGreaterThan(savedHtml.indexOf('confluence-layout-cell'));
    expect(savedHtml.lastIndexOf('</div>')).toBeGreaterThan(proseIdx);
  });

  it('#781: hallucinated layout tokens on a layout-free page are stripped, never built', async () => {
    mockPageWith('<h1>Plain page</h1><p>No layout here.</p>');

    const improvedMarkdown = [
      '[[[LAYOUT]]]', '',
      '[[[LAYOUT-SECTION two_equal]]]', '',
      '[[[LAYOUT-CELL]]]', '',
      'Hallucinated structure around real prose.', '',
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
    expect(savedHtml).not.toContain('[[[');
    expect(savedHtml).not.toContain('confluence-layout');
    expect(savedHtml).toContain('Hallucinated structure around real prose.');
  });
});
