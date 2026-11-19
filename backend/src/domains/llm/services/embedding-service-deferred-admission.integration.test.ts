/**
 * SPEC-WORK-001 — embedding admission deferral (#281 runtime finding).
 *
 * Reproduces the accepted-tree defect with the REAL provider graph: real
 * `llm_providers` rows and use-case assignment, the real resolver, the real
 * `generateEmbedding` HTTP client posting at a loopback `node:http` model
 * sink, real PostgreSQL and Redis. Nothing is mocked.
 *
 * Sequence (the parent's runtime script): P1 is the embedding provider. The
 * test takes the exclusive AI-policy advisory lock for the page BEFORE the
 * worker runs, so `processDirtyPages` resolves P1 and then parks on the
 * shared admission lock. While it waits, P2 becomes the default and P1 is
 * deleted (admin operations). Releasing the lock lets admission read a
 * provider row that no longer exists → `policy_unavailable` (retryable).
 *
 * Required: ZERO model HTTP requests, the page reported as neither processed
 * nor failed, no in-progress `embedding` status left behind, the row still
 * dirty with no persistent block reason. The next ORDINARY pass resolves P2
 * and must embed the page for real — the authored prose reaches the sink —
 * so the no-call phase is not vacuous.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClient, type RedisClientType } from 'redis';
import type { PoolClient } from 'pg';

import { setupTestDb, teardownTestDb, truncateAllTables, isDbAvailable } from '../../../test-db-helper.js';
import { isRedisAvailable } from '../../../test-redis-helper.js';
import { getPool, query } from '../../../core/db/postgres.js';
import { setRedisClient, forceReleaseEmbeddingLock } from '../../../core/services/redis-cache.js';
import { AI_POLICY_LOCK_NAMESPACE } from '../../../core/services/ai-policy-service.js';
import { processDirtyPages } from './embedding-service.js';
import { createProvider, deleteProvider, setDefaultProvider } from './llm-provider-service.js';

const dbAvailable = await isDbAvailable();
const redisAvailable = dbAvailable ? await isRedisAvailable() : false;
const canRun = dbAvailable && redisAvailable;

let redis: RedisClientType | null = null;
const USER = 'deferred-admission-user';
const PROSE = 'Authored prose that is long enough to be chunked and embedded by the worker.';

/** Loopback model sink: records every request body; answers 1024-dim vectors. */
let sink: http.Server | null = null;
let sinkUrl = '';
const sinkRequests: Array<{ url: string; body: string }> = [];

function startSink(): Promise<void> {
  return new Promise((resolve) => {
    sink = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString('utf8'); });
      req.on('end', () => {
        sinkRequests.push({ url: req.url ?? '', body });
        let count = 1;
        try {
          const parsed = JSON.parse(body) as { input?: unknown };
          if (Array.isArray(parsed.input)) count = parsed.input.length;
        } catch { /* non-JSON: answer one vector */ }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: Array.from({ length: count }, () => ({ embedding: new Array(1024).fill(0.1) })) }));
      });
    });
    sink.listen(0, '127.0.0.1', () => {
      const addr = sink!.address() as AddressInfo;
      sinkUrl = `http://127.0.0.1:${addr.port}/v1`;
      resolve();
    });
  });
}

