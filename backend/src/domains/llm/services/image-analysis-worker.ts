/**
 * ADR-027 D13 — the image analysis worker: one queue, one lease, a three-step
 * batch of which only the last needs a model, and a bounded backoff with a
 * terminal state. The #1612 batch pattern (`quality-worker.ts`), verbatim:
 * local guard, `worker:lock:image-analysis` (lease 600 s, renewed every 60 s
 * from a timer armed for the run's lifetime, `assertLockHeld` before every
 * write, stop after loss), BullMQ concurrency 1, one bounded batch per
 * scheduled cycle and per Run Now.
 *
 * A batch is three steps, in order:
 *
 *  1. **Invalidation sweep, and its inverse** — assigned or not. Every
 *     `analyzed` row that fails D5's validity predicate becomes `pending` with
 *     its payload kept; every `pending` row whose kept payload PASSES it flips
 *     back to `analyzed` with no call (`reused`); every `failed` /
 *     `failed_terminal` row under an old identity or version, or `truncated`
 *     under a ceiling below the current setting, becomes `failed, attempts 0,
 *     due now`. Each affected page gets `image_analysis_revision + 1` and
 *     `embedding_dirty = TRUE` in the same statement (D6.3).
 *  2. **Reconcile** every dirty page (`image-analysis-reconcile.ts`).
 *  3. **Analyze** up to the batch size of work rows — gated on three terms
 *     read once per batch: the use case is assigned, the stored vision verdict
 *     for the pair is `true`, and the identity the assignment resolves to
 *     equals the RETAINED identity (D7). Every row written carries the
 *     retained identity, so a provider `base_url` edit cannot start a loop:
 *     the worker writes nothing under it (`identity_drift`). A work row whose
 *     bytes cannot be read at call time leaves the work window as `skipped`
 *     with the intake's reason (`missing` for an attachment that is gone —
 *     the reconcile's `missing` skip, written here because the reconcile
 *     keeps an existing row on purpose); no attempt is charged, no call is
 *     spent, and the page is not bumped. The lazy re-fetch and attachment
 *     writers raise the page flag when bytes arrive, and the reconcile
 *     re-pends a `skipped` row whose bytes read — the same road a policy skip
 *     takes back to work. Bytes that read but hash differently from the row
 *     re-raise the flag instead: the reconcile re-pends under the new hash.
 *
 * The result shape is the same on every path. A gate that is shut returns
 * `{ processed: 0, …, reason: 'unassigned' | 'capability' | 'identity_drift' }`
 * with the sweep's and reconcile's counts; a batch that stopped early carries
 * `reason: 'provider_status' | 'uniform_rejection'` plus `httpStatus`; a lost
 * lease carries `reason: 'lease_lost'` and fails the BullMQ job with the
 * partial counts (queue-service.ts); a batch that ran to its size carries no
 * `reason`.
 *
 * No DB transaction spans inference; every write is preceded by the lease
 * check; nothing here logs an image, a base64 string, a description or a
 * provider body (D14).
 */
import { query } from '../../../core/db/postgres.js';
import { randomUUID } from 'node:crypto';
import { emitAiDecision, newAiOperation } from '../../../core/enterprise/ai-policy-hooks.js';
import { isAiPolicy } from '../../../core/services/ai-policy-service.js';
import { logger } from '../../../core/utils/logger.js';
import { getWorkerBatchSize } from '../../../core/services/admin-settings-service.js';
import {
  acquireWorkerLock,
  refreshWorkerLock,
  releaseWorkerLock,
  isEmbeddingLocked,
} from '../../../core/services/redis-cache.js';
import { getVisionCapability, refreshVisionCapability } from './model-capabilities.js';
import {
  analyzeImage,
  encodeImageAnalysisError,
  getImageAnalysisMaxOutputTokens,
  getRetainedImageAnalysisIdentity,
  resolveImageAnalysisIdentity,
  type AnalyzeImageInput,
  type AnalyzeImageResult,
  type ImageAnalysisFailureClass,
  type ImageAnalysisIdentity,
  type ResolvedImageAnalysisIdentity,
} from './image-analysis-provider.js';
import {
  ImageAnalysisLeaseLostError,
  reconcileDirtyPages,
  type ReconcileCounts,
} from './image-analysis-reconcile.js';
import { intakePageImage, mimeTypeForImageFormat } from './image-intake.js';
import { validityParamValues, validitySql } from './image-analysis-validity.js';
import { assertNoShadowMigration, REEMBED_ALL_LOCK_USER } from './embedding-service.js';
import { admitPageForProvider, isPersistableBlockReason, publishCurrentAiPolicyBlock } from './ai-policy-admission.js';
import type { ConversationTurnAiProvenance, ImageAnalysisBatchReason } from '@compendiq/contracts';
import type { QueryResult, QueryResultRow } from 'pg';
import { admitArticleStage, ArticleStageRefusedError } from './article-stage-admission.js';
import { asRevision, decodeProviderMetadata, PROVIDER_METADATA_COLUMNS, type ProviderMetadataRow, emitUnresolvedDecision } from './ai-policy-admission.js';

