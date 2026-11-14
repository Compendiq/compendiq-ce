import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { query } from '../../core/db/postgres.js';
import {
  buildFilterClauses,
  BulkPageFilterSchema,
  BulkSelectionSchema,
} from '../../core/services/bulk-page-selection.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
  waitForDatabaseCondition,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { workerDatabaseName, workerIdFromEnv } from '../../test-worker-isolation.js';
import { pagesCrudRoutes } from './pages-crud.js';
import { buildKnowledgeTestApp, insertLocalSpace, insertUser } from './pages.test-helpers.js';
import { searchRoutes } from './search.js';

const DATE_KEYS = ['dateFrom', 'dateTo'] as const;
const READ_ROUTES = ['list', 'search'] as const;
type DateKey = typeof DATE_KEYS[number];
type ReadRoute = typeof READ_ROUTES[number];
type DateFilter = Partial<Record<DateKey, string>>;

// Exactly the contracts suite's matrix: all seven zones at precisions 0–6,
// Gregorian leap controls, and both four-digit-year endpoints. All 57 values
// are used on EACH route with from-only, to-only and equal bounds.
const ACCEPTED_FORMATS = [
  { name: 'date ordinary', value: '2025-06-15' },
  { name: 'date leap 2000', value: '2000-02-29' },
  { name: 'date leap 2024', value: '2024-02-29' },
  { name: 'date year 0001', value: '0001-01-01' },
  { name: 'date year 9999', value: '9999-12-31' },
  ...['Z', '+00:00', '-00:00', '+05:30', '-04:00', '+15:59', '-15:59'].flatMap((zone) =>
    Array.from({ length: 7 }, (_, digits) => ({
      name: `timestamp ${zone} fraction ${digits}`,
      value: `2025-06-15T06:30:00${digits ? `.${'123456'.slice(0, digits)}` : ''}${zone}`,
    })),
  ),
  { name: 'timestamp leap 2000', value: '2000-02-29T00:00:00Z' },
  { name: 'timestamp year 0001', value: '0001-01-01T00:00:00Z' },
  { name: 'timestamp year 9999', value: '9999-12-31T00:00:00Z' },
];

const INVALID_DATES = [
  'notadate',
  '2025-02-29', '1900-02-29', '2025-04-31',
  '2025-13-01', '2025-00-01', '2025-01-00', '2025-01-32',
  '2025-02-29T12:00:00Z', '1900-02-29T12:00:00+05:30',
  '0000-01-01', '0000-02-29', '0000-01-01T00:00:00Z',
  '2025-06-15T25:00:00Z', '2025-06-15T12:60:00Z', '2025-06-15T12:00:61Z',
  '2025-06-15T12:00:00+16:00', '2025-06-15T12:00:00-16:00',
  '2025-06-15T12:00:00+23:59', '2025-06-15T12:00:00-23:59',
  '2025-06-15T12:00:00+24:00', '2025-06-15T12:00:00+05:60',
  '2025-06-15T12:00:00+15:60',
];

// Explicit compatibility hardening: PostgreSQL can accept/normalize many of
// these. A new 400 here is NOT universally a former-500 regression.
const UNSUPPORTED_PROFILE = [
  '', ' ', '\t',
  ' 2025-06-15', '2025-06-15 ', '2025-06-15\n', '2025-06-15\r\n', '2025-06-15\u2028',
  '2025-06-15T06:30:00Z\n', '2025-06-15T06:30:00Z\r\n', '2025-06-15T06:30:00Z\u2029',
  'now', 'today', 'epoch', 'infinity', '-infinity',
  '2025-06-15T24:00:00Z', '2025-06-15T23:59:60Z',
  '2025-06-15T12:00Z', '2025-06-15T12:00+05:30', '2025-06-15T12:00:00',
  '2025-06-15 12:00:00Z', '2025-06-15t12:00:00z',
  '20250615', '2025-6-15',
  '2025-06-15T12:00:00+0530', '2025-06-15T12:00:00+05',
  '2025-06-15T12:00:00+05:30:00', '2025-06-15T12:00:00 UTC',
  '2025-06-15T12:00:00.Z',
  '2025-06-15T12:00:00.1234567Z',
  '2025-06-15T12:00:00.1234567+05:30', '2025-06-15T12:00:00.1234567-04:00',
  `2025-06-15T12:00:00.${'1'.repeat(100)}Z`,
  '+010000-01-01', '-0001-01-01', '10000-01-01',
];

