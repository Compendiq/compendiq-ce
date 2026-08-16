import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { adminRoutes } from './admin.js';

/**
 * #1114 — the admin settings route's half of the calibration record.
 *
 * The gap this closes: nothing between the #1105 refuse gate and the #1116
 * shadow swap connected the two. A swap rewrites the `embedding` assignment
 * (`shadow-migration-service.ts`) and moves every cosine in the corpus;
 * `rag_confidence_threshold` sits untouched on the old model's scale. The
 * ruling is warn-don't-mutate, so this route records what a threshold was
 * tuned against and reports whether that is still live.
 *
 * The harness is `admin-retrieval-settings.test.ts`'s: a fake
 * `admin_settings` table that the handler really writes into and the real
 * readers really read back, so a round-trip assertion is a claim about the
 * handler rather than about a spy. The resolver is mocked at ITS boundary —
 * it is the thing whose answer changes when an admin re-assigns a model, and
 * that is precisely what the staleness verdict is a function of.
 */

const mockQuery = vi.fn();
const mockRelease = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
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
 * The live assignment, mocked at the resolver boundary. `resolveConfidenceBasisPair`
 * is the one seam that answers "which model is this basis running on?" — it
 * owns inheritance from the default provider, the EE org-policy override and
 * ADR-021's "unassigned rerank = stage disabled" (its own unit is
 * `llm-provider-resolver`'s). Re-deriving those rules from
 * `llm_usecase_assignments` here would test a different question than the one
 * the pipeline asks. `null` is a first-class answer, not a failure.
 */
const liveEmbedding = {
  value: null as { providerId: string; model: string } | null,
  /**
   * Review r2 — the seam reports "could not resolve" separately from "nothing
   * is assigned". `resolves: false` is a DB hiccup, a decrypt failure or an EE
   * override that threw; `{resolves: true, value: null}` is an instance with
   * genuinely no model behind the basis. The write path treats them
   * differently and nothing else in this file could tell them apart.
   */
  resolves: true,
};
const liveRerank = {
  value: null as { providerId: string; model: string } | null,
  resolves: true,
};
vi.mock('../../domains/llm/services/llm-provider-resolver.js', () => ({
  resolveConfidenceBasisPair: vi.fn(async (basis: string) => {
    const live = basis === 'rerank' ? liveRerank : liveEmbedding;
    return live.resolves ? { resolved: true, pair: live.value } : { resolved: false, pair: null };
  }),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn().mockReturnValue({ sendMail: vi.fn(), close: vi.fn() }) },
}));

import { invalidateRagConfidenceThresholdCache } from '../../core/services/admin-settings-service.js';
import { CALIBRATION_SETTING_KEYS } from '../../core/services/confidence-calibration.js';

const BGE = { providerId: '11111111-2222-3333-4444-555555555555', model: 'bge-m3' };
const QWEN = { providerId: '11111111-2222-3333-4444-555555555555', model: 'Qwen3-Embedding-4B' };
const JINA = { providerId: '99999999-9999-4999-8999-999999999999', model: 'jina-reranker-v2' };

/** The fake `admin_settings` table. */
let rows: Record<string, string>;
let pending: Record<string, string> | null;