/** A stale completion (including a failure) owns no publication rights. */
export async function publishImageAnalysisResult<T extends QueryResultRow>(
  provenance: ConversationTurnAiProvenance,
  sql: string,
  params: unknown[],
  assertLockHeld: () => Promise<void>,
): Promise<QueryResult<T>> {
  let result: QueryResult<T> = { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };
  try {
    await admitArticleStage(provenance, null, 'image_analysis', async (client) => {
      await assertLockHeld();
      result = await client.query<T>(sql, params);
    });
  } catch (err) {
    if (!(err instanceof ArticleStageRefusedError)) throw err;
  }
  return result;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** `worker:lock:image-analysis`. Distinct from `embedding:lock:*` and the legacy image lock. */
export const IMAGE_ANALYSIS_WORKER_LOCK = 'image-analysis';
const LOCK_TTL_SECONDS = 600;
const LOCK_REFRESH_MS = 60_000;

/** Deterministic failures at this many attempts go `failed_terminal` (D13). */
export const IMAGE_ANALYSIS_MAX_ATTEMPTS = 5;
/** First N calls of a batch all `rejected` with one status → the batch stops (D13). */
export const IMAGE_ANALYSIS_UNIFORM_REJECT_LIMIT = 3;
/** Per-image latency budget, covering queue wait — the legacy image worker's figure. */
const ANALYSIS_TIMEOUT_MS = 120_000;

/** `admin_settings` row carrying the last batch result, as JSON (the card's last-run line). */
export const IMAGE_ANALYSIS_LAST_RUN_KEY = 'image_analysis_last_run';

const DETERMINISTIC_CLASSES: ReadonlySet<ImageAnalysisFailureClass> = new Set([
  'malformed',
  'empty',
  'refused',
  'truncated',
  'rejected',
]);

/**
 * `NOW() + LEAST(15 min × 2^LEAST(attempts, 7), 24 h)` — one definition for
 * every backoff write.
 *
 * The EXPONENT is clamped, not just the result. `interval '15 minutes' *
 * power(2, attempts)` is evaluated before `LEAST` ever sees it, so it raises
 * `interval out of range` at `attempts >= 34` — and nothing caps `attempts`
 * for a class that never goes terminal (`unavailable`), which charges one
 * attempt per due batch for as long as the fault lasts. That overflow threw
 * out of the whole batch, so no last-run line was written and the poisoned
 * row headed the due-ordered work window on every later batch: the analyze
 * step was permanently dead (#1626 review r3). `2^7 × 15 min = 32 h` already
 * exceeds the ceiling, so the clamp changes no schedule a row can reach.
 */
const BACKOFF_SQL = `NOW() + LEAST(interval '15 minutes' * power(2, LEAST(attempts, 7)), interval '24 hours')`;

// ─── Result shape ────────────────────────────────────────────────────────────

/**
 * Why a batch stopped before analyzing. Defined in `@compendiq/contracts`
 * (#1618) because the operator card renders one label per member: a reason
 * added here without a label on that surface is a stop nothing explains.
 */
export type { ImageAnalysisBatchReason };

export interface ImageAnalysisBatchResult {
  /** Rows analyzed (committed) in this batch. */
  processed: number;
  /** Rows the sweep's inverse flipped back to `analyzed` without a call. */
  reused: number;
  /** Rows skipped: reconcile skips (policy, format, missing) plus rows whose bytes moved or were absent before their call. */
  skipped: number;
  /** Rows that failed in this batch (every class, including `unavailable:bytes`; `terminal` counts apart). */
  failed: number;
  /** Rows the attempt cap moved to `failed_terminal` in this batch. */
  terminal: number;
  reason?: ImageAnalysisBatchReason;
  /** The status behind `provider_status` / `uniform_rejection`. */
  httpStatus?: number;
  /** Sweep: `analyzed` rows that failed the predicate and were re-pended (payload kept). */
  repended: number;
  /** Sweep: stale `failed` / `failed_terminal` rows returned to `failed, attempts 0, due`. */
  returned: number;
  /** Sweep: `truncated:<ceiling>` rows re-opened by a raised ceiling. */
  reopened: number;
  /** Reconcile: pages claimed in this batch. */
  reconciledPages: number;
  /** Reconcile: rows deleted because their reference left the body. */
  removed: number;
  /**
   * Reconcile: pages whose pass did not complete — it threw, or some of the
   * page's referenced bytes were there but unreadable, so its desired set
   * was written only in part. Such a page is still dirty and is re-read next
   * cadence; the counter is what makes the condition visible on the card,
   * as the legacy image leg's own `pagesFailed` does.
   */
  pagesFailed: number;
  /**
   * Reconcile: individual references whose bytes were there but unreadable.
   * One page can hold many, so this is the finer count behind `pagesFailed`
   * and the one that tells an operator whether one image or twenty is stuck.
   */
  unreadableRefs: number;
  /** Another process holds the worker lock; this call did nothing. */
  alreadyRunning?: boolean;
  /**
   * Rows the article AI policy parked as `policy_blocked` in this batch
   * (SPEC-WORK-001): neither processed nor failed, no call spent. Present
   * only when non-zero.
   */
  policyBlocked?: number;
}

function emptyResult(): ImageAnalysisBatchResult {
  return {
    processed: 0,
    reused: 0,
    skipped: 0,
    failed: 0,
    terminal: 0,
    repended: 0,
    returned: 0,
    reopened: 0,
    reconciledPages: 0,
    removed: 0,
    pagesFailed: 0,
    unreadableRefs: 0,
  };
}

// ─── Dependencies (test seam) ────────────────────────────────────────────────

/**
 * The boundaries a suite replaces with a deterministic double: the identity
 * resolution and the client (#1615's modules, through the seam), the vision
 * verdict, and the two settings reads. Everything else — the table, the
 * pages, the lock — is real.
 */
export interface ImageAnalysisWorkerDeps {
  resolveIdentity: () => Promise<ResolvedImageAnalysisIdentity | null>;
  getRetainedIdentity: () => Promise<ImageAnalysisIdentity | null>;
  getVisionCapability: (providerId: string, model: string) => Promise<boolean | null>;
  refreshVisionCapability: (providerId: string, model: string) => Promise<unknown>;
  analyzeImage: (input: AnalyzeImageInput) => Promise<AnalyzeImageResult>;
  getMaxOutputTokens: () => Promise<number>;
  getBatchSize: () => Promise<number>;
}

const defaultDeps: ImageAnalysisWorkerDeps = {
  resolveIdentity: resolveImageAnalysisIdentity,
  getRetainedIdentity: getRetainedImageAnalysisIdentity,
  getVisionCapability,
  refreshVisionCapability,
  analyzeImage,
  getMaxOutputTokens: getImageAnalysisMaxOutputTokens,
  getBatchSize: () => getWorkerBatchSize('image_analysis_batch_size'),
};

export interface RunImageAnalysisBatchOptions {
  deps?: Partial<ImageAnalysisWorkerDeps>;
  /** Test seam: lease renewal cadence, defaulting to 60 s. */
  lockRefreshMs?: number;
}

// ─── The batch ───────────────────────────────────────────────────────────────

let running = false;

/**
 * Protected entrypoint shared by BullMQ's repeat, the legacy interval worker
 * and (#1618) Run Now. One bounded batch.
 */
export async function runImageAnalysisBatch(
  opts: RunImageAnalysisBatchOptions = {},
): Promise<ImageAnalysisBatchResult> {
  const result = emptyResult();
  if (running) return { ...result, alreadyRunning: true };
  // Claim the local guard before the first await, including Redis acquisition.
  running = true;
  const deps: ImageAnalysisWorkerDeps = { ...defaultDeps, ...opts.deps };
  let token: string | null = null;
  let guardTimer: NodeJS.Timeout | undefined;
  let guardInFlight: Promise<void> | undefined;
  let lockLost = false;
  try {
    token = await acquireWorkerLock(IMAGE_ANALYSIS_WORKER_LOCK, LOCK_TTL_SECONDS, { failClosed: true });
    if (!token) {
      logger.info('Image analysis batch already running elsewhere — skipping this trigger');
      return { ...result, alreadyRunning: true };
    }
    const lockToken = token;
    const renewLock = (): Promise<void> => {
      if (guardInFlight) return guardInFlight;
      if (lockLost) return Promise.resolve();
      guardInFlight = refreshWorkerLock(IMAGE_ANALYSIS_WORKER_LOCK, lockToken, LOCK_TTL_SECONDS)
        .then((holder) => {
          if (holder !== lockToken) lockLost = true;
        })
        .catch((err: unknown) => {
          lockLost = true;
          logger.error({ err }, 'Image analysis worker lock renewal failed');
        })
        .finally(() => {
          guardInFlight = undefined;
        });
      return guardInFlight;
    };
    const assertLockHeld = async (): Promise<void> => {
      await guardInFlight;
      if (lockLost) throw new ImageAnalysisLeaseLostError();
    };
    guardTimer = setInterval(() => {
      void renewLock();
    }, Math.max(1, opts.lockRefreshMs ?? LOCK_REFRESH_MS));
    guardTimer.unref();

    try {
      await assertLockHeld();
      await runBatchSteps(result, deps, assertLockHeld);
      await assertLockHeld();
    } catch (err) {
      if (!(err instanceof ImageAnalysisLeaseLostError)) throw err;
      // D6.4: the lease is gone, so the last-run line is not written either —
      // the new holder owns it. The partial counts reach the operator through
      // the failed BullMQ job (queue-service.ts) and this log line.
      logger.warn({ ...result }, 'Image analysis worker lock lost — batch stopped with partial counts');
      result.reason = 'lease_lost';
      return result;
    }
    await recordLastRun(result);
    return result;
  } finally {
    clearInterval(guardTimer);
    try {
      await guardInFlight;
      if (token) await releaseWorkerLock(IMAGE_ANALYSIS_WORKER_LOCK, token);
    } finally {
      running = false;
    }
  }
}

async function runBatchSteps(
  result: ImageAnalysisBatchResult,
  deps: ImageAnalysisWorkerDeps,
  assertLockHeld: () => Promise<void>,
): Promise<void> {
  // Read once per batch (D13): the retained identity every row will carry,
  // and the ceiling that sets `max_tokens` and re-opens `truncated` rows.
  let retained: ImageAnalysisIdentity | null;
  let maxOutputTokens: number;
  try {
    [retained, maxOutputTokens] = await Promise.all([deps.getRetainedIdentity(), deps.getMaxOutputTokens()]);
  } catch {
    // No usable destination has been resolved yet. Keep work pending and its
    // durable operation identity, but do not mistake unavailable settings for
    // permission to run the sweep or inference with cached configuration.
    await recordUnresolvedImageWork(deps, assertLockHeld, 'policy_unavailable');
    result.reason = 'unassigned';
    return;
  }

  // ── Step 1: invalidation sweep and its inverse ──────────────────────────
  const swept = await runInvalidationSweep(retained?.identityHash ?? null, maxOutputTokens, assertLockHeld);
  result.repended = swept.repended;
  result.reused = swept.reused;
  result.returned = swept.returned;
  result.reopened = swept.reopened;

  // ── Step 2: reconcile every dirty page ──────────────────────────────────
  const reconciled = await reconcileDirtyPages(assertLockHeld);
  result.reconciledPages = reconciled.pages;
  result.removed = reconciled.removed;
  result.pagesFailed = reconciled.pagesFailed;
  result.unreadableRefs = reconciled.unreadable;
  result.skipped += sumSkips(reconciled);

  // ── Step 3: analyze, gated ──────────────────────────────────────────────
  let resolved: ResolvedImageAnalysisIdentity | null;
  try { resolved = await deps.resolveIdentity(); } catch {
    await recordUnresolvedImageWork(deps, assertLockHeld, 'policy_unavailable');
    result.reason = 'unassigned';
    return;
  }
  if (!resolved) {
    await recordUnresolvedImageWork(deps, assertLockHeld, 'stage_disabled');
    result.reason = 'unassigned';
    return;
  }
  let capability: boolean | null;
  try {
    capability = await deps.getVisionCapability(resolved.providerId, resolved.model);
  } catch {
    await recordUnresolvedImageWork(deps, assertLockHeld, 'policy_unavailable', resolved);
    result.reason = 'capability';
    return;
  }
  if (capability !== true) {
    await recordUnresolvedImageWork(deps, assertLockHeld, 'capability', resolved);
    result.reason = 'capability';
    return;
  }
  if (!retained || retained.identityHash !== resolved.identityHash) {
    await recordUnresolvedImageWork(deps, assertLockHeld, 'identity_drift', resolved);
    result.reason = 'identity_drift';
    return;
  }

  const batchSize = await deps.getBatchSize();
  await analyzeWorkRows(result, deps, assertLockHeld, retained, maxOutputTokens, batchSize);
}

/** Claim failure is not admission: keep the selected job identity, but never
 * guess an ordinal after an ambiguous write. A successor (zero rows) is silent. */
async function claimImageAttempt(
  row: { id: number; page_id: number; row_version: string; ai_operation_id: string | null },
  destination?: { providerId: string; model: string },
) {
  const operation = newAiOperation('image_analysis', { kind: 'worker', id: IMAGE_ANALYSIS_WORKER_LOCK });
  if (row.ai_operation_id) operation.operationId = row.ai_operation_id;
  try {
    const claim = await query<{ ai_operation_id: string; ai_attempt: number; row_version: string }>(
      `UPDATE page_image_analyses a SET ai_operation_id = COALESCE(ai_operation_id, $2::uuid),
         ai_attempt = ai_attempt + 1
       WHERE a.id = $1 AND a.xmin::text = $3
       RETURNING ai_operation_id, ai_attempt, a.xmin::text AS row_version`,
      [row.id, operation.operationId, row.row_version],
    );
    const job = claim.rows[0];
    if (!job) return null;
    operation.operationId = job.ai_operation_id;
    return { operation, stage: `vision:${row.id}`, attempt: job.ai_attempt, rowVersion: job.row_version };
  } catch {
    await emitUnresolvedDecision(row.page_id, 'image_analysis',
      { operation, stage: `vision:${row.id}`, attempt: null }, 'policy_unavailable', destination);
    return null;
  }
}

async function recordUnresolvedImageWork(
  deps: ImageAnalysisWorkerDeps, assertLockHeld: () => Promise<void>,
  reason: 'stage_disabled' | 'policy_unavailable' | 'capability' | 'identity_drift',
  resolved?: ResolvedImageAnalysisIdentity,
): Promise<void> {
  const rows = await query<{ id: number; page_id: number; row_version: string; ai_operation_id: string | null }>(
    `SELECT a.id, a.page_id, a.ai_operation_id, a.xmin::text AS row_version FROM page_image_analyses a
       JOIN pages p ON p.id = a.page_id
      WHERE (a.status = 'pending' OR (a.status = 'failed' AND a.next_attempt_at <= NOW()))
        AND p.deleted_at IS NULL AND COALESCE(p.page_type, 'page') <> 'folder'
      ORDER BY a.id LIMIT $1`, [await deps.getBatchSize()],
  );
  for (const row of rows.rows) {
    await assertLockHeld();
    const context = await claimImageAttempt(row, resolved);
    if (!context) continue;
    const { operation } = context;
    if (!resolved && (reason === 'stage_disabled' || reason === 'policy_unavailable')) {
      await emitUnresolvedDecision(row.page_id, 'image_analysis', context, reason);
    } else {
      let article: { pageId: number; policy: 'all' | 'local_only' | 'none' | null; policyRevision: number | null; contentRevision: number | null } =
        { pageId: row.page_id, policy: null, policyRevision: null, contentRevision: null };
      let provider: import('@compendiq/contracts').AiDecisionEvent['provider'] = resolved
        ? { providerId: resolved.providerId, model: resolved.model, configRevision: null, declaredLocality: null, effectiveLocality: null } : null;
      try {
        const current = (await query('SELECT ai_policy,ai_policy_revision,content_revision FROM pages WHERE id=$1 AND deleted_at IS NULL', [row.page_id])).rows[0];
        article = { pageId: row.page_id, policy: isAiPolicy(current?.ai_policy) ? current.ai_policy : null,
          policyRevision: asRevision(current?.ai_policy_revision), contentRevision: asRevision(current?.content_revision) };
        if (resolved) {
          const saved = (await query<ProviderMetadataRow>(`SELECT ${PROVIDER_METADATA_COLUMNS} FROM llm_providers WHERE id::text=$1`, [resolved.providerId])).rows[0];
          const metadata = decodeProviderMetadata(saved);
          provider = { providerId: resolved.providerId, model: resolved.model, configRevision: asRevision(saved?.config_revision),
            declaredLocality: saved?.locality === 'local' || saved?.locality === 'external' ? saved.locality : null,
            effectiveLocality: metadata?.effectiveLocality ?? null };
        }
      } catch { /* Retain only metadata actually read; a pause never dispatches. */ }
      emitAiDecision({ ...operation, eventId: randomUUID(), occurredAt: new Date().toISOString(), type: 'decision',
        usecase: 'image_analysis', stage: context.stage, attempt: context.attempt,
        articles: [article], provider, decision: 'blocked', reason });
    }
  }
}

function sumSkips(counts: ReconcileCounts): number {
  return Object.values(counts.skipped).reduce((a, b) => a + b, 0);
}

// ─── Step 1 ──────────────────────────────────────────────────────────────────

interface SweepCounts {
  repended: number;
  reused: number;
  returned: number;
  reopened: number;
}

/**
 * Four idempotent `UPDATE … RETURNING page_id`s, each a no-op when nothing
 * changed. The first two change a page's valid derived set and bump it
 * (D6.3) in the same statement; the last two only move failed rows and bump
 * nothing.
 */
async function runInvalidationSweep(
  identityHash: string | null,
  maxOutputTokens: number,
  assertLockHeld: () => Promise<void>,
): Promise<SweepCounts> {
  const validity = validityParamValues({ identityHash });

  await assertLockHeld();
  const repended = await query<{ n: number }>(
    `WITH w AS (
       UPDATE page_image_analyses a SET status = 'pending', updated_at = NOW()
        WHERE a.status = 'analyzed' AND NOT (${validitySql('a', 1, 2, 3)})
        RETURNING a.page_id
     ), b AS (
       UPDATE pages SET image_analysis_revision = image_analysis_revision + 1, embedding_dirty = TRUE
        WHERE id IN (SELECT DISTINCT page_id FROM w)
     )
     SELECT COUNT(*)::int AS n FROM w`,
    validity,
  );

  await assertLockHeld();
  // Reuse is publication, not just an identity-cache hit. Re-admit every
  // candidate and publish under the same page/provider locks as fresh results.
  // Snapshot xmin also prevents a reconcile/successor from donating its payload
  // to this decision. No transaction spans inference (reuse makes no call).
  const candidates = await query<{
    id: number; page_id: number; provider_id: string; model: string;
    content_revision: string; row_version: string;
  }>(
    `SELECT a.id, a.page_id, a.provider_id, a.model,
            p.content_revision::text, a.xmin::text AS row_version
       FROM page_image_analyses a JOIN pages p ON p.id = a.page_id
      WHERE a.status = 'pending' AND a.payload IS NOT NULL
        AND a.identity_hash = $1 AND a.prompt_version = $2 AND a.schema_version = $3
        AND a.provider_id IS NOT NULL AND a.model IS NOT NULL
        AND p.deleted_at IS NULL AND COALESCE(p.page_type, 'page') <> 'folder'`,
    validity,
  );
  let reused = 0;
  for (const candidate of candidates.rows) {
    await assertLockHeld();
    const contentRevision = asRevision(candidate.content_revision);
    if (contentRevision === null) continue;
    const admission = await admitPageForProvider(candidate.page_id, 'image_analysis', candidate.provider_id, candidate.model,
      { operation: newAiOperation('image_reuse', { kind: 'worker', id: IMAGE_ANALYSIS_WORKER_LOCK }),
        stage: 'image_reuse', attempt: 1, preliminary: true });
    if (!admission.admitted) continue;
    const provenance: ConversationTurnAiProvenance = {
      version: 1, providerId: admission.providerId, configRevision: admission.configRevision,
      locality: admission.locality, pages: [{ pageId: candidate.page_id, policy: admission.policy,
        policyRevision: admission.policyRevision, contentRevision }],
    };
    const published = await publishImageAnalysisResult<{ n: number }>(provenance,
      `WITH w AS (
         UPDATE page_image_analyses a SET status = 'analyzed', updated_at = NOW()
          WHERE a.id = $1 AND a.xmin::text = $2 AND a.status = 'pending'
            AND a.payload IS NOT NULL AND a.identity_hash = $3
            AND a.prompt_version = $4 AND a.schema_version = $5
            AND EXISTS (SELECT 1 FROM llm_providers provider
                         WHERE provider.id = a.provider_id AND provider.base_url = a.base_url)
          RETURNING a.page_id
       ), b AS (
         UPDATE pages SET image_analysis_revision = image_analysis_revision + 1, embedding_dirty = TRUE
          WHERE id IN (SELECT page_id FROM w)
       ) SELECT COUNT(*)::int AS n FROM w`,
      [candidate.id, candidate.row_version, ...validity], assertLockHeld);
    reused += published.rows[0]?.n ?? 0;
  }

  await assertLockHeld();
  const returned = await query<{ n: number }>(
    `WITH w AS (
       UPDATE page_image_analyses a
          SET status = 'failed', attempts = 0, next_attempt_at = NOW(), updated_at = NOW()
        WHERE a.status IN ('failed', 'failed_terminal')
          AND (a.identity_hash IS DISTINCT FROM $1 OR a.prompt_version IS DISTINCT FROM $2
               OR a.schema_version IS DISTINCT FROM $3)
          AND NOT (a.status = 'failed' AND a.attempts = 0 AND a.next_attempt_at <= NOW())
        RETURNING a.page_id
     )
     SELECT COUNT(*)::int AS n FROM w`,
    validity,
  );

  await assertLockHeld();
  const reopened = await query<{ n: number }>(
    `WITH w AS (
       UPDATE page_image_analyses a
          SET status = 'failed', attempts = 0, next_attempt_at = NOW(), updated_at = NOW()
        WHERE a.status IN ('failed', 'failed_terminal')
          AND a.error ~ '^truncated:[0-9]+$'
          AND substring(a.error from '^truncated:([0-9]+)$')::bigint < $1
          AND NOT (a.status = 'failed' AND a.attempts = 0 AND a.next_attempt_at <= NOW())
        RETURNING a.page_id
     )
     SELECT COUNT(*)::int AS n FROM w`,
    [maxOutputTokens],
  );

  await assertLockHeld();
  // Article AI policy (SPEC-WORK-001): a `provider_not_local` block was a
  // fact about the provider, so it is re-checked every batch — the row goes
  // back to `pending` and the analyze step re-admits it. A `policy_none`
  // block is lifted only by the policy write.
  await query(
    `UPDATE page_image_analyses a
        SET status = 'pending', ai_policy_block_reason = NULL, updated_at = NOW()
       FROM pages p
      WHERE a.page_id = p.id AND a.status = 'policy_blocked'
        AND a.ai_policy_block_reason = 'provider_not_local' AND p.ai_policy <> 'none'`,
  );

  return {
    repended: repended.rows[0]?.n ?? 0,
    reused,
    returned: returned.rows[0]?.n ?? 0,
    reopened: reopened.rows[0]?.n ?? 0,
  };
}

// ─── Step 3 ──────────────────────────────────────────────────────────────────

interface WorkRow {
  id: number;
  page_id: number;
  source: 'confluence' | 'local';
  attachment_key: string;
  content_hash: string;
  attempts: number;
  confluence_id: string | null;
  page_source: 'confluence' | 'standalone';
  content_revision: string;
  row_version: string;
  ai_operation_id: string | null;
}

async function analyzeWorkRows(
  result: ImageAnalysisBatchResult,
  deps: ImageAnalysisWorkerDeps,
  assertLockHeld: () => Promise<void>,
  retained: ImageAnalysisIdentity,
  maxOutputTokens: number,
  batchSize: number,
): Promise<void> {
  // D13's work predicate: pending first, then oldest due.
  const work = await query<WorkRow>(
    `SELECT a.id, a.page_id, a.source, a.attachment_key, a.content_hash, a.attempts, a.ai_operation_id,
            p.confluence_id, p.source AS page_source, p.content_revision::text, a.xmin::text AS row_version
       FROM page_image_analyses a
       JOIN pages p ON p.id = a.page_id
      WHERE (a.status = 'pending' OR (a.status = 'failed' AND a.next_attempt_at <= NOW()))
        AND p.deleted_at IS NULL AND COALESCE(p.page_type, 'page') <> 'folder'
      ORDER BY (a.status = 'pending') DESC, a.next_attempt_at ASC NULLS FIRST, a.id ASC
      LIMIT $1`,
    [batchSize],
  );

  const validity = validityParamValues({ identityHash: retained.identityHash });
  const identityColumns = [retained.providerId, retained.model, retained.baseUrl];

  // Uniform-rejection tracking: the first N CALLS of the batch.
  let calls = 0;
  let succeeded = false;
  const rejections: Array<{ rowId: number; status: number; rowVersion: string; provenance: ConversationTurnAiProvenance; terminal: boolean }> = [];

  for (const row of work.rows) {
    await assertLockHeld();

    // Article AI policy (SPEC-WORK-001): admitted against the RETAINED
    // identity — the exact provider the call below names — before the bytes
    // are even read. A block parks the row with its reason, spends no attempt
    // and no call, and is neither a success nor a failure. The commit
    // predicate keeps a concurrent reconcile's rewrite intact.
    const context = await claimImageAttempt(row, retained);
    if (!context) { result.skipped++; continue; }
    row.row_version = context.rowVersion;
    const admission = await admitPageForProvider(row.page_id, 'image_analysis', retained.providerId, retained.model,
      { ...context, preliminary: true });
    if (!admission.admitted) {
      if (admission.reason !== 'not_found' && !isPersistableBlockReason(admission.reason)) {
        // Retryable (deployment, not article): the row keeps its state and
        // attempt budget for the next due batch; nothing is written or called.
        logger.warn({ rowId: row.id, pageId: row.page_id, reason: admission.reason }, 'Image analysis admission unavailable; row left for the next batch');
        result.skipped++;
        continue;
      }
      if (admission.reason !== 'not_found') {
        const published = await publishCurrentAiPolicyBlock({
          pageId: row.page_id, providerId: retained.providerId,
          contentRevision: row.content_revision, reason: admission.reason,
        }, async (client) => {
          await assertLockHeld();
          const updated = await client.query(
            `UPDATE page_image_analyses a
                SET status = 'policy_blocked', ai_policy_block_reason = $3, payload = NULL,
                    next_attempt_at = NULL, error = NULL, updated_at = NOW()
              WHERE a.id = $1 AND a.content_hash = $2
                AND (a.status = 'pending' OR (a.status = 'failed' AND a.next_attempt_at <= NOW()))`,
            [row.id, row.content_hash, admission.reason],
          );
          return (updated.rowCount ?? 0) > 0;
        });
        if (published) {
          result.policyBlocked = (result.policyBlocked ?? 0) + 1;
          logger.info({ rowId: row.id, pageId: row.page_id, reason: admission.reason }, 'Image analysis blocked by article AI policy');
        } else result.skipped++;
      }
      continue;
    }

    const contentRevision = asRevision(row.content_revision);
    if (contentRevision === null) { result.skipped++; continue; }
    const provenance: ConversationTurnAiProvenance = {
      version: 1, providerId: admission.providerId, configRevision: admission.configRevision,
      locality: admission.locality, pages: [{ pageId: row.page_id, policy: admission.policy,
        policyRevision: admission.policyRevision, contentRevision }],
    };
    const publish = <T extends QueryResultRow>(sql: string, params: unknown[]) =>
      publishImageAnalysisResult<T>(provenance,
        sql.replace('WHERE a.id = $1', `WHERE a.xmin::text = $${params.length + 1} AND a.id = $1`),
        [...params, row.row_version], assertLockHeld);

    const intake = await intakePageImage(
      { id: row.page_id, confluence_id: row.confluence_id, source: row.page_source },
      { source: row.source, key: row.attachment_key },
    );
    // Fresh check after the file I/O: the lease may have gone while reading.
    await assertLockHeld();
    if (intake.kind === 'unavailable') {
      // The file is there but could not be read right now (EACCES after a
      // restore, EIO, a network volume blinking): a fact about the disk, not
      // the image, so it is charged like any other `unavailable` — one
      // attempt, backoff, never terminal (D8) — and re-read when due. Not
      // `skipped (missing)`: that state is left for a confirmed absence,
      // because nothing short of a page writer revisits it. The row records
      // the identity it failed under, as every failed row does, or the next
      // sweep would return it "stale" and due at once, every batch.
      const failed = await publish<{ n: number }>(
        `WITH w AS (
           UPDATE page_image_analyses a
              SET status = 'failed', attempts = a.attempts + 1, next_attempt_at = ${BACKOFF_SQL},
                  error = 'unavailable:bytes', payload = NULL, updated_at = NOW(),
                  provider_id = $6, model = $7, base_url = $8,
                  identity_hash = $3, prompt_version = $4, schema_version = $5
            WHERE a.id = $1 AND a.content_hash = $2
              AND NOT (${validitySql('a', 3, 4, 5)})
            RETURNING a.id
         )
         SELECT COUNT(*)::int AS n FROM w`,
        [row.id, row.content_hash, ...validity, ...identityColumns],
      );
      if ((failed.rows[0]?.n ?? 0) > 0) result.failed++;
      else result.skipped++;
      logger.warn({ err: intake.error, rowId: row.id, pageId: row.page_id }, 'Image analysis: attachment could not be read — row failed (unavailable:bytes)');
      continue;
    }
    if (intake.kind === 'skipped') {
      // Absent now (attachment cleaned while its reference stayed in the
      // body, a cache evicted) or no longer a raster: the row leaves the work
      // window as `skipped` with the intake's reason, hash and format by the
      // reconcile's convention, attempt budget untouched and no call spent.
      // The commit predicate keeps a concurrent reconcile's rewrite intact.
      await publish(
        `UPDATE page_image_analyses a
            SET status = 'skipped', skip_reason = $3, content_hash = $4, format = '',
                width = NULL, height = NULL, payload = NULL, attempts = 0, next_attempt_at = NULL, error = NULL,
                updated_at = NOW()
          WHERE a.id = $1 AND a.content_hash = $2`,
        [row.id, row.content_hash, intake.reason, intake.sha256 ?? ''],
      );
      result.skipped++;
      continue;
    }
    if (intake.sha256 !== row.content_hash) {
      // The bytes moved under the row since the reconcile: not the image the
      // row describes, so no call is spent and the page is re-queued for the
      // reconcile to settle. Not charged an attempt.
      await query(`UPDATE pages SET image_analysis_dirty = TRUE WHERE id = $1`, [row.page_id]);
      result.skipped++;
      continue;
    }

    let outcome: AnalyzeImageResult;
    try {
      outcome = await deps.analyzeImage({
        bytes: intake.bytes,
        mimeType: mimeTypeForImageFormat(intake.format),
        identity: { providerId: retained.providerId, model: retained.model, baseUrl: retained.baseUrl },
        maxOutputTokens,
        timeoutMs: ANALYSIS_TIMEOUT_MS,
        articleStage: { provenance, userId: null, usecase: 'image_analysis', context },
      });
    } catch (err) {
      if (err instanceof ArticleStageRefusedError) {
        result.skipped++;
        continue;
      }
      // A client that throws is a transport-class fact about the endpoint,
      // never a verdict about the image.
      logger.error({ err, rowId: row.id, pageId: row.page_id }, 'Image analysis call threw — row failed (unavailable)');
      outcome = { ok: false, class: 'unavailable', providerLevel: false, message: 'client threw' };
    }
    calls++;

    await assertLockHeld();
    if (outcome.ok) {
      const committed = await publish<{ n: number }>(
        `WITH w AS (
           UPDATE page_image_analyses a
              SET status = 'analyzed', payload = $6::jsonb, analysis_version = a.analysis_version + 1,
                  attempts = 0, next_attempt_at = NULL, error = NULL, analyzed_at = NOW(), updated_at = NOW(),
                  provider_id = $7, model = $8, base_url = $9,
                  identity_hash = $3, prompt_version = $4, schema_version = $5
            WHERE a.id = $1 AND a.content_hash = $2
              AND NOT (${validitySql('a', 3, 4, 5)})
            RETURNING a.page_id
         ), b AS (
           UPDATE pages SET image_analysis_revision = image_analysis_revision + 1, embedding_dirty = TRUE
            WHERE id IN (SELECT page_id FROM w)
         )
         SELECT COUNT(*)::int AS n FROM w`,
        [row.id, row.content_hash, ...validity, JSON.stringify(outcome.payload), ...identityColumns],
      );
      if ((committed.rows[0]?.n ?? 0) > 0) {
        result.processed++;
        succeeded = true;
      } else {
        // D6.1: the reference moved under the worker (reconcile replaced the
        // hash, or the row was deleted). The result is discarded, never
        // published, and the row's new state stands.
        result.skipped++;
        logger.info({ rowId: row.id, pageId: row.page_id }, 'Image analysis result discarded — the reference moved');
      }
      continue;
    }

    const deterministic = DETERMINISTIC_CLASSES.has(outcome.class);
    const failed = await publish<{ status: string; row_version: string }>(
      `UPDATE page_image_analyses a
          SET attempts = a.attempts + 1,
              status = CASE WHEN $6::boolean AND a.attempts + 1 >= $7 THEN 'failed_terminal' ELSE 'failed' END,
              next_attempt_at = CASE WHEN $6::boolean AND a.attempts + 1 >= $7 THEN NULL ELSE ${BACKOFF_SQL} END,
              error = $8, payload = NULL, updated_at = NOW(),
              provider_id = $9, model = $10, base_url = $11,
              identity_hash = $3, prompt_version = $4, schema_version = $5
        WHERE a.id = $1 AND a.content_hash = $2
          AND NOT (${validitySql('a', 3, 4, 5)})
        RETURNING a.status, a.xmin::text AS row_version`,
      [
        row.id,
        row.content_hash,
        ...validity,
        deterministic,
        IMAGE_ANALYSIS_MAX_ATTEMPTS,
        encodeImageAnalysisError(outcome),
        ...identityColumns,
      ],
    );
    const written = failed.rows[0]?.status;
    if (written === undefined) {
      result.skipped++;
      continue;
    }
    result.failed++;
    if (written === 'failed_terminal') result.terminal++;
    logger.warn(
      { rowId: row.id, pageId: row.page_id, class: outcome.class, httpStatus: outcome.httpStatus, status: written },
      'Image analysis failed for a row',
    );

    if (outcome.providerLevel) {
      // D8's default arm: a fact about the endpoint until an operator has
      // looked. Rows not yet attempted are not charged; the pair is re-probed
      // and a verdict other than `true` shuts the gate until a re-check.
      result.reason = 'provider_status';
      result.httpStatus = outcome.httpStatus;
      await reprobe(deps, retained);
      return;
    }

    if (outcome.class === 'rejected' && outcome.httpStatus !== undefined && !succeeded) {
      rejections.push({ rowId: row.id, status: outcome.httpStatus, rowVersion: failed.rows[0]!.row_version, provenance,
        terminal: written === 'failed_terminal' });
      const uniform =
        calls === IMAGE_ANALYSIS_UNIFORM_REJECT_LIMIT &&
        rejections.length === IMAGE_ANALYSIS_UNIFORM_REJECT_LIMIT &&
        rejections.every((r) => r.status === rejections[0]!.status);
      if (uniform) {
        const status = rejections[0]!.status;
        await assertLockHeld();
        // The stop may reverse this batch's terminal writes, but never a
        // successor's state. Count only reversals that actually committed.
        for (const rejection of rejections) {
          const rewritten = await publishImageAnalysisResult(rejection.provenance,
            `UPDATE page_image_analyses a
                SET status = 'failed', error = $2, next_attempt_at = ${BACKOFF_SQL}, updated_at = NOW()
              WHERE a.id = $1 AND a.xmin::text = $3`,
            [rejection.rowId, `unavailable:${status}`, rejection.rowVersion], assertLockHeld);
          if (rejection.terminal && (rewritten.rowCount ?? 0) > 0) result.terminal--;
        }
        result.reason = 'uniform_rejection';
        result.httpStatus = status;
        await reprobe(deps, retained);
        return;
      }
    }
  }
}

async function reprobe(deps: ImageAnalysisWorkerDeps, retained: ImageAnalysisIdentity): Promise<void> {
  try {
    await deps.refreshVisionCapability(retained.providerId, retained.model);
  } catch (err) {
    logger.warn({ err }, 'Vision capability re-probe after an analysis stop failed');
  }
}

// ─── Last run ────────────────────────────────────────────────────────────────

export interface ImageAnalysisLastRun extends ImageAnalysisBatchResult {
  /** ISO-8601 — when the batch finished. */
  at: string;
}

/**
 * Persist the batch result for the card, as one `admin_settings` row (the
 * `image_index_last_run` precedent). Written when the batch did anything or
 * stopped early — a gate-shut no-op on a settled corpus must not overwrite
 * the last real run's counters, or a "Stopped after 3 images" line, with
 * zeroes every cadence. Never reached after a lost lease (D6.4): the caller
 * returns before this write.
 */
async function recordLastRun(result: ImageAnalysisBatchResult): Promise<void> {
  const didSomething =
    result.processed + result.reused + result.skipped + result.failed + result.repended +
      result.returned + result.reopened + result.reconciledPages + result.removed +
      result.pagesFailed > 0;
  const stopped = result.reason === 'provider_status' || result.reason === 'uniform_rejection';
  if (!didSomething && !stopped) return;
  const run: ImageAnalysisLastRun = { ...result, at: new Date().toISOString() };
  try {
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW()`,
      [IMAGE_ANALYSIS_LAST_RUN_KEY, JSON.stringify(run)],
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to record the image analysis run summary');
  }
}

/** The last recorded batch, or null when none has been recorded or it is unreadable. */
export async function readImageAnalysisLastRun(): Promise<ImageAnalysisLastRun | null> {
  const r = await query<{ setting_value: string }>(
    `SELECT setting_value FROM admin_settings WHERE setting_key = $1`,
    [IMAGE_ANALYSIS_LAST_RUN_KEY],
  );
  const raw = r.rows[0]?.setting_value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ImageAnalysisLastRun>;
    if (typeof parsed.at !== 'string' || typeof parsed.processed !== 'number') return null;
    return { ...emptyResult(), ...parsed, at: parsed.at };
  } catch (err) {
    logger.warn({ err }, 'Ignoring an unreadable image_analysis_last_run row');
    return null;
  }
}

// ─── Operator actions (#1618 wires the routes) ───────────────────────────────

/**
 * **Retry failed** (D13): every `failed` and `failed_terminal` row becomes
 * `failed, attempts = 0, next_attempt_at = NOW()` — due at once, fresh
 * budget; the `error` class stays readable until the next attempt overwrites
 * it. Answers the number of rows made due.
 */
export async function retryFailedImageAnalyses(): Promise<number> {
  const r = await query(
    `UPDATE page_image_analyses
        SET status = 'failed', attempts = 0, next_attempt_at = NOW(), updated_at = NOW()
      WHERE status IN ('failed', 'failed_terminal')`,
  );
  return r.rowCount ?? 0;
}

/**
 * **Re-analyze all** (D13): re-pend every `analyzed`, `failed` and
 * `failed_terminal` row with `payload = NULL, attempts = 0,
 * next_attempt_at = NULL`, bumping the affected pages as the sweep does.
 * Nulling the payload is what makes it different from the sweep — nothing is
 * `reused` — which is the one documented action for an in-place server
 * upgrade behind an unchanged identity.
 *
 * Shares the one-active-run rule with text Re-embed all, the #1116 shadow
 * backfill and the production benchmark: refuses with a 409 while a shadow
 * migration is in any state or a re-embed-all holds its lock.
 */
export async function reanalyzeAllImages(): Promise<number> {
  await assertNoShadowMigration();
  if (await isEmbeddingLocked(REEMBED_ALL_LOCK_USER)) {
    const err = new Error(
      'A text re-embed of the whole corpus is running — wait for it to finish before re-analyzing every image (#1611).',
    ) as Error & { statusCode: number };
    err.statusCode = 409;
    throw err;
  }
  const r = await query<{ n: number }>(
    `WITH w AS (
       UPDATE page_image_analyses
          SET status = 'pending', payload = NULL, attempts = 0, next_attempt_at = NULL, error = NULL, updated_at = NOW(),
              ai_operation_id = NULL, ai_attempt = 0
        WHERE status IN ('analyzed', 'failed', 'failed_terminal')
        RETURNING page_id
     ), b AS (
       UPDATE pages SET image_analysis_revision = image_analysis_revision + 1, embedding_dirty = TRUE
        WHERE id IN (SELECT DISTINCT page_id FROM w)
     )
     SELECT COUNT(*)::int AS n FROM w`,
  );
  return r.rows[0]?.n ?? 0;
}

// ─── Legacy interval worker (USE_BULLMQ=false) ───────────────────────────────

let intervalHandle: NodeJS.Timeout | null = null;

export function startImageAnalysisWorker(intervalMinutes: number): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    runImageAnalysisBatch()
      .then((r) => {
        if (r.processed > 0 || r.failed > 0 || r.reason) logger.info(r, 'Image analysis batch completed');
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'Image analysis worker error');
      });
  }, intervalMinutes * 60 * 1000);
  intervalHandle.unref();
  logger.info({ intervalMinutes }, 'Background image analysis worker started');
}

export function stopImageAnalysisWorker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
