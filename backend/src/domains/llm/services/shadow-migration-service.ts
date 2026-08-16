import { query, getPool } from '../../../core/db/postgres.js';
import { generateEmbedding } from './openai-compatible-client.js';
import { LlmHttpError } from './llm-http-error.js';
import { getProviderById } from './llm-provider-service.js';
import { bumpProviderCacheVersion } from './cache-bus.js';
import { enqueueJob, getJobStatus } from '../../../core/services/queue-service.js';
import { getReembedHistoryRetention } from '../../../core/services/admin-settings-service.js';
import { warnThresholdOutlivedItsModel } from '../../../core/services/confidence-calibration.js';
import { resolveConfidenceBasisPair } from './llm-provider-resolver.js';
import { logger } from '../../../core/utils/logger.js';
import { getEnterprisePlugin } from '../../../core/enterprise/loader.js';
import { invalidateGraphCache } from '../../../core/services/redis-cache.js';
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

/**
 * A start-time probe that never reached an HTTP response — provider
 * unreachable, breaker open, queue refusal. Carries a bounded detail so the
 * route can answer 502 with the one thing the admin can act on.
 */
export class ShadowProbeError extends Error {
  constructor(public readonly detail: string) {
    super(`Probe failed before the provider answered: ${detail.slice(0, 300)}`);
    this.name = 'ShadowProbeError';
  }
}
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
  /**
   * Set by a post-swap revert. Without it the reverted state is byte-identical
   * to the pre-swap one (`status:startedAt:swappedAt`), so an embedPage whose
   * epoch snapshot straddled BOTH the swap and the revert passed its recheck
   * and wrote swapped-epoch vectors into reverted columns (review r7).
   */
  revertedAt?: string;
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
  return `${state.status}:${state.startedAt}:${state.swappedAt ?? ''}:${state.revertedAt ?? ''}`;
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

/**
 * Review r6 — the one assumption the whole design rests on: that after the
 * rename, `resolveUsecase('embedding')` returns the pair this migration
 * embedded with. The swap guarantees that by writing
 * `llm_usecase_assignments`, but an enterprise org LLM policy is consulted
 * BEFORE that table and short-circuits it (llm-provider-resolver.ts), so on
 * such an instance the repoint is a no-op for every consumer: the corpus
 * would carry the migration's model while embedPage and every query resolve
 * the policy's. Equal dimensions makes that a silently mixed vector space;
 * unequal makes every embed and search fail on vector length. CE's noop
 * answers null, so this is inert in community mode.
 */
async function embeddingPolicyOverride(): Promise<{ providerId: string; model: string } | null> {
  return (await getEnterprisePlugin().resolveUsecaseOverride?.('embedding')) ?? null;
}

