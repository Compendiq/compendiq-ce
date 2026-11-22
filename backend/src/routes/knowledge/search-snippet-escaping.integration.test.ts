/**
 * #1964 — `/api/search` `snippet` is an HTML-safe fragment in every mode:
 * page text passed once through the `& < > " '` mapping, plus `<mark>` exactly
 * where PostgreSQL's `ts_headline` generated a highlight. The frontend renders
 * it as HTML (`SanitizedHtml allowedTags={['mark']}`).
 *
 * Keyword full-text rows keep the passage and highlights PostgreSQL chose over
 * the unmodified body, as before #1964; they still omit text the parser treats
 * as a tag (a recorded limitation). Fuzzy-title, semantic and hybrid rows are
 * cut from stored text and show it.
 *
 * Real PostgreSQL and real retrieval. Only auth, the space list and the
 * embedding HTTP boundary are controlled. Titles are neutral unless the case is
 * about the title, and each case seeds exactly one page.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { Response, fetch } from 'undici';
import pgvector from 'pgvector';
import { JSDOM } from 'jsdom';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { getFtsLanguage } from '../../core/services/fts-language.js';
import { chooseLexicalParser } from '../../core/utils/lexical-query.js';
import { flushSearchAnalytics } from '../../domains/llm/services/rag-service.js';
import { invalidateRagFetchWidthCache } from '../../core/services/admin-settings-service.js';
import { searchRoutes } from './search.js';

vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: vi.fn(),
}));
vi.mock('../../core/services/rbac-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/services/rbac-service.js')>()),
  getUserAccessibleSpacesMemoized: vi.fn().mockResolvedValue(['DEV']),
  getUserAccessibleSpaces: vi.fn().mockResolvedValue(['DEV']),
}));

const dbAvailable = await isDbAvailable();
const embedding = Array.from({ length: 1024 }, (_, index) => Math.sin(index + 1) * 0.01);

/** Every `&` in a fragment must open one complete entity of the escape mapping. */
const BARE_AMPERSAND = /&(?!(?:amp|lt|gt|quot|#39);)/;

/** Reference selectors for the dev-style headline; never present in a fixture. */
const REF_START = '\uE000';
const REF_STOP = '\uE001';

interface Highlighted {
  text: string;
  /** [start, end) UTF-16 offsets of each mark in `text`. */
  marks: Array<[number, number]>;
}

/** Parse the emitted HTML once; record anything other than an attribute-free, text-only `mark`. */
function parseFragment(html: string): Highlighted & { unexpected: string[] } {
  const fragment = JSDOM.fragment(html);
  let text = '';
  const marks: Array<[number, number]> = [];
  const unexpected: string[] = [];
  for (const node of Array.from(fragment.childNodes)) {
    if (node.nodeType === 3) {
      text += node.textContent ?? '';
      continue;
    }
    const element = node as Element;
    if (
      node.nodeType !== 1 ||
      element.tagName !== 'MARK' ||
      element.attributes.length > 0 ||
      Array.from(element.childNodes).some((child) => child.nodeType !== 3)
    ) {
      unexpected.push(element.outerHTML ?? String(node.nodeType));
    }
    const start = text.length;
    text += node.textContent ?? '';
    marks.push([start, text.length]);
  }
  return { text, marks, unexpected };
}

describe.skipIf(!dbAvailable)('search snippets are HTML-safe fragments (#1964)', () => {
  let app: FastifyInstance;
  let userId: string;

  beforeAll(async () => {
    await setupTestDb();
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = userId;
    });
    await app.register(searchRoutes, { prefix: '/api' });
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await flushSearchAnalytics();
    await app.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await flushSearchAnalytics();
    await truncateAllTables();
    invalidateRagFetchWidthCache();
    vi.mocked(fetch).mockReset();
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({
      data: [{ embedding }],
    }), { headers: { 'Content-Type': 'application/json' } }));
    const user = await query<{ id: string }>(
      "INSERT INTO users (username, email, password_hash, role) VALUES ('snippets', 'snippets@test', 'x', 'user') RETURNING id",
    );
    userId = user.rows[0]!.id;
    await query('INSERT INTO user_settings (user_id, confluence_enabled) VALUES ($1, FALSE)', [userId]);
    await query("INSERT INTO spaces (space_key, space_name) VALUES ('DEV', 'Development')");
  });

  async function seedPage(title: string, bodyText: string | null): Promise<void> {
    await query(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html, visibility, created_by_user_id)
       VALUES (NULL, 'standalone', 'DEV', $1, $2, '', '', 'shared', $3)`,
      [title, bodyText, userId],
    );
  }

  /** One chunk per page whose text is the page's body, plus an embedding assignment. */
  async function seedEmbeddings() {
    const provider = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, default_model)
       VALUES ('snippets', 'http://snippets.test/v1', 'none', TRUE, 'snippet-embedding') RETURNING id`,
    );
    await query(
      "INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('embedding', $1, 'snippet-embedding')",
      [provider.rows[0]!.id],
    );
    await query(
      `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
       SELECT id, 0, body_text, $1::vector,
              jsonb_build_object('page_title', title, 'section_title', title, 'space_key', space_key, 'source', source)
       FROM pages`,
      [pgvector.toSql(embedding)],
    );
  }

  async function snippetFor(search: string, mode: string): Promise<string> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/search?q=${encodeURIComponent(search)}&mode=${mode}&includeFacets=false`,
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ mode: string; items: Array<{ snippet: unknown }> }>();
    expect(body.mode).toBe(mode);
    expect(body.items).toHaveLength(1);
    const snippet = body.items[0]!.snippet;
    expect(typeof snippet).toBe('string');
    expect(snippet).not.toMatch(BARE_AMPERSAND);
    return snippet as string;
  }

  /**
   * The headline `dev` produced for this body and query, with a selector pair
   * absent from the fixture instead of `<mark>`, decoded to text and mark offsets.
   */
  async function referenceHeadline(body: string, search: string): Promise<Highlighted> {
    expect(body.includes(REF_START) || body.includes(REF_STOP)).toBe(false);
    const lang = await getFtsLanguage();
    const parser = chooseLexicalParser(search);
    const result = await query<{ headline: string }>(
      `SELECT ts_headline('${lang}', $1::text, ${parser}('${lang}', $2),
                          'MaxWords=30, MinWords=15, StartSel=' || chr(57344) || ', StopSel=' || chr(57345)) AS headline`,
      [body, search],
    );
    // HTML parsing normalises line endings; compare like with like.
    const headline = result.rows[0]!.headline.replace(/\r\n?/g, '\n');
    let text = '';
    let start = -1;
    const marks: Array<[number, number]> = [];
    for (const char of headline) {
      if (char === REF_START) start = text.length;
      else if (char === REF_STOP) marks.push([start, text.length]);
      else text += char;
    }
    return { text, marks };
  }

  describe('keyword full-text rows keep the dev passage and highlights', () => {
    const filler = 'ordinary introduction '.repeat(35);
    it.each([
      ['a quoted URL late in a long text', `${filler}See "https://example.com/docs" for the manual at the end`, '/docs'],
      ['./config after <br>', 'Use <br>./config for settings', './config'],
      ['a phrase across <br>', 'a line <br> break end', '"line break"'],
      ['a phrase across <br> after an early partial operand', `line first ${filler}a line <br> break end`, '"line break"'],
      ['an exclusion across <br>', 'a line <br> break end', 'line -br'],
      ['an exclusion after an early partial operand', `break first ${filler}a line <br> other end`, 'line -br'],
      ['mixed AND', 'line <br> other words then break', 'line break'],
      ['a 2,048-character token next to a control character', `${'x'.repeat(2048)}\u0001 needle end`, 'needle'],
      ['a run of 1,024 <', `${'<'.repeat(1024)} needle end`, 'needle'],
      ['U+0001 alone', 'before \u0001 needle after', 'needle'],
      ['U+0002 alone', 'before \u0002 needle after', 'needle'],
      ['U+0003 alone', 'before \u0003 needle after', 'needle'],
      ['U+0004 alone', 'before \u0004 needle after', 'needle'],
      ['U+0001–U+0004 adjacent', 'needle\u0001\u0002\u0003\u0004 tail', 'needle'],
      ['primary-selector-shaped text', 'x \u0001needle\u0002 and needle', 'needle'],
      ['alternate-selector-shaped text', 'x \u0003needle\u0004 and needle', 'needle'],
      ['an unbalanced selector-shaped text', 'x \u0002needle\u0001 and \u0001needle', 'needle'],
    ])('%s', async (_case, body, search) => {
      await seedPage('Formatting notes', body);
      const parsed = parseFragment(await snippetFor(search, 'keyword'));
      const reference = await referenceHeadline(body, search);
      expect(reference.marks.length).toBeGreaterThan(0);
      expect(parsed.unexpected).toEqual([]);
      expect({ text: parsed.text, marks: parsed.marks }).toEqual(reference);
    });

    it('highlights a quoted URL path late in a long document and keeps the quotes as text', async () => {
      await seedPage('Formatting notes', `${filler}See "https://example.com/docs" for the manual at the end`);
      const html = await snippetFor('/docs', 'keyword');
      expect(html).toBe(
        'introduction ordinary introduction ordinary introduction See &quot;https://example.com<mark>/docs</mark>&quot; for the manual at the end',
      );
      const parsed = parseFragment(html);
      expect(parsed.text).toContain('See "https://example.com/docs" for the manual');
      expect(parsed.marks.map(([start, end]) => parsed.text.slice(start, end))).toEqual(['/docs']);
    });

    it.each([
      ['br', 'Use &amp;lt;<mark>br</mark>&amp;gt; for a line break', [[8, 10]]],
      ['line', 'Use &amp;lt;br&amp;gt; for a <mark>line</mark> break', [[21, 25]]],
    ] as const)('shows the entity text `Use &lt;br&gt; for a line break` searched for %j', async (search, expected, marks) => {
      await seedPage('Formatting notes', 'Use &lt;br&gt; for a line break');
      const html = await snippetFor(search, 'keyword');
      expect(html).toBe(expected);
      const parsed = parseFragment(html);
      expect(parsed.text).toBe('Use &lt;br&gt; for a line break');
      expect(parsed.marks).toEqual(marks);
      expect(parsed.unexpected).toEqual([]);
    });

    it.each([
      // Tag-shaped text is omitted, exactly as before #1964 (recorded limitation).
      ['Use <br> for a line break', 'br OR line', 'Use   for a <mark>line</mark> break'],
      ['Use <br> for a line break', 'line', 'Use   for a <mark>line</mark> break'],
      ['Example: <script>alert("x")</script> is blocked', 'example', '<mark>Example</mark>:  alert(&quot;x&quot;)  is blocked'],
      ['Wrap the term in <mark>important</mark> tags', 'wrap', '<mark>Wrap</mark> the term in  important  tags'],
      ["It's \"quoted\" & done", 'done', 'It&#39;s &quot;quoted&quot; &amp; <mark>done</mark>'],
    ])('body %j searched for %j', async (body, search, expected) => {
      await seedPage('Formatting notes', body);
      expect(await snippetFor(search, 'keyword')).toBe(expected);
    });

    it("keeps PostgreSQL's partial mark for a title/body split hit", async () => {
      await seedPage('blue', 'red <br> line');
      expect(await snippetFor('blue red', 'keyword')).toBe('<mark>red</mark>   line');
    });

    it('shows the opening text with no mark for a pure title hit', async () => {
      await seedPage('blue', 'red <br> line');
      expect(await snippetFor('blue', 'keyword')).toBe('red   line');
    });

    it('returns a bounded excerpt with the true late highlight for a long ordinary-word document', async () => {
      const body = `${'ordinary introduction '.repeat(200)}the quartzneedle sits here ${'closing remark '.repeat(50)}`;
      await seedPage('Formatting notes', body);
      const parsed = parseFragment(await snippetFor('quartzneedle', 'keyword'));
      expect(parsed.unexpected).toEqual([]);
      expect(parsed.marks.map(([start, end]) => parsed.text.slice(start, end))).toEqual(['quartzneedle']);
      expect(body).toContain(parsed.text);
      expect(parsed.text.trim().split(/\s+/).length).toBeLessThanOrEqual(30);
    });
  });

  describe('fuzzy-title rows: the first 300 characters of the stored text, escaped', () => {
    const title = 'Snippet Escaping Handbook';
    const search = 'Snippet Escapng Handbok';

    it.each([
      ['Example: <script>alert("x")</script> is blocked', 'Example: &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; is blocked'],
      ['Wrap the term in <mark>important</mark> tags', 'Wrap the term in &lt;mark&gt;important&lt;/mark&gt; tags'],
      // A cut after escaping would have left a bare `&l`.
      [`${'word '.repeat(59)}abc<br>&b tail`, `${'word '.repeat(59)}abc&lt;b`],
      // 300 code points, not UTF-16 units.
      [`${'a'.repeat(299)}😀z`, `${'a'.repeat(299)}😀`],
    ])('body %j', async (body, expected) => {
      await seedPage(title, body);
      expect(await snippetFor(search, 'keyword')).toBe(expected);
    });

    it('returns an empty string for a page with no text', async () => {
      await seedPage(title, null);
      expect(await snippetFor(search, 'keyword')).toBe('');
    });

    it('keeps U+0001–U+0004 literal and produces no mark', async () => {
      const body = '\u0001needle\u0002 text \u0003x\u0004';
      await seedPage(title, body);
      const html = await snippetFor(search, 'keyword');
      expect(html).toBe(body);
      const parsed = parseFragment(html);
      expect(parsed.marks).toEqual([]);
      expect(parsed.unexpected).toEqual([]);
      expect(parsed.text).toBe(body);
    });
  });

  describe.each(['semantic', 'hybrid'])('%s rows: the flattened chunk cut at 300 code points, then escaped', (mode) => {
    it.each([
      ['Example: <script>alert("x")</script> is blocked', 'Example: &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; is blocked'],
      ['Wrap the term in <mark>important</mark> tags', 'Wrap the term in &lt;mark&gt;important&lt;/mark&gt; tags'],
      [
        `Use <br> & "quotes" for a line break ${'x'.repeat(261)}<br> tail`,
        `Use &lt;br&gt; &amp; &quot;quotes&quot; for a line break ${'x'.repeat(261)}&lt;b`,
      ],
      [`${'a'.repeat(299)}😀z`, `${'a'.repeat(299)}😀`],
    ])('chunk %j', async (body, expected) => {
      await seedPage('Formatting notes', body);
      await seedEmbeddings();
      expect(await snippetFor('example', mode)).toBe(expected);
    });
  });
});
