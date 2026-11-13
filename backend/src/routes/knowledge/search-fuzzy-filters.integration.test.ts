/**
 * #1740 — every fuzzy-title hit in keyword search satisfies every active
 * keyword filter, against a REAL PostgreSQL (all migrations).
 *
 * `GET /api/search?mode=keyword` runs two statements: the full-text leg and
 * the fuzzy-title (`pg_trgm`) leg, whose title-only hits are appended after
 * the full-text rows. The fuzzy statement used to carry only the visibility,
 * trash and AI-policy predicates, so a misspelt query with `spaceKey`,
 * `tags`, `author` or `dateFrom`/`dateTo` active still returned title matches
 * outside the filter. Both statements now bind the same filter predicates.
 *
 * Every fixture title is a fuzzy-ONLY hit for QUERY: the misspelling defeats
 * the full-text conjunction (asserted below, not assumed), so a row the
 * filter excludes could only have leaked through the fuzzy leg.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { getFtsLanguage } from '../../core/services/fts-language.js';
import type * as RbacService from '../../core/services/rbac-service.js';
import { flushSearchAnalytics } from '../../domains/llm/services/rag-service.js';
import { searchRoutes } from './search.js';

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// The caller may READ every space but HIDDEN, so a space the filter drops is
// dropped by the filter, never by access control.
vi.mock('../../core/services/rbac-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof RbacService>()),
  getUserAccessibleSpacesMemoized: vi.fn().mockResolvedValue(['DEV', 'OPS', 'AUDITA', 'AUDITB']),
  getUserAccessibleSpaces: vi.fn().mockResolvedValue(['DEV', 'OPS', 'AUDITA', 'AUDITB']),
}));

const dbAvailable = await isDbAvailable();

/** One typo away from TITLE: no full-text match, trigram similarity far above 0.3. */
const QUERY = 'Kubernetes Upgrade Runbok';
const TITLE = 'Kubernetes Upgrade Runbook';

interface Seed {
  space: string;
  author: string;
  modified: string;
  labels: string[];
  aiPolicy: 'all' | 'local_only' | 'none';
  inheritPerms: boolean;
  trashed: boolean;
}

/** `match` satisfies every filter in FILTERS; each other row breaks exactly one. */
const BASE: Seed = {
  space: 'DEV', author: 'alice', modified: '2025-06-15T12:00:00Z', labels: ['k8s'],
  aiPolicy: 'all', inheritPerms: true, trashed: false,
};
const SEEDS = {
  match: {},
  otherSpace: { space: 'OPS' },
  unlabeled: { labels: [] },
  otherAuthor: { author: 'bob' },
  tooOld: { modified: '2023-03-01T12:00:00Z' },
  tooNew: { modified: '2026-03-01T12:00:00Z' },
  aiExcluded: { aiPolicy: 'none' },
  // Never returned, filtered or not: the visibility and trash predicates stay
  // on the fuzzy leg.
  unreadable: { space: 'HIDDEN' },
  restricted: { inheritPerms: false },
  trashed: { trashed: true },
} satisfies Record<string, Partial<Seed>>;
type Key = keyof typeof SEEDS;

const READABLE: Key[] = ['match', 'otherSpace', 'unlabeled', 'otherAuthor', 'tooOld', 'tooNew', 'aiExcluded'];

/** Each keyword filter, as a query string, and the one row it must drop. */
const FILTERS: Array<[name: string, params: string, drops: Key]> = [
  ['spaceKey', 'spaceKey=DEV', 'otherSpace'],
  ['tags', 'tags=k8s', 'unlabeled'],
  ['author', 'author=alice', 'otherAuthor'],
  ['dateFrom', 'dateFrom=2025-01-01', 'tooOld'],
  ['dateTo', 'dateTo=2025-12-31', 'tooNew'],
  // Regression guard: the fuzzy leg applied the AI-policy filter before #1740
  // too; this row keeps it applied now that its placeholder is renumbered.
  ['aiPolicy', 'aiPolicy=all', 'aiExcluded'],
];