const POLICY_OVERRIDE_MSG =
  'An organization LLM policy pins the embedding use case, and it outranks the assignment a swap writes — the corpus would be re-embedded with one model while every query resolves another. Point the policy at the new model (or disable it) before migrating (#1116).';

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

  if (await embeddingPolicyOverride()) {
    throw new Error(POLICY_OVERRIDE_MSG);
  }

  const cfg = await providerConfigFor(opts.providerId);
  if (!cfg) {
    throw new Error('Provider not found');
  }

  // Probe the pair server-side. The MEASURED dimension types the shadow
  // column — the enforcement gap the issue body flags (server trusting a
  // client-posted number) does not exist on this path because no number is
  // accepted at all.
  let vectors: number[][];
  try {
    vectors = await generateEmbedding(cfg, opts.model, 'probe');
  } catch (err) {
    // LlmHttpError means the provider ANSWERED with an error status; the
    // failure an admin is most likely to cause — wrong port, service down,
    // open breaker — never produces one, and reached the route as a masked
    // 500 (review r5). Classify it so the route can name it instead.
    if (err instanceof LlmHttpError) throw err;
    throw new ShadowProbeError(err instanceof Error ? err.message : String(err));
  }
  const dimensions = vectors[0]?.length ?? 0;
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 16000) {
    throw new Error(`Probe returned an unusable dimension (${dimensions})`);
  }

  const { columnType, opclass } = columnTypeFor(dimensions);

  // ADD COLUMN takes a brief ACCESS EXCLUSIVE lock too — same bounded-lock
  // discipline as the swap (review r1), or the start can queue indefinitely
  // behind a long reader while blocking every new one.
  await withLockRetry({ lockTimeoutMs: 5000, maxAttempts: 5 }, async (client) => {
    // Lock first, re-verify second — the same discipline as swap/abort/
    // revert/cleanup, and start needs it most: the probe above is a
    // provider round-trip seconds wide, so the pre-probe checks are long
    // stale by now (review r5). Without this, a second start racing the
    // probe window failed on a raw 42701 (duplicate column) and a provider
    // deleted during it left a migration pointing at nothing.
    await client.query(`LOCK TABLE page_embeddings, pages IN ACCESS EXCLUSIVE MODE`);
    const raceRows = await client.query(
      `SELECT setting_value FROM admin_settings WHERE setting_key = '${SHADOW_MIGRATION_STATE_KEY}'`,
    );
    const raceRaw = (raceRows.rows[0] as { setting_value?: string } | undefined)?.setting_value;
    if (raceRaw) {
      const raceState = JSON.parse(raceRaw) as ShadowMigrationState;
      throw new Error(
        `A shadow migration is already ${raceState.status} (started ${raceState.startedAt}) — swap, roll it back or clean it up first`,
      );
    }
    const stillThere = await client.query(`SELECT 1 FROM llm_providers WHERE id = $1`, [opts.providerId]);
    if (stillThere.rows.length === 0) {
      throw new Error('Provider not found');
    }
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
  // pg_indexes spans every schema in the database and index names are unique
  // only per schema, so an unfiltered row count can be satisfied twice over by
  // a restored clone schema while a real shadow index is missing (review r5).
  const r = await query<{ indexname: string }>(
    `SELECT DISTINCT indexname FROM pg_indexes
     WHERE schemaname = current_schema()
       AND indexname IN ('idx_page_embeddings_hnsw_next', 'idx_pages_page_avg_embedding_hnsw_next')`,
  );
  return r.rows.length === 2;
}

export async function getShadowMigrationStatus(): Promise<ShadowMigrationStatus | null> {
  try {
    return await readShadowMigrationStatus();
  } catch (err) {
    // The straggler count and the index probe both name the shadow columns,
    // and an abort committing between this function's state read and those
    // queries drops them — 42703 out of a plain status read, and out of the
    // swap's pre-flight gate as a masked 500 (review r7). Same discipline as
    // the backfill job: only when the state row agrees the migration ended.
    if (await abortedOutFromUnder(err)) {
      const now = await getShadowMigrationState();
      if (!now) return null;
      // A SWAP raises the same 42703 — it renames `embedding_next` away, so a
      // status poll queued behind its lock re-plans after the commit and finds
      // the column gone. Reporting that as 'aborting' put the card's "a
      // previous abort did not finish — retry it" panel in front of an admin,
      // whose button POSTs /rollback and would REVERT the swap (review r8).
      if (now.status !== 'aborting') return readShadowMigrationStatus();
      return { ...now, phase: 'aborting', totalPages: 0, backfilledPages: 0, stragglerPages: 0, indexReady: false };
    }
    throw err;
  }
}

async function readShadowMigrationStatus(): Promise<ShadowMigrationStatus | null> {
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
 * Review r6: an abort drops the shadow columns, and both the batch SELECT and
 * the final straggler recount name `embedding_next` — an abort committing
 * between pages takes the job's own queries out from under it and Postgres
 * answers 42703. That is this job losing a race it is MEANT to lose, so it
 * exits the way the in-loop state re-read does, instead of marking the BullMQ
 * record failed with a raw DB error that reads like a genuine backfill
 * failure. Confirmed against the state row, so a 42703 with the migration
 * still active stays the bug it would be.
 */
async function abortedOutFromUnder(err: unknown): Promise<boolean> {
  if ((err as { code?: string })?.code !== '42703') return false;
  const now = await getShadowMigrationState();
  return !now || now.status !== 'active';
}

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
    let batch: { rows: Array<{ page_id: number }> };
    try {
      batch = await query<{ page_id: number }>(
        `SELECT DISTINCT page_id FROM page_embeddings
         WHERE embedding_next IS NULL
         ${exclude.length > 0 ? `AND page_id NOT IN (${exclude.join(',')})` : ''}
         ORDER BY page_id LIMIT $1`,
        [BACKFILL_PAGE_BATCH],
      );
    } catch (err) {
      if (await abortedOutFromUnder(err)) return 'aborted';
      throw err;
    }
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

  try {
    if ((await countStragglerPages()) === 0) {
      await buildShadowIndexes(state);
      await job?.updateProgress?.({ total, processed, failed, phase: 'complete' });
    }
  } catch (err) {
    if (await abortedOutFromUnder(err)) return 'aborted';
    throw err;
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
  // Same exemption as the DDL transactions: an HNSW build over a real corpus
  // outruns any sane PG_STATEMENT_TIMEOUT, and being cancelled here means the
  // backfill can never reach `ready` (review r8). Session-scoped, so it is
  // reset before the connection returns to the pool.
  const idxClient = await getPool().connect();
  try {
    await idxClient.query('SET statement_timeout = 0');
    // Plain CREATE INDEX (not CONCURRENTLY): blocks WRITES to page_embeddings
    // for the build, never reads — search stays on the live index throughout.
    // Documented in the runbook; sync writes queue behind it briefly.
    await idxClient.query(
      `CREATE INDEX IF NOT EXISTS idx_page_embeddings_hnsw_next
       ON page_embeddings USING hnsw (embedding_next ${opclass}) WITH (m = 16, ef_construction = 200)`,
    );
    await idxClient.query(
      `CREATE INDEX IF NOT EXISTS idx_pages_page_avg_embedding_hnsw_next
       ON pages USING hnsw (page_avg_embedding_next ${opclass}) WITH (m = 16, ef_construction = 200)`,
    );
  } finally {
    // RESET restores the pool's startup value, not Postgres' default — the
    // same discipline runMigrations uses before returning its client.
    try {
      await idxClient.query('RESET statement_timeout');
      idxClient.release();
    } catch (err) {
      // Swallowing this would return a connection permanently exempt from
      // PG_STATEMENT_TIMEOUT to the shared pool, silently disabling for every
      // later query the protection this exemption exists to respect. Destroy
      // it instead — runMigrations does the same (review r9).
      logger.warn({ err }, 'Could not reset statement_timeout after the shadow index build — destroying the connection');
      idxClient.release(true);
    }
  }
}

const LOCK_NOT_AVAILABLE = '55P03';
const DEADLOCK_DETECTED = '40P01';

/**
 * `page_relationships.embedding_similarity` is a PERSISTED derivative of
 * `pages.page_avg_embedding` — the column the swap replaces. Nothing else
 * rebuilds it: the destructive path only self-heals because it dirties the
 * whole corpus and `processDirtyPages` recomputes every edge on the way out
 * (review r7). Left alone, the graph and related-pages keep serving scores
 * from the OLD vector space, and worse, drift into a permanent MIXTURE as
 * individual pages are edited and rewrite only their own edges — with one
 * read-time score floor applied across two incomparable distributions.
 *
 * Runs AFTER the swap transaction commits, never inside it: this is a
 * whole-corpus recompute, and holding the swap's ACCESS EXCLUSIVE lock across
 * it would turn a sub-second rename into an outage. A failure here is logged,
 * not thrown — the vectors are already live and correct, the edges are stale
 * derived data, and `POST /api/pages/graph/refresh` rebuilds them on demand.
 */
let pendingEdgeRefresh: Promise<void> = Promise.resolve();

/**
 * Rollback and cleanup wait for the detached edge rebuild rather than fight it
 * for the table lock — but only up to a point. The rebuild is a whole-corpus
 * recompute; waiting on it unbounded would 504 through the edge proxy an
 * operation that had not yet started, which is the same false-failure the
 * detach was introduced to avoid (review r9). After the cap they proceed and
 * take their chances on the lock, whose own bounded retry then reports
 * honestly. The wait is also process-local by nature: another replica's
 * rebuild is invisible here, so the lock retry stays the real backstop.
 */
const EDGE_REFRESH_WAIT_MS = 30_000;

function waitForEdgeRefresh(): Promise<unknown> {
  return Promise.race([
    pendingEdgeRefresh,
    new Promise((resolve) => setTimeout(resolve, EDGE_REFRESH_WAIT_MS)),
  ]);
}

/** Tests await the detached refresh; nothing in production needs to. */
export function awaitSimilarityEdgeRefresh(): Promise<void> {
  return pendingEdgeRefresh;
}

function startSimilarityEdgeRefresh(phase: 'swap' | 'rollback'): void {
  // DETACHED from the request on purpose. The swap's own transaction has
  // already committed, and a whole-corpus recompute can outlast an edge
  // proxy's read timeout — which would report a FAILED swap for one that
  // succeeded, and invite the admin to click Roll back on it. Stale edges
  // with a logged warning and a documented one-call remedy are the milder
  // failure. Errors are handled inside, so this promise never rejects.
  pendingEdgeRefresh = refreshSimilarityEdges(phase);
}

async function refreshSimilarityEdges(phase: 'swap' | 'rollback'): Promise<void> {
  try {
    // Dynamic: embedding-service imports THIS module for the dual-write, so a
    // static import here would close the cycle at module-init time.
    const { computePageRelationships } = await import('./embedding-service.js');
    await computePageRelationships();
    await invalidateGraphCache();
    logger.info({ phase }, 'Similarity edges recomputed for the new embedding space');
  } catch (err) {
    logger.error(
      { err, phase },
      'Failed to recompute similarity edges after the shadow migration — the graph and related pages keep old-model scores until POST /api/pages/graph/refresh is run',
    );
  }
}

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
      // A deployment that sets PG_STATEMENT_TIMEOUT applies it to every pooled
      // connection, and these transactions run genuinely long statements: the
      // re-dirty scan, the NULL-row DELETE and the SET NOT NULL validation
      // scan. 57014 is neither a lock code nor retried, so it aborted the
      // transaction and propagated — cleanup and rollback would fail EVERY
      // time, stranding the instance in `swapped` with no way out of the UI
      // (review r8). SET LOCAL, so it lasts exactly this transaction; the
      // lock_timeout above still bounds the wait that could hurt others.
      await client.query('SET LOCAL statement_timeout = 0');
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
  // Symmetric with rollback and cleanup (review r10): after a post-swap
  // revert the state returns to `ready` and the card offers Swap again
  // immediately, while that revert's own whole-corpus recompute is still
  // reading both tables — so the swap would spend its entire lock budget
  // losing to this branch's own background work and answer 503.
  await waitForEdgeRefresh();
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

  // #1114 review r3 — the OUTGOING model comes from the resolver, never from
  // `prev.model`. That column is NULL on an instance that pins a provider and
  // inherits its `default_model` — a first-class partial pin the rollback
  // below restores verbatim — so a raw read names the outgoing model `null`,
  // which is the one field this whole log line exists to carry. It is the
  // same raw-row-vs-resolver mistake `resolveConfidenceBasisPair`'s own doc
  // forbids, and `prev.model` must keep its raw value regardless: that is what
  // the rollback restores.
  //
  // Read here rather than inside the transaction because the resolver runs
  // its own connection, and this is the pair the pipeline was embedding with
  // when the swap began. An unresolved read falls back to the raw column: a
  // possibly-null model beats suppressing the warning entirely.
  const prevResolved = await resolveConfidenceBasisPair('similarity');
  const previousModel = prevResolved.resolved ? (prevResolved.pair?.model ?? null) : prev.model;

  // #1114 — captured INSIDE the transaction, off the state this swap verified
  // under the lock, exactly as the rollback below does (review r2). `status`
  // is a PRE-LOCK snapshot and the assignment is written from `state`; the two
  // differ precisely when another lifecycle step won the lock race, and a
  // warning naming a model the swap did not install is worse than none. No
  // resolver needed on this side: the swap always writes an explicit model.
  let swappedTo: string | null = null;
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
      // Re-checked here as well as at start: a policy switched on during the
      // backfill would make this write cosmetic, and the swap is the moment
      // the corpus becomes the one the queries disagree with (review r6).
      if (await embeddingPolicyOverride()) {
        throw new Error(POLICY_OVERRIDE_MSG);
      }
      swappedTo = state.model;
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
  startSimilarityEdgeRefresh('swap');
  logger.info('Shadow migration swapped — new model is live; run cleanup once validated, or rollback to revert');
  // #1114 — the cosine scale just moved and `rag_confidence_threshold` did
  // not. READ-ONLY by owner ruling: an operator who set a refuse gate
  // deliberately must not find it rewritten by an action about embeddings,
  // and a silently *relaxed* gate is worse than a silently strict one. The
  // Retrieval panel carries the same notice for operators who do not read
  // logs. After the transaction, because a swap that renamed the columns
  // successfully must not fail on a diagnostic.
  await warnThresholdOutlivedItsModel({
    basis: 'similarity',
    previousModel,
    newModel: swappedTo,
  });
}

export async function rollbackShadowMigration(opts?: {
  lockTimeoutMs?: number;
  maxAttempts?: number;
}): Promise<'aborted' | 'reverted'> {
  // The detached edge rebuild reads `pages` and `page_embeddings` for as long
  // as a whole-corpus recompute takes, while both of these open with LOCK
  // TABLE … ACCESS EXCLUSIVE on a ~27s total budget — so a rollback clicked
  // right after a swap would exhaust its retries against our OWN background
  // work and report a lock failure. Wait it out instead of racing it; it
  // never rejects (review r8).
  await waitForEdgeRefresh();
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
  //
  // #1114 — captured INSIDE the transaction, off the state this revert
  // verified under the lock (review r5's discipline, for the same reason):
  // the pre-lock snapshot and the verified one differ exactly when another
  // lifecycle step won the lock race, and a warning naming the wrong pair of
  // models is worse than none.
  let revertedFrom: string | null = null;
  let revertedTo: string | null = null;
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
      revertedFrom = revState.model;
      revertedTo = revState.prev?.model ?? null;
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
      if (revState.prev && (revState.prev.providerId !== null || revState.prev.model !== null)) {
        await client.query(
          `INSERT INTO llm_usecase_assignments (usecase, provider_id, model, updated_at)
           VALUES ('embedding', $1, $2, NOW())
           ON CONFLICT (usecase) DO UPDATE SET provider_id = $1, model = $2, updated_at = NOW()`,
          [revState.prev.providerId, revState.prev.model],
        );
      } else {
        await client.query(`DELETE FROM llm_usecase_assignments WHERE usecase = 'embedding'`);
      }
      await client.query(
        `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
         VALUES ('embedding_dimensions', $1, NOW())
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1, updated_at = NOW()`,
        [String(revState.prev?.dimensions ?? 1024)],
      );
      await saveState(
        {
          // Everything consumed here comes from the state this transaction
          // VERIFIED under the lock, never the pre-lock snapshot (review r5):
          // the two differ exactly when another lifecycle step won the lock
          // race, which is when restoring the stale one does the damage.
          status: 'active',
          providerId: revState.providerId,
          model: revState.model,
          dimensions: revState.dimensions,
          columnType: revState.columnType,
          indexed: revState.indexed,
          startedAt: revState.startedAt,
          revertedAt: new Date().toISOString(),
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
  // Symmetric with the swap: the edges were rebuilt against the new model's
  // averages there, so leaving them now would strand new-model scores over
  // old-model vectors.
  startSimilarityEdgeRefresh('rollback');
  logger.info('Shadow migration reverted — old model is live again; state back to active');
  // #1114 review r3 — the model that is live AGAIN, resolved rather than read
  // off `revState.prev.model`. The restore a few lines up deliberately writes
  // that column back verbatim, NULL included ("a first-class partial pin"), so
  // on a provider-pinned/model-inherited assignment the raw value names the
  // incoming model `null` — the one field the line carries. Resolved after
  // the transaction and after `bumpProviderCacheVersion()`, so it reads the
  // assignment this rollback just restored; `resolveUsecase` re-queries the
  // row on every call and caches only the provider config.
  const restoredResolved = await resolveConfidenceBasisPair('similarity');
  // #1114 — a revert moves the cosine scale back, which is still a move: an
  // operator who re-tuned the threshold after the swap is now on the OLD
  // model's scale with the NEW model's number. Symmetric with the swap, and
  // deliberately only on this branch — an abort never rewrote the live
  // assignment, so there is nothing to report.
  await warnThresholdOutlivedItsModel({
    basis: 'similarity',
    previousModel: revertedFrom,
    newModel: restoredResolved.resolved ? (restoredResolved.pair?.model ?? null) : revertedTo,
  });
  return 'reverted';
}

export async function cleanupShadowMigration(opts?: {
  lockTimeoutMs?: number;
  maxAttempts?: number;
}): Promise<void> {
  // The detached edge rebuild reads `pages` and `page_embeddings` for as long
  // as a whole-corpus recompute takes, while both of these open with LOCK
  // TABLE … ACCESS EXCLUSIVE on a ~27s total budget — so a rollback clicked
  // right after a swap would exhaust its retries against our OWN background
  // work and report a lock failure. Wait it out instead of racing it; it
  // never rejects (review r8).
  await waitForEdgeRefresh();
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
