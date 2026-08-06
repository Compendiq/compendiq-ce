import { query, getPool } from '../../../core/db/postgres.js';
import { generateEmbedding } from './openai-compatible-client.js';
import { getProviderById } from './llm-provider-service.js';
import { bumpProviderCacheVersion } from './cache-bus.js';
import { enqueueJob, getJobStatus } from '../../../core/services/queue-service.js';
import { getReembedHistoryRetention } from '../../../core/services/admin-settings-service.js';
import { logger } from '../../../core/utils/logger.js';
import pgvector from 'pgvector';

/**
 * #1116 — non-destructive re-embed: shadow column + atomic rename-swap.
 *
 * The destructive path (`enqueueReembedAll({newDimensions})`) TRUNCATEs the
 * live vectors up front: search degrades for the whole re-embed window,
 * related-pages (#919) goes dead, and the old model is unrecoverable. This
 * service replaces that for model/dimension changes:
 *
 *   start    → probe the (provider, model) pair server-side (the MEASURED
 *              dimension types the column — nothing client-supplied is
 *              trusted), ADD nullable `embedding_next` /
 *              `page_avg_embedding_next` columns at runtime (their type is
 *              only known at probe time, so there is deliberately no numbered
 *              migration — owner decision on #1100), enqueue the backfill.
 *   backfill → embed every existing chunk row with the NEW model into
 *              `embedding_next`, on the rows the live column keeps serving;
 *              build the shadow HNSW index at the end. `embedPage` dual-writes
 *              both columns for pages edited while this runs.
 *   swap     → one transaction under an explicit `lock_timeout` with bounded
 *              retries: RENAME columns and indexes (live→prev, next→live),
 *              drop the prev column's NOT NULL (post-swap inserts don't
 *              provide it), repoint the embedding use-case assignment and
 *              `embedding_dimensions`. Readers are untouched — they only ever
 *              name `embedding` / `page_avg_embedding`.
 *   rollback → before the swap: abort and drop the shadow columns. After the
 *              swap (until cleanup): reverse the renames, restore the
 *              assignment, and re-dirty pages embedded post-swap (their prev
 *              vectors never existed).
 *   cleanup  → drop the prev columns/indexes, restore the live column's
 *              NOT NULL, clear the state.
 *
 * State lives in `admin_settings` under `embedding_shadow_migration` — the
 * same single-seam table the destructive path already uses for
 * `embedding_dimensions`.
 */

export const SHADOW_MIGRATION_STATE_KEY = 'embedding_shadow_migration';
export const SHADOW_JOB_QUEUE = 'shadow-reembed';

export interface ShadowMigrationState {
  /**
   * 'active' = backfilling/ready; 'swapped' = new model live, prev retained;
   * 'aborting' = an abort was requested but its column drops may not have
   * completed (crash window) — rollback is idempotent and resumes it.
   */
  status: 'active' | 'swapped' | 'aborting';
  providerId: string;
  model: string;
  dimensions: number;
  columnType: string;
  indexed: boolean;
  startedAt: string;
  swappedAt?: string;
  prev?: {
    providerId: string | null;
    model: string | null;
    dimensions: number;
  };
}

export interface ShadowMigrationStatus extends ShadowMigrationState {
  phase: 'backfilling' | 'ready' | 'swapped' | 'aborting';
  totalPages: number;
  backfilledPages: number;
  stragglerPages: number;
  indexReady: boolean;
}

/** Same tiering as the destructive path: vector ≤2000, halfvec ≤4000, else unindexed vector. */
function columnTypeFor(dimensions: number): { columnType: string; opclass: string | null } {
  if (dimensions <= 2000) return { columnType: `vector(${dimensions})`, opclass: 'vector_cosine_ops' };
  if (dimensions <= 4000) return { columnType: `halfvec(${dimensions})`, opclass: 'halfvec_cosine_ops' };
  return { columnType: `vector(${dimensions})`, opclass: null };
}

export async function getShadowMigrationState(): Promise<ShadowMigrationState | null> {
  const r = await query<{ setting_value: string }>(
    `SELECT setting_value FROM admin_settings WHERE setting_key = $1`,
    [SHADOW_MIGRATION_STATE_KEY],
  );
  const raw = r.rows[0]?.setting_value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ShadowMigrationState;
  } catch {
    logger.error({ raw }, 'Unparseable shadow-migration state — treating as absent');
    return null;
  }
}

async function saveState(state: ShadowMigrationState, client?: { query: (sql: string, params?: unknown[]) => Promise<unknown> }): Promise<void> {
  const runner = client ?? { query: (sql: string, params?: unknown[]) => query(sql, params as unknown[]) };
  await runner.query(
    `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW()`,
    [SHADOW_MIGRATION_STATE_KEY, JSON.stringify(state)],
  );
}

