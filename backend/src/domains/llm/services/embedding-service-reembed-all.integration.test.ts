/**
 * Integration test for issue #257 / PR #261 — real Redis + real Postgres.
 *
 * Guards against a regression of the CRITICAL bug:
 *   runReembedAllJob acquires the `__reembed_all__` embedding lock, then
 *   calls processDirtyPages(REEMBED_ALL_LOCK_USER, ...). Before the fix,
 *   processDirtyPages re-ran `acquireEmbeddingLock` against the same key,
 *   Redis SET NX EX refused, and processDirtyPages short-circuited with
 *   `alreadyProcessing: true`. The wrapper had already marked every
 *   eligible page dirty — so on any non-empty DB, the outer return string
 *   was `processed=0 failed=0 total=N`.
 *
 * This test seeds one dirty page, mocks ONLY the external embedding
 * provider (`generateEmbedding`) so no LLM call is made, and asserts that
 * `runReembedAllJob` returns `processed=1 failed=0 total=1`. Against the
 * pre-fix code it would have returned `processed=0`.
 *
 * Skipped automatically when the test PG / Redis instances aren't
 * reachable (CI uses docker-compose; local `docker compose up` covers it).
 */

import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type RedisClientType } from 'redis';

// Mock ONLY the external embedding provider to avoid real LLM calls.
// Everything else (Postgres, Redis, chunking, DB transactions) runs for real.
vi.mock('./openai-compatible-client.js', async () => {
  const actual = await vi.importActual<typeof import('./openai-compatible-client.js')>(
    './openai-compatible-client.js',
  );
  return {
    ...actual,
    // Return a 1024-dim vector per input text. Dimensions must match the
    // default embedding column (vector(1024)) — otherwise pgvector rejects
    // the insert and the test would fail for an unrelated reason.
    generateEmbedding: vi.fn(async (_cfg: unknown, _model: string, texts: string[] | string) => {
      const arr = Array.isArray(texts) ? texts : [texts];
      return arr.map(() => new Array(1024).fill(0.1));
    }),
  };
});

// Provider resolver: skip the real DB lookup — the openai-compatible-client
// mock ignores the config anyway, and bootstrapping llm_providers rows would
// require extra seed work that's out of scope for this test.
vi.mock('./llm-provider-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('./llm-provider-resolver.js')>(
    './llm-provider-resolver.js',
  );
  return {
    ...actual,
    resolveUsecase: vi.fn(async () => ({
      config: {
        providerId: 'test-provider',
        id: 'test-provider',
        name: 'Test',
        baseUrl: 'http://localhost:0/v1',
        apiKey: null,
        authType: 'none' as const,
        verifySsl: false,
        defaultModel: 'bge-m3',
      },
      model: 'bge-m3',
    })),
  };
});

import { setupTestDb, teardownTestDb, truncateAllTables, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import {
  setRedisClient,
  forceReleaseEmbeddingLock,
} from '../../../core/services/redis-cache.js';
import { runReembedAllJob } from './embedding-service.js';

const dbAvailable = await isDbAvailable();

async function checkRedisReachable(): Promise<boolean> {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const probe = createClient({ url });
  try {
    probe.on('error', () => {
      /* swallow — we only care whether connect works */
    });
    await probe.connect();
    await probe.ping();
    await probe.quit();
    return true;
  } catch {
    try {
      await probe.quit();
    } catch {
      /* best effort */
    }
    return false;
  }
}

const redisAvailable = dbAvailable ? await checkRedisReachable() : false;
const canRun = dbAvailable && redisAvailable;

let redis: RedisClientType | null = null;

type FakeJob = {
  id: string;
  name: string;
  data: unknown;
  updateProgress: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};

function makeFakeJob(): FakeJob {
  return {
    id: 'reembed-all',
    name: 'reembed-all',
    data: {},
    updateProgress: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  };
}

beforeAll(async () => {
  if (!canRun) return;
  await setupTestDb();
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  redis = createClient({ url }) as RedisClientType;
  redis.on('error', () => {
    /* connection errors surface via the test runner */
  });
  await redis.connect();
  setRedisClient(redis);
}, 30_000);

afterAll(async () => {
  if (!canRun) return;
  if (redis) {
    try {
      await redis.quit();
    } catch {
      /* best effort */
    }
  }
  await teardownTestDb();
});

beforeEach(async () => {
  if (!canRun) return;
  await truncateAllTables();
  // Drop any lingering lock keys from prior runs (different test file may
  // have written them).
  await forceReleaseEmbeddingLock('__reembed_all__');
});

describe.skipIf(!canRun)('runReembedAllJob integration (#257)', () => {
  it('embeds a dirty page end-to-end and returns processed=1 (regression guard for double-acquire bug)', async () => {
    // Seed one page that matches processDirtyPages' WHERE filter:
    //   embedding_dirty = TRUE, body_html IS NOT NULL, deleted_at IS NULL,
    //   COALESCE(page_type, 'page') != 'folder'.
    const seeded = await query<{ id: number }>(
      `INSERT INTO pages
        (confluence_id, space_key, title, body_html, body_text, last_modified_at,
         embedding_dirty, embedding_status, deleted_at, page_type)
       VALUES
        ('reembed-int-1', 'DEV', 'Re-embed Regression Page',
         '<p>Content substantial enough that the chunker will keep it after filtering.</p>',
         'Content substantial enough that the chunker will keep it after filtering.',
         NOW(), TRUE, 'not_embedded', NULL, 'page')
       RETURNING id`,
    );
    expect(seeded.rows).toHaveLength(1);
    const pageId = seeded.rows[0]!.id;

    const job = makeFakeJob();
    const result = await runReembedAllJob(job as unknown as Parameters<typeof runReembedAllJob>[0]);

    // Pre-fix behaviour on any non-empty DB: `processed=0`. Post-fix: at
    // least one page must have been embedded.
    expect(result).toMatch(/^processed=([1-9]\d*) /);
    expect(result).toContain('failed=0');

    // Verify the embedding actually landed in page_embeddings — the
    // string-assertion above would pass if processDirtyPages cheated, but
    // the row count is ground truth.
    const chunks = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM page_embeddings WHERE page_id = $1`,
      [pageId],
    );
    expect(parseInt(chunks.rows[0]!.c, 10)).toBeGreaterThanOrEqual(1);

    // And the page is no longer dirty.
    const pageRow = await query<{ embedding_dirty: boolean; embedding_status: string }>(
      `SELECT embedding_dirty, embedding_status FROM pages WHERE id = $1`,
      [pageId],
    );
    expect(pageRow.rows[0]!.embedding_dirty).toBe(false);
    expect(pageRow.rows[0]!.embedding_status).toBe('embedded');

    // And the system lock got released.
    const stillLocked = await redis!.exists('embedding:lock:__reembed_all__');
    expect(stillLocked).toBe(0);
  }, 30_000);
});

// When the test environment is missing PG or Redis we still want the file
// to report *something* rather than silently producing zero tests — vitest
// treats an empty suite as success, which would quietly hide a broken CI.
describe.skipIf(canRun)('runReembedAllJob integration (#257) [SKIPPED]', () => {
  it.skip(
    `Requires real Postgres (${dbAvailable ? 'OK' : 'MISSING'}) and Redis (${redisAvailable ? 'OK' : 'MISSING'})`,
    () => {
      /* placeholder */
    },
  );
});
