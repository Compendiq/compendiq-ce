import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { adminRoutes, FTS_REBUILD_LOCK_TIMEOUT_MS } from './admin.js';

/**
 * #1118 — the retrieval knobs' write path, tested against the **real**
 * `admin-settings-service`.
 *
 * That is the point of this file existing beside `admin.test.ts`, which
 * `vi.mock`s the whole service: with the getters stubbed there is no cache,
 * and with no cache an invalidation test can only assert that a spy was
 * called — which passes just as happily if the function it calls is a no-op.
 * Here the caches are the live ones, so "writing a knob makes the next read
 * see the new value" is a behavioural claim about this handler.
 *
 * Only the database and the neighbouring services are mocked, at their own
 * boundaries.
 */

const mockQuery = vi.fn();
const mockRelease = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  // #1114 — the keyword-index save runs on a CHECKED-OUT client inside a
  // transaction, so the fake pool has to hand one out. Its statements go
  // through the same `mockQuery`, which models BEGIN / COMMIT / ROLLBACK
  // below: a rolled-back write must really be invisible in `rows`, or the
  // atomicity assertions would pass against a handler that has none.
  getPool: vi.fn().mockReturnValue({
    connect: async () => ({
      query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
      release: mockRelease,
    }),
  }),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../../core/services/audit-service.js', () => ({
  getAuditLog: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 50 }),
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/services/error-tracker.js', () => ({
  listErrors: vi.fn(),
  resolveError: vi.fn(),
  getErrorSummary: vi.fn(),
  trackError: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../domains/llm/services/llm-queue.js', () => ({
  setLlmConcurrencyClusterWide: vi.fn().mockResolvedValue(undefined),
  setLlmMaxQueueDepthClusterWide: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../domains/llm/services/embedding-service.js', () => ({
  assertNoShadowMigration: vi.fn().mockResolvedValue(undefined),
}));

/**
 * #1114 — writing a confidence threshold now records the model it was tuned
 * against, which means this handler resolves the live pair. Pinned to one
 * embedder here so the knob assertions below stay about the knobs; the
 * calibration's own behaviour is `admin-confidence-calibration.test.ts`.
 */
vi.mock('../../domains/llm/services/llm-provider-resolver.js', () => ({
  resolveConfidenceBasisPair: vi.fn(async (basis: string) =>
    basis === 'rerank' ? null : { providerId: '11111111-2222-3333-4444-555555555555', model: 'bge-m3' },
  ),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn().mockReturnValue({ sendMail: vi.fn(), close: vi.fn() }) },
}));

import { logAuditEvent } from '../../core/services/audit-service.js';
import {
  getRagFetchWidth,
  getRagRerankCandidates,
  getRagConfidenceThreshold,
  getRagConfidenceThresholdRerank,
  getRagContextCharsPerPage,
  getRagPinIdentifiersEnabled,
  getRagMmrConfig,
  getRagRankingPriorWeight,
  invalidateRagFetchWidthCache,
  invalidateRagRerankCandidatesCache,
  invalidateRagConfidenceThresholdCache,
  invalidateRagContextCharsCache,
  invalidateRagPinIdentifiersCache,
  invalidateRagMmrCache,
  invalidateRagRankingPriorCache,
} from '../../core/services/admin-settings-service.js';

/**
 * The rows the mocked database currently holds. `mockQuery` answers the
 * retrieval getters' SELECTs from this, and the PUT handler's UPSERT writes
 * into it — so a value really does have to travel handler → "database" →
 * reader for a round-trip assertion to pass.
 */
let rows: Record<string, string>;

/**
 * Writes made since `BEGIN`, applied to `rows` on COMMIT and dropped on
 * ROLLBACK. `null` outside a transaction, where writes autocommit.
 */
let pending: Record<string, string> | null;

/**
 * #1114 — when true, the corpus-wide `UPDATE pages SET tsv` fails the way a
 * `PG_STATEMENT_TIMEOUT` deployment makes it fail (57014). That is the case
 * that used to leave `fts_language` committed while every `tsv` still held
 * the previous configuration.
 */