/**
 * The migration epoch as read through an EXISTING client/transaction — the
 * seam embedPage's write transaction uses for its schema-epoch recheck. Kept
 * here (not inline in embedPage) so the embed unit tests can stub it at the
 * module boundary instead of scripting an extra row into their client mocks.
 */
export async function shadowEpochFromClient(client: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ setting_value?: string }> }>;
}): Promise<string> {
  const r = await client.query(
    `SELECT setting_value FROM admin_settings WHERE setting_key = $1`,
    [SHADOW_MIGRATION_STATE_KEY],
  );
  const raw = r.rows[0]?.setting_value;
  if (!raw) return 'none';
  try {
    return shadowStateFingerprint(JSON.parse(raw) as ShadowMigrationState);
  } catch {
    return 'unparseable';
  }
}

/** The provider config shape generateEmbedding needs, from a providerId. */
async function providerConfigFor(providerId: string) {
  const cfg = await getProviderById(providerId);
  if (!cfg) return null;
  return {
    providerId: cfg.id,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    authType: cfg.authType,
    verifySsl: cfg.verifySsl,
  };
}

/**
 * A comparable identity for the migration's schema epoch: it changes whenever
 * a swap, revert or abort lands. embedPage snapshots it before generating and
 * re-checks it inside its write transaction — vectors generated against one
 * epoch must never be written into another (review r1: an embedPage in flight
 * across an equal-dimension swap would otherwise silently write old-model
 * vectors into the renamed columns).
 */
export function shadowStateFingerprint(state: ShadowMigrationState | null): string {
  if (!state) return 'none';
  return `${state.status}:${state.startedAt}:${state.swappedAt ?? ''}`;
}

/**
 * The dual-write target for embedPage: the shadow (provider config, model)
 * pair when a migration is actively backfilling, else null. Owner decision:
 * pages edited during the backfill embed with BOTH models so the shadow never
 * goes stale and no reconcile pass exists.
 */
export async function getActiveShadowTarget(): Promise<{
  cfg: NonNullable<Awaited<ReturnType<typeof providerConfigFor>>>;
  model: string;
  dimensions: number;
} | null> {
  const state = await getShadowMigrationState();
  if (!state || state.status !== 'active') return null;
  const cfg = await providerConfigFor(state.providerId);
  if (!cfg) return null;
  return { cfg, model: state.model, dimensions: state.dimensions };
}

export async function startShadowMigration(opts: {
  providerId: string;
  model: string;
}): Promise<{ dimensions: number; columnType: string; pageCount: number; jobId: string }> {
  const existing = await getShadowMigrationState();
  if (existing) {
    throw new Error(
      `A shadow migration is already ${existing.status} (started ${existing.startedAt}) — swap, roll it back or clean it up first`,
    );
  }

  // Soft mutual exclusion with the destructive path: refuse while a
  // reembed-all job is anywhere in the queue. (Legacy non-BullMQ mode returns
  // null here; the destructive path's own Redis lock still serializes the
  // actual work.)
  const reembed = await getJobStatus('reembed-all', 'reembed-all');
  if (reembed && ['active', 'waiting', 'delayed'].includes(reembed.state ?? '')) {
    throw new Error('A destructive re-embed job is queued or running — wait for it before starting a shadow migration');
  }

  // A previous migration's backfill job can outlive its abort under the fixed
  // jobId; BullMQ silently ignores a duplicate add, so starting now would
  // create a migration with NO job. Refuse until it drains.
  const previous = await getJobStatus(SHADOW_JOB_QUEUE, SHADOW_JOB_QUEUE);
  if (previous && ['active', 'waiting', 'delayed'].includes(previous.state ?? '')) {
    throw new Error('The previous shadow backfill job is still running or queued — wait for it to finish before starting a new migration');
  }

  const cfg = await providerConfigFor(opts.providerId);
  if (!cfg) {
    throw new Error('Provider not found');
  }

  // Probe the pair server-side. The MEASURED dimension types the shadow
  // column — the enforcement gap the issue body flags (server trusting a
  // client-posted number) does not exist on this path because no number is
  // accepted at all.
  const vectors = await generateEmbedding(cfg, opts.model, 'probe');
  const dimensions = vectors[0]?.length ?? 0;
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 16000) {
    throw new Error(`Probe returned an unusable dimension (${dimensions})`);
  }

  const { columnType, opclass } = columnTypeFor(dimensions);

  // ADD COLUMN takes a brief ACCESS EXCLUSIVE lock too — same bounded-lock
  // discipline as the swap (review r1), or the start can queue indefinitely
  // behind a long reader while blocking every new one.
  await withLockRetry({ lockTimeoutMs: 5000, maxAttempts: 5 }, async (client) => {
    await client.query(`ALTER TABLE page_embeddings ADD COLUMN embedding_next ${columnType}`);
    await client.query(`ALTER TABLE pages ADD COLUMN page_avg_embedding_next ${columnType}`);
    await saveState(
      {
        status: 'active',
        providerId: opts.providerId,
        model: opts.model,
        dimensions,
        columnType,
        indexed: opclass !== null,
        startedAt: new Date().toISOString(),
      },
      client as unknown as { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    );
  });

  const pageCount = await countBackfillPages();
  const retention = await getReembedHistoryRetention();
  const jobId = await enqueueJob(
    SHADOW_JOB_QUEUE,
    { startedAt: new Date().toISOString() },
    { jobId: SHADOW_JOB_QUEUE, removeOnComplete: retention, removeOnFail: retention },
  );

  logger.info({ providerId: opts.providerId, model: opts.model, dimensions, columnType, pageCount }, 'Shadow migration started');
  return { dimensions, columnType, pageCount, jobId };
}