const TOKEN = 'dateproof';
const SPACE = 'DATE_FILTERS';
const DEFAULT_BOUND = '2025-06-15T06:30:00.123456Z';

function expectBulkDateRejected(value: unknown): void {
  for (const key of DATE_KEYS) {
    const filter = { [key]: value };
    expect.soft(BulkPageFilterSchema.safeParse(filter).success, key).toBe(false);
    expect.soft(BulkSelectionSchema.safeParse({ filter, expectedCount: 0 }).success, key).toBe(false);
  }
}

describe('date filters boundary regression — existing bulk schemas', () => {
  it.each(INVALID_DATES)('rejects %j in both exported boundary schemas', expectBulkDateRejected);
});

describe('date filters profile hardening — existing bulk schemas', () => {
  it.each(UNSUPPORTED_PROFILE)('rejects out-of-profile %j, without claiming a prior 500', expectBulkDateRejected);
});

describe('date filters accepted profile — existing bulk schemas', () => {
  it.each(ACCEPTED_FORMATS)('$name stays a raw string in filter and selection', ({ value }) => {
    for (const key of DATE_KEYS) {
      expect(BulkPageFilterSchema.parse({ [key]: value })[key]).toBe(value);
      expect(BulkSelectionSchema.parse({ filter: { [key]: value }, expectedCount: 0 }).filter?.[key]).toBe(value);
    }
    const filter = { dateFrom: value, dateTo: value };
    expect(BulkSelectionSchema.parse({ filter, expectedCount: 0 }).filter).toEqual(filter);
    expect(buildFilterClauses(filter, 3)).toEqual({
      parts: ['cp.last_modified_at >= $3', 'cp.last_modified_at <= $4'],
      values: [value, value], nextIdx: 5,
    });
  });
});

describe('date filters preservation — strict bulk selection shape', () => {
  it('retains IDs-only, omission, strict fields, expectedCount and mutual exclusion', () => {
    expect(BulkPageFilterSchema.parse({})).toEqual({});
    expect(BulkSelectionSchema.parse({ ids: ['42'] })).toEqual({ ids: ['42'] });
    for (const value of [null, 0, true, [], {}]) {
      for (const key of DATE_KEYS) {
        expect(BulkPageFilterSchema.safeParse({ [key]: value }).success).toBe(false);
      }
    }
    for (const payload of [
      {}, { filter: {} }, { ids: ['42'], filter: {}, expectedCount: 0 },
      { ids: ['42'], expectedCount: 1 }, { filter: { surprise: true }, expectedCount: 0 },
    ]) {
      expect(BulkSelectionSchema.safeParse(payload).success).toBe(false);
    }
  });
});

interface Point {
  name: string;
  delta: string;
  foreign?: boolean;
  trashed?: boolean;
  undated?: boolean;
  shared?: boolean;
}
type FixtureIds = Record<string, number>;

const BOUNDARY_POINTS: Point[] = [
  { name: 'before', delta: '-1 microsecond' },
  { name: 'exact', delta: '0 microseconds' },
  { name: 'after', delta: '1 microsecond' },
  { name: 'undated', delta: '0 microseconds', undated: true },
  { name: 'trashed', delta: '0 microseconds', trashed: true },
  { name: 'foreign', delta: '0 microseconds', foreign: true },
];
const MIDNIGHT_POINTS: Point[] = [
  { name: 'previousEnd', delta: '-1 microsecond' },
  { name: 'midnight', delta: '0 microseconds' },
  { name: 'noon', delta: '12 hours' },
  { name: 'dayEnd', delta: '24 hours -1 microsecond' },
  { name: 'nextMidnight', delta: '24 hours' },
  { name: 'trashed', delta: '0 microseconds', trashed: true },
  { name: 'foreign', delta: '0 microseconds', foreign: true },
];