let rebuildFails: boolean;
/** PostgreSQL SQLSTATE the faked rebuild throws with. 57014 = statement timeout, 55P03 = lock_not_available. */
let rebuildFailureCode: string;

function settingKeysIn(sql: string): string[] {
  // The getters' SELECTs name their key(s) as literals except the confidence
  // reader, which parameterises. Both shapes are handled by the caller.
  return [...sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

beforeEach(() => {
  rows = {};
  pending = null;
  rebuildFails = false;
  rebuildFailureCode = '57014';
  mockRelease.mockReset();
  vi.mocked(logAuditEvent).mockClear();
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (/^\s*BEGIN/i.test(sql)) {
      pending = {};
      return { rows: [], rowCount: 0 };
    }
    if (/^\s*COMMIT/i.test(sql)) {
      Object.assign(rows, pending ?? {});
      pending = null;
      return { rows: [], rowCount: 0 };
    }
    if (/^\s*ROLLBACK/i.test(sql)) {
      pending = null;
      return { rows: [], rowCount: 0 };
    }
    if (/UPDATE pages SET tsv/i.test(sql)) {
      if (rebuildFails) {
        const err = Object.assign(
          new Error(
            rebuildFailureCode === '55P03'
              ? 'canceling statement due to lock timeout'
              : 'canceling statement due to statement timeout',
          ),
          { code: rebuildFailureCode },
        );
        throw err;
      }
      return { rows: [], rowCount: 0 };
    }
    if (/^\s*INSERT INTO admin_settings/i.test(sql)) {
      // Two upsert shapes reach this table: the batch one binds `($1, $2)`,
      // while `fts_language` names its key as a literal and binds only the
      // value (it is written on its own, ahead of the tsvector rebuild).
      const target = pending ?? rows;
      const literalKey = sql.match(/VALUES\s*\('([a-z_]+)'/);
      if (literalKey) {
        target[literalKey[1]!] = String((params as unknown[])[0]);
        return { rows: [], rowCount: 1 };
      }
      const [key, value] = params as [string, string];
      target[key] = value;
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT setting_key, setting_value FROM admin_settings/i.test(sql)) {
      const keys = settingKeysIn(sql);
      return {
        rows: keys.filter((k) => k in rows).map((k) => ({ setting_key: k, setting_value: rows[k] })),
        rowCount: 0,
      };
    }
    if (/SELECT setting_value FROM admin_settings/i.test(sql)) {
      // `WHERE setting_key = $1` (confidence thresholds) or a literal key.
      const key = typeof params?.[0] === 'string' ? (params[0] as string) : settingKeysIn(sql)[0];
      const value = key !== undefined ? rows[key] : undefined;
      return { rows: value === undefined ? [] : [{ setting_value: value }], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });

  // Every knob's cache is process-global; clear them so one test cannot leak
  // a cached value into the next.
  invalidateRagFetchWidthCache();
  invalidateRagRerankCandidatesCache();
  invalidateRagConfidenceThresholdCache();
  invalidateRagContextCharsCache();
  invalidateRagPinIdentifiersCache();
  invalidateRagMmrCache();
  invalidateRagRankingPriorCache();
});

let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(sensible);
  // Mirrors `app.ts`'s production handler, INCLUDING its 500-message
  // scrubbing (`app.test.ts` pins that: "Should NOT expose the actual error
  // message for 500 errors"). The first cut of this file sent
  // `{ error: error.message }` for every status, which made an assertion on
  // operator-facing copy pass against a route whose message production
  // replaces with a flat 'Internal Server Error' (review r2).
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.status(400).send({ error: 'ValidationError', message: error.message, statusCode: 400 });
      return;
    }
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    reply.status(statusCode).send({
      error: statusCode === 500 ? 'InternalServerError' : error.name,
      message: statusCode === 500 ? 'Internal Server Error' : error.message,
      statusCode,
    });
  });
  const asAdmin = async (request: { userId: string; userRole: string }) => {
    request.userId = 'admin-user-id';
    request.userRole = 'admin';
  };
  app.decorate('authenticate', asAdmin);
  app.decorate('requireAdmin', asAdmin);
  await app.register(adminRoutes, { prefix: '/api' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function put(body: Record<string, unknown>) {
  return app.inject({ method: 'PUT', url: '/api/admin/settings', payload: body });
}

/** The raw string the handler wrote for `key`, straight out of the fake table. */
function stored(key: string): string | undefined {
  return rows[key];
}

describe('PUT /api/admin/settings — retrieval knobs are persisted (#1118)', () => {
  it('writes each knob under its documented admin_settings key', async () => {
    const res = await put({
      ragFetchWidth: 40,
      ragRerankCandidates: 60,
      ragConfidenceThreshold: 0.35,
      ragConfidenceThresholdRerank: 0.2,
      ragContextCharsPerPage: 12_000,
      ragPinIdentifiers: false,
      ragMmrEnabled: true,
      ragMmrLambda: 0.5,
      ragRankingPriorWeight: 0.003,
    });
    expect(res.statusCode).toBe(200);
    expect(rows).toEqual({
      rag_fetch_width: '40',
      rag_rerank_candidates: '60',
      rag_confidence_threshold: '0.35',
      rag_confidence_threshold_rerank: '0.2',
      rag_context_chars_per_page: '12000',
      rag_pin_identifiers: 'false',
      rag_mmr_enabled: 'true',
      rag_mmr_lambda: '0.5',
      rag_ranking_prior_weight: '0.003',
      // #1114 — each written threshold records the model behind its basis.
      // The similarity basis resolves to the embedder mocked above; the
      // rerank stage is unassigned here, which is recorded as a literal
      // `null` so a LATER assignment cannot read as "the model this was
      // tuned on".
      rag_confidence_threshold_calibration: JSON.stringify({
        providerId: '11111111-2222-3333-4444-555555555555',
        model: 'bge-m3',
        setAt: JSON.parse(rows['rag_confidence_threshold_calibration']!).setAt,
      }),
      rag_confidence_threshold_rerank_calibration: 'null',
    });
  });

  it('writes NOTHING for a knob the body omits', async () => {
    const res = await put({ ragFetchWidth: 40 });
    expect(res.statusCode).toBe(200);
    // An untouched knob must not acquire a row. Absent and "explicitly set to
    // the default" read alike today, but a row nobody set is a lie about what
    // the operator configured — and the assembly budget's last-good fallback
    // is written assuming no phantom row.
    expect(Object.keys(rows)).toEqual(['rag_fetch_width']);
  });

  it('rejects out-of-range values at the schema edge rather than saving a lie', async () => {
    for (const body of [
      { ragFetchWidth: 9 }, // reader would fall back to the default
      { ragFetchWidth: 201 },
      { ragRerankCandidates: 9 },
      { ragConfidenceThreshold: 1 }, // reader REJECTS '1'
      { ragConfidenceThresholdRerank: 1 },
      { ragContextCharsPerPage: -1 },
      { ragContextCharsPerPage: 24_001 },
      { ragMmrLambda: 1.5 },
      { ragRankingPriorWeight: 0.06 },
    ]) {
      const res = await put(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(rows).toEqual({});
  });
});

/**
 * TRAP 1 — the invalidation bug this PR fixes.
 *
 * All seven `invalidate*` functions shipped exported with ZERO production
 * callsites; every reference in the tree was a test. Each knob's JSDoc named
 * this handler as the caller that did not exist yet. The user-visible effect
 * was not subtle: the settings page refetches immediately after saving, that
 * GET reads the same in-process caches, and so the panel rendered the OLD
 * value straight back at the admin who had just changed it — for up to a
 * minute, on the pod that did the write.
 *
 * Each case below primes the cache with a read, saves a different value, and
 * reads again. Delete the corresponding `invalidate*()` call from the handler
 * and the second read returns the primed value.
 */
describe('PUT /api/admin/settings — writing a knob invalidates its cache (#1118 trap 1)', () => {
  it('rag_fetch_width', async () => {
    expect(await getRagFetchWidth()).toBe(10);
    expect((await put({ ragFetchWidth: 75 })).statusCode).toBe(200);
    expect(await getRagFetchWidth()).toBe(75);
  });

  it('rag_rerank_candidates', async () => {
    expect(await getRagRerankCandidates()).toBe(30);
    expect((await put({ ragRerankCandidates: 55 })).statusCode).toBe(200);
    expect(await getRagRerankCandidates()).toBe(55);
  });

  it('rag_confidence_threshold', async () => {
    expect(await getRagConfidenceThreshold()).toBe(0);
    expect((await put({ ragConfidenceThreshold: 0.42 })).statusCode).toBe(200);
    expect(await getRagConfidenceThreshold()).toBe(0.42);
  });

  it('rag_confidence_threshold_rerank — the two bases share one cache map', async () => {
    expect(await getRagConfidenceThresholdRerank()).toBe(0);
    expect((await put({ ragConfidenceThresholdRerank: 0.18 })).statusCode).toBe(200);
    expect(await getRagConfidenceThresholdRerank()).toBe(0.18);
  });

  it('rag_context_chars_per_page', async () => {
    expect(await getRagContextCharsPerPage()).toBe(6000);
    expect((await put({ ragContextCharsPerPage: 0 })).statusCode).toBe(200);
    // 0 is the kill switch, and it is exactly the value a stale cache hides.
    expect(await getRagContextCharsPerPage()).toBe(0);
  });

  it('rag_pin_identifiers', async () => {
    expect(await getRagPinIdentifiersEnabled()).toBe(true);
    expect((await put({ ragPinIdentifiers: false })).statusCode).toBe(200);
    expect(await getRagPinIdentifiersEnabled()).toBe(false);
  });

  it('rag_mmr_enabled and rag_mmr_lambda share one cache entry', async () => {
    expect(await getRagMmrConfig()).toEqual({ enabled: false, lambda: 0.7 });
    expect((await put({ ragMmrEnabled: true, ragMmrLambda: 0.5 })).statusCode).toBe(200);
    expect(await getRagMmrConfig()).toEqual({ enabled: true, lambda: 0.5 });
  });

  it('rag_ranking_prior_weight', async () => {
    expect(await getRagRankingPriorWeight()).toBe(0);
    expect((await put({ ragRankingPriorWeight: 0.003 })).statusCode).toBe(200);
    expect(await getRagRankingPriorWeight()).toBe(0.003);
  });

  it('GET /admin/settings reflects the save immediately, not a minute later', async () => {
    // The round trip an admin actually performs, in order: open the panel
    // (which primes every knob's cache), save, and let the panel refetch.
    // The opening GET is what makes this discriminate — without it the save
    // is the first read of the process and a stale cache has nothing to hide.
    const before = await app.inject({ method: 'GET', url: '/api/admin/settings' });
    expect(before.json()).toMatchObject({ ragFetchWidth: 10, ragMmrEnabled: false });

    expect((await put({ ragFetchWidth: 120, ragMmrEnabled: true })).statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: '/api/admin/settings' });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toMatchObject({ ragFetchWidth: 120, ragMmrEnabled: true });
  });
});

/**
 * TRAP 2 — exponent notation silently reverts a decimal knob to its default.
 *
 * `String(5e-7)` is `'5e-7'`; `getRagRankingPriorWeight`'s `/^\d+(\.\d+)?$/`
 * rejects it, logs, and keeps 0. The PUT still answers 200, so the panel
 * reports success for a stage that stayed off.
 */
describe('PUT /api/admin/settings — small decimals survive the round trip (#1118 trap 2)', () => {
  it('stores the ranking prior in fixed notation, not 5e-7', async () => {
    expect(String(5e-7), 'the naive serialisation this guards against').toBe('5e-7');
    expect((await put({ ragRankingPriorWeight: 0.0000005 })).statusCode).toBe(200);
    expect(stored('rag_ranking_prior_weight')).toBe('0.0000005');
    expect(await getRagRankingPriorWeight()).toBe(0.0000005);
  });

  it('stores a small confidence threshold in fixed notation', async () => {
    expect((await put({ ragConfidenceThreshold: 0.0000005 })).statusCode).toBe(200);
    expect(stored('rag_confidence_threshold')).toBe('0.0000005');
    expect(await getRagConfidenceThreshold()).toBe(0.0000005);
  });

  it('stores a small MMR lambda in fixed notation', async () => {
    expect((await put({ ragMmrLambda: 0.0000005 })).statusCode).toBe(200);
    expect(stored('rag_mmr_lambda')).toBe('0.0000005');
    expect((await getRagMmrConfig()).lambda).toBe(0.0000005);
  });

  it('leaves ordinary decimals in the shape an operator would recognise in SQL', async () => {
    expect((await put({ ragRankingPriorWeight: 0.003, ragConfidenceThreshold: 0.35 })).statusCode).toBe(200);
    expect(stored('rag_ranking_prior_weight')).toBe('0.003');
    expect(stored('rag_confidence_threshold')).toBe('0.35');
  });
});

/**
 * TRAP 3 — the two booleans are parsed by OPPOSITE list shapes.
 *
 * `rag_mmr_enabled` is an ON-list (`1|true|on` enables, everything else is
 * off) and `rag_pin_identifiers` an OFF-list (`0|false|off` disables,
 * everything else is on). Only a serialisation that lands inside both lists
 * round-trips in both directions: `'true'` / `'false'`. Write `''` or `'yes'`
 * and one of the two silently keeps its default.
 */
describe('PUT /api/admin/settings — booleans round-trip in both states (#1118 trap 3)', () => {
  it('rag_pin_identifiers: off then back on (OFF-list parser)', async () => {
    expect((await put({ ragPinIdentifiers: false })).statusCode).toBe(200);
    expect(stored('rag_pin_identifiers')).toBe('false');
    expect(await getRagPinIdentifiersEnabled()).toBe(false);

    expect((await put({ ragPinIdentifiers: true })).statusCode).toBe(200);
    expect(stored('rag_pin_identifiers')).toBe('true');
    expect(await getRagPinIdentifiersEnabled()).toBe(true);
  });

  it('rag_mmr_enabled: on then back off (ON-list parser)', async () => {
    expect((await put({ ragMmrEnabled: true })).statusCode).toBe(200);
    expect(stored('rag_mmr_enabled')).toBe('true');
    expect((await getRagMmrConfig()).enabled).toBe(true);

    expect((await put({ ragMmrEnabled: false })).statusCode).toBe(200);
    expect(stored('rag_mmr_enabled')).toBe('false');
    expect((await getRagMmrConfig()).enabled).toBe(false);
  });

  it("the stored strings are the pair both parsers agree on", async () => {
    // Stated directly, so a future "tidy" to '1'/'0' or 'on'/'off' has to
    // argue with the readers rather than with a style preference.
    await put({ ragPinIdentifiers: true, ragMmrEnabled: true });
    expect([stored('rag_pin_identifiers'), stored('rag_mmr_enabled')]).toEqual(['true', 'true']);
    await put({ ragPinIdentifiers: false, ragMmrEnabled: false });
    expect([stored('rag_pin_identifiers'), stored('rag_mmr_enabled')]).toEqual(['false', 'false']);
  });
});

/**
 * #1114 — the keyword-index language, now that Settings is its only source.
 *
 * `getFtsLanguage` and this handler both used to end in
 * `?? process.env.FTS_LANGUAGE ?? 'simple'`. Migration 049 seeds the row on
 * every instance before the first request, so that arm was unreachable in
 * practice — `FTS_LANGUAGE=german` did nothing, and the panel could not have
 * shown it if it had. The env var is retired; the row is the answer.
 */
describe('admin settings — the keyword-index language comes from the row alone (#1114)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('GET answers simple when no row exists, even with FTS_LANGUAGE set in the environment', async () => {
    vi.stubEnv('FTS_LANGUAGE', 'german');
    const res = await app.inject({ method: 'GET', url: '/api/admin/settings' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ftsLanguage: 'simple' });
  });

  it('GET answers the stored row', async () => {
    expect((await put({ ftsLanguage: 'german' })).statusCode).toBe(200);
    const res = await app.inject({ method: 'GET', url: '/api/admin/settings' });
    expect(res.json()).toMatchObject({ ftsLanguage: 'german' });
  });

  it('GET answers what the reader resolves, not the raw row', async () => {
    // A row that never passed through Zod — psql, a restored dump, a future
    // migration. `getFtsLanguage` discards it and the keyword leg really runs
    // `simple`, so reporting the raw value would show the panel a language
    // search is not using — and one `AdminSettingsSchema` itself rejects,
    // leaving the select with no matching option and Save disabled.
    rows['fts_language'] = 'klingon';
    const res = await app.inject({ method: 'GET', url: '/api/admin/settings' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ftsLanguage: 'simple' });
  });

  it('PUT persists the language and rebuilds every page tsvector with it', async () => {
    const res = await put({ ftsLanguage: 'german' });
    expect(res.statusCode).toBe(200);
    expect(stored('fts_language')).toBe('german');

    const rebuild = mockQuery.mock.calls.find(([sql]) =>
      /UPDATE pages SET tsv = to_tsvector/i.test(String(sql)),
    );
    expect(rebuild, 'saving the language must rebuild the keyword index').toBeDefined();
    // Bound, not interpolated, on this one statement — the reader's
    // interpolation is what the allow-list exists for.
    expect(rebuild![1]).toEqual(['german']);
    // EVERY page, trash included (review r2). The maintenance trigger fires
    // on `title`/`body_text` only and the restore path clears `deleted_at`
    // alone, so a skipped row returns from the trash indexed in the previous
    // language with nothing left to rebuild it — and the panel's copy says
    // "every page".
    expect(
      String(rebuild![0]),
      'a `deleted_at` filter leaves restorable pages indexed in the old language',
    ).not.toMatch(/deleted_at/i);
  });

  it('writes the row and rebuilds the corpus in ONE transaction', async () => {
    await put({ ftsLanguage: 'german' });

    const sqls = mockQuery.mock.calls.map(([sql]) => String(sql));
    const begin = sqls.findIndex((s) => /^\s*BEGIN/i.test(s));
    const upsert = sqls.findIndex((s) => /INSERT INTO admin_settings[\s\S]*'fts_language'/i.test(s));
    const rebuild = sqls.findIndex((s) => /UPDATE pages SET tsv/i.test(s));
    const commit = sqls.findIndex((s) => /^\s*COMMIT/i.test(s));

    expect(begin, 'the language save must open a transaction').toBeGreaterThanOrEqual(0);
    expect(upsert).toBeGreaterThan(begin);
    expect(rebuild).toBeGreaterThan(upsert);
    expect(commit).toBeGreaterThan(rebuild);
    // A corpus-wide rebuild is exactly the statement a deployment's
    // PG_STATEMENT_TIMEOUT kills, and it is applied pool-wide.
    expect(sqls.some((s) => /SET LOCAL statement_timeout = 0/i.test(s))).toBe(true);
    expect(mockRelease).toHaveBeenCalled();
  });

  it('bounds the LOCK wait too — lifting statement_timeout removes the only cancellation there was', async () => {
    // Review r3. `UPDATE pages` carries no WHERE, so it is the widest lock the
    // app takes, and no pool sets `lock_timeout` (only `runMigrations`, to 0).
    // With `statement_timeout` lifted and nothing in its place, a page row held
    // by an in-flight save makes this transaction wait forever, holding one of
    // PG_POOL_MAX connections and blocking every page write behind it — and
    // closing the browser tab cancels no PostgreSQL statement. The precedent
    // this handler cites (`shadow-migration-service.ts`) sets both for exactly
    // this reason.
    await put({ ftsLanguage: 'german' });

    const sqls = mockQuery.mock.calls.map(([sql]) => String(sql));
    const lock = sqls.findIndex((s) => /SET LOCAL lock_timeout/i.test(s));
    const rebuild = sqls.findIndex((s) => /UPDATE pages SET tsv/i.test(s));

    expect(lock, 'the rebuild must bound how long it waits for page locks').toBeGreaterThanOrEqual(0);
    expect(rebuild, 'the bound has to be in force before the widest lock is taken').toBeGreaterThan(lock);
    expect(sqls[lock]).toContain(`${FTS_REBUILD_LOCK_TIMEOUT_MS}ms`);
  });

  it('turns a lock wait that times out into the same retryable refusal, not a hang', async () => {
    // 55P03 is what the bound above produces. It must land in the handler's
    // catch like any other rebuild failure: ROLLBACK, no language change, and
    // the operator-facing message that makes a retry obviously safe.
    rebuildFails = true;
    rebuildFailureCode = '55P03';

    const res = await put({ ftsLanguage: 'german' });

    expect(res.statusCode).toBe(503);
    expect(res.json().message).toMatch(/was not changed/i);
    expect(stored('fts_language')).toBeUndefined();
    expect(mockQuery.mock.calls.some(([sql]) => /^\s*ROLLBACK/i.test(String(sql)))).toBe(true);
  });

  it('stores no language when the rebuild fails, so the row cannot outlive the index', async () => {
    // Before the transaction, the upsert autocommitted first: a rebuild that
    // timed out left `fts_language = german` with every `tsv` still built
    // with the previous configuration, and the panel reported the language
    // search was NOT using — the silent wrong-index failure this issue is
    // about, reachable from a control whose copy promises the rebuild.
    rebuildFails = true;

    const res = await put({ ftsLanguage: 'german' });

    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    // What the admin needs to know is that nothing changed, so a retry is
    // safe — not the driver's own message. It has to survive `app.ts`'s
    // handler, which flattens the body message of every 500 (review r2), so
    // this asserts the field the panel actually reads.
    expect(res.json().message).toMatch(/was not changed/i);
    expect(
      res.statusCode,
      'a 500 has its message replaced with "Internal Server Error" in production',
    ).not.toBe(500);
    expect(stored('fts_language'), 'the row must roll back with the rebuild').toBeUndefined();
    expect(mockQuery.mock.calls.some(([sql]) => /^\s*ROLLBACK/i.test(String(sql)))).toBe(true);
    expect(mockRelease).toHaveBeenCalled();
  });

  it('keeps the other knobs saved in the same request when the rebuild fails, and says so', async () => {
    // The panel batches the language with the nine knobs into one PUT, so a
    // rebuild failure must not discard settings that already validated and
    // have nothing to do with the keyword index — and the message the panel
    // toasts is the only feedback for the whole request, so a bare "failed"
    // reads as "nothing saved" (review r2).
    rebuildFails = true;

    const res = await put({ ftsLanguage: 'german', ragFetchWidth: 40 });

    expect(stored('rag_fetch_width')).toBe('40');
    await expect(getRagFetchWidth()).resolves.toBe(40);
    expect(res.json().message).toMatch(/other settings in this request were saved/i);
  });

  it('still dirties the corpus and writes the audit row when the rebuild fails', async () => {
    // The r9 invariant at the top of the handler is not only about the
    // settings row: a chunk change that persists without
    // `embedding_dirty` is the same silently mixed index. The language
    // rebuild is the one statement here that can throw, so it must run after
    // every other write (review r2).
    rebuildFails = true;

    const res = await put({ ftsLanguage: 'german', embeddingChunkSize: 800 });

    expect(res.statusCode).toBe(503);
    expect(stored('embedding_chunk_size')).toBe('800');
    expect(
      mockQuery.mock.calls.some(([sql]) => /UPDATE pages SET embedding_dirty = TRUE/i.test(String(sql))),
      'a persisted chunk size must always be paired with a dirtied corpus',
    ).toBe(true);
    // The audit trail records what landed — the chunk size, not a language
    // change the database rolled back.
    expect(logAuditEvent).toHaveBeenCalledTimes(1);
    const details = vi.mocked(logAuditEvent).mock.calls[0]![4] as Record<string, unknown>;
    expect(details.embeddingChunkSize).toBe(800);
    expect(details).not.toHaveProperty('ftsLanguage');
  });

  it('refuses a configuration outside the contracts allow-list, writing nothing', async () => {
    // The value reaches SQL as a regconfig identifier in the read path, so an
    // unknown name must never be stored in the first place.
    for (const bad of ['klingon', 'SIMPLE', "english'); DROP TABLE pages; --"]) {
      const res = await put({ ftsLanguage: bad });
      expect(res.statusCode, bad).toBe(400);
    }
    expect(rows).toEqual({});
    expect(
      mockQuery.mock.calls.some(([sql]) => /UPDATE pages SET tsv/i.test(String(sql))),
      'a rejected language must not trigger a corpus-wide rebuild',
    ).toBe(false);
  });
});
