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
 *     the worker writes nothing under it (`identity_drift`).
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
import { imageAnalysisStorePresent, validityParamValues, validitySql } from './image-analysis-validity.js';
import { assertNoShadowMigration, REEMBED_ALL_LOCK_USER } from './embedding-service.js';

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

/** `NOW() + LEAST(15 min × 2^attempts, 24 h)` — one definition for every backoff write. */
const BACKOFF_SQL = `NOW() + LEAST(interval '15 minutes' * power(2, attempts), interval '24 hours')`;

// ─── Result shape ────────────────────────────────────────────────────────────

export type ImageAnalysisBatchReason =
  | 'unassigned'
  | 'capability'
  | 'identity_drift'
  | 'provider_status'
  | 'uniform_rejection'
  | 'lease_lost';

export interface ImageAnalysisBatchResult {
  /** Rows analyzed (committed) in this batch. */
  processed: number;
  /** Rows the sweep's inverse flipped back to `analyzed` without a call. */
  reused: number;
  /** Rows skipped: reconcile skips (policy, format, missing) plus rows whose bytes moved before their call. */
  skipped: number;
  /** Rows that failed in this batch (every class; `terminal` counts apart). */
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
  /** Another process holds the worker lock; this call did nothing. */
  alreadyRunning?: boolean;
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
let storeAbsentLogged = false;

/**
 * Protected entrypoint shared by BullMQ, the post-sync kick, the legacy
 * interval worker and (#1618) Run Now. One bounded batch.
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
    if (!(await imageAnalysisStorePresent())) {
      // Migration 115 (#1615) has not landed: nothing to sweep, reconcile or
      // analyze. The flags keep accumulating and the first batch after 115
      // drains them (pause, not purge).
      if (!storeAbsentLogged) {
        storeAbsentLogged = true;
        logger.info('page_image_analyses is absent (migration 115) — the image analysis worker is idle');
      }
      return { ...result, reason: 'unassigned' };
    }

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
      logger.warn({ ...result }, 'Image analysis worker lock lost — batch stopped with partial counts');
      result.reason = 'lease_lost';
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
  const [retained, maxOutputTokens] = await Promise.all([deps.getRetainedIdentity(), deps.getMaxOutputTokens()]);

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
  result.skipped += sumSkips(reconciled);

  // ── Step 3: analyze, gated ──────────────────────────────────────────────
  const resolved = await deps.resolveIdentity();
  if (!resolved) {
    result.reason = 'unassigned';
    return;
  }
  if ((await deps.getVisionCapability(resolved.providerId, resolved.model)) !== true) {
    result.reason = 'capability';
    return;
  }
  if (!retained || retained.identityHash !== resolved.identityHash) {
    result.reason = 'identity_drift';
    return;
  }

  const batchSize = await deps.getBatchSize();
  await analyzeWorkRows(result, deps, assertLockHeld, retained, maxOutputTokens, batchSize);
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
  // The inverse. The predicate's `identity_hash = $1` cannot match with no
  // identity retained, so a never-assigned instance reuses nothing.
  const reused = await query<{ n: number }>(
    `WITH w AS (
       UPDATE page_image_analyses a SET status = 'analyzed', updated_at = NOW()
        WHERE a.status = 'pending' AND a.payload IS NOT NULL
          AND a.identity_hash = $1 AND a.prompt_version = $2 AND a.schema_version = $3
        RETURNING a.page_id
     ), b AS (
       UPDATE pages SET image_analysis_revision = image_analysis_revision + 1, embedding_dirty = TRUE
        WHERE id IN (SELECT DISTINCT page_id FROM w)
     )
     SELECT COUNT(*)::int AS n FROM w`,
    validity,
  );

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

  return {
    repended: repended.rows[0]?.n ?? 0,
    reused: reused.rows[0]?.n ?? 0,
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
    `SELECT a.id, a.page_id, a.source, a.attachment_key, a.content_hash, a.attempts,
            p.confluence_id, p.source AS page_source
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
  const rejections: Array<{ rowId: number; status: number }> = [];

  for (const row of work.rows) {
    await assertLockHeld();

    const intake = await intakePageImage(
      { id: row.page_id, confluence_id: row.confluence_id, source: row.page_source },
      { source: row.source, key: row.attachment_key },
    );
    if (intake.kind !== 'ok' || intake.sha256 !== row.content_hash) {
      // The bytes moved (or went) under the row since the reconcile: not the
      // image the row describes, so no call is spent and the page is
      // re-queued for the reconcile to settle. Not charged an attempt.
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
      });
    } catch (err) {
      // A client that throws is a transport-class fact about the endpoint,
      // never a verdict about the image.
      logger.error({ err, rowId: row.id, pageId: row.page_id }, 'Image analysis call threw — row failed (unavailable)');
      outcome = { ok: false, class: 'unavailable', providerLevel: false, message: 'client threw' };
    }
    calls++;

    await assertLockHeld();
    if (outcome.ok) {
      const committed = await query<{ n: number }>(
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
    const failed = await query<{ status: string }>(
      `UPDATE page_image_analyses a
          SET attempts = a.attempts + 1,
              status = CASE WHEN $6::boolean AND a.attempts + 1 >= $7 THEN 'failed_terminal' ELSE 'failed' END,
              next_attempt_at = CASE WHEN $6::boolean AND a.attempts + 1 >= $7 THEN NULL ELSE ${BACKOFF_SQL} END,
              error = $8, payload = NULL, updated_at = NOW(),
              provider_id = $9, model = $10, base_url = $11,
              identity_hash = $3, prompt_version = $4, schema_version = $5
        WHERE a.id = $1 AND a.content_hash = $2
          AND NOT (${validitySql('a', 3, 4, 5)})
        RETURNING a.status`,
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
      rejections.push({ rowId: row.id, status: outcome.httpStatus });
      const uniform =
        calls === IMAGE_ANALYSIS_UNIFORM_REJECT_LIMIT &&
        rejections.length === IMAGE_ANALYSIS_UNIFORM_REJECT_LIMIT &&
        rejections.every((r) => r.status === rejections[0]!.status);
      if (uniform) {
        const status = rejections[0]!.status;
        await assertLockHeld();
        // One unconditional write per row, `attempts` unchanged, never
        // terminal: the stop's rewrite takes precedence over the cap.
        await query(
          `UPDATE page_image_analyses a
              SET status = 'failed', error = $2, next_attempt_at = ${BACKOFF_SQL}, updated_at = NOW()
            WHERE a.id = ANY($1::bigint[])`,
          [rejections.map((r) => r.rowId), `unavailable:${status}`],
        );
        // These three were the batch's only calls, so every row the cap took
        // to `failed_terminal` in it has just been rewritten `failed`.
        result.terminal = 0;
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
 * zeroes every cadence.
 */
async function recordLastRun(result: ImageAnalysisBatchResult): Promise<void> {
  const didSomething =
    result.processed + result.reused + result.skipped + result.failed + result.repended +
      result.returned + result.reopened + result.reconciledPages + result.removed > 0;
  const stopped = result.reason === 'provider_status' || result.reason === 'uniform_rejection' || result.reason === 'lease_lost';
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
          SET status = 'pending', payload = NULL, attempts = 0, next_attempt_at = NULL, error = NULL, updated_at = NOW()
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

/** Test seam: forget the once-per-process notice. */
export function _resetImageAnalysisWorkerNoticeForTests(): void {
  storeAbsentLogged = false;
}
