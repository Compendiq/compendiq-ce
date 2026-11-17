/**
 * Integration test for the fuzzy-title trigram query planner behaviour (#928)
 * against a REAL PostgreSQL (all migrations, incl. 045_trgm_title_index).
 *
 * #928: the keyword-search "Path B" fuzzy-title query filtered with
 * `similarity(cp.title, $1) > $4`. A bare function call is NOT sargable, so the
 * planner cannot use the GIN trigram index (idx_pages_title_trgm) and falls back
 * to a Seq Scan of every page — an O(n) scan that defeats the whole point of the
 * index. The fix adds the sargable `cp.title % $1` operator predicate (pg_trgm's
 * `%` uses the default 0.3 similarity threshold, matching TRGM_SIMILARITY_THRESHOLD),
 * which lets the planner choose a Bitmap Index Scan over idx_pages_title_trgm while
 * the retained `similarity()` threshold predicate keeps the check exact.
 *
 * How this fails-before / passes-after: we drive a real keyword search request,
 * capture the exact SQL the route emits for the trigram query, then EXPLAIN it
 * under `enable_seqscan = off` (forced because the tiny test table would be
 * seq-scanned on cost regardless of sargability). The captured plan must
 * reference idx_pages_title_trgm — true only once the `%` operator is present.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import * as pg from '../../core/db/postgres.js';
import { query, getPool } from '../../core/db/postgres.js';

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const mockGetAccessibleSpaces = vi.fn();
vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: (...args: unknown[]) => mockGetAccessibleSpaces(...args),
  getUserAccessibleSpacesMemoized: (...args: unknown[]) => mockGetAccessibleSpaces(...args),
  invalidateRbacCache: vi.fn().mockResolvedValue(undefined),
}));

const dbAvailable = await isDbAvailable();

let userId: string;

/** Run EXPLAIN on a captured SQL string with seq scans disabled, returning the plan JSON as a string. */
async function explainPlan(sql: string, params: unknown[]): Promise<string> {
  const client = await getPool().connect();
  try {
    await client.query('SET enable_seqscan = off');
    const res = await client.query({ text: `EXPLAIN (FORMAT JSON) ${sql}`, values: params });
    return JSON.stringify(res.rows);
  } finally {
    client.release();
  }
}

/**
 * EXPLAIN `sql` inside a rolled-back transaction where every *secondary* index on
 * `pages` except idx_pages_title_trgm has been dropped. This isolates the title
 * predicate: the trigram index is the only usable secondary index left, so whether
 * the plan uses it depends purely on whether the predicate is sargable. On tiny
 * uniform test data the planner would otherwise favour the visibility-predicate
 * indexes and apply the title match as a post-filter, masking the behaviour #928
 * is about. The transaction is rolled back, so no schema change persists.
 */
