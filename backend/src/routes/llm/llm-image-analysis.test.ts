import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  IMAGE_ANALYSIS_SCHEMA_VERSION,
  ImageAnalysisStatusSchema,
  type ImageAnalysisStatus,
} from '@compendiq/contracts';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { query } from '../../core/db/postgres.js';
import { buildApp } from '../../app.js';
import { generateAccessToken } from '../../core/plugins/auth.js';
import {
  acquireEmbeddingLock,
  acquireWorkerLock,
  isWorkerLocked,
  releaseEmbeddingLock,
  releaseWorkerLock,
} from '../../core/services/redis-cache.js';
import {
  IMAGE_ANALYSIS_IDENTITY_KEY,
  IMAGE_ANALYSIS_PROMPT_VERSION,
} from '../../domains/llm/services/image-analysis-identity.js';
import {
  IMAGE_ANALYSIS_LAST_RUN_KEY,
  IMAGE_ANALYSIS_WORKER_LOCK,
  readImageAnalysisLastRun,
} from '../../domains/llm/services/image-analysis-worker.js';
import { REEMBED_ALL_LOCK_USER } from '../../domains/llm/services/embedding-service.js';

/**
 * #1618 (ADR-027 Stage 1) — the image-analysis processing surface.
 *
 * Every case here is a fact an operator reads off the card or an effect an
 * operator's press has on `page_image_analyses`. No vision model is reachable
 * (ADR-027 O8 records this instance UNASSIGNED), so rows are hand-seeded in
 * the shapes the worker writes and the actions are observed through the table.
 *
 * The two bulk actions kick a DETACHED batch, so every test that presses one
 * holds the worker lock first: the kick then returns from the worker's own
 * guard without touching a row, and the row effect under assertion is the
 * action's alone.
 */

const dbAvailable = await isDbAvailable();
const redisAvailable = await isRedisAvailable();

let app: FastifyInstance;
let adminToken: string;
let userToken: string;
let ownerId: string;

beforeAll(async () => {
  if (!dbAvailable) return;
  await setupTestDb();
  app = await buildApp();
  await app.ready();
}, 30_000);

afterAll(async () => {
  if (!dbAvailable) return;
  await app?.close();
  await teardownTestDb();
});

async function createUser(username: string, role: 'admin' | 'user'): Promise<{ id: string; token: string }> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'h', $2) RETURNING id`,
    [username, role],
  );
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [rows[0]!.id]);
  return { id: rows[0]!.id, token: await generateAccessToken({ sub: rows[0]!.id, username, role }) };
}

beforeEach(async () => {
  if (!dbAvailable) return;
  await truncateAllTables();
  const admin = await createUser('ia_admin', 'admin');
  adminToken = admin.token;
  ownerId = admin.id;
  ({ token: userToken } = await createUser('ia_user', 'user'));
});

const RETAINED_HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const PROVIDER_ID = '00000000-0000-4000-8000-000000000001';

async function retainIdentity(hash = RETAINED_HASH): Promise<void> {
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value) VALUES ($1, $2)
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2`,
    [
      IMAGE_ANALYSIS_IDENTITY_KEY,
      JSON.stringify({
        providerId: PROVIDER_ID,
        model: 'qwen3-vl-8b',
        baseUrl: 'http://vision.internal/v1',
        identityHash: hash,
        assignedAt: '2026-09-15T00:00:00.000Z',
      }),
    ],
  );
}

async function seedPage(over: { dirty?: boolean; embeddingDirty?: boolean } = {}): Promise<number> {
  const r = await query<{ id: number }>(
    `INSERT INTO pages (title, source, visibility, created_by_user_id, body_html,
                        image_analysis_dirty, embedding_dirty)
     VALUES ('p', 'standalone', 'shared', $1, '<p>x</p>', $2, $3) RETURNING id`,
    [ownerId, over.dirty ?? false, over.embeddingDirty ?? false],
  );
  return r.rows[0]!.id;
}

