import { describe, it, expect, afterEach, vi } from 'vitest';
import type { PoolClient } from 'pg';
import {
  extractInternalLinks,
  getInternalHosts,
  runExplicitLinkProducer,
} from './link-extractor.js';

// vi.mock the postgres module so any accidental fall-through to the global
// `query()` helper would throw — tightens the assertion that the producer
// only talks to the provided `client` (Finding 2: producer contract).
vi.mock('../../../core/db/postgres.js', () => ({
  query: vi.fn(() => {
    throw new Error(
      'runExplicitLinkProducer must use the provided PoolClient, not the global pool query()',
    );
  }),
  getPool: vi.fn(() => {
    throw new Error('runExplicitLinkProducer must not call getPool()');
  }),
}));

describe('extractInternalLinks', () => {
  it('returns [] for empty/null html', () => {
    expect(extractInternalLinks(null, new Map())).toEqual([]);
    expect(extractInternalLinks(undefined, new Map())).toEqual([]);
    expect(extractInternalLinks('', new Map())).toEqual([]);
  });

  it('extracts /pages/:id app-route links', () => {
    const html = `<p>See <a href="/pages/42">our doc</a> and <a href="/pages/7/section#x">other</a>.</p>`;
    expect(extractInternalLinks(html, new Map())).toEqual([
      { targetPageId: 42 },
      { targetPageId: 7 },
    ]);
  });

  it('resolves #confluence-page:<title> to ids via the title map', () => {
    const html = `<a href="#confluence-page:Architecture">arch</a>`;
    const map = new Map([['Architecture', 12]]);
    expect(extractInternalLinks(html, map)).toEqual([{ targetPageId: 12 }]);
  });

  it('drops #confluence-page:<title> when title is unknown to the map', () => {
    const html = `<a href="#confluence-page:NoSuchTitle">x</a>`;
    expect(extractInternalLinks(html, new Map())).toEqual([]);
  });

  it('dedupes the same target referenced multiple times in one page', () => {
    const html = `<a href="/pages/5">a</a><a href="/pages/5">b</a>`;
    expect(extractInternalLinks(html, new Map())).toEqual([{ targetPageId: 5 }]);
  });

  it('ignores external URLs and non-page anchors', () => {
    const html = `
      <a href="https://example.com">external</a>
      <a href="mailto:x@y.z">mail</a>
      <a href="#anchor-only">anchor</a>
      <a href="/spaces/DEV">space</a>
    `;
    expect(extractInternalLinks(html, new Map())).toEqual([]);
  });

  it('ignores anchors without an href', () => {
    const html = `<a>no href</a>`;
    expect(extractInternalLinks(html, new Map())).toEqual([]);
  });

  it('handles malformed/garbled HTML without throwing', () => {
    const html = `<a href="/pages/3">ok</a><a href=`;
    expect(extractInternalLinks(html, new Map())).toEqual([{ targetPageId: 3 }]);
  });

  it('rejects /pages/:id when :id is non-numeric', () => {
    const html = `<a href="/pages/new">new page form</a>`;
    expect(extractInternalLinks(html, new Map())).toEqual([]);
  });

  // ── #359 absolute-URL matching against the configured deployment host ──

  it('matches absolute URLs whose host is in internalHosts', () => {
    const hosts = new Set(['kb.example.com']);
    const html = `<a href="https://kb.example.com/pages/123">x</a>`;
    expect(extractInternalLinks(html, new Map(), hosts)).toEqual([
      { targetPageId: 123 },
    ]);
  });

  it('rejects absolute URLs whose host is NOT in internalHosts (foreign host)', () => {
    const hosts = new Set(['kb.example.com']);
    const html = `<a href="https://other.example.com/pages/123">x</a>`;
    expect(extractInternalLinks(html, new Map(), hosts)).toEqual([]);
  });

  it('treats absolute URL host case-insensitively', () => {
    const hosts = new Set(['kb.example.com']);
    const html = `<a href="https://KB.Example.COM/pages/9">x</a>`;
    expect(extractInternalLinks(html, new Map(), hosts)).toEqual([
      { targetPageId: 9 },
    ]);
  });

  it('matches absolute URLs across multiple internal hosts (comma-separated FRONTEND_URL)', () => {
    const hosts = new Set(['kb.example.com', 'staging.example.com']);
    const html = `
      <a href="https://kb.example.com/pages/1">a</a>
      <a href="https://staging.example.com/pages/2">b</a>
    `;
    expect(extractInternalLinks(html, new Map(), hosts)).toEqual([
      { targetPageId: 1 },
      { targetPageId: 2 },
    ]);
  });

  it('rejects absolute URLs to internal host that do not point at /pages/:id', () => {
    const hosts = new Set(['kb.example.com']);
    const html = `<a href="https://kb.example.com/spaces/DEV">x</a>`;
    expect(extractInternalLinks(html, new Map(), hosts)).toEqual([]);
  });

  it('still rejects absolute URLs when internalHosts is empty (default)', () => {
    const html = `<a href="https://kb.example.com/pages/1">x</a>`;
    expect(extractInternalLinks(html, new Map())).toEqual([]);
  });

  it('dedupes a relative /pages/:id and an absolute internal URL to the same id', () => {
    const hosts = new Set(['kb.example.com']);
    const html = `
      <a href="/pages/42">rel</a>
      <a href="https://kb.example.com/pages/42">abs</a>
    `;
    expect(extractInternalLinks(html, new Map(), hosts)).toEqual([
      { targetPageId: 42 },
    ]);
  });
});