let seq = 0;
async function adminUser(): Promise<string> {
  seq += 1;
  const r = await query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, 'x', 'admin') RETURNING id`,
    [`adm${seq}`, `adm${seq}@test.invalid`],
  );
  return r.rows[0]!.id;
}

/** True once some OTHER backend is WAITING on the page's admission lock. */
async function admissionWaiting(pageId: number): Promise<boolean> {
  const r = await query(
    `SELECT 1 FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted AND classid = $1 AND objid = $2 AND objsubid = 2`,
    [AI_POLICY_LOCK_NAMESPACE, pageId],
  );
  return (r.rowCount ?? 0) > 0;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out waiting for the admission barrier');
}

beforeAll(async () => {
  if (!canRun) return;
  await setupTestDb();
  redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' }) as RedisClientType;
  redis.on('error', () => undefined);
  await redis.connect();
  setRedisClient(redis);
  await startSink();
}, 30_000);

afterAll(async () => {
  if (!canRun) return;
  if (sink) await new Promise<void>((r) => sink!.close(() => r()));
  if (redis) {
    try { await redis.quit(); } catch { /* best effort */ }
  }
  await teardownTestDb();
});

beforeEach(async () => {
  if (!canRun) return;
  await truncateAllTables();
  sinkRequests.length = 0;
  await forceReleaseEmbeddingLock(USER);
  await forceReleaseEmbeddingLock('__reembed_all__');
});

let barrier: PoolClient | null = null;
afterEach(async () => {
  // Failure cleanup: never leave the advisory lock held by a pooled client.
  if (barrier) {
    await barrier.query('ROLLBACK').catch(() => undefined);
    barrier.release();
    barrier = null;
  }
});

describe.skipIf(!canRun)('processDirtyPages — retryable admission refusal (SPEC-WORK-001)', () => {
  it('provider deleted between resolution and admission: no model call, neither success nor failure, no in-progress state; the next ordinary pass embeds through the real provider HTTP', async () => {
    const admin = await adminUser();
    const p1 = await createProvider(
      { name: 'P1', baseUrl: sinkUrl, authType: 'none', verifySsl: false, defaultModel: 'bge-m3' }, admin,
    );
    await setDefaultProvider(p1.id);
    const seeded = await query<{ id: number }>(
      `INSERT INTO pages
        (confluence_id, space_key, title, body_html, body_text, last_modified_at,
         embedding_dirty, embedding_status, deleted_at, page_type)
       VALUES ('deferred-1', 'DEV', 'Deferred admission page', $1, $2, NOW(), TRUE, 'not_embedded', NULL, 'page')
       RETURNING id`,
      [`<p>${PROSE}</p>`, PROSE],
    );
    const pageId = seeded.rows[0]!.id;

    // Barrier: the exclusive policy lock the worker's admission must wait on.
    barrier = await getPool().connect();
    await barrier.query('BEGIN');
    await barrier.query('SELECT pg_advisory_xact_lock($1, $2)', [AI_POLICY_LOCK_NAMESPACE, pageId]);

    const run = processDirtyPages(USER);
    try {
      await waitFor(() => admissionWaiting(pageId), 10_000);
      // The worker has resolved P1 and is parked at admission. Repoint the
      // deployment and delete P1 through the admin service (P2 default first,
      // so the delete is legal), then release admission.
      const p2 = await createProvider(
        { name: 'P2', baseUrl: sinkUrl, authType: 'none', verifySsl: false, defaultModel: 'bge-m3' }, admin,
      );
      await setDefaultProvider(p2.id);
      await deleteProvider(p1.id);
    } finally {
      // Failure cleanup: release the barrier even if the wait timed out so the
      // parked worker run can finish instead of hanging the file.
      await barrier.query('COMMIT').catch(() => undefined);
      barrier.release();
      barrier = null;
    }

    const first = await run;
    expect(first).toEqual({ processed: 0, errors: 0 });
    expect(sinkRequests).toHaveLength(0);
    const parked = await query<{ embedding_dirty: boolean; embedding_status: string; embedding_error: string | null; ai_policy_block_reason: string | null }>(
      `SELECT embedding_dirty, embedding_status, embedding_error, ai_policy_block_reason FROM pages WHERE id = $1`,
      [pageId],
    );
    expect(parked.rows[0]).toEqual({
      embedding_dirty: true, embedding_status: 'not_embedded', embedding_error: null, ai_policy_block_reason: null,
    });
    expect(await query(`SELECT 1 FROM page_embeddings WHERE page_id = $1`, [pageId])).toMatchObject({ rowCount: 0 });
    expect(await redis!.exists(`embedding:lock:${USER}`)).toBe(0);

    // Ordinary later pass: P2 is resolved and the authored prose is embedded
    // through the configured provider's real HTTP endpoint.
    const second = await processDirtyPages(USER);
    expect(second).toEqual({ processed: 1, errors: 0 });
    expect(sinkRequests.length).toBeGreaterThan(0);
    expect(sinkRequests.every((r) => r.url.endsWith('/v1/embeddings'))).toBe(true);
    expect(sinkRequests.some((r) => r.body.includes('Authored prose'))).toBe(true);
    const done = await query<{ embedding_dirty: boolean; embedding_status: string }>(
      `SELECT embedding_dirty, embedding_status FROM pages WHERE id = $1`,
      [pageId],
    );
    expect(done.rows[0]).toEqual({ embedding_dirty: false, embedding_status: 'embedded' });
    const chunks = await query(`SELECT 1 FROM page_embeddings WHERE page_id = $1`, [pageId]);
    expect(chunks.rowCount).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

describe.skipIf(canRun)('processDirtyPages deferred admission [SKIPPED]', () => {
  it.skip(`Requires real Postgres (${dbAvailable ? 'OK' : 'MISSING'}) and Redis (${redisAvailable ? 'OK' : 'MISSING'})`, () => undefined);
});
