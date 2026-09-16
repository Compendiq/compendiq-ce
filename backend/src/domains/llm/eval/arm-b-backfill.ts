/**
 * #1619 — arm B's backfill, DRIVEN by the measured run instead of waited on.
 *
 * ADR-027's arm B is "the candidate revision with `image_analysis` assigned
 * and the corpus analysed", and the backfill that produces that state is the
 * PRODUCT's own worker (#1616). Nothing here re-implements it: this module
 * calls `runImageAnalysisBatch()` — the one protected entrypoint BullMQ's
 * repeat, the legacy interval worker and #1618's Run Now all call — and then
 * the product's own `processDirtyPages`, until the database is in arm B's
 * state.
 *
 * It exists because `--arm B` could not reach that state unattended (#1619):
 *
 * 1. The analyses need a trigger. The queue is `pages.image_analysis_dirty`
 *    (D6.2) and the seeder now raises it, but only three things ever drain it
 *    — BullMQ's `SYNC_INTERVAL_MIN` repeat (15 min a cadence, four cadences
 *    for 187 images at the seeded batch size), an admin route, or this. The
 *    eval process runs no queue and serves no routes, so a run that merely
 *    POLLED `page_image_analyses` sat until its `--backfill-timeout` expired
 *    with 0 valid rows unless a human drove a second process by hand — and
 *    that process had to be handed the run's own `mkdtemp` `ATTACHMENTS_DIR`
 *    (exported into THIS process's environment, `stageEvalAttachmentsDir`),
 *    or it enumerated a corpus whose bytes it could not read.
 * 2. Nothing re-embedded afterwards. A committed analysis bumps
 *    `image_analysis_revision` and raises `embedding_dirty`, and `embedPage`
 *    is the ONLY writer of derived `page_embeddings` rows — so without a
 *    second embedding pass the top-K carries no derived chunk and `runArmEval`
 *    refuses arm B at the 50 % evidence floor with exactly that diagnosis.
 *
 * Both steps are the product's, in the product's order (analyse, then embed),
 * inside the process that owns the attachments directory. The deadline is the
 * caller's `--backfill-timeout`; a state the driver cannot advance — a
 * terminal row, an unassigned or drifted identity, a failing embed pass — is
 * refused at once rather than spun on until that deadline.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { query } from '../../../core/db/postgres.js';
import { processDirtyPages } from '../services/embedding-service.js';
import { readImageAnalysisCorpusCounts } from '../services/image-analysis-readiness.js';
import { runImageAnalysisBatch } from '../services/image-analysis-worker.js';
import { assertSingleAnalysisVersionPair, type AnalysisVersionCount, type ArmBState } from './arms.js';

/** The poll/backoff pause between two driving passes that changed nothing. */
const IDLE_PAUSE_MS = 5_000;

export interface ArmBBackfillResult {
  /** D5's one (prompt, schema) pair over the valid rows — what the report records. */
  versions: { prompt: number; schema: number };
  /** Valid analyses under the assignment's retained identity. */
  analyses: number;
  /** `runImageAnalysisBatch()` calls it took. */
  batches: number;
  /** `processDirtyPages()` passes, and the pages they re-embedded. */
  embedPasses: number;
  pagesReEmbedded: number;
  /** Wall clock of the whole drive — the O11 cost figure for the backfill. */
  wallMs: number;
  /** The last counts read: reported beside the figures above, never gated. */
  failed: number;
  skipped: number;
}

/**
 * D5's validity count, identity-scoped: `analyzed` rows carrying the retained
 * identity hash of the assignment this run read, and how many distinct
 * (prompt, schema) pairs they carry.
 */
export async function countValidAnalyses(identityHash: string): Promise<AnalysisVersionCount> {
  const valid = await query<{ n: number; versions: number; prompt: number | null; schema: number | null }>(
    `SELECT COUNT(*)::int AS n,
            COUNT(DISTINCT (prompt_version, schema_version))::int AS versions,
            MIN(prompt_version)::int AS prompt,
            MIN(schema_version)::int AS schema
       FROM page_image_analyses WHERE status = 'analyzed' AND identity_hash = $1`,
    [identityHash],
  );
  const row = valid.rows[0];
  return {
    analyzed: row?.n ?? 0,
    versions: row?.versions ?? 0,
    prompt: row?.prompt ?? null,
    schema: row?.schema ?? null,
  };
}

export interface DriveArmBBackfillOptions {
  /** The eval user, for the embedding lock `processDirtyPages` takes. */
  userId: string;
  /** `--backfill-timeout`, in ms. `0` means "refuse unless already complete". */
  timeoutMs: number;
  onProgress?: (line: string) => void;
}

/**
 * Drive the product's analysis worker and embedding pass until the database
 * is in arm B's state: `expectedImages` valid analyses under one (prompt,
 * schema) pair, no page left dirty for the reconcile, and no page left
 * awaiting the re-embed that turns an analysis into a derived chunk.
 */