function settingKeysIn(sql: string): string[] {
  return [...sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

beforeEach(() => {
  rows = {};
  pending = null;
  liveEmbedding.value = { ...BGE };
  liveEmbedding.resolves = true;
  liveRerank.value = null;
  liveRerank.resolves = true;
  mockRelease.mockReset();
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
    if (/UPDATE pages SET tsv/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/^\s*INSERT INTO admin_settings/i.test(sql)) {
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
    if (/^\s*DELETE FROM admin_settings/i.test(sql)) {
      const target = pending ?? rows;
      const key = typeof params?.[0] === 'string' ? (params[0] as string) : settingKeysIn(sql)[0];
      if (key) delete target[key];
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
      const key = typeof params?.[0] === 'string' ? (params[0] as string) : settingKeysIn(sql)[0];
      const value = key !== undefined ? rows[key] : undefined;
      return { rows: value === undefined ? [] : [{ setting_value: value }], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  invalidateRagConfidenceThresholdCache();
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

async function getCalibration() {
  const res = await app.inject({ method: 'GET', url: '/api/admin/settings' });
  expect(res.statusCode).toBe(200);
  return (res.json() as { ragConfidenceCalibration: unknown }).ragConfidenceCalibration as {
    similarity: Record<string, unknown> | null;
    rerank: Record<string, unknown> | null;
  };
}

function storedRecord(key: string): Record<string, unknown> | null {
  const raw = rows[key];
  return raw === undefined ? null : (JSON.parse(raw) as Record<string, unknown> | null);
}

describe('PUT /api/admin/settings — a written threshold records its model (#1114)', () => {
  it('records the live embedding pair beside the similarity threshold', async () => {
    expect((await put({ ragConfidenceThreshold: 0.35 })).statusCode).toBe(200);

    const record = storedRecord(CALIBRATION_SETTING_KEYS.similarity);
    expect(record).toMatchObject({ providerId: BGE.providerId, model: 'bge-m3' });
    expect(Date.parse(String(record!.setAt))).not.toBeNaN();
  });

  it('records the live rerank pair beside the rerank threshold', async () => {
    liveRerank.value = { ...JINA };
    expect((await put({ ragConfidenceThresholdRerank: 0.2 })).statusCode).toBe(200);

    expect(storedRecord(CALIBRATION_SETTING_KEYS.rerank)).toMatchObject({
      providerId: JINA.providerId,
      model: 'jina-reranker-v2',
    });
    // Never the OTHER basis: the two knobs exist because the scales are
    // incommensurable, and so are their calibrations.
    expect(rows[CALIBRATION_SETTING_KEYS.similarity]).toBeUndefined();
  });

  it('records a null PAIR — a present record — when the rerank stage is unassigned', async () => {
    // ADR-021's ordinary disabled state. Review r1: written as a literal
    // `null` it read back as "never recorded", so the panel reported a
    // threshold saved seconds ago as predating the feature.
    expect((await put({ ragConfidenceThresholdRerank: 0.2 })).statusCode).toBe(200);
    expect(storedRecord(CALIBRATION_SETTING_KEYS.rerank)).toMatchObject({
      providerId: null,
      model: null,
    });
  });

  it('re-records on a RE-SAVE of the same value — that is how an operator keeps it', async () => {
    expect((await put({ ragConfidenceThreshold: 0.35 })).statusCode).toBe(200);
    liveEmbedding.value = { ...QWEN };

    // Same number, new model. The panel's remedy for a stale calibration is
    // "save it again to keep it and record it against the live model", so a
    // value-unchanged PUT has to re-record or that remedy does nothing.
    expect((await put({ ragConfidenceThreshold: 0.35 })).statusCode).toBe(200);
    expect(storedRecord(CALIBRATION_SETTING_KEYS.similarity)).toMatchObject({ model: 'Qwen3-Embedding-4B' });
  });

  it('leaves the OTHER basis untouched when only one threshold is in the body', async () => {
    liveRerank.value = { ...JINA };
    expect((await put({ ragConfidenceThresholdRerank: 0.2 })).statusCode).toBe(200);
    const before = rows[CALIBRATION_SETTING_KEYS.rerank];

    liveRerank.value = { providerId: JINA.providerId, model: 'bge-reranker-v2-m3' };
    expect((await put({ ragFetchWidth: 40 })).statusCode).toBe(200);

    // A PUT that never mentioned the rerank threshold must not re-date its
    // calibration — that would silently certify a threshold against a model
    // nobody tuned it on.
    expect(rows[CALIBRATION_SETTING_KEYS.rerank]).toBe(before);
  });

  it('writes NO calibration at all for a PUT carrying neither threshold', async () => {
    expect((await put({ ragFetchWidth: 40 })).statusCode).toBe(200);
    expect(Object.keys(rows)).toEqual(['rag_fetch_width']);
  });

  it('CLEARS the calibration when the threshold goes back to 0', async () => {
    expect((await put({ ragConfidenceThreshold: 0.35 })).statusCode).toBe(200);
    expect(rows[CALIBRATION_SETTING_KEYS.similarity]).toBeDefined();

    expect((await put({ ragConfidenceThreshold: 0 })).statusCode).toBe(200);
    expect(rows[CALIBRATION_SETTING_KEYS.similarity]).toBeUndefined();
  });

  it('still saves the threshold when no model resolves at all', async () => {
    liveEmbedding.value = null; // no provider configured on the instance
    expect((await put({ ragConfidenceThreshold: 0.35 })).statusCode).toBe(200);
    expect(rows['rag_confidence_threshold']).toBe('0.35');
    expect(storedRecord(CALIBRATION_SETTING_KEYS.similarity)).toMatchObject({
      providerId: null,
      model: null,
    });
  });

  it('records NOTHING when the resolver FAILED — and leaves the previous record standing', async () => {
    // Review r2. A resolver that throws (DB hiccup, decrypt failure, an EE
    // override that raised) used to arrive here as the same `null` an
    // unassigned basis produces, and got written down as the claim "this
    // threshold was tuned against no model at all" — false on an instance
    // that has had an embedder assigned the whole time, and permanent, since
    // the panel then states it as fact and rates it stale the moment the
    // resolver recovers. Unknown is not a finding: keep the last thing we
    // actually knew.
    expect((await put({ ragConfidenceThreshold: 0.35 })).statusCode).toBe(200);
    const recorded = rows[CALIBRATION_SETTING_KEYS.similarity];
    expect(storedRecord(CALIBRATION_SETTING_KEYS.similarity)).toMatchObject({ model: 'bge-m3' });

    liveEmbedding.resolves = false;
    expect((await put({ ragConfidenceThreshold: 0.5 })).statusCode).toBe(200);

    // The knob the operator asked for still lands; only the diagnostic
    // abstains.
    expect(rows['rag_confidence_threshold']).toBe('0.5');
    expect(rows[CALIBRATION_SETTING_KEYS.similarity]).toBe(recorded);
  });

  it('still CLEARS the calibration at 0 when the resolver is failing', async () => {
    // Clearing needs no pair, so an unreachable resolver must not strand a
    // record beside a gate that is off — the panel would warn about a
    // threshold that runs nothing.
    expect((await put({ ragConfidenceThreshold: 0.35 })).statusCode).toBe(200);
    liveEmbedding.resolves = false;
    expect((await put({ ragConfidenceThreshold: 0 })).statusCode).toBe(200);

    expect(rows[CALIBRATION_SETTING_KEYS.similarity]).toBeUndefined();
  });
});

describe('GET /api/admin/settings — the staleness verdict (#1114)', () => {
  it('reports both bases null on an instance that never set a threshold', async () => {
    expect(await getCalibration()).toEqual({ similarity: null, rerank: null });
  });

  it('is not stale while the recorded pair is still the live one', async () => {
    await put({ ragConfidenceThreshold: 0.35 });

    const { similarity } = await getCalibration();
    expect(similarity).toMatchObject({
      providerId: BGE.providerId,
      model: 'bge-m3',
      liveProviderId: BGE.providerId,
      liveModel: 'bge-m3',
      stale: false,
    });
  });

  it('turns stale when the embedding assignment moves under it', async () => {
    await put({ ragConfidenceThreshold: 0.35 });
    liveEmbedding.value = { ...QWEN };

    const { similarity } = await getCalibration();
    expect(similarity).toMatchObject({ model: 'bge-m3', liveModel: 'Qwen3-Embedding-4B', stale: true });
  });

  it('turns stale when the rerank stage becomes unassigned', async () => {
    liveRerank.value = { ...JINA };
    await put({ ragConfidenceThresholdRerank: 0.2 });
    liveRerank.value = null;

    const { rerank } = await getCalibration();
    expect(rerank).toMatchObject({ model: 'jina-reranker-v2', liveProviderId: null, liveModel: null, stale: true });
  });

  it('turns stale when a rerank model APPEARS behind a threshold tuned without one', async () => {
    // Review r1's second half, end to end: the rerank threshold is set while
    // the stage is disabled, then a reranker is assigned. The number now gates
    // on a relevance scale it was never measured against, and the record can
    // say so because it is a record.
    await put({ ragConfidenceThresholdRerank: 0.2 });
    expect((await getCalibration()).rerank).toMatchObject({ model: null, stale: false });

    liveRerank.value = { ...JINA };
    expect((await getCalibration()).rerank).toMatchObject({
      model: null,
      liveModel: 'jina-reranker-v2',
      stale: true,
    });
  });

  it('clears back to not-stale once the threshold is saved again', async () => {
    await put({ ragConfidenceThreshold: 0.35 });
    liveEmbedding.value = { ...QWEN };
    expect((await getCalibration()).similarity).toMatchObject({ stale: true });

    await put({ ragConfidenceThreshold: 0.35 });
    expect((await getCalibration()).similarity).toMatchObject({ model: 'Qwen3-Embedding-4B', stale: false });
  });

  it('puts nothing provider-secret on the wire', async () => {
    liveRerank.value = { ...JINA };
    await put({ ragConfidenceThreshold: 0.35, ragConfidenceThresholdRerank: 0.2 });

    const calibration = await getCalibration();
    for (const basis of [calibration.similarity, calibration.rerank]) {
      expect(Object.keys(basis!).sort()).toEqual(
        ['liveModel', 'liveProviderId', 'model', 'providerId', 'setAt', 'stale'].sort(),
      );
    }
  });

  it('never MUTATES the threshold, however stale the calibration is', async () => {
    await put({ ragConfidenceThreshold: 0.35 });
    liveEmbedding.value = { ...QWEN };
    await getCalibration();
    // The ruling: the swap never changes refusal policy. A read least of all.
    expect(rows['rag_confidence_threshold']).toBe('0.35');
  });
});