describe('getInternalHosts', () => {
  const originalFrontendUrl = process.env.FRONTEND_URL;

  afterEach(() => {
    if (originalFrontendUrl === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = originalFrontendUrl;
  });

  it('returns empty set when FRONTEND_URL is unset', () => {
    delete process.env.FRONTEND_URL;
    expect(getInternalHosts().size).toBe(0);
  });

  it('parses single FRONTEND_URL into one lower-cased hostname', () => {
    process.env.FRONTEND_URL = 'https://Kb.Example.COM';
    expect(Array.from(getInternalHosts())).toEqual(['kb.example.com']);
  });

  it('parses comma-separated FRONTEND_URL into multiple hostnames', () => {
    process.env.FRONTEND_URL = 'https://kb.example.com, https://staging.example.com';
    const hosts = Array.from(getInternalHosts()).sort();
    expect(hosts).toEqual(['kb.example.com', 'staging.example.com']);
  });

  it('skips malformed entries silently', () => {
    process.env.FRONTEND_URL = 'not-a-url, https://kb.example.com';
    expect(Array.from(getInternalHosts())).toEqual(['kb.example.com']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// runExplicitLinkProducer — incremental rescan + producer-contract tests
// ─────────────────────────────────────────────────────────────────────────
//
// These exercise the symmetric incremental scan (PR #372 review Finding 1)
// and the "use only the provided client" contract (Finding 2). We mock the
// `PoolClient` rather than spin up Postgres so the test runs in the unit
// suite without the integration DB; the SQL strings are inspected directly.

interface MockPoolClient {
  query: ReturnType<typeof vi.fn>;
}

/**
 * Build a minimal PoolClient mock that routes:
 *  - The `loadTitleIndex` SELECT (matched by `FROM pages WHERE deleted_at IS NULL AND title IS NOT NULL`)
 *    to a configurable list of `{id, title}` rows.
 *  - The page-fetch SELECT (matched by `FROM pages WHERE deleted_at IS NULL` *with*
 *    a leading body_html filter or id ANY) to a configurable list.
 *  - The INSERT into page_relationships to a `{rowCount: 1}` success.
 */
function makeClient(opts: {
  titleRows: { id: number; title: string }[];
  pageRows: { id: number; body_html: string | null }[];
  /** Optional: assert the SELECT for pages received specific bind values. */
  onPageSelect?: (sql: string, params: unknown[] | undefined) => void;
}): MockPoolClient {
  const client: MockPoolClient = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (s.includes('SELECT id, title FROM pages')) {
        return { rows: opts.titleRows, rowCount: opts.titleRows.length };
      }
      if (s.includes('SELECT id, body_html FROM pages')) {
        opts.onPageSelect?.(s, params);
        return { rows: opts.pageRows, rowCount: opts.pageRows.length };
      }
      if (s.includes('INSERT INTO page_relationships')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL in mock: ${s}`);
    }),
  };
  return client;
}

describe('runExplicitLinkProducer — Finding 2 (producer contract)', () => {
  it('uses ONLY the provided client (does not call the global pool query/getPool)', async () => {
    // The vi.mock at the top throws on any global query()/getPool() call,
    // so this test merely needs to complete without those throws to prove
    // the contract holds. We exercise both the full and incremental paths.
    const client = makeClient({
      titleRows: [{ id: 1, title: 'Alpha' }, { id: 2, title: 'Beta' }],
      pageRows: [{ id: 1, body_html: '<a href="/pages/2">b</a>' }],
    });

    const fullCount = await runExplicitLinkProducer(client as unknown as PoolClient);
    expect(fullCount).toBe(1);

    const incCount = await runExplicitLinkProducer(client as unknown as PoolClient, [1]);
    expect(incCount).toBeGreaterThanOrEqual(0);

    // Every SQL touched the mock client — none escaped to a separate pool.
    expect(client.query.mock.calls.length).toBeGreaterThan(0);
  });

  it('runs the title-index SELECT on the provided client (not via global query())', async () => {
    const client = makeClient({
      titleRows: [{ id: 7, title: 'Gamma' }],
      pageRows: [],
    });

    await runExplicitLinkProducer(client as unknown as PoolClient);

    const titleCall = client.query.mock.calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('SELECT id, title FROM pages'),
    );
    expect(titleCall).toBeDefined();
  });
});

describe('runExplicitLinkProducer — Finding 1 (symmetric incremental rescan)', () => {
  it('emits B↔C even when only C is in changedPageIds (B unchanged, B links to C)', async () => {
    // Scenario from the review: page B (id=10) has `<a href="/pages/20">` to
    // page C (id=20). C becomes dirty (e.g. label-only re-embed). The
    // symmetric DELETE in computePageRelationships removes the B↔C row.
    // The producer MUST re-emit it by re-scanning B (a referrer of C).
    const titleRows = [
      { id: 10, title: 'Page B' },
      { id: 20, title: 'Page C' },
    ];
    // Symmetric scan returns BOTH C (changed) and B (referrer of C).
    const pageRows = [
      { id: 10, body_html: '<a href="/pages/20">link to C</a>' },
      { id: 20, body_html: '<p>no outbound links</p>' },
    ];
    let capturedSql = '';
    let capturedParams: unknown[] | undefined;
    const client = makeClient({
      titleRows,
      pageRows,
      onPageSelect: (sql, params) => {
        capturedSql = sql;
        capturedParams = params;
      },
    });

    const count = await runExplicitLinkProducer(client as unknown as PoolClient, [20]);

    // SQL contract: the page-select must include both `id = ANY($1)` AND
    // `body_html LIKE ANY($2)` to catch referrers of changed pages.
    expect(capturedSql).toContain('id = ANY($1::int[])');
    expect(capturedSql).toContain('body_html LIKE ANY($2::text[])');
    // $1 = changed ids, $2 includes the `/pages/20` substring pattern.
    expect(capturedParams?.[0]).toEqual([20]);
    const patterns = capturedParams?.[1] as string[];
    expect(patterns).toContain('%/pages/20%');
    // And the title-substring pattern for the Confluence shape.
    expect(patterns).toContain('%#confluence-page:Page C%');

    // One INSERT was issued for the B↔C edge.
    const insertCalls = client.query.mock.calls.filter((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO page_relationships'),
    );
    expect(insertCalls).toHaveLength(1);
    // Canonical (lo, hi) ordering: 10 < 20.
    expect(insertCalls[0][1]).toEqual([10, 20]);
    expect(count).toBe(1);
  });

  it('emits B↔C when B references C via #confluence-page:<title> and C is the changed page', async () => {
    const titleRows = [
      { id: 100, title: 'Architecture' },
      { id: 200, title: 'Onboarding' },
    ];
    // B (id=100) links to C (id=200) via the Confluence-sync placeholder.
    const pageRows = [
      { id: 100, body_html: '<a href="#confluence-page:Onboarding">go</a>' },
    ];
    const client = makeClient({ titleRows, pageRows });

    const count = await runExplicitLinkProducer(client as unknown as PoolClient, [200]);

    const insertCalls = client.query.mock.calls.filter((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO page_relationships'),
    );
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0][1]).toEqual([100, 200]);
    expect(count).toBe(1);
  });

  it('still includes the changed page itself as a source (path (a) of the symmetric scan)', async () => {
    // C is in changedPageIds; C also has outbound links — those must still
    // be emitted, in addition to inbound links from referrers.
    const titleRows = [
      { id: 1, title: 'A' },
      { id: 2, title: 'B' },
      { id: 3, title: 'C' },
    ];
    // The symmetric SELECT returns id=3 (changed) AND id=1 (referrer of 3).
    const pageRows = [
      { id: 1, body_html: '<a href="/pages/3">to C</a>' },
      { id: 3, body_html: '<a href="/pages/2">C to B</a>' },
    ];
    const client = makeClient({ titleRows, pageRows });

    const count = await runExplicitLinkProducer(client as unknown as PoolClient, [3]);

    const insertCalls = client.query.mock.calls.filter((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO page_relationships'),
    );
    // Two edges: (1,3) from referrer and (2,3) from C's outbound link.
    expect(insertCalls).toHaveLength(2);
    const pairs = insertCalls.map((c) => c[1]).sort((a, b) =>
      (a as number[])[0] - (b as number[])[0],
    );
    expect(pairs).toEqual([[1, 3], [2, 3]]);
    expect(count).toBe(2);
  });

  it('full-recompute path (no changedPageIds) does not emit the LIKE-ANY pattern filter', async () => {
    let capturedSql = '';
    const client = makeClient({
      titleRows: [{ id: 1, title: 'A' }],
      pageRows: [{ id: 1, body_html: null }],
      onPageSelect: (sql) => {
        capturedSql = sql;
      },
    });

    await runExplicitLinkProducer(client as unknown as PoolClient, null);

    // Full recompute = plain `WHERE deleted_at IS NULL`, no LIKE-ANY.
    expect(capturedSql).toContain('WHERE deleted_at IS NULL');
    expect(capturedSql).not.toContain('LIKE ANY');
  });

  it('escapes LIKE meta-chars in titles so a title with `%` does not match unrelated pages', async () => {
    const titleRows = [{ id: 42, title: 'Weird % Title' }];
    let capturedParams: unknown[] | undefined;
    const client = makeClient({
      titleRows,
      pageRows: [],
      onPageSelect: (_sql, params) => {
        capturedParams = params;
      },
    });

    await runExplicitLinkProducer(client as unknown as PoolClient, [42]);

    const patterns = capturedParams?.[1] as string[];
    // The title's `%` is escaped (`\%`) inside the substring pattern so
    // PostgreSQL treats it literally; the outer `%…%` wildcards remain.
    expect(patterns).toContain('%#confluence-page:Weird \\% Title%');
  });
});