async function countBackfillPages(): Promise<number> {
  const r = await query<{ n: number }>(`SELECT COUNT(DISTINCT page_id)::int AS n FROM page_embeddings`);
  return r.rows[0]?.n ?? 0;
}

async function countStragglerPages(): Promise<number> {
  const r = await query<{ n: number }>(
    `SELECT COUNT(DISTINCT page_id)::int AS n FROM page_embeddings WHERE embedding_next IS NULL`,
  );
  return r.rows[0]?.n ?? 0;
}

async function shadowIndexesReady(state: ShadowMigrationState): Promise<boolean> {
  if (!state.indexed) return true;
  // BOTH shadow indexes (review r4): a crash between the two CREATE INDEX
  // statements would otherwise report 'ready' and the swap's IF EXISTS
  // rename would silently leave the pages avg column unindexed post-swap.
  const r = await query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
     WHERE indexname IN ('idx_page_embeddings_hnsw_next', 'idx_pages_page_avg_embedding_hnsw_next')`,
  );
  return r.rows.length === 2;
}

export async function getShadowMigrationStatus(): Promise<ShadowMigrationStatus | null> {
  const state = await getShadowMigrationState();
  if (!state) return null;
  if (state.status === 'aborting') {
    // The shadow columns may be half-dropped — no column-touching queries here.
    return { ...state, phase: 'aborting', totalPages: 0, backfilledPages: 0, stragglerPages: 0, indexReady: false };
  }
  if (state.status === 'swapped') {
    const totalPages = await countBackfillPages();
    return { ...state, phase: 'swapped', totalPages, backfilledPages: totalPages, stragglerPages: 0, indexReady: true };
  }
  const totalPages = await countBackfillPages();
  const stragglerPages = await countStragglerPages();
  const indexReady = await shadowIndexesReady(state);
  return {
    ...state,
    phase: stragglerPages === 0 && indexReady ? 'ready' : 'backfilling',
    totalPages,
    backfilledPages: totalPages - stragglerPages,
    stragglerPages,
    indexReady,
  };
}

const BACKFILL_PAGE_BATCH = 25;
const EMBED_BATCH = 16;

/**
 * The backfill worker. Embeds every chunk row that still lacks a shadow
 * vector, page by page, with the NEW model; per-page failures are logged and
 * left as stragglers (the swap gate refuses while any remain). Aborts cleanly
 * when the state row disappears (rollback-before-swap).
 */
export async function runShadowBackfillJob(job?: {
  updateProgress?: (p: number | object) => Promise<void>;
}): Promise<{ processed: number; failed: number } | 'no-active-migration' | 'aborted'> {
  let state = await getShadowMigrationState();
  if (!state || state.status !== 'active') return 'no-active-migration';

  const cfg = await providerConfigFor(state.providerId);
  if (!cfg) {
    logger.error({ providerId: state.providerId }, 'Shadow migration provider vanished — leaving stragglers');
    return { processed: 0, failed: 0 };
  }

  const total = await countBackfillPages();
  let processed = 0;
  let failed = 0;
  // Pages that failed THIS run are excluded from every later batch SELECT, so
  // a poison page cannot be re-selected forever (review r1, blocking): the
  // loop ends when every remaining NULL page is in this set. Values come from
  // the DB's integer PK column and are re-validated before interpolation.
  const failedPages = new Set<number>();

  for (;;) {
    const exclude = [...failedPages].filter((n) => Number.isInteger(n));
    const batch = await query<{ page_id: number }>(
      `SELECT DISTINCT page_id FROM page_embeddings
       WHERE embedding_next IS NULL
       ${exclude.length > 0 ? `AND page_id NOT IN (${exclude.join(',')})` : ''}
       ORDER BY page_id LIMIT $1`,
      [BACKFILL_PAGE_BATCH],
    );
    if (batch.rows.length === 0) break;

    for (const { page_id } of batch.rows) {
      // Re-read state per page so a rollback aborts the job promptly even
      // inside a large batch (review r1).
      state = await getShadowMigrationState();
      if (!state || state.status !== 'active') return 'aborted';
      try {
        await shadowEmbedExistingRows(page_id, cfg, state.model);
        processed++;
      } catch (err) {
        failed++;
        failedPages.add(page_id);
        logger.warn({ err, pageId: page_id }, 'Shadow backfill failed for page — left as straggler');
      }
      if ((processed + failed) % 100 === 0 || processed + failed === total) {
        await job?.updateProgress?.({ total, processed, failed, phase: 'backfilling' });
      }
    }
  }

  if ((await countStragglerPages()) === 0) {
    await buildShadowIndexes(state);
    await job?.updateProgress?.({ total, processed, failed, phase: 'complete' });
  }

  return { processed, failed };
}

/** Embed one page's existing chunk rows with the shadow model and fill embedding_next. */
async function shadowEmbedExistingRows(
  pageId: number,
  cfg: NonNullable<Awaited<ReturnType<typeof providerConfigFor>>>,
  model: string,
): Promise<void> {
  const rows = await query<{ chunk_index: number; chunk_text: string }>(
    `SELECT chunk_index, chunk_text FROM page_embeddings WHERE page_id = $1 AND embedding_next IS NULL ORDER BY chunk_index`,
    [pageId],
  );
  if (rows.rows.length === 0) return;

  const embeddings: Array<{ chunkIndex: number; text: string; embedding: number[] }> = [];
  for (let i = 0; i < rows.rows.length; i += EMBED_BATCH) {
    const slice = rows.rows.slice(i, i + EMBED_BATCH);
    const vectors = await generateEmbedding(cfg, model, slice.map((r) => r.chunk_text));
    for (let j = 0; j < slice.length; j++) {
      embeddings.push({ chunkIndex: slice[j]!.chunk_index, text: slice[j]!.chunk_text, embedding: vectors[j]! });
    }
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    for (const e of embeddings) {
      // Guarded write-back (review r1): the provider round-trip above is a
      // long lock-free window in which embedPage can replace the page's rows
      // and dual-write them. Only fill rows that are still NULL AND still
      // carry the text this vector was computed from — anything else is a
      // fresh row this pass must not stamp stale-text vectors onto; if its
      // dual-write failed it stays NULL and the next pass re-embeds it from
      // its CURRENT text.
      await client.query(
        `UPDATE page_embeddings SET embedding_next = $3
         WHERE page_id = $1 AND chunk_index = $2 AND embedding_next IS NULL AND chunk_text = $4`,
        [pageId, e.chunkIndex, pgvector.toSql(e.embedding), e.text],
      );
    }
    // Materialize the shadow average only when every row has a shadow vector
    // — a partial AVG would silently skew #919's related-pages after the swap.
    await client.query(
      `UPDATE pages SET page_avg_embedding_next = (
         SELECT CASE WHEN COUNT(*) FILTER (WHERE embedding_next IS NULL) = 0
                     THEN AVG(embedding_next) END
         FROM page_embeddings WHERE page_id = $1
       ) WHERE id = $1`,
      [pageId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function buildShadowIndexes(state: ShadowMigrationState): Promise<void> {
  if (!state.indexed) {
    logger.warn({ dimensions: state.dimensions }, 'Shadow dimension exceeds 4000 — no HNSW index; post-swap vector search will seq-scan');
    return;
  }
  const { opclass } = columnTypeFor(state.dimensions);
  // Plain CREATE INDEX (not CONCURRENTLY): blocks WRITES to page_embeddings
  // for the build, never reads — search stays on the live index throughout.
  // Documented in the runbook; sync writes queue behind it briefly.
  await query(
    `CREATE INDEX IF NOT EXISTS idx_page_embeddings_hnsw_next
     ON page_embeddings USING hnsw (embedding_next ${opclass}) WITH (m = 16, ef_construction = 200)`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS idx_pages_page_avg_embedding_hnsw_next
     ON pages USING hnsw (page_avg_embedding_next ${opclass}) WITH (m = 16, ef_construction = 200)`,
  );
}

