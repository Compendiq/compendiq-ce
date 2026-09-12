import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClient, type RedisClientType } from 'redis';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { isRedisAvailable } from '../../../test-redis-helper.js';
import { query } from '../../../core/db/postgres.js';
import { setRedisClient, acquireWorkerLock, releaseWorkerLock } from '../../../core/services/redis-cache.js';
import { invalidateDispatcher } from '../../llm/services/openai-compatible-client.js';
import { processBatch, triggerQualityBatch, getQualityStatus, stopQualityWorker } from './quality-worker.js';

// Real persistence, provider resolution, streaming client and locks. Only the
// external HTTP provider is replaced by a local endpoint with controlled replies.
const dbAvailable = await isDbAvailable();
const redisAvailable = await isRedisAvailable();
const report = '## Overall Quality Score: 75/100\n## Completeness: 80/100\n## Clarity: 70/100\n## Structure: 78/100\n## Accuracy: 72/100\n## Readability: 68/100\n## Summary\nDecent article.';
const content = 'This article describes the deployment procedure and recovery steps with sufficient detail for a meaningful quality analysis.';
const lockKey = 'worker:lock:quality-worker';
// The setter is non-nullable, although null is its supported no-Redis fallback.
const noRedis = null as unknown as RedisClientType;

function respondWithReport(res: ServerResponse, text = report): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  res.end('data: [DONE]\n\n');
}

async function seedPage(name: string, order: number, body = content): Promise<void> {
  await query(
    `INSERT INTO pages (space_key, title, body_text, body_html, quality_status, last_synced)
     VALUES ('QUALITY', $1, $2, $3, 'pending', $4)`,
    [name, body, `<p>${body}</p>`, new Date(Date.UTC(2026, 0, order))],
  );
}

async function pageStates() {
  return (await query<{
    title: string;
    quality_status: string;
    quality_error: string | null;
    quality_score: number | null;
    quality_retry_count: number;
  }>(`SELECT title, quality_status, quality_error, quality_score, quality_retry_count FROM pages ORDER BY last_synced`)).rows;
}

