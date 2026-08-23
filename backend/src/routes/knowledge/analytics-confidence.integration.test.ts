/**
 * #1284 — `GET /api/analytics/confidence-distribution` against a REAL
 * PostgreSQL (port 5433, per `test-db-helper.ts`).
 *
 * The route exists to answer one question the Retrieval panel used to send
 * operators to their log files for: what does `rag.confidence` actually look
 * like on THIS deployment, per basis. Percentiles are a database
 * computation, so the route's own SQL is the thing under test — a mocked
 * `query()` could only ever prove the shape of a string. Nothing here
 * restates the route's SQL.
 *
 * Only `fastify.authenticate` / `requireAdmin` are stubbed: they are the
 * route's only boundary, and the admin gate is asserted separately with a
 * refusing stub.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { analyticsRoutes } from './analytics.js';

const dbAvailable = await isDbAvailable();

interface Bucket {
  p50: number | null;
  p90: number | null;
  count: number;
}
interface Body {
  windowDays: number;
  surface: string;
  similarity: Bucket;
  rerank: Bucket;
}

async function makeUser(): Promise<string> {
  const res = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id`,
    [`conf-${Math.floor(performance.now() * 1000)}`],
  );
  return res.rows[0]!.id;
}

/** One analytics row, `daysAgo` in the past. */
async function seedRow(
  userId: string,
  opts: { confidence: number | null; basis: string | null; surface: string | null; daysAgo?: number },
): Promise<void> {
  await query(
    `INSERT INTO search_analytics
       (user_id, query, result_count, max_score, search_type, confidence, confidence_basis, surface, created_at)
     VALUES ($1, 'q', 3, 0.03, 'hybrid', $2, $3, $4, NOW() - ($5 || ' days')::INTERVAL)`,
    [userId, opts.confidence, opts.basis, opts.surface, String(opts.daysAgo ?? 0)],
  );
}