/** An `analyzed` row. `identityHash` decides whether it reads valid or stale. */
async function seedAnalyzed(pageId: number, key: string, identityHash = RETAINED_HASH): Promise<void> {
  await query(
    `INSERT INTO page_image_analyses
       (page_id, source, attachment_key, content_hash, format, status,
        provider_id, model, base_url, identity_hash, prompt_version, schema_version,
        payload, analysis_version, analyzed_at)
     VALUES ($1, 'local', $2, 'h-' || $2, 'png', 'analyzed',
             NULL, 'qwen3-vl-8b', 'http://vision.internal/v1', $3, $4, $5,
             '{"schemaVersion":1,"kind":"diagram","description":"a flow","limitations":[]}'::jsonb, 1, NOW())`,
    [pageId, key, identityHash, IMAGE_ANALYSIS_PROMPT_VERSION, IMAGE_ANALYSIS_SCHEMA_VERSION],
  );
}

async function seedFailed(pageId: number, key: string, terminal = false): Promise<void> {
  await query(
    `INSERT INTO page_image_analyses
       (page_id, source, attachment_key, content_hash, format, status,
        identity_hash, prompt_version, schema_version, attempts, next_attempt_at, error)
     VALUES ($1, 'confluence', $2, 'h-' || $2, 'png', $3,
             $4, $5, $6, $7, $8, 'rejected:413')`,
    [
      pageId,
      key,
      terminal ? 'failed_terminal' : 'failed',
      RETAINED_HASH,
      IMAGE_ANALYSIS_PROMPT_VERSION,
      IMAGE_ANALYSIS_SCHEMA_VERSION,
      terminal ? 5 : 2,
      terminal ? null : new Date(Date.now() + 3_600_000),
    ],
  );
}

async function seedSkipped(pageId: number, key: string, reason: string): Promise<void> {
  await query(
    `INSERT INTO page_image_analyses
       (page_id, source, attachment_key, content_hash, format, status, skip_reason)
     VALUES ($1, 'local', $2, 'h-' || $2, 'png', 'skipped', $3)`,
    [pageId, key, reason],
  );
}

async function seedPending(pageId: number, key: string): Promise<void> {
  await query(
    `INSERT INTO page_image_analyses (page_id, source, attachment_key, content_hash, format, status)
     VALUES ($1, 'local', $2, 'h-' || $2, 'png', 'pending')`,
    [pageId, key],
  );
}

function get(token = adminToken) {
  return app.inject({
    method: 'GET',
    url: '/api/admin/embedding/image-analysis',
    headers: { authorization: `Bearer ${token}` },
  });
}