export async function driveArmBBackfill(
  state: ArmBState,
  expectedImages: number,
  opts: DriveArmBBackfillOptions,
): Promise<ArmBBackfillResult> {
  const started = Date.now();
  const deadline = started + opts.timeoutMs;
  const progress = opts.onProgress ?? (() => {});
  let batches = 0;
  let embedPasses = 0;
  let pagesReEmbedded = 0;

  for (;;) {
    const valid = await countValidAnalyses(state.identityHash);
    const counts = await readImageAnalysisCorpusCounts();
    const analysesComplete = valid.analyzed >= expectedImages && counts.rows.pending === 0 && counts.dirtyPages === 0;
    if (analysesComplete && counts.pagesAwaitingEmbed === 0) {
      return {
        versions: assertSingleAnalysisVersionPair(valid),
        analyses: valid.analyzed,
        batches,
        embedPasses,
        pagesReEmbedded,
        wallMs: Date.now() - started,
        failed: counts.rows.failed,
        skipped: counts.rows.skipped,
      };
    }

    // A terminal row is a DETERMINISTIC failure five attempts deep (D13) and
    // is re-opened only by raising `image_analysis_max_output_tokens` (D8/D13)
    // — so it can never become valid under this run's ceiling and the count
    // above can never reach `expectedImages`. Refuse with that diagnosis now
    // rather than after the whole timeout.
    if (counts.rows.terminal > 0) {
      throw new Error(
        `--arm B: ${counts.rows.terminal} of ${expectedImages} corpus images are failed_terminal — a deterministic ` +
          `failure (truncated / malformed / refused / empty) at ${state.imageAnalysisMaxOutputTokens} output tokens, ` +
          'which no further attempt re-opens (ADR-027 D13). Every corpus image is a raster inside both ceilings, so ' +
          'this is the ceiling or the model, not the corpus: pick the ceiling from a measured pre-check, write it to ' +
          'admin_settings.image_analysis_max_output_tokens, and re-seed.',
      );
    }
    if (counts.rows.skipped > 0) {
      throw new Error(
        `--arm B: ${counts.rows.skipped} corpus image(s) were SKIPPED by the intake ` +
          `(${JSON.stringify(counts.skipReasons)}) — every image in this corpus is a raster inside both ceilings ` +
          '(`corpus-de-images.test.ts` pins that), so a skip is a fault in the rig, not a fact about the corpus.',
      );
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `--arm B: ${valid.analyzed}/${expectedImages} corpus images carry a valid analysis (status analyzed under ` +
          `the assignment's identity ${state.identityHash.slice(0, 12)}…), ${counts.rows.pending} pending, ` +
          `${counts.rows.failed} failed (retried on a 15-minute backoff), ${counts.dirtyPages} pages still dirty, ` +
          `${counts.pagesAwaitingEmbed} awaiting the re-embed — after ${((Date.now() - started) / 1000).toFixed(0)}s ` +
          `of driving the product's worker in ${batches} batch(es). The database is not in arm B's state; raise ` +
          '--backfill-timeout <sec> (187 images at ~1 image/minute on one GPU is hours, not minutes) or fix the ' +
          'vision endpoint.',
      );
    }

    let advanced = false;
    if (!analysesComplete) {
      const batch = await runImageAnalysisBatch();
      batches++;
      if (batch.alreadyRunning === true) {
        // Another holder of `worker:lock:image-analysis` is draining the same
        // queue (a dev stack pointed at this database). Let it.
        progress(`batch ${batches}: the analysis lease is held elsewhere — waiting`);
      } else if (batch.reason !== undefined) {
        throw new Error(
          `--arm B: the product's analysis batch stopped with reason "${batch.reason}" before analysing anything. ` +
            'unassigned = image_analysis resolves to nothing on this database (O8); capability = the model has not ' +
            'probed vision-capable (llm_model_capabilities, migration 087 — probe it through the assignment route); ' +
            'identity_drift = the retained identity (D7) is not what the assignment resolves to now; lease_lost = ' +
            'another holder took `worker:lock:image-analysis` mid-batch.',
        );
      } else {
        advanced = batch.processed > 0 || batch.reused > 0 || batch.reconciledPages > 0;
        progress(
          `batch ${batches}: analysed ${batch.processed}, reused ${batch.reused}, failed ${batch.failed}, ` +
            `reconciled ${batch.reconciledPages} page(s) — ${valid.analyzed}/${expectedImages} valid before it`,
        );
      }
    }

    // The analyses that just landed raised `embedding_dirty`; `embedPage` is
    // the only writer of the derived chunks the top-K must carry, so the
    // re-embed runs in the same loop rather than once at the end — a page
    // whose analysis committed early is then already indexed when the poll
    // above next reads `pagesAwaitingEmbed`.
    const awaiting = await readImageAnalysisCorpusCounts();
    if (awaiting.pagesAwaitingEmbed > 0) {
      const embed = await processDirtyPages(opts.userId);
      embedPasses++;
      pagesReEmbedded += embed.processed;
      if (embed.alreadyProcessing === true) {
        progress(`embed pass ${embedPasses}: the embedding lock is held elsewhere — waiting`);
      } else if (embed.errors > 0) {
        throw new Error(
          `--arm B: the re-embed of the analysed pages reported ${embed.errors} error(s) after ${embed.processed} ` +
            'page(s). A page whose text embed failed carries no derived chunk, so the arm would be measured with ' +
            'part of its evidence missing — refused.',
        );
      } else {
        advanced = advanced || embed.processed > 0;
        progress(`embed pass ${embedPasses}: re-embedded ${embed.processed} page(s) of ${awaiting.pagesAwaitingEmbed} awaiting`);
      }
    }

    // Nothing moved: the remaining rows are `failed` and sitting out their
    // backoff, or another process holds a lease. Pause instead of spinning the
    // GPU-less loop, and let the deadline above end it.
    if (!advanced) await sleep(IDLE_PAUSE_MS);
  }
}
