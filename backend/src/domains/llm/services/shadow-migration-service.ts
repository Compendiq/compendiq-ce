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
  status: 'active' | 'swapped';
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
  phase: 'backfilling' | 'ready' | 'swapped';
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

async function clearState(): Promise<void> {
  await query(`DELETE FROM admin_settings WHERE setting_key = $1`, [SHADOW_MIGRATION_STATE_KEY]);
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
 * The dual-write target for embedPage: the shadow (provider config, model)
 * pair when a migration is actively backfilling, else null. Owner decision:
 * pages edited during the backfill embed with BOTH models so the shadow never
 * goes stale and no reconcile pass exists.
 */
export async function getActiveShadowTarget(): Promise<{
  cfg: NonNullable<Awaited<ReturnType<typeof providerConfigFor>>>;
  model: string;
} | null> {
  const state = await getShadowMigrationState();
  if (!state || state.status !== 'active') return null;
  const cfg = await providerConfigFor(state.providerId);
  if (!cfg) return null;
  return { cfg, model: state.model };
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
  if (reembed && ['active', 'waiting', 'delayed'].includes(reembed.state)) {
    throw new Error('A destructive re-embed job is queued or running — wait for it before starting a shadow migration');
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

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
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
      client,
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

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
  const r = await query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE indexname = 'idx_page_embeddings_hnsw_next'`,
  );
  return r.rows.length > 0;
}

export async function getShadowMigrationStatus(): Promise<ShadowMigrationStatus | null> {
  const state = await getShadowMigrationState();
  if (!state) return null;
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

  for (;;) {
    // Re-read state each batch so a rollback aborts the job promptly.
    state = await getShadowMigrationState();
    if (!state || state.status !== 'active') return 'aborted';

    const batch = await query<{ page_id: number }>(
      `SELECT DISTINCT page_id FROM page_embeddings WHERE embedding_next IS NULL ORDER BY page_id LIMIT $1`,
      [BACKFILL_PAGE_BATCH],
    );
    if (batch.rows.length === 0) break;

    for (const { page_id } of batch.rows) {
      try {
        await shadowEmbedExistingRows(page_id, cfg, state.model);
        processed++;
      } catch (err) {
        failed++;
        logger.warn({ err, pageId: page_id }, 'Shadow backfill failed for page — left as straggler');
        // Mark the page's rows so this pass does not spin on it forever; a
        // NULL embedding_next remains NULL, but we must not re-select it in
        // an infinite loop. Skip forward by remembering it this run.
      }
      if ((processed + failed) % 100 === 0 || processed + failed === total) {
        await job?.updateProgress?.({ total, processed, failed, phase: 'backfilling' });
      }
    }
    // A page whose embed failed still has NULL rows and would be re-selected
    // forever; stop when a full pass makes no progress.
    if (batch.rows.length > 0 && processed === 0 && failed >= batch.rows.length) break;
    if (failed > 0 && batch.rows.length <= failed && processed === 0) break;
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

  const embeddings: Array<{ chunkIndex: number; embedding: number[] }> = [];
  for (let i = 0; i < rows.rows.length; i += EMBED_BATCH) {
    const slice = rows.rows.slice(i, i + EMBED_BATCH);
    const vectors = await generateEmbedding(cfg, model, slice.map((r) => r.chunk_text));
    for (let j = 0; j < slice.length; j++) {
      embeddings.push({ chunkIndex: slice[j]!.chunk_index, embedding: vectors[j]! });
    }
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    for (const e of embeddings) {
      await client.query(
        `UPDATE page_embeddings SET embedding_next = $3 WHERE page_id = $1 AND chunk_index = $2`,
        [pageId, e.chunkIndex, pgvector.toSql(e.embedding)],
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
      if (code !== LOCK_NOT_AVAILABLE) throw err;
      logger.warn({ attempt, maxAttempts: opts.maxAttempts }, 'Shadow swap lock wait timed out — retrying');
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
      // Re-check the gate INSIDE the lock: a page embedded between the check
      // above and the lock grant dual-writes both columns, so it cannot
      // create stragglers — but a shadow-provider failure in that window can.
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

      const state = (await getShadowMigrationState())!;
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

  if (state.status === 'active') {
    // Abort: clear state FIRST so the backfill job's per-batch re-read exits,
    // then drop the shadow artifacts.
    await clearState();
    await query(`DROP INDEX IF EXISTS idx_page_embeddings_hnsw_next`);
    await query(`DROP INDEX IF EXISTS idx_pages_page_avg_embedding_hnsw_next`);
    await query(`ALTER TABLE page_embeddings DROP COLUMN IF EXISTS embedding_next`);
    await query(`ALTER TABLE pages DROP COLUMN IF EXISTS page_avg_embedding_next`);
    logger.info('Shadow migration aborted — shadow columns dropped, live path untouched');
    return 'aborted';
  }

  // status === 'swapped': reverse the renames and restore the assignment.
  await withLockRetry(
    { lockTimeoutMs: opts?.lockTimeoutMs ?? 5000, maxAttempts: opts?.maxAttempts ?? 5 },
    async (client) => {
      await client.query(`ALTER TABLE page_embeddings RENAME COLUMN embedding TO embedding_next`);
      await client.query(`ALTER TABLE page_embeddings RENAME COLUMN embedding_prev TO embedding`);
      await client.query(`ALTER TABLE pages RENAME COLUMN page_avg_embedding TO page_avg_embedding_next`);
      await client.query(`ALTER TABLE pages RENAME COLUMN page_avg_embedding_prev TO page_avg_embedding`);
      await client.query(`ALTER INDEX IF EXISTS idx_page_embeddings_hnsw RENAME TO idx_page_embeddings_hnsw_next`);
      await client.query(`ALTER INDEX IF EXISTS idx_page_embeddings_hnsw_prev RENAME TO idx_page_embeddings_hnsw`);
      await client.query(`ALTER INDEX IF EXISTS idx_pages_page_avg_embedding_hnsw RENAME TO idx_pages_page_avg_embedding_hnsw_next`);
      await client.query(`ALTER INDEX IF EXISTS idx_pages_page_avg_embedding_hnsw_prev RENAME TO idx_pages_page_avg_embedding_hnsw`);

      if (state.prev?.providerId && state.prev.model) {
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
    },
  );

  await bumpProviderCacheVersion();
  logger.info('Shadow migration reverted — old model is live again; state back to active');
  return 'reverted';
}

export async function cleanupShadowMigration(): Promise<void> {
  const state = await getShadowMigrationState();
  if (!state || state.status !== 'swapped') {
    throw new Error('Cleanup only applies after a swap — nothing to clean up');
  }

  await query(`DROP INDEX IF EXISTS idx_page_embeddings_hnsw_prev`);
  await query(`DROP INDEX IF EXISTS idx_pages_page_avg_embedding_hnsw_prev`);
  await query(`ALTER TABLE page_embeddings DROP COLUMN IF EXISTS embedding_prev`);
  await query(`ALTER TABLE pages DROP COLUMN IF EXISTS page_avg_embedding_prev`);
  // Restore the schema invariant the swap suspended. The precondition + the
  // dual-write make NULLs impossible on the forward path; delete defensively
  // so a stray NULL cannot wedge the ALTER.
  await query(`DELETE FROM page_embeddings WHERE embedding IS NULL`);
  await query(`ALTER TABLE page_embeddings ALTER COLUMN embedding SET NOT NULL`);
  await clearState();
  logger.info('Shadow migration cleaned up — prev columns dropped, NOT NULL restored');
}