function post(action: string, token = adminToken) {
  return app.inject({
    method: 'POST',
    url: `/api/admin/embedding/image-analysis/${action}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

/**
 * Hold the analysis worker lock for the body of a test, so the detached kick
 * every action fires is a no-op against a held lease.
 */
async function withHeldLock(body: () => Promise<void>): Promise<void> {
  const token = await acquireWorkerLock(IMAGE_ANALYSIS_WORKER_LOCK, 60);
  try {
    await body();
  } finally {
    if (token) await releaseWorkerLock(IMAGE_ANALYSIS_WORKER_LOCK, token);
  }
}

/**
 * The detached batch a lock-FREE kick starts, run to completion: it records
 * its last-run line and then releases the lease, so both together are the
 * only observable end of a run nothing awaited.
 *
 * A real poll on those two facts, not a fixed sleep and not fake timers: the
 * batch is a detached promise doing real Postgres and Redis work, so there is
 * no clock to advance and no signal the route exposes to await.
 */
async function tick(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function settleDetachedBatch(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let run = await readImageAnalysisLastRun();
  while (!run && Date.now() < deadline) {
    await tick(25);
    run = await readImageAnalysisLastRun();
  }
  while ((await isWorkerLocked(IMAGE_ANALYSIS_WORKER_LOCK)) && Date.now() < deadline) {
    await tick(25);
  }
  return run;
}

describe.skipIf(!dbAvailable)('image-analysis admin routes — authorization', () => {
  const routes: Array<['GET' | 'POST', string]> = [
    ['GET', '/api/admin/embedding/image-analysis'],
    ['POST', '/api/admin/embedding/image-analysis/process'],
    ['POST', '/api/admin/embedding/image-analysis/retry-failed'],
    ['POST', '/api/admin/embedding/image-analysis/reanalyze-all'],
  ];

  it.each(routes)('%s %s refuses a non-admin', async (method, url) => {
    const res = await app.inject({ method, url, headers: { authorization: `Bearer ${userToken}` } });
    expect(res.statusCode).toBe(403);
  });

  it.each(routes)('%s %s refuses an unauthenticated caller', async (method, url) => {
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(401);
  });
});

describe.skipIf(!dbAvailable)('GET /api/admin/embedding/image-analysis', () => {
  it('reports every row status, the skip reasons by name, and both page counts', async () => {
    await retainIdentity();
    const analyzedPage = await seedPage({ embeddingDirty: true });
    const busyPage = await seedPage({ dirty: true });

    await seedAnalyzed(analyzedPage, 'valid.png');
    // Analyzed on disk under a foreign identity: STALE, never `analyzed`.
    await seedAnalyzed(analyzedPage, 'stale.png', OTHER_HASH);
    await seedPending(busyPage, 'queued.png');
    await seedFailed(busyPage, 'refused.png');
    await seedFailed(busyPage, 'given-up.png', true);
    await seedSkipped(busyPage, 'gone.png', 'missing');
    await seedSkipped(busyPage, 'sheet.svg', 'unsupported');
    await seedSkipped(busyPage, 'huge.png', 'too_large');

    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = ImageAnalysisStatusSchema.parse(res.json());

    expect(body.rows).toEqual({ analyzed: 1, stale: 1, pending: 1, failed: 1, terminal: 1, skipped: 3 });
    expect(body.skipReasons).toEqual({
      missing: 1,
      unsupported: 1,
      oversized: 0,
      tooLarge: 1,
      external: 0,
      capped: 0,
    });
    // One page carries the dirty flag; the other has a valid analysis and is
    // still awaiting its text embed — the epic's two distinct facts.
    expect(body.dirtyPages).toBe(1);
    expect(body.pagesAwaitingEmbed).toBe(1);
  });

  it('counts a page as awaiting embed only while a VALID analysis sits behind a dirty embedding flag', async () => {
    await retainIdentity();
    const stalePage = await seedPage({ embeddingDirty: true });
    await seedAnalyzed(stalePage, 'stale.png', OTHER_HASH);

    const cleanPage = await seedPage({ embeddingDirty: false });
    await seedAnalyzed(cleanPage, 'valid.png');

    const body = (await get()).json() as ImageAnalysisStatus;
    expect(body.pagesAwaitingEmbed).toBe(0);
  });

  it('reports an unassigned instance as a pause: not assigned, nothing to compare, no last run', async () => {
    await retainIdentity();
    const page = await seedPage();
    await seedAnalyzed(page, 'kept.png');

    const body = (await get()).json() as ImageAnalysisStatus;
    expect(body.assigned).toBe(false);
    // No live pair, so no verdict — an unassigned instance is paused, not mismatched.
    expect(body.identityMatchesAssignment).toBeNull();
    // The stored descriptions survive the pause and still read as valid.
    expect(body.rows.analyzed).toBe(1);
    expect(body.lastRun).toBeNull();
    expect(body.retainedIdentity?.identityHash).toBe(RETAINED_HASH);
  });

  it('serves the retained identity without a provider secret', async () => {
    await retainIdentity();
    const body = (await get()).json() as ImageAnalysisStatus;
    expect(body.retainedIdentity).toMatchObject({ providerId: PROVIDER_ID, model: 'qwen3-vl-8b' });
    expect(JSON.stringify(body)).not.toMatch(/api[-_]?key|password|secret|bearer/i);
  });

  it('reports a recorded stop with its reason and HTTP status', async () => {
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value) VALUES ($1, $2)`,
      [
        IMAGE_ANALYSIS_LAST_RUN_KEY,
        JSON.stringify({
          at: '2026-09-16T08:00:00.000Z',
          processed: 4,
          reused: 1,
          skipped: 2,
          failed: 3,
          terminal: 0,
          repended: 5,
          returned: 1,
          reopened: 0,
          reconciledPages: 7,
          removed: 1,
          pagesFailed: 1,
          unreadableRefs: 2,
          reason: 'provider_status',
          httpStatus: 503,
        }),
      ],
    );

    const body = (await get()).json() as ImageAnalysisStatus;
    expect(body.lastRun).toMatchObject({ reason: 'provider_status', httpStatus: 503, processed: 4, pagesFailed: 1 });
  });

  it('serves a last run recorded before a counter existed rather than dropping it', async () => {
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value) VALUES ($1, $2)`,
      [IMAGE_ANALYSIS_LAST_RUN_KEY, JSON.stringify({ at: '2026-09-16T08:00:00.000Z', processed: 2 })],
    );
    const body = (await get()).json() as ImageAnalysisStatus;
    expect(body.lastRun).toMatchObject({ processed: 2, unreadableRefs: 0, reconciledPages: 0 });
  });

  it('answers a polling card for a whole open tab without refusing a read', async () => {
    // The card polls at 5s while a batch holds the lease and through a 20s
    // warm-up after every press, on top of the mount fetch, the invalidate
    // each press fires and a window-focus refetch. Against the shared 20/min
    // admin bucket the 21st read of an open Embeddings tab answered 429 —
    // which does not delay this card, it drops it into "the status could not
    // be read" with every counter at an em-dash until the next interval.
    // `rate_limit_admin_max` is at its default 20 here: no row is seeded.
    const codes: number[] = [];
    for (let i = 0; i < 25; i++) codes.push((await get()).statusCode);
    expect(codes.filter((code) => code !== 200)).toEqual([]);
  });
});

describe.skipIf(!dbAvailable || !redisAvailable)('POST …/process', () => {
  it('reports a batch as already running while the lease is held, and never claims it started', async () => {
    await withHeldLock(async () => {
      const res = await post('process');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ started: false, alreadyRunning: true });
    });
  });

  it('starts a batch when no lease is held, and the detached run really happens', async () => {
    // The other branch of `kickBatch`, with nothing holding the lease. The
    // response is a SAMPLE of the lock, so what proves a batch followed is
    // work only a batch does: a dirty page whose body references no image at
    // all, carrying an analysis of an image that is gone. The reconcile drops
    // that row and clears the flag; no vision model is assigned (ADR-027 O8),
    // so the analyze step is skipped with D13's pause reason and nothing here
    // spends a call.
    const page = await seedPage({ dirty: true });
    await seedAnalyzed(page, 'vanished.png');

    const res = await post('process');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ started: true, alreadyRunning: false });

    const run = await settleDetachedBatch();
    expect(run).toMatchObject({ reason: 'unassigned', processed: 0, reconciledPages: 1, removed: 1 });
    const rows = await query<{ n: string }>(`SELECT count(*)::text AS n FROM page_image_analyses`);
    expect(rows.rows[0]?.n).toBe('0');
    const flag = await query<{ dirty: boolean }>(
      `SELECT image_analysis_dirty AS dirty FROM pages WHERE id = $1`,
      [page],
    );
    expect(flag.rows[0]?.dirty).toBe(false);
    // The lease is released by the run that took it, so the next press is not
    // answered `alreadyRunning` by a batch that has finished.
    expect(await isWorkerLocked(IMAGE_ANALYSIS_WORKER_LOCK)).toBe(false);
  });
});

describe.skipIf(!dbAvailable || !redisAvailable)('POST …/retry-failed', () => {
  it('makes every failed and terminal row due now with a fresh attempt budget', async () => {
    await retainIdentity();
    const page = await seedPage();
    await seedFailed(page, 'refused.png');
    await seedFailed(page, 'given-up.png', true);
    await seedAnalyzed(page, 'kept.png');
    await seedSkipped(page, 'gone.png', 'missing');

    await withHeldLock(async () => {
      const res = await post('retry-failed');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ rows: 2, alreadyRunning: true });
    });

    const rows = await query<{ attachment_key: string; status: string; attempts: number; due: boolean }>(
      `SELECT attachment_key, status, attempts, next_attempt_at <= NOW() AS due
         FROM page_image_analyses ORDER BY attachment_key`,
    );
    expect(rows.rows).toEqual([
      { attachment_key: 'given-up.png', status: 'failed', attempts: 0, due: true },
      { attachment_key: 'gone.png', status: 'skipped', attempts: 0, due: null },
      { attachment_key: 'kept.png', status: 'analyzed', attempts: 0, due: null },
      { attachment_key: 'refused.png', status: 'failed', attempts: 0, due: true },
    ]);
  });

  it('re-arms the same row on a second press rather than compounding it', async () => {
    const page = await seedPage();
    await seedFailed(page, 'refused.png');

    await withHeldLock(async () => {
      expect((await post('retry-failed')).json()).toMatchObject({ rows: 1 });
      const armed = await query<{ updated_at: string }>(
        `SELECT updated_at FROM page_image_analyses`,
      );

      // `rows` is what the statement MATCHED, and the second press matches
      // the same still-failed row — so the count the toast quotes is only
      // honest if that row was genuinely rewritten. It is: the press re-arms
      // it, moving `updated_at` and `next_attempt_at` without compounding
      // `attempts` or adding a row.
      expect((await post('retry-failed')).json()).toMatchObject({ rows: 1 });
      const after = await query<{ status: string; attempts: number; updated_at: string; due: boolean }>(
        `SELECT status, attempts, updated_at, next_attempt_at <= NOW() AS due FROM page_image_analyses`,
      );
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0]).toMatchObject({ status: 'failed', attempts: 0, due: true });
      expect(new Date(after.rows[0]!.updated_at).getTime()).toBeGreaterThan(
        new Date(armed.rows[0]!.updated_at).getTime(),
      );
    });
  });
});

describe.skipIf(!dbAvailable || !redisAvailable)('POST …/reanalyze-all', () => {
  it('re-pends analyzed, failed and terminal rows, drops their payloads and re-embeds their pages', async () => {
    await retainIdentity();
    const page = await seedPage({ embeddingDirty: false });
    await seedAnalyzed(page, 'kept.png');
    await seedFailed(page, 'refused.png');
    await seedFailed(page, 'given-up.png', true);
    await seedSkipped(page, 'external.png', 'external');

    await withHeldLock(async () => {
      const res = await post('reanalyze-all');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ rows: 3 });
    });

    const rows = await query<{ attachment_key: string; status: string; payload: unknown; attempts: number }>(
      `SELECT attachment_key, status, payload, attempts FROM page_image_analyses ORDER BY attachment_key`,
    );
    expect(rows.rows).toEqual([
      { attachment_key: 'external.png', status: 'skipped', payload: null, attempts: 0 },
      { attachment_key: 'given-up.png', status: 'pending', payload: null, attempts: 0 },
      { attachment_key: 'kept.png', status: 'pending', payload: null, attempts: 0 },
      { attachment_key: 'refused.png', status: 'pending', payload: null, attempts: 0 },
    ]);

    // The page's derived chunks describe payloads that are gone, so the page
    // must be recomposed — the action bumps the revision and the embed flag.
    const pageRow = await query<{ image_analysis_revision: number; embedding_dirty: boolean }>(
      `SELECT image_analysis_revision::int AS image_analysis_revision, embedding_dirty FROM pages WHERE id = $1`,
      [page],
    );
    expect(pageRow.rows[0]).toEqual({ image_analysis_revision: 1, embedding_dirty: true });
  });

  it('is idempotent: a second press finds nothing left to re-pend', async () => {
    const page = await seedPage();
    await retainIdentity();
    await seedAnalyzed(page, 'kept.png');

    await withHeldLock(async () => {
      expect((await post('reanalyze-all')).json()).toMatchObject({ rows: 1 });
      expect((await post('reanalyze-all')).json()).toMatchObject({ rows: 0 });
    });
  });

  it('refuses with 409 while a corpus re-embed holds its lock, and moves no row', async () => {
    const page = await seedPage();
    await retainIdentity();
    await seedAnalyzed(page, 'kept.png');

    const lock = await acquireEmbeddingLock(REEMBED_ALL_LOCK_USER);
    try {
      const res = await post('reanalyze-all');
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toMatch(/re-embed/i);
    } finally {
      if (lock) await releaseEmbeddingLock(REEMBED_ALL_LOCK_USER, lock);
    }

    const rows = await query<{ status: string }>(`SELECT status FROM page_image_analyses`);
    expect(rows.rows).toEqual([{ status: 'analyzed' }]);
  });
});

afterEach(async () => {
  if (!dbAvailable) return;
  // A detached kick from a previous test can still be settling; the next
  // file's truncate is what isolates it, but drop the last-run row here so a
  // straggler cannot be mistaken for a seeded fixture.
  await query(`DELETE FROM admin_settings WHERE setting_key = $1`, [IMAGE_ANALYSIS_LAST_RUN_KEY]);
});
