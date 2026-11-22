/**
 * #1964 — `/api/search` `snippet` is an HTML-safe fragment in every mode:
 * HTML-escaped page text plus the `<mark>`/`</mark>` tags `ts_headline` adds.
 * The frontend renders it as HTML (`SanitizedHtml allowedTags={['mark']}`), so a
 * page whose text shows `<br>` must show `<br>` in its snippet, not a line break
 * or nothing.
 *
 * Real PostgreSQL and real retrieval. Only auth, the space list and the
 * embedding HTTP boundary are controlled. Titles are neutral, so only the body
 * can match a full-text query, and each case seeds exactly one page.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { Response, fetch } from 'undici';
import pgvector from 'pgvector';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
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

  async function seedPage(title: string, bodyText: string): Promise<number> {
    const page = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html, visibility, created_by_user_id)
       VALUES (NULL, 'standalone', 'DEV', $1, $2, '', '', 'shared', $3)
       RETURNING id`,
      [title, bodyText, userId],
    );
    return page.rows[0]!.id;
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
    const body = response.json<{ mode: string; items: Array<{ snippet: string }> }>();
    expect(body.mode).toBe(mode);
    expect(body.items).toHaveLength(1);
    const snippet = body.items[0]!.snippet;
    expect(snippet).not.toMatch(BARE_AMPERSAND);
    return snippet;
  }

  describe('keyword full-text rows (escape before ts_headline)', () => {
    it.each([
      // The page shows `&lt;br&gt;` as text: `br` is a word inside it and is
      // highlighted, and the ampersands stay text.
      ['Use &lt;br&gt; for a line break', 'br', 'Use &amp;lt;<mark>br</mark>&amp;gt; for a line break'],
      ['Use &lt;br&gt; for a line break', 'line', 'Use &amp;lt;br&amp;gt; for a <mark>line</mark> break'],
      // The page shows `<br>` as text. Raw `ts_headline` replaced it with a
      // space; escaped first it survives and `br` is highlighted with `line`.
      ['Use <br> for a line break', 'br OR line', 'Use &lt;<mark>br</mark>&gt; for a <mark>line</mark> break'],
      ['Use <br> for a line break', 'line', 'Use &lt;br&gt; for a <mark>line</mark> break'],
      // A tag-shaped example stays inert text.
      [
        'Example: <script>alert("x")</script> is blocked',
        'example',
        '<mark>Example</mark>: &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; is blocked',
      ],
      // Literal `<mark>` text is text; only the two tags ts_headline inserts are markup.
      [
        'Wrap the term in <mark>important</mark> tags',
        'wrap',
        '<mark>Wrap</mark> the term in &lt;mark&gt;important&lt;/mark&gt; tags',
      ],
      // Inside a URL the escaped `&amp;` is part of one parser token, which the
      // headline never cuts.
      [
        'See https://example.com/a?b=1&c=2 for details',
        'details',
        'See https://example.com/a?b=1&amp;c=2 for <mark>details</mark>',
      ],
      ["It's \"quoted\" & done", 'done', 'It&#39;s &quot;quoted&quot; &amp; <mark>done</mark>'],
    ])('body %j searched for %j', async (body, search, expected) => {
      await seedPage('Formatting notes', body);
      expect(await snippetFor(search, 'keyword')).toBe(expected);
    });

    it('cuts a long body between tokens, never inside an entity', async () => {
      // Every word is followed by escaped characters, so wherever MaxWords ends
      // the fragment an entity sits next to the cut. Each entity is one parser
      // token, so the fragment keeps or drops it whole (here it ends after
      // `&lt;`, the `&amp;&gt;` beside it dropped).
      const words = Array.from({ length: 60 }, (_, index) => `w${index}<&>`);
      words[40] = 'quartzneedle<&>';
      await seedPage('Formatting notes', words.join(' '));
      expect(await snippetFor('quartzneedle', 'keyword')).toBe(
        `<mark>quartzneedle</mark>&lt;&amp;&gt; ${
          words.slice(41, 47).map((word) => word.replace('<&>', '&lt;&amp;&gt;')).join(' ')
        } w47&lt;`,
      );
    });
  });

  it('fuzzy-title rows cut 300 raw characters, then escape', async () => {
    // 298 characters, then `<br>` straddles the 300-character cut. Escaping
    // first would have cut `&lt;` to a bare `&l`.
    const prefix = `${'word '.repeat(59)}abc`;
    expect(prefix).toHaveLength(298);
    await seedPage('Snippet Escaping Handbook', `${prefix}<br>&b tail`);
    expect(await snippetFor('Snippet Escapng Handbok', 'keyword')).toBe(`${prefix}&lt;b`);
  });

  it.each(['semantic', 'hybrid'])('%s rows flatten and cut the chunk, then escape', async (mode) => {
    // 298 characters, then `<br>` straddles the 300-character cut.
    const head = 'Use <br> & "quotes" for a line break ';
    const filler = 'x'.repeat(298 - head.length);
    await seedPage('Formatting notes', `${head}${filler}<br> tail`);
    await seedEmbeddings();
    expect(await snippetFor('line', mode)).toBe(
      `Use &lt;br&gt; &amp; &quot;quotes&quot; for a line break ${filler}&lt;b`,
    );
  });
});