const sorted = (ids: number[]) => [...ids].sort((left, right) => left - right);
const idsOf = (ids: FixtureIds, names: string[]) => sorted(names.map((name) => ids[name]!));

async function removeUserRedisState(redis: RedisClientType, userId: string): Promise<void> {
  for (const pattern of [`kb:${userId}:*`, `rbac:*:${userId}*`]) {
    let cursor = '0';
    do {
      const result = await redis.scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = String(result.cursor);
      if (result.keys.length > 0) await redis.del(result.keys);
    } while (cursor !== '0');
  }
  await redis.del([
    `kb-cache-generation:pages:user:${userId}`,
    `kb-cache-generation:search:user:${userId}`,
  ]);
}

describe('page date filters — real PostgreSQL, Redis, routes and authorization', () => {
  let app: FastifyInstance;
  let redis: RedisClientType;
  let userId: string;
  let foreignUserId: string;
  let targetVerified = false;
  const ownedUserIds: string[] = [];
  const capturedErrors: Error[] = [];
  const redisErrors: Error[] = [];

  beforeAll(async () => {
    // No skipIf/early-return: an unavailable prerequisite is not acceptance proof.
    expect(await isDbAvailable(), 'real PostgreSQL must be available').toBe(true);
    const active = await query<{ name: string }>('SELECT current_database() AS name');
    const activeName = active.rows[0]!.name;
    expect(activeName).toBe(new URL(process.env.POSTGRES_URL!).pathname.slice(1));
    // Follow the active harness namespace/slot; private run ownership checks
    // belong to the invoking command, not this permanent regression suite.
    expect(activeName).toBe(workerDatabaseName(workerIdFromEnv(), process.env.TEST_DATABASE_NAMESPACE));
    targetVerified = true;
    await setupTestDb();
    expect(await isRedisAvailable(), 'real Redis must be available').toBe(true);
    redis = createClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: false, connectTimeout: 1_000 },
    }) as RedisClientType;
    redis.on('error', (error: Error) => redisErrors.push(error));
    await redis.connect();
    expect(await redis.ping()).toBe('PONG');
    expect(new URL(process.env.REDIS_URL!).pathname).toBe(`/${workerIdFromEnv()}`);
    setRedisClient(redis);

    app = await buildKnowledgeTestApp(() => userId, async (instance) => {
      instance.redis = redis;
      instance.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
        capturedErrors.push(error);
        if (error instanceof ZodError) {
          return reply.status(400).send({
            error: 'ValidationError',
            message: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
            statusCode: 400,
          });
        }
        // Preserve non-Zod failures as failures; NEVER turn PostgreSQL errors into 400.
        return reply.status(error.statusCode ?? 500).send({ error: error.name, message: error.message });
      });
      await instance.register(pagesCrudRoutes, { prefix: '/api' });
      await instance.register(searchRoutes, { prefix: '/api' });
    });
  });

  beforeEach(async () => {
    await truncateAllTables();
    capturedErrors.length = 0;
    userId = await insertUser(`date-filter-${randomUUID()}`);
    foreignUserId = await insertUser(`date-filter-foreign-${randomUUID()}`);
    ownedUserIds.push(userId, foreignUserId);
    await insertLocalSpace(SPACE, userId);
    await query('INSERT INTO user_settings (user_id, confluence_enabled) VALUES ($1, FALSE)', [userId]);
    const role = await query<{ id: number }>(
      `INSERT INTO roles (name, display_name, is_system, permissions)
       VALUES ('date-filter-reader', 'Date filter reader', FALSE, ARRAY['read']) RETURNING id`,
    );
    await query(
      `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
       VALUES ($1, 'user', $2, $3)`,
      [SPACE, userId, role.rows[0]!.id],
    );
  });

  afterAll(async () => {
    if (app) await app.close();
    setRedisClient(null);
    if (redis?.isOpen) {
      for (const id of ownedUserIds) await removeUserRedisState(redis, id);
      await redis.quit();
    }
    if (targetVerified) await truncateAllTables();
    await teardownTestDb();
    expect(redisErrors).toEqual([]);
  });

  async function seed(bound = DEFAULT_BOUND, points = BOUNDARY_POINTS): Promise<FixtureIds> {
    const ids: FixtureIds = {};
    for (const point of points) {
      const row = await query<{ id: number }>(
        `INSERT INTO pages (
           source, space_key, title, body_html, body_text, version, labels, author,
           last_modified_at, last_synced, embedding_dirty, embedding_status,
           visibility, created_by_user_id, deleted_at
         ) VALUES (
           'standalone', $1, $2, '<p>dateproof</p>', 'dateproof', 1, ARRAY['date-proof'], 'Date author',
           CASE WHEN $3::boolean THEN NULL ELSE $4::timestamptz + $5::interval END,
           NOW(), FALSE, 'not_embedded', $6, $7, CASE WHEN $8::boolean THEN NOW() END
         ) RETURNING id`,
        [SPACE, `${TOKEN} ${point.name}`, point.undated ?? false, bound, point.delta,
          point.shared ? 'shared' : 'private', point.foreign ? foreignUserId : userId, point.trashed ?? false],
      );
      ids[point.name] = row.rows[0]!.id;
    }
    return ids;
  }

  async function analyticsCount(): Promise<number> {
    const result = await query<{ count: number }>(
      'SELECT COUNT(*)::integer AS count FROM search_analytics WHERE user_id = $1', [userId],
    );
    return result.rows[0]!.count;
  }

  async function inject(url: string, payload?: Record<string, unknown>) {
    const analyticsBefore = url.startsWith('/api/search?') ? await analyticsCount() : undefined;
    const response = payload === undefined
      ? await app.inject({ method: 'GET', url })
      : await app.inject({ method: 'POST', url, payload });
    if (analyticsBefore !== undefined && response.statusCode === 200) {
      // Keyword search uses an untracked fire-and-forget analytics write. Wait
      // for that real write before snapshots/TRUNCATE; no service mock or sleep.
      expect(await waitForDatabaseCondition(async () =>
        await analyticsCount() === analyticsBefore + 1,
      ), 'successful search analytics must settle before fixture teardown').toBe(true);
    }
    return response;
  }

  function readUrl(route: ReadRoute, filter: DateFilter, q = TOKEN): string {
    const params = new URLSearchParams(route === 'search'
      ? { q, mode: 'keyword', includeFacets: 'false', limit: '20' }
      : { limit: '20' });
    for (const [key, value] of Object.entries(filter)) params.set(key, value);
    return `/api/${route === 'list' ? 'pages' : 'search'}?${params}`;
  }

  async function expectRead(route: ReadRoute, filter: DateFilter, expected: number[]): Promise<void> {
    const response = await inject(readUrl(route, filter));
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ items: Array<{ id: string | number }>; total: number }>();
    expect(sorted(body.items.map((item) => Number(item.id))), route).toEqual(sorted(expected));
    expect(body.total, route).toBe(expected.length);
  }

  async function pageSnapshot(): Promise<string> {
    // JSON is constructed by PostgreSQL so microseconds/bigint revisions are
    // not lost by the pg driver's JavaScript Date conversion.
    const result = await query<{ value: string }>(
      `SELECT COALESCE(jsonb_agg(to_jsonb(cp) ORDER BY cp.id), '[]'::jsonb)::text AS value FROM pages cp`,
    );
    return result.rows[0]!.value;
  }

  async function effectSnapshot() {
    const result = await query<{ audit: number; analytics: number; versions: number }>(
      `SELECT (SELECT COUNT(*)::integer FROM audit_log) AS audit,
              (SELECT COUNT(*)::integer FROM search_analytics) AS analytics,
              (SELECT COUNT(*)::integer FROM page_versions) AS versions`,
    );
    return { pages: await pageSnapshot(), ...result.rows[0]! };
  }

  async function expectInvalid(url: string, path: string, payload?: Record<string, unknown>): Promise<void> {
    const before = await effectSnapshot();
    capturedErrors.length = 0;
    const response = await inject(url, payload);
    const label = `${url} ${payload ? JSON.stringify(payload) : ''}`;
    expect.soft(response.statusCode, label).toBe(400);
    expect.soft(response.json(), label).toMatchObject({ error: 'ValidationError', statusCode: 400 });
    expect.soft(capturedErrors, label).toHaveLength(1);
    for (const error of capturedErrors) {
      expect.soft(error, label).toBeInstanceOf(ZodError);
      expect.soft((error as Error & { code?: string }).code, label).toBeUndefined();
    }
    const issuePaths = capturedErrors.flatMap((error) =>
      error instanceof ZodError ? error.issues.map((issue) => issue.path.join('.')) : [],
    );
    expect.soft(issuePaths, label).toContain(path);
    expect.soft(await effectSnapshot(), `${label}: no persisted effects`).toEqual(before);
    expect((await query<{ alive: number }>('SELECT 1 AS alive')).rows).toEqual([{ alive: 1 }]);
  }

  async function expectBulkDelete(filter: DateFilter, selected: number[], ids: FixtureIds): Promise<void> {
    const originalTrash = await query<{ stamp: string }>(
      'SELECT deleted_at::text AS stamp FROM pages WHERE id = $1', [ids.trashed],
    );
    const response = await inject('/api/pages/bulk/delete', {
      filter, expectedCount: selected.length, driftToleranceFraction: 0,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ succeeded: selected.length, failed: 0, errors: [] });
    const deleted = await query<{ id: number }>('SELECT id FROM pages WHERE deleted_at IS NOT NULL ORDER BY id');
    expect(deleted.rows.map((row) => row.id)).toEqual(sorted([...selected, ids.trashed!]));
    expect((await query<{ stamp: string }>(
      'SELECT deleted_at::text AS stamp FROM pages WHERE id = $1', [ids.trashed],
    )).rows).toEqual(originalTrash.rows);
  }

  describe('date filters boundary regression', () => {
    it('rejects GET /api/pages?dateFrom=notadate before timestamp SQL with no DB effects', async () => {
      await seed();
      await expectInvalid('/api/pages?dateFrom=notadate', 'dateFrom');
    });

    it('rejects GET /api/search?q=x&dateTo=notadate before timestamp SQL with no DB effects', async () => {
      await seed();
      await expectInvalid('/api/search?q=x&dateTo=notadate', 'dateTo');
    });

    it('rejects a bulk/delete date filter before selection with no DB effects', async () => {
      await seed();
      await expectInvalid('/api/pages/bulk/delete', 'filter.dateFrom', {
        filter: { dateFrom: 'notadate' }, expectedCount: 0,
      });
    });

    it.each(INVALID_DATES)('rejects %j for both bounds on list/search/bulk', async (value) => {
      await seed();
      for (const key of DATE_KEYS) {
        for (const route of READ_ROUTES) await expectInvalid(readUrl(route, { [key]: value }), key);
        await expectInvalid('/api/pages/bulk/delete', `filter.${key}`, {
          filter: { [key]: value }, expectedCount: 0,
        });
      }
    });

    const otherBulkRoutes = [
      { route: 'sync', extra: {} }, { route: 'embed', extra: {} }, { route: 'quality', extra: {} },
      { route: 'tag', extra: { addTags: ['date-proof'] } },
      { route: 'replace-tags', extra: { tags: ['date-proof'] } },
    ].flatMap((entry) => DATE_KEYS.map((key) => ({ ...entry, key })));

    it.each(otherBulkRoutes)('validates bulk/$route filter.$key, not an unrelated precondition', async ({ route, extra, key }) => {
      await seed();
      await expectInvalid(`/api/pages/bulk/${route}`, `filter.${key}`, {
        filter: { [key]: 'notadate' }, expectedCount: 0, ...extra,
      });
    });

    it.each(['semantic', 'hybrid'].flatMap((mode) => DATE_KEYS.map((key) => ({ mode, key }))))(
      'rejects $mode $key before retrieval dispatch without a model call', async ({ mode, key }) => {
        await seed();
        const params = new URLSearchParams({ q: TOKEN, mode, [key]: 'notadate' });
        await expectInvalid(`/api/search?${params}`, key);
      },
    );

    it('does not use a warm cache or valid companion to ignore a bad bound', async () => {
      const ids = await seed();
      await expectRead('list', {}, idsOf(ids, ['before', 'exact', 'after', 'undated']));
      await expectRead('list', { dateFrom: DEFAULT_BOUND }, idsOf(ids, ['exact', 'after']));
      for (const key of DATE_KEYS) {
        const filter = { dateFrom: DEFAULT_BOUND, dateTo: DEFAULT_BOUND, [key]: 'notadate' };
        for (const route of READ_ROUTES) await expectInvalid(readUrl(route, filter), key);
        await expectInvalid('/api/pages/bulk/delete', `filter.${key}`, { filter, expectedCount: 0 });
      }
    });
  });

  describe('date filters profile hardening', () => {
    it.each(UNSUPPORTED_PROFILE)('rejects unsupported %j on all three paths, without a universal prior-500 claim', async (value) => {
      await seed();
      for (const key of DATE_KEYS) {
        for (const route of READ_ROUTES) await expectInvalid(readUrl(route, { [key]: value }), key);
        await expectInvalid('/api/pages/bulk/delete', `filter.${key}`, {
          filter: { [key]: value }, expectedCount: 0,
        });
      }
    });
  });

  describe('date filters accepted profile', () => {
    it.each(ACCEPTED_FORMATS)('$name filters inclusively on list/search/bulk, preserving microseconds', async ({ value }) => {
      const ids = await seed(value);
      const precision = await query<{ id: number; delta: number }>(
        `SELECT id, ((EXTRACT(EPOCH FROM last_modified_at) - EXTRACT(EPOCH FROM $1::timestamptz))
                    * 1000000)::integer AS delta
           FROM pages WHERE id = ANY($2::integer[]) ORDER BY id`,
        [value, idsOf(ids, ['before', 'exact', 'after'])],
      );
      expect(precision.rows).toEqual([
        { id: ids.before, delta: -1 }, { id: ids.exact, delta: 0 }, { id: ids.after, delta: 1 },
      ]);
      const cases = [
        { filter: { dateFrom: value }, names: ['exact', 'after'] },
        { filter: { dateTo: value }, names: ['before', 'exact'] },
        { filter: { dateFrom: value, dateTo: value }, names: ['exact'] },
      ];
      for (const { filter, names } of cases) {
        const selected = idsOf(ids, names);
        for (const route of READ_ROUTES) await expectRead(route, filter, selected);
        await expectBulkDelete(filter, selected, ids);
        // Restore only these fixture roots for the next independent bound case.
        await query('UPDATE pages SET deleted_at = NULL WHERE id = ANY($1::integer[])', [selected]);
      }
    });

    it('equivalent Z/signed/zero offsets select identical IDs without changing submitted strings', async () => {
      const ids = await seed('2025-06-15T06:30:00Z');
      for (const value of [
        '2025-06-15T06:30:00Z', '2025-06-15T12:00:00+05:30', '2025-06-15T02:30:00-04:00',
        '2025-06-15T06:30:00+00:00', '2025-06-15T06:30:00-00:00',
      ]) {
        const filter = { dateFrom: value, dateTo: value };
        for (const route of READ_ROUTES) await expectRead(route, filter, [ids.exact!]);
        await expectBulkDelete(filter, [ids.exact!], ids);
        await query('UPDATE pages SET deleted_at = NULL WHERE id = $1', [ids.exact]);
        expect(BulkPageFilterSchema.parse(filter)).toEqual(filter);
      }
    });
  });

  describe('date filters preservation — dateTo midnight', () => {
    it.each(['list', 'search', 'bulk'] as const)(
      '%s includes exact midnight but excludes later that day, not an end-of-day fix', async (route) => {
        const ids = await seed('2025-06-15', MIDNIGHT_POINTS);
        // This is the actual connection TimeZone's midnight, NOT assumed UTC.
        const midnight = await query<{ atMidnight: boolean; timezone: string }>(
          `SELECT last_modified_at = '2025-06-15'::date::timestamptz AS "atMidnight",
                  current_setting('TimeZone') AS timezone FROM pages WHERE id = $1`, [ids.midnight],
        );
        expect(midnight.rows[0]!.atMidnight).toBe(true);
        expect(midnight.rows[0]!.timezone).not.toBe('');
        const upper = { dateTo: '2025-06-15' };
        const equal = { dateFrom: '2025-06-15', dateTo: '2025-06-15' };
        if (route === 'bulk') {
          const selected = idsOf(ids, ['previousEnd', 'midnight']);
          await expectBulkDelete(upper, selected, ids);
          await query('UPDATE pages SET deleted_at = NULL WHERE id = ANY($1::integer[])', [selected]);
          await expectBulkDelete(equal, [ids.midnight!], ids);
        } else {
          await expectRead(route, upper, idsOf(ids, ['previousEnd', 'midnight']));
          await expectRead(route, equal, [ids.midnight!]);
        }
      },
    );
  });

  describe('date filters preservation — IDs-only', () => {
    it('keeps the existing IDs-only bulk delete working without a filter/count', async () => {
      const ids = await seed();
      const response = await inject('/api/pages/bulk/delete', { ids: [String(ids.before)] });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ succeeded: 1, failed: 0, errors: [] });
      expect((await query<{ id: number }>(
        'SELECT id FROM pages WHERE deleted_at IS NOT NULL ORDER BY id',
      )).rows.map((row) => row.id)).toEqual(idsOf(ids, ['before', 'trashed']));
    });
  });

  describe('date filters preservation — authorization', () => {
    it('hides foreign-private matches and retains owner-only trashing of readable shared matches', async () => {
      const ids = await seed(DEFAULT_BOUND, [
        ...BOUNDARY_POINTS, { name: 'foreignShared', delta: '0 microseconds', foreign: true, shared: true },
      ]);
      const filter = { dateFrom: DEFAULT_BOUND, dateTo: DEFAULT_BOUND };
      for (const route of READ_ROUTES) await expectRead(route, filter, idsOf(ids, ['exact', 'foreignShared']));
      const response = await inject('/api/pages/bulk/delete', { filter, expectedCount: 2, driftToleranceFraction: 0 });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ succeeded: 1, failed: 1 });
      expect(response.json<{ errors: string[] }>().errors).toEqual([`Page ${ids.foreignShared}: not the owner`]);
      expect((await query<{ id: number }>(
        'SELECT id FROM pages WHERE deleted_at IS NOT NULL ORDER BY id',
      )).rows.map((row) => row.id)).toEqual(idsOf(ids, ['exact', 'trashed']));
    });
  });

  describe('date filters preservation — trash', () => {
    it('excludes already-trashed bound matches on all three paths and retains their original stamp', async () => {
      const ids = await seed();
      const filter = { dateFrom: DEFAULT_BOUND, dateTo: DEFAULT_BOUND };
      for (const route of READ_ROUTES) await expectRead(route, filter, [ids.exact!]);
      await expectBulkDelete(filter, [ids.exact!], ids);
    });
  });

  describe('date filters preservation — ranges and count drift', () => {
    it('retains valid reversed ranges as empty success, not a new pair-validation 400', async () => {
      const ids = await seed();
      const filter = { dateFrom: '2025-06-15T01:00:00Z', dateTo: '2025-06-15T05:00:00+05:30' };
      for (const route of READ_ROUTES) await expectRead(route, filter, []);
      await expectBulkDelete(filter, [], ids);
    });

    it('retains CountDrift 409 for a valid filter with an incorrect preview and no effects', async () => {
      await seed();
      const before = await effectSnapshot();
      const response = await inject('/api/pages/bulk/delete', {
        filter: { dateFrom: DEFAULT_BOUND, dateTo: DEFAULT_BOUND }, expectedCount: 2, driftToleranceFraction: 0,
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ error: 'CountDrift', expected: 2, actual: 1 });
      expect(await effectSnapshot()).toEqual(before);
    });

    it('does not exclude NULL timestamps when date keys are omitted', async () => {
      const ids = await seed();
      for (const route of READ_ROUTES) await expectRead(route, {}, idsOf(ids, ['before', 'exact', 'after', 'undated']));
      await expectBulkDelete({}, idsOf(ids, ['before', 'exact', 'after', 'undated']), ids);
    });
  });
});