const LOCK_NOT_AVAILABLE = '55P03';
const DEADLOCK_DETECTED = '40P01';

/**
 * Run `fn` inside a transaction with `SET LOCAL lock_timeout`, retrying with
 * backoff when a lock wait times out. No pool sets lock_timeout (only
 * runMigrations, to 0), so without the explicit SET LOCAL the renames would
 * queue indefinitely behind long-running readers while blocking every new one.
 */
async function withLockRetry(
  opts: { lockTimeoutMs: number; maxAttempts: number },
  fn: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }) => Promise<void>,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = '${Number(opts.lockTimeoutMs)}ms'`);
      await fn(client as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> });
      await client.query('COMMIT');
      return;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      lastErr = err;
      const code = (err as { code?: string }).code;
      // 55P03 = lock_not_available (our SET LOCAL fired), 40P01 = deadlock
      // detected — e.g. against the per-search coverage COUNT, which touches
      // the same two tables (review r1). Both are transient; retry.
      if (code !== LOCK_NOT_AVAILABLE && code !== DEADLOCK_DETECTED) throw err;
      logger.warn({ attempt, maxAttempts: opts.maxAttempts, code }, 'Shadow DDL lock wait failed — retrying');
      await new Promise((r) => setTimeout(r, 200 * attempt));
    } finally {
      client.release();
    }
  }
  throw new Error(
    `Could not acquire the table lock for the shadow swap after ${opts.maxAttempts} attempts (lock_timeout ${opts.lockTimeoutMs}ms) — retry when long-running queries have drained: ${String((lastErr as Error)?.message ?? lastErr)}`,
  );
}

export async function performShadowSwap(opts?: {
  lockTimeoutMs?: number;
  maxAttempts?: number;
}): Promise<void> {
  const status = await getShadowMigrationStatus();
  if (!status || status.status !== 'active') {
    throw new Error('No active shadow migration to swap');
  }
  if (status.phase !== 'ready') {
    throw new Error(
      `Shadow migration not ready to swap: ${status.stragglerPages} straggler pages${status.indexReady ? '' : ', shadow index missing'} — re-run the backfill`,
    );
  }

  const prevAssignment = await query<{ provider_id: string; model: string }>(
    `SELECT provider_id, model FROM llm_usecase_assignments WHERE usecase = 'embedding'`,
  );
  const prevDims = await query<{ setting_value: string }>(
    `SELECT setting_value FROM admin_settings WHERE setting_key = 'embedding_dimensions'`,
  );
  const prev = {
    providerId: prevAssignment.rows[0]?.provider_id ?? null,
    model: prevAssignment.rows[0]?.model ?? null,
    dimensions: parseInt(prevDims.rows[0]?.setting_value ?? '1024', 10) || 1024,
  };

  await withLockRetry(
    { lockTimeoutMs: opts?.lockTimeoutMs ?? 5000, maxAttempts: opts?.maxAttempts ?? 5 },
    async (client) => {
      // Acquire the exclusive locks FIRST (still under lock_timeout), so the
      // straggler recheck below runs with every writer either committed or
      // queued behind us. Rechecking before the lock grant left a window in
      // which an in-flight dual-write whose shadow leg failed could commit a
      // NULL embedding_next after the recheck's snapshot (review r1) — and
      // the swap would promote that NULL into the live column.
      await client.query(`LOCK TABLE page_embeddings, pages IN ACCESS EXCLUSIVE MODE`);
      // State re-verify directly after the lock (review r4): if an abort
      // COMPLETED while we queued, embedding_next is gone and the straggler
      // SELECT below would raise a raw 42703 → masked 500 instead of this
      // crafted refusal.
      const preRows = await client.query(
        `SELECT setting_value FROM admin_settings WHERE setting_key = '${SHADOW_MIGRATION_STATE_KEY}'`,
      );
      const preRaw = (preRows.rows[0] as { setting_value?: string } | undefined)?.setting_value;
      const preState = preRaw ? (JSON.parse(preRaw) as ShadowMigrationState) : null;
      if (!preState || preState.status !== 'active') {
        throw new Error(`Migration state changed mid-swap (now ${preState?.status ?? 'absent'}) — swap refused`);
      }
      const straggle = await client.query(
        `SELECT COUNT(DISTINCT page_id)::int AS n FROM page_embeddings WHERE embedding_next IS NULL`,
      );
      if ((straggle.rows[0] as { n: number }).n > 0) {
        throw new Error(`Shadow migration not ready to swap: ${(straggle.rows[0] as { n: number }).n} straggler pages appeared`);
      }

      await client.query(`ALTER TABLE page_embeddings RENAME COLUMN embedding TO embedding_prev`);
      await client.query(`ALTER TABLE page_embeddings RENAME COLUMN embedding_next TO embedding`);
      // The NOT NULL travelled to embedding_prev with the rename; post-swap
      // inserts never provide it, so it MUST go or every embedPage fails.
      await client.query(`ALTER TABLE page_embeddings ALTER COLUMN embedding_prev DROP NOT NULL`);
      await client.query(`ALTER TABLE pages RENAME COLUMN page_avg_embedding TO page_avg_embedding_prev`);
      await client.query(`ALTER TABLE pages RENAME COLUMN page_avg_embedding_next TO page_avg_embedding`);
      await client.query(`ALTER INDEX IF EXISTS idx_page_embeddings_hnsw RENAME TO idx_page_embeddings_hnsw_prev`);
      await client.query(`ALTER INDEX IF EXISTS idx_page_embeddings_hnsw_next RENAME TO idx_page_embeddings_hnsw`);
      await client.query(`ALTER INDEX IF EXISTS idx_pages_page_avg_embedding_hnsw RENAME TO idx_pages_page_avg_embedding_hnsw_prev`);
      await client.query(`ALTER INDEX IF EXISTS idx_pages_page_avg_embedding_hnsw_next RENAME TO idx_pages_page_avg_embedding_hnsw`);

      // Re-read the state through THIS transaction's client and refuse any
      // status but 'active' (review r2): a concurrent abort flips the row to
      // 'aborting', and blindly spreading it into 'swapped' below would let
      // the queued abort later erase the swap's state row — new model live,
      // prev columns stranded, lifecycle wedged.
      const stateRows = await client.query(
        `SELECT setting_value FROM admin_settings WHERE setting_key = '${SHADOW_MIGRATION_STATE_KEY}'`,
      );
      const rawState = (stateRows.rows[0] as { setting_value?: string } | undefined)?.setting_value;
      const state = rawState ? (JSON.parse(rawState) as ShadowMigrationState) : null;
      if (!state || state.status !== 'active') {
        throw new Error(
          `Migration state changed mid-swap (now ${state?.status ?? 'absent'}) — swap refused`,
        );
      }
      await client.query(
        `INSERT INTO llm_usecase_assignments (usecase, provider_id, model, updated_at)
         VALUES ('embedding', $1, $2, NOW())
         ON CONFLICT (usecase) DO UPDATE SET provider_id = $1, model = $2, updated_at = NOW()`,
        [state.providerId, state.model],
      );
      await client.query(
        `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
         VALUES ('embedding_dimensions', $1, NOW())
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1, updated_at = NOW()`,
        [String(state.dimensions)],
      );
      await saveState(
        { ...state, status: 'swapped', swappedAt: new Date().toISOString(), prev },
        client as unknown as { query: (sql: string, params?: unknown[]) => Promise<unknown> },
      );
    },
  );

  await bumpProviderCacheVersion();
  logger.info('Shadow migration swapped — new model is live; run cleanup once validated, or rollback to revert');
}

export async function rollbackShadowMigration(opts?: {
  lockTimeoutMs?: number;
  maxAttempts?: number;
}): Promise<'aborted' | 'reverted'> {
  const state = await getShadowMigrationState();
  if (!state) {
    throw new Error('No shadow migration to roll back');
  }

  if (state.status === 'active' || state.status === 'aborting') {
    // Abort in two resumable steps (review r1): flip the state to 'aborting'
    // first — the backfill job's per-page re-read exits on any non-active
    // status, and a crash before the drops leaves a state row that this same
    // function completes on re-run instead of stranding orphan columns that
    // would 500 every future start. The drops + state delete then run in ONE
    // bounded-lock transaction (they take ACCESS EXCLUSIVE, the same hazard
    // the swap guards against).
    if (state.status === 'active') {
      // Compare-and-set (review r2): a blind upsert could land AFTER a
      // concurrently-committing swap and overwrite its 'swapped' row. Flip
      // only if the row still says 'active'; otherwise re-route below.
      const cas = await query(
        `UPDATE admin_settings SET setting_value = $2, updated_at = NOW()
         WHERE setting_key = $1 AND setting_value::jsonb->>'status' = 'active'`,
        [SHADOW_MIGRATION_STATE_KEY, JSON.stringify({ ...state, status: 'aborting' })],
      );
      if ((cas as unknown as { rowCount?: number }).rowCount === 0) {
        const now = await getShadowMigrationState();
        if (now?.status === 'swapped') {
          throw new Error('The swap completed while the abort was queued — use rollback to revert it, or cleanup to keep it');
        }
        if (!now) return 'aborted'; // someone else already finished the abort
      }
    }
    await withLockRetry(
      { lockTimeoutMs: opts?.lockTimeoutMs ?? 5000, maxAttempts: opts?.maxAttempts ?? 5 },
      async (client) => {
        // Lock FIRST, then re-verify (review r2+r3): the drops are IF EXISTS
        // and would silently no-op against a post-swap schema, after which
        // the DELETE below would erase the swap's state row — and a
        // pre-lock state read cannot see a DDL transaction that currently
        // holds the table lock.
        await client.query(`LOCK TABLE page_embeddings, pages IN ACCESS EXCLUSIVE MODE`);
        const rows = await client.query(
          `SELECT setting_value FROM admin_settings WHERE setting_key = '${SHADOW_MIGRATION_STATE_KEY}'`,
        );
        const raw = (rows.rows[0] as { setting_value?: string } | undefined)?.setting_value;
        const current = raw ? (JSON.parse(raw) as ShadowMigrationState) : null;
        if (current && current.status !== 'aborting') {
          throw new Error(`Migration state changed mid-abort (now ${current.status}) — abort refused`);
        }
        await client.query(`DROP INDEX IF EXISTS idx_page_embeddings_hnsw_next`);
        await client.query(`DROP INDEX IF EXISTS idx_pages_page_avg_embedding_hnsw_next`);
        await client.query(`ALTER TABLE page_embeddings DROP COLUMN IF EXISTS embedding_next`);
        await client.query(`ALTER TABLE pages DROP COLUMN IF EXISTS page_avg_embedding_next`);
        await client.query(`DELETE FROM admin_settings WHERE setting_key = $1`, [SHADOW_MIGRATION_STATE_KEY]);
      },
    );
    logger.info('Shadow migration aborted — shadow columns dropped, live path untouched');
    return 'aborted';
  }

  // status === 'swapped': reverse the renames and restore the assignment.
  await withLockRetry(
    { lockTimeoutMs: opts?.lockTimeoutMs ?? 5000, maxAttempts: opts?.maxAttempts ?? 5 },
    async (client) => {
      // Lock FIRST, re-verify second (review r4, same discipline as swap/
      // abort/cleanup): a revert losing the race to a cleanup or a second
      // revert would otherwise fail on a raw RENAME error → masked 500.
      await client.query(`LOCK TABLE page_embeddings, pages IN ACCESS EXCLUSIVE MODE`);
      const revRows = await client.query(
        `SELECT setting_value FROM admin_settings WHERE setting_key = '${SHADOW_MIGRATION_STATE_KEY}'`,
      );
      const revRaw = (revRows.rows[0] as { setting_value?: string } | undefined)?.setting_value;
      const revState = revRaw ? (JSON.parse(revRaw) as ShadowMigrationState) : null;
      if (!revState || revState.status !== 'swapped') {
        throw new Error(`Migration state changed mid-rollback (now ${revState?.status ?? 'absent'}) — rollback refused`);
      }
      await client.query(`ALTER TABLE page_embeddings RENAME COLUMN embedding TO embedding_next`);
      await client.query(`ALTER TABLE page_embeddings RENAME COLUMN embedding_prev TO embedding`);
      await client.query(`ALTER TABLE pages RENAME COLUMN page_avg_embedding TO page_avg_embedding_next`);
      await client.query(`ALTER TABLE pages RENAME COLUMN page_avg_embedding_prev TO page_avg_embedding`);
      await client.query(`ALTER INDEX IF EXISTS idx_page_embeddings_hnsw RENAME TO idx_page_embeddings_hnsw_next`);
      await client.query(`ALTER INDEX IF EXISTS idx_page_embeddings_hnsw_prev RENAME TO idx_page_embeddings_hnsw`);
      await client.query(`ALTER INDEX IF EXISTS idx_pages_page_avg_embedding_hnsw RENAME TO idx_pages_page_avg_embedding_hnsw_next`);
      await client.query(`ALTER INDEX IF EXISTS idx_pages_page_avg_embedding_hnsw_prev RENAME TO idx_pages_page_avg_embedding_hnsw`);

      // Restore what was captured VERBATIM (review r4): {provider: P,
      // model: NULL} and {provider: NULL, model: M} are first-class partial
      // pins with their own resolution semantics — collapsing either to
      // full inherit repoints the restored vectors' model at the default
      // provider. Delete only when the captured row was absent or fully
      // null (those resolve identically to no row).
      if (state.prev && (state.prev.providerId !== null || state.prev.model !== null)) {
        await client.query(
          `INSERT INTO llm_usecase_assignments (usecase, provider_id, model, updated_at)
           VALUES ('embedding', $1, $2, NOW())
           ON CONFLICT (usecase) DO UPDATE SET provider_id = $1, model = $2, updated_at = NOW()`,
          [state.prev.providerId, state.prev.model],
        );
      } else {
        await client.query(`DELETE FROM llm_usecase_assignments WHERE usecase = 'embedding'`);
      }
      await client.query(
        `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
         VALUES ('embedding_dimensions', $1, NOW())
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1, updated_at = NOW()`,
        [String(state.prev?.dimensions ?? 1024)],
      );
      await saveState(
        {
          status: 'active',
          providerId: state.providerId,
          model: state.model,
          dimensions: state.dimensions,
          columnType: state.columnType,
          indexed: state.indexed,
          startedAt: state.startedAt,
        },
        client as unknown as { query: (sql: string, params?: unknown[]) => Promise<unknown> },
      );

      // Pages embedded after the swap have no prev vectors: after the reverse
      // rename their live embedding is NULL, so they would silently vanish
      // from vector search. Re-dirty them for the normal pipeline.
      await client.query(
        `UPDATE pages SET embedding_dirty = TRUE, embedding_status = 'not_embedded', page_avg_embedding = NULL
         WHERE id IN (SELECT DISTINCT page_id FROM page_embeddings WHERE embedding IS NULL)`,
      );
      await client.query(`DELETE FROM page_embeddings WHERE embedding IS NULL`);
      // With the NULL rows gone, the old live column can take its NOT NULL
      // back — otherwise the invariant is lost forever on this path
      // (review r1); the forward path restores it in cleanup.
      await client.query(`ALTER TABLE page_embeddings ALTER COLUMN embedding SET NOT NULL`);
    },
  );

  await bumpProviderCacheVersion();
  logger.info('Shadow migration reverted — old model is live again; state back to active');
  return 'reverted';
}

export async function cleanupShadowMigration(opts?: {
  lockTimeoutMs?: number;
  maxAttempts?: number;
}): Promise<void> {
  const state = await getShadowMigrationState();
  if (!state || state.status !== 'swapped') {
    throw new Error('Cleanup only applies after a swap — nothing to clean up');
  }

  // One bounded-lock transaction (review r1): these DROPs take ACCESS
  // EXCLUSIVE on the hot tables, and half-done cleanup must not be possible.
  await withLockRetry(
    { lockTimeoutMs: opts?.lockTimeoutMs ?? 5000, maxAttempts: opts?.maxAttempts ?? 5 },
    async (client) => {
      // Lock FIRST, re-verify second (review r3, same discipline as the
      // swap): a state SELECT holds no conflicting lock, so it would read
      // before this transaction queues behind a concurrent rollback — and a
      // rollback that wins reverses the renames and sets the state back to
      // 'active', after which these IF EXISTS drops silently no-op and the
      // DELETE below would erase the ACTIVE migration's state row.
      await client.query(`LOCK TABLE page_embeddings, pages IN ACCESS EXCLUSIVE MODE`);
      const rows = await client.query(
        `SELECT setting_value FROM admin_settings WHERE setting_key = '${SHADOW_MIGRATION_STATE_KEY}'`,
      );
      const raw = (rows.rows[0] as { setting_value?: string } | undefined)?.setting_value;
      const current = raw ? (JSON.parse(raw) as ShadowMigrationState) : null;
      if (!current || current.status !== 'swapped') {
        throw new Error(`Migration state changed mid-cleanup (now ${current?.status ?? 'absent'}) — cleanup refused`);
      }
      await client.query(`DROP INDEX IF EXISTS idx_page_embeddings_hnsw_prev`);
      await client.query(`DROP INDEX IF EXISTS idx_pages_page_avg_embedding_hnsw_prev`);
      await client.query(`ALTER TABLE page_embeddings DROP COLUMN IF EXISTS embedding_prev`);
      await client.query(`ALTER TABLE pages DROP COLUMN IF EXISTS page_avg_embedding_prev`);
      // A NULL live vector here is a row that slipped through the swap window
      // — deleting it without re-queueing its page would permanently drop
      // that content from vector search (review r1). Re-dirty first, then
      // delete, then restore the invariant.
      await client.query(
        `UPDATE pages SET embedding_dirty = TRUE, embedding_status = 'not_embedded', page_avg_embedding = NULL
         WHERE id IN (SELECT DISTINCT page_id FROM page_embeddings WHERE embedding IS NULL)`,
      );
      await client.query(`DELETE FROM page_embeddings WHERE embedding IS NULL`);
      await client.query(`ALTER TABLE page_embeddings ALTER COLUMN embedding SET NOT NULL`);
      await client.query(`DELETE FROM admin_settings WHERE setting_key = $1`, [SHADOW_MIGRATION_STATE_KEY]);
    },
  );
  logger.info('Shadow migration cleaned up — prev columns dropped, NOT NULL restored');
}

/**
 * Re-enqueue the backfill for an active migration (review r1): stragglers, a
 * crashed worker, or a crash between start's COMMIT and its enqueue would
 * otherwise dead-end the migration with only Abort available.
 */
export async function rerunShadowBackfill(): Promise<{ jobId: string }> {
  const state = await getShadowMigrationState();
  if (!state || state.status !== 'active') {
    throw new Error('No active shadow migration — nothing to backfill');
  }
  // BullMQ silently ignores an add under a fixed jobId while that job is
  // queued or running — the admin would get a success toast and nothing
  // would happen (review r2). Refuse honestly instead.
  const running = await getJobStatus(SHADOW_JOB_QUEUE, SHADOW_JOB_QUEUE);
  if (running && ['active', 'waiting', 'delayed'].includes(running.state ?? '')) {
    throw new Error('The backfill job is still running or queued — wait for it to finish before re-running');
  }
  const retention = await getReembedHistoryRetention();
  const jobId = await enqueueJob(
    SHADOW_JOB_QUEUE,
    { rerunAt: new Date().toISOString() },
    { jobId: SHADOW_JOB_QUEUE, removeOnComplete: retention, removeOnFail: retention },
  );
  logger.info('Shadow backfill re-enqueued');
  return { jobId };
}