describe.skipIf(!dbAvailable)('Quality batch integration', () => {
  let server: Server;
  let baseUrl: string;
  let redis: RedisClientType | undefined;
  let providerId: string;
  let calls: number;
  let respond: (res: ServerResponse) => void;

  beforeAll(async () => {
    await setupTestDb();
    server = createServer((req, res) => {
      if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
        res.writeHead(404);
        res.end();
        return;
      }
      req.on('data', () => undefined);
      req.on('end', () => {
        calls++;
        respond(res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    if (redisAvailable) {
      redis = createClient({
        url: process.env.REDIS_URL,
        socket: { connectTimeout: 1_000, reconnectStrategy: false },
      }) as RedisClientType;
      redis.on('error', () => undefined);
      await redis.connect();
    }
  });

  beforeEach(async () => {
    await truncateAllTables();
    // Exercise the supported single-node fallback in the ordinary cases.
    setRedisClient(noRedis);
    calls = 0;
    respond = (res) => respondWithReport(res);
    await query(`INSERT INTO spaces (space_key, space_name) VALUES ('QUALITY', 'Quality integration')`);
    const provider = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, default_model)
       VALUES ('quality-integration', $1, 'none', TRUE, 'quality-test-model') RETURNING id`,
      [baseUrl],
    );
    providerId = provider.rows[0]!.id;
    await query(
      `INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('quality', $1, 'quality-test-model')`,
      [providerId],
    );
  });

  afterEach(() => {
    invalidateDispatcher(providerId);
  });

  afterAll(async () => {
    stopQualityWorker();
    setRedisClient(noRedis);
    if (redis) await redis.quit();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await teardownTestDb();
  });

  it('counts provider and parse failures separately while processing later articles and deliberate skips', async () => {
    await seedPage('provider failure', 1);
    await seedPage('parse failure', 2);
    await seedPage('successful article', 3);
    await seedPage('short article', 4, 'tiny');
    respond = (res) => {
      if (calls === 1) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'PRIVATE_PROVIDER_BODY: no models loaded' }));
      } else {
        respondWithReport(res, calls === 2 ? 'This is not a structured quality report.' : report);
      }
    };

    expect(await processBatch()).toEqual({ processed: 2, errors: 2 });
    expect(calls).toBe(3);
    const rows = await pageStates();
    expect(rows.map((row) => row.quality_status)).toEqual(['failed', 'failed', 'analyzed', 'skipped']);
    expect(rows.map((row) => row.quality_retry_count)).toEqual([1, 1, 0, 0]);
    expect(rows[0]!.quality_error).toContain('HTTP 400');
    expect(rows[0]!.quality_error).not.toContain('PRIVATE_PROVIDER_BODY');
    expect(rows[1]!.quality_error).toContain('parse');
    expect(rows[2]!.quality_score).toBe(75);
    expect((await getQualityStatus()).isProcessing).toBe(false);
  });

  it('does not abandon the next article when a page update unexpectedly rejects', async () => {
    await seedPage('reject analyzing', 1);
    await seedPage('successful article', 2);
    await query(`ALTER TABLE pages ADD CONSTRAINT quality_worker_reject_analyzing
      CHECK (title != 'reject analyzing' OR quality_status != 'analyzing') NOT VALID`);
    try {
      expect(await processBatch()).toEqual({ processed: 1, errors: 1 });
      expect((await pageStates()).map((row) => row.quality_status)).toEqual(['pending', 'analyzed']);
      expect(calls).toBe(1);
    } finally {
      await query(`ALTER TABLE pages DROP CONSTRAINT quality_worker_reject_analyzing`);
    }
  });

  it.each(['direct', 'manual'] as const)('prevents concurrent direct/manual recovery of an article held by a %s invocation', async (entrypoint) => {
    await seedPage('in flight', 1);
    await seedPage('next article', 2);
    let held: ServerResponse | undefined;
    respond = (res) => {
      if (calls === 1) held = res;
      else respondWithReport(res);
    };
    const first = entrypoint === 'direct' ? processBatch() : triggerQualityBatch();
    try {
      await vi.waitFor(() => expect(held).toBeDefined());
      expect((await getQualityStatus()).isProcessing).toBe(true);
      // Make the row look recoverable even to the stale-row sweep. The shared
      // entrypoint lock, not just the timestamp hedge, must prevent recovery.
      await query(`UPDATE pages SET quality_analyzed_at = NULL WHERE title = 'in flight'`);
      expect(await processBatch()).toEqual({ processed: 0, errors: 0 });
      await triggerQualityBatch();
      expect((await pageStates()).map((row) => row.quality_status)).toEqual(['analyzing', 'pending']);
      expect(calls).toBe(1);
    } finally {
      if (held) respondWithReport(held);
      await first;
    }
    expect(calls).toBe(2);
    expect((await pageStates()).map((row) => row.quality_status)).toEqual(['analyzed', 'analyzed']);
    expect((await getQualityStatus()).isProcessing).toBe(false);
  });

  it('retains the five-page batch boundary rather than draining the backlog', async () => {
    for (let i = 1; i <= 6; i++) await seedPage(`article ${i}`, i);
    expect(await processBatch()).toEqual({ processed: 5, errors: 0 });
    expect(calls).toBe(5);
    expect((await pageStates()).map((row) => row.quality_status)).toEqual([
      'analyzed', 'analyzed', 'analyzed', 'analyzed', 'analyzed', 'pending',
    ]);
  });

  it.skipIf(!redisAvailable)('does not recover rows while another Redis holder owns the batch', async () => {
    setRedisClient(redis!);
    await seedPage('other worker article', 1);
    await query(`UPDATE pages SET quality_status = 'analyzing', quality_analyzed_at = NULL`);
    const token = await acquireWorkerLock('quality-worker', 600);
    expect(token).not.toBeNull();
    try {
      expect(await processBatch()).toEqual({ processed: 0, errors: 0 });
      await triggerQualityBatch();
      expect((await pageStates())[0]!.quality_status).toBe('analyzing');
      expect(calls).toBe(0);
    } finally {
      await releaseWorkerLock('quality-worker', token!);
      setRedisClient(noRedis);
    }
  });

  it.skipIf(!redisAvailable)('renews during a slow article, then stops before the next article when the lease is replaced', async () => {
    setRedisClient(redis!);
    await seedPage('slow article', 1);
    await seedPage('next article', 2);
    let held: ServerResponse | undefined;
    respond = (res) => { held = res; };
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const run = processBatch();
    // Attach rejection handling immediately, including assertion-failure cleanup.
    const result = run.then((value) => value, (error: unknown) => error);
    try {
      await vi.waitFor(() => expect(held).toBeDefined());
      const token = await redis!.get(lockKey);
      expect(token).not.toBeNull();
      await redis!.expire(lockKey, 10);
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(async () => expect(await redis!.ttl(lockKey)).toBeGreaterThan(500));
      expect(calls).toBe(1);
      await redis!.set(lockKey, 'replacement-owner', { EX: 600 });
      await vi.advanceTimersByTimeAsync(60_000);
      respondWithReport(held!);
      expect(await result).toBeInstanceOf(Error);
      expect((await pageStates()).map((row) => row.quality_status)).toEqual(['analyzed', 'pending']);
      expect(calls).toBe(1);
      expect(await redis!.get(lockKey)).toBe('replacement-owner');
      expect((await getQualityStatus()).isProcessing).toBe(false);
    } finally {
      // Let any held response finish before restoring timers or DB state.
      respond = (res) => respondWithReport(res);
      if (held && !held.writableEnded) respondWithReport(held);
      await result;
      vi.useRealTimers();
      await releaseWorkerLock('quality-worker', 'replacement-owner');
      setRedisClient(noRedis);
    }
  });
});
