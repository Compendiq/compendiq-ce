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
 * the retained `similarity() > $4` keeps the threshold check exact.
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
});