describe.skipIf(!dbAvailable)('GET /api/analytics/confidence-distribution (#1284)', () => {
  let app: ReturnType<typeof Fastify>;
  let userId: string;

  beforeAll(async () => {
    await setupTestDb();
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: { userId: string; userRole: string }) => {
      request.userId = userId;
      request.userRole = 'admin';
    });
    app.decorate('requireAdmin', async (request: { userId: string; userRole: string }) => {
      request.userId = userId;
      request.userRole = 'admin';
    });
    app.decorateRequest('userId', '');
    app.decorateRequest('userRole', '');
    await app.register(analyticsRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    userId = await makeUser();
  });

  async function get(): Promise<Body> {
    const res = await app.inject({ method: 'GET', url: '/api/analytics/confidence-distribution' });
    expect(res.statusCode).toBe(200);
    return res.json() as Body;
  }

  it('answers per basis with p50, p90 and the sample size', async () => {
    // Ten similarity rows 0.1 … 1.0 — p50 0.55, p90 0.91 by linear
    // interpolation, which is what percentile_cont computes.
    for (let i = 1; i <= 10; i++) {
      await seedRow(userId, { confidence: i / 10, basis: 'similarity', surface: 'ask' });
    }
    await seedRow(userId, { confidence: 0.2, basis: 'rerank', surface: 'ask' });
    await seedRow(userId, { confidence: 0.4, basis: 'rerank', surface: 'ask' });

    const body = await get();
    expect(body.windowDays).toBe(7);
    expect(body.surface).toBe('ask');
    expect(body.similarity.count).toBe(10);
    expect(body.similarity.p50).toBeCloseTo(0.55, 5);
    expect(body.similarity.p90).toBeCloseTo(0.91, 5);
    expect(body.rerank.count).toBe(2);
    expect(body.rerank.p50).toBeCloseTo(0.3, 5);
  });

  it('never merges the two bases — a rerank bypass is measured on the cosine scale', async () => {
    await seedRow(userId, { confidence: 0.9, basis: 'rerank', surface: 'ask' });
    await seedRow(userId, { confidence: 0.1, basis: 'similarity', surface: 'ask' });

    const body = await get();
    // `confidence` is REAL, so a single-row percentile comes back at float4
    // precision (0.9 → 0.89999997…). The panel renders two decimals; the
    // point of this assertion is the SEPARATION, not the last bit.
    expect(body.rerank.count).toBe(1);
    expect(body.rerank.p50).toBeCloseTo(0.9, 5);
    expect(body.rerank.p90).toBeCloseTo(0.9, 5);
    expect(body.similarity.count).toBe(1);
    expect(body.similarity.p50).toBeCloseTo(0.1, 5);
    expect(body.similarity.p90).toBeCloseTo(0.1, 5);
  });

  it('counts assistant questions only — a page search never dilutes the sample', async () => {
    await seedRow(userId, { confidence: 0.5, basis: 'similarity', surface: 'ask' });
    await seedRow(userId, { confidence: 0.05, basis: 'similarity', surface: 'search' });
    // Historical rows carry no surface at all, and "unknown" is not "ask".
    await seedRow(userId, { confidence: 0.05, basis: 'similarity', surface: null });

    const body = await get();
    expect(body.similarity.count).toBe(1);
    expect(body.similarity.p50).toBeCloseTo(0.5, 5);
  });

  it('stops at the 7-day window', async () => {
    await seedRow(userId, { confidence: 0.5, basis: 'similarity', surface: 'ask', daysAgo: 1 });
    await seedRow(userId, { confidence: 0.9, basis: 'similarity', surface: 'ask', daysAgo: 8 });

    const body = await get();
    expect(body.similarity.count).toBe(1);
    expect(body.similarity.p50).toBeCloseTo(0.5, 5);
  });

  it('excludes unmeasurable rows by BASIS — including the healthy-empty 0', async () => {
    // basis 'none' belongs to no scale, and a null score is not a 0. Either
    // one admitted would drag both percentiles toward the floor.
    await seedRow(userId, { confidence: null, basis: 'none', surface: 'ask' });
    await seedRow(userId, { confidence: null, basis: 'similarity', surface: 'ask' });
    // The row the header comments used to get wrong: `computeRetrievalConfidence`
    // returns `{ score: 0, basis: 'none' }` for a HEALTHY EMPTY set — the
    // ordinary `no_context` path, and by volume the COMMON 'none' case — so
    // this row really lands with `confidence = 0`, NOT NULL. `confidence IS
    // NOT NULL` therefore does not exclude it and never did; the basis
    // predicate does. Anyone reaching for the score-only predicate on this
    // column (a new report, a dashboard) gets a distribution floored by these
    // zeros — which is why both the migration and this route now say the
    // exclusion is by BASIS.
    await seedRow(userId, { confidence: 0, basis: 'none', surface: 'ask' });
    await seedRow(userId, { confidence: 0.6, basis: 'similarity', surface: 'ask' });

    const body = await get();
    expect(body.similarity.count).toBe(1);
    expect(body.similarity.p50).toBeCloseTo(0.6, 5);
    // "Appears in NEITHER readout" is the claim the rerank row's copy now
    // makes on screen; assert it on the wire rather than only in prose.
    expect(body.rerank).toEqual({ p50: null, p90: null, count: 0 });
  });

  it('answers nulls, never NaN, when nothing was measured', async () => {
    const body = await get();
    expect(body.similarity).toEqual({ p50: null, p90: null, count: 0 });
    expect(body.rerank).toEqual({ p50: null, p90: null, count: 0 });
  });
});

describe.skipIf(!dbAvailable)('GET /api/analytics/confidence-distribution — admin gate (#1284)', () => {
  it('is refused for a non-admin', async () => {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async () => {});
    app.decorate('requireAdmin', async () => {
      throw app.httpErrors.forbidden('Admin required');
    });
    app.decorateRequest('userId', '');
    app.decorateRequest('userRole', '');
    await app.register(analyticsRoutes, { prefix: '/api' });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/analytics/confidence-distribution' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