async function explainWithOnlyTrgmIndex(sql: string, params: unknown[]): Promise<string> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    const idx = await client.query<{ relname: string }>(
      `SELECT i.relname
         FROM pg_index x
         JOIN pg_class i ON i.oid = x.indexrelid
         JOIN pg_class t ON t.oid = x.indrelid
        WHERE t.relname = 'pages'
          AND NOT x.indisprimary
          AND NOT x.indisunique
          AND i.relname <> 'idx_pages_title_trgm'`,
    );
    for (const row of idx.rows) {
      await client.query(`DROP INDEX ${row.relname}`);
    }
    const res = await client.query({ text: `EXPLAIN (FORMAT JSON) ${sql}`, values: params });
    return JSON.stringify(res.rows);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe.skipIf(!dbAvailable)('keyword search trigram query uses the GIN index (#928)', () => {
  let app: ReturnType<typeof Fastify>;
  // Captures every (sql, params) pair the route passes to the real query fn.
  const captured: Array<{ sql: string; params: unknown[] }> = [];

  beforeAll(async () => {
    await setupTestDb();

    const realQuery = pg.query;
    vi.spyOn(pg, 'query').mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (sql: any, params?: any) => {
        captured.push({ sql: String(sql), params: (params ?? []) as unknown[] });
        return realQuery(sql, params);
      },
    );

    app = Fastify({ logger: false });
    await app.register(sensible);
    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed' });
      }
      return reply.status(error.statusCode ?? 500).send({ error: error.message });
    });
    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = userId;
    });
    const { searchRoutes } = await import('./search.js');
    await app.register(searchRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    vi.restoreAllMocks();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    captured.length = 0;
    const res = await query<{ id: string }>(
      "INSERT INTO users (username, email, password_hash, role) VALUES ('trgm_user', 'trgm@test', 'x', 'user') RETURNING id",
    );
    userId = res.rows[0]!.id;
    mockGetAccessibleSpaces.mockResolvedValue(['DEV']);

    // Seed a corpus where the `welcome` trigram match is highly selective: many
    // non-matching titles plus a handful of matches. This makes the trigram index
    // path clearly cheaper than a full scan, so the planner reveals whether the
    // predicate is sargable (pre-fix it never is — it stays a post-filter).
    const rows: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (let i = 0; i < 200; i++) {
      const title = i < 5 ? `Welcome Guide ${i}` : `Release Notes Volume ${i}`;
      rows.push(`($${p++}, 'confluence', 'DEV', $${p++}, $${p++}, '', '', TRUE)`);
      params.push(`trgm-${i}`, title, `body content ${i}`);
    }
    await query(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_text,
                          body_storage, body_html, inherit_perms)
       VALUES ${rows.join(', ')}`,
      params,
    );
    // Populate planner statistics so cost estimates reflect the seeded corpus.
    await query('ANALYZE pages');
  });

  it('emits a sargable trigram predicate whose plan uses idx_pages_title_trgm', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=welcome&mode=keyword',
    });
    expect(response.statusCode).toBe(200);

    // Locate the exact trigram query the route emitted (Path B fuzzy title match).
    const trgm = captured.find(
      (c) => c.sql.includes('similarity(cp.title') && c.sql.includes('FROM pages cp'),
    );
    expect(trgm, 'route should emit a fuzzy-title trigram query').toBeDefined();

    const plan = await explainWithOnlyTrgmIndex(trgm!.sql, trgm!.params);
    // With the sargable `%` predicate the planner reaches for the GIN trigram
    // index (Bitmap Index Scan). The old bare `similarity() > $4` form is not
    // sargable, so it can never drive the index — it stays a post-filter and the
    // plan falls back to a Seq Scan of every visible page.
    expect(plan).toContain('idx_pages_title_trgm');
  });

  it('stays sargable with every keyword filter bound to the trigram query (#1740)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=welcome&mode=keyword&spaceKey=DEV&author=alice&dateFrom=2020-01-01&dateTo=2030-12-31&tags=guide&aiPolicy=all',
    });
    expect(response.statusCode).toBe(200);

    const trgm = captured.find(
      (c) => c.sql.includes('similarity(cp.title') && c.sql.includes('FROM pages cp'),
    );
    expect(trgm, 'route should emit a fuzzy-title trigram query').toBeDefined();
    // The statement planned below is the FILTERED one: the filters narrow the
    // `%` candidates as extra conjuncts and never replace the operator. Since
    // #1741 it is one statement, so check the fuzzy-title leg itself: the
    // full-text leg alone would satisfy a whole-statement match.
    const legStart = trgm!.sql.indexOf('trgm AS (');
    const legEnd = trgm!.sql.indexOf('paged AS (');
    expect(legStart, 'the keyword statement should have a trgm leg').toBeGreaterThan(-1);
    expect(legEnd).toBeGreaterThan(legStart);
    const trgmLeg = trgm!.sql.slice(legStart, legEnd);
    for (const predicate of [
      /cp\.space_key = \$\d+/,
      /cp\.author = \$\d+/,
      /cp\.last_modified_at >= \$\d+/,
      /cp\.last_modified_at <= \$\d+/,
      /cp\.labels @> \$\d+::text\[\]/,
      /cp\.ai_policy = \$\d+/,
    ]) {
      expect(trgmLeg).toMatch(predicate);
    }
    expect(trgmLeg).toContain('cp.title % $1');

    const plan = await explainWithOnlyTrgmIndex(trgm!.sql, trgm!.params);
    expect(plan).toContain('idx_pages_title_trgm');
  });

  it('documents the difference: the bare similarity() form cannot use the index', async () => {
    // Baseline: a function-only predicate is not sargable, so even with seq scans
    // disabled the planner does NOT use idx_pages_title_trgm. This is the
    // pre-fix behaviour and the reason the `%` operator is required.
    const bare = await explainPlan(
      "SELECT cp.id FROM pages cp WHERE similarity(cp.title, $1) > 0.3",
      ['welcome'],
    );
    expect(bare).not.toContain('idx_pages_title_trgm');

    // Contrast: the sargable `%` operator does use the index.
    const sargable = await explainPlan(
      "SELECT cp.id FROM pages cp WHERE cp.title % $1",
      ['welcome'],
    );
    expect(sargable).toContain('idx_pages_title_trgm');
  });

  it('keeps the paged union sargable: its fuzzy-title leg plans on idx_pages_title_trgm (#1741)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=welcome&mode=keyword&sort=title&page=2&limit=2',
    });
    expect(response.statusCode).toBe(200);

    // The ONE keyword statement: both legs unioned, then ordered and paged.
    const union = captured.find(
      (c) => c.sql.includes('UNION ALL') && c.sql.includes('similarity(cp.title') && c.sql.includes('OFFSET'),
    );
    expect(union, 'route should page one statement over the full-text and fuzzy-title union').toBeDefined();
    expect(union!.sql).toContain('cp.title % $1');

    const plan = await explainWithOnlyTrgmIndex(union!.sql, union!.params);
    expect(plan).toContain('idx_pages_title_trgm');
  });

  /**
   * #1741 — keyword search pages ONE deduplicated union of its two legs:
   * every page id on exactly one page, no page over `limit`, `total` = the
   * union's size on every page (and past the last one), one order per sort.
   *
   * Fixture, beside the 200-page corpus (`quartzpurple` matches none of it):
   * 12 full-text hits, two of which (`overlapA`, `overlapB`) are also fuzzy
   * title hits the union must not repeat, and 3 fuzzy-only title hits. The
   * union holds 15 pages; the two legs' raw sizes sum to 17. Ids grow in
   * FIXTURE order. ts_rank grows with the `quartzpurple` count (3 > 2 > 1);
   * similarity is typoA = typoC (0.79) > typoB (0.69).
   */
  describe('pagination over the deduplicated full-text and fuzzy-title union (#1741)', () => {
    type Item = { id: number; author: string | null; lastModifiedAt: string | null; labels: string[]; snippet: string };
    const FTS_ONE_HIT = ['Bravo', 'Charlie', 'Delta', 'Echo', 'Sierra', 'Tango', 'Uniform'];
    const FIXTURE: Array<{
      key: string; title: string; body: string; modified: string | null; author?: string; labels?: string[];
    }> = [
      { key: 'fts3', title: 'Alpha handbook', body: 'quartzpurple quartzpurple quartzpurple', modified: '2026-02-01' },
      { key: 'overlapA', title: 'Quartzpurple', body: 'quartzpurple runbook', modified: '2025-11-01' },
      { key: 'fts2', title: 'Romeo handbook', body: 'quartzpurple quartzpurple', modified: '2025-10-01' },
      { key: 'overlapB', title: 'Quartzpurple guide', body: 'quartzpurple', modified: '2025-09-01' },
      ...FTS_ONE_HIT.map((name, i) => ({
        key: `fts1${name}`, title: `${name} note`, body: 'quartzpurple', modified: `2025-08-0${i + 1}`,
      })),
      { key: 'fts1Victor', title: 'Victor note', body: 'quartzpurple', modified: null },
      // Fuzzy-only: no `quartzpurple` token, so only the trigram leg finds them.
      { key: 'typoA', title: 'Quartzpurpl', body: 'typo in the title', modified: '2026-01-15', author: 'bob', labels: ['typo'] },
      { key: 'typoB', title: 'Quartz purple', body: 'split title', modified: '2026-03-01' },
      { key: 'typoC', title: 'quartzpurpl', body: 'another typo', modified: null },
    ];
    let ids: Record<string, number>;

    beforeEach(async () => {
      ids = {};
      for (const row of FIXTURE) {
        const res = await query<{ id: number }>(
          `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html,
                              inherit_perms, author, last_modified_at, labels)
           VALUES ($1, 'confluence', 'DEV', $2, $3, '', '', TRUE, $4, $5, $6) RETURNING id`,
          [`p1741-${row.key}`, row.title, row.body, row.author ?? 'alice',
            row.modified && `${row.modified}T00:00:00Z`, row.labels ?? ['runbook']],
        );
        ids[row.key] = res.rows[0]!.id;
      }
    });

    async function search(params: string) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/search?q=quartzpurple&mode=keyword&includeFacets=false&${params}`,
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json<{ items: Item[]; total: number; totalPages: number }>();
      return { items: body.items, ids: body.items.map((item) => item.id), total: body.total, totalPages: body.totalPages };
    }

    const firstThreePages = (params = '') =>
      Promise.all([1, 2, 3].map((page) => search(`limit=5&page=${page}${params}`)));

    it('puts every union id on exactly one page and never more than limit on a page', async () => {
      const pages = await firstThreePages();
      expect(pages.map((page) => page.ids.length)).toEqual([5, 5, 5]);
      const seen = pages.flatMap((page) => page.ids);
      expect(seen).toHaveLength(new Set(seen).size);
      expect([...seen].sort((a, b) => a - b)).toEqual(Object.values(ids).sort((a, b) => a - b));
    });

    it('reports the deduplicated union size as total on every page', async () => {
      const pages = await firstThreePages();
      expect(pages.map(({ total, totalPages }) => ({ total, totalPages }))).toEqual(
        Array.from({ length: 3 }, () => ({ total: 15, totalPages: 3 })),
      );
    });

    it('returns an empty page past the last one with the same total', async () => {
      const past = await search('limit=5&page=4');
      expect({ ids: past.ids, total: past.total, totalPages: past.totalPages })
        .toEqual({ ids: [], total: 15, totalPages: 3 });
    });

    it('orders relevance as full-text hits by ts_rank, then fuzzy-only hits by similarity, the page id breaking ties', async () => {
      const pages = await firstThreePages();
      expect(pages.flatMap((page) => page.ids)).toEqual([
        'fts3', 'overlapA', 'fts2', 'overlapB',
        ...FTS_ONE_HIT.map((name) => `fts1${name}`), 'fts1Victor',
        'typoA', 'typoC', 'typoB',
      ].map((key) => ids[key]));
    });

    // The fixture interleaves the legs: typoB is the newest page, typoA sits
    // between fts3 and overlapA, and fts1Victor and typoC have no date (NULLS
    // LAST, then id). The fuzzy titles likewise sort among the full-text ones.
    it.each([
      ['modified', 'last_modified_at DESC NULLS LAST, id'],
      ['title', 'title, id'],
    ])('sort=%s orders both legs together across pages', async (sort, order) => {
      const pages = await firstThreePages(`&sort=${sort}`);
      const expected = await query<{ id: number }>(
        `SELECT id FROM pages WHERE id = ANY($1::int[]) ORDER BY ${order}`,
        [Object.values(ids)],
      );
      const seen = pages.flatMap((page) => page.ids);
      expect(seen).toEqual(expected.rows.map((row) => row.id));
      // Interleaved, not a block at either end: some fuzzy-only hit sorts
      // before a full-text hit, and some full-text hit before a fuzzy-only one.
      const fuzzyOnly = seen.map((id) => [ids.typoA, ids.typoB, ids.typoC].includes(id));
      expect(fuzzyOnly.indexOf(true)).toBeLessThan(fuzzyOnly.lastIndexOf(false));
      expect(fuzzyOnly.indexOf(false)).toBeLessThan(fuzzyOnly.lastIndexOf(true));
    });

    it('gives every fuzzy-only hit its own author, lastModifiedAt and labels', async () => {
      const { items } = await search('limit=20');
      const stored = await query<{ id: number; author: string | null; last_modified_at: Date | null; labels: string[] }>(
        'SELECT id, author, last_modified_at, labels FROM pages WHERE id = ANY($1::int[]) ORDER BY id',
        [[ids.typoA, ids.typoB, ids.typoC]],
      );
      expect(stored.rows).toHaveLength(3);
      for (const row of stored.rows) {
        expect(items.find((item) => item.id === row.id)).toMatchObject({
          author: row.author,
          lastModifiedAt: row.last_modified_at ? row.last_modified_at.toISOString() : null,
          labels: row.labels,
        });
      }
      expect(items.find((item) => item.id === ids.typoA)).toMatchObject({
        author: 'bob',
        lastModifiedAt: '2026-01-15T00:00:00.000Z',
        labels: ['typo'],
        snippet: 'typo in the title',
      });
      // A full-text hit keeps its highlighted ts_headline snippet.
      expect(items.find((item) => item.id === ids.fts3)!.snippet).toContain('<mark>quartzpurple</mark>');
    });
  });
});
