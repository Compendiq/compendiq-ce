import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { adminRoutes } from './admin.js';

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
vi.mock('../../core/db/postgres.js', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  getPool: vi.fn().mockReturnValue({}),
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

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn().mockReturnValue({ sendMail: vi.fn(), close: vi.fn() }) },
}));

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

function settingKeysIn(sql: string): string[] {
  // The getters' SELECTs name their key(s) as literals except the confidence
  // reader, which parameterises. Both shapes are handled by the caller.
  return [...sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

beforeEach(() => {
  rows = {};
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (/^\s*INSERT INTO admin_settings/i.test(sql)) {
      const [key, value] = params as [string, string];
      rows[key] = value;
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
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.status(400).send({ error: 'ValidationError', message: error.message, statusCode: 400 });
      return;
    }
    reply.status(error.statusCode ?? 500).send({ error: error.message, statusCode: error.statusCode ?? 500 });
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