describe.skipIf(!dbAvailable)('keyword search: fuzzy-title hits honour every active filter (#1740)', () => {
  let app: FastifyInstance;
  let userId: string;
  let ids: Record<Key, number>;

  beforeAll(async () => {
    await setupTestDb();
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = userId;
    });
    await app.register(searchRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await flushSearchAnalytics();
    await app.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await flushSearchAnalytics();
    await truncateAllTables();
    // A plain user: the page-restriction arm of the visibility predicate applies.
    const user = await query<{ id: string }>(
      "INSERT INTO users (username, email, password_hash, role) VALUES ('fuzzy', 'fuzzy@test', 'x', 'user') RETURNING id",
    );
    userId = user.rows[0]!.id;
    ids = {} as Record<Key, number>;
    for (const [key, overrides] of Object.entries(SEEDS) as Array<[Key, Partial<Seed>]>) {
      const s: Seed = { ...BASE, ...overrides };
      const row = await query<{ id: number }>(
        `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html,
                            author, last_modified_at, labels, ai_policy, inherit_perms, deleted_at)
         VALUES ($1, 'confluence', $2, $3, 'cluster maintenance notes', '', '', $4, $5, $6, $7, $8,
                 CASE WHEN $9::boolean THEN NOW() END)
         RETURNING id`,
        [`fuzzy-${key}`, s.space, TITLE, s.author, s.modified, s.labels, s.aiPolicy, s.inheritPerms, s.trashed],
      );
      ids[key] = row.rows[0]!.id;
    }
  });

  /** Returned ids, ascending: these cases assert membership, not ranking. */
  async function search(params: string, q = QUERY): Promise<number[]> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/search?q=${encodeURIComponent(q)}&mode=keyword&limit=20&includeFacets=false${params ? `&${params}` : ''}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ items: Array<{ id: number }> }>().items.map((item) => item.id).sort((a, b) => a - b);
  }

  const idsOf = (keys: Key[]) => keys.map((key) => ids[key]).sort((a, b) => a - b);

  it('still returns every readable fuzzy-only hit when no filter is active', async () => {
    // Regression guard (green before #1740 too): binding the filters must not
    // narrow an unfiltered search, nor drop the visibility and trash predicates.
    // Fixture guard: no seeded page matches the query through full text, so
    // every returned row came through the fuzzy-title leg.
    const fts = await query(
      'SELECT id FROM pages WHERE tsv @@ websearch_to_tsquery($2::regconfig, $1)',
      [QUERY, await getFtsLanguage()],
    );
    expect(fts.rows).toEqual([]);

    expect(await search('')).toEqual(idsOf(READABLE));
  });

  it.each(FILTERS)('%s drops the fuzzy hit that fails it and keeps the rest', async (_name, params, drops) => {
    expect(await search(params)).toEqual(idsOf(READABLE.filter((key) => key !== drops)));
  });

  it('returns only the fuzzy hit that satisfies every filter when all are active at once', async () => {
    expect(await search(FILTERS.map(([, params]) => params).join('&'))).toEqual(idsOf(['match']));
  });

  it('reproduces the report: a fuzzy hit from another space or without the tag is filtered', async () => {
    const pages = await query<{ id: number; space_key: string }>(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html, inherit_perms)
       VALUES ('audit-a', 'confluence', 'AUDITA', 'Deployment guide', 'release steps', '', '', TRUE),
              ('audit-b', 'confluence', 'AUDITB', 'Deplyoment guide', 'release steps', '', '', TRUE)
       RETURNING id, space_key`,
    );
    const auditA = pages.rows.find((page) => page.space_key === 'AUDITA')!.id;
    // AUDITB's title is the query itself: an FTS hit the filters exclude, and
    // the top fuzzy hit, so only the fuzzy leg can return it.
    expect({
      spaceKey: await search('spaceKey=AUDITA', 'deplyoment guide'),
      tags: await search('tags=nonexistent', 'deplyoment guide'),
    }).toEqual({ spaceKey: [auditA], tags: [] });
  });
});
