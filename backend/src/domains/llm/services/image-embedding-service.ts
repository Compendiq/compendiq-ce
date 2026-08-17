/**
 * #1115 P2 — what fills `page_image_embeddings`.
 *
 * One page at a time (`embedPageImages`), driven over the corpus by
 * `processDirtyPageImages`. It is the image-side counterpart of
 * `embedding-service.ts`, and it deliberately does NOT reuse it: the two share
 * neither an input (HTML `<img src>` vs chunked Markdown), a client (the VL
 * chat-embeddings shape vs `/v1/embeddings`), a table, nor a dirty flag.
 * Migration 093 gave the flags separate columns precisely so the image model
 * moving cannot enqueue a text re-embed.
 *
 * ── Six rules, each of which has a wrong-looking obvious alternative ──────
 *
 * 1. **Source follows the URL PREFIX** (`extractImageReferencesFromHtml`),
 *    never `pages.confluence_id IS NULL`. A relocated page has a NULL
 *    `confluence_id` and its bytes in the LOCAL store, and one page can carry
 *    both prefixes; deriving the store from the column reads a directory the
 *    bytes have never been in and answers `null`, which is indistinguishable
 *    from "no such attachment".
 *
 * 2. **Unassigned keeps the flag.** `resolveImageEmbeddingUsecase()` answering
 *    null means the leg is off (ADR-021's rule for the non-inheriting use
 *    cases). Clearing `image_embedding_dirty` then would quietly drain the
 *    queue of every page while nothing is indexing them, and the operator who
 *    assigns the leg tomorrow would find an index that never fills.
 *
 * 3. **Skip and COUNT; never resize** (ADR-025 D10). SVG and draw.io's
 *    XML-behind-a-`.png` sniff as no raster format, and the byte and dimension
 *    ceilings are `image-validator.ts`'s. The backend has no pixel decoder and
 *    adding one is a supply-chain decision of its own, so an image over a
 *    ceiling is reported, not shrunk — the Embeddings card is where an
 *    operator learns why the row count is lower than the picture count.
 *
 * 4. **sha256 is what makes a re-scan cheap.** An unchanged file keeps its row
 *    and costs no HTTP call at all. The row's `model` is compared too: a
 *    rebuild truncates, so a surviving row is always of the current identity,
 *    and the check is the belt to that braces.
 *
 * 5. **The identity is re-read INSIDE the write transaction**, exactly as
 *    `embedPage`'s Phase 2 re-reads the shadow epoch and for the same reason:
 *    the vectors were produced for one vector space, and a concurrent
 *    `ensureImageEmbeddingColumn` may have TRUNCATEd the table for another
 *    while they were in flight. Committing them anyway refills a freshly
 *    emptied index with values nothing can compare, under keys that look
 *    current.
 *
 * 6. **A VL failure leaves the page dirty.** Skips are terminal facts about
 *    the file; a failure is a fact about the endpoint, and the page has to be
 *    tried again. The two must never be conflated in the counters, because one
 *    is "working as designed" and the other is "your provider is down".
 */
import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import pgvector from 'pgvector/pg';
import { getPool, query } from '../../../core/db/postgres.js';
import { logger } from '../../../core/utils/logger.js';
import {
  extractImageReferencesFromHtml,
  isExternalImageKey,
  type PageImageReference,
} from '../../../core/services/image-references.js';
import { resolveAttachmentBytes } from '../../../core/services/attachment-store.js';
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  readImageDimensions,
} from '../../../core/services/image-validator.js';
import {
  getRagImageIndexExternal,
  getRagImagesPerPageMax,
} from '../../../core/services/admin-settings-service.js';
import { getImageEmbeddingTargetDimensions } from '../../../core/services/image-embedding-target-dimensions.js';
import {
  acquireWorkerLock,
  refreshWorkerLock,
  releaseWorkerLock,
} from '../../../core/services/redis-cache.js';
import { resolveImageEmbeddingUsecase } from './llm-provider-resolver.js';
import { embedImagesVl } from './vl-embedding-client.js';
import {
  imageIndexIdentityFromClient,
  readImageIndexDimensions,
  readImageIndexIdentity,
} from './image-embedding-index.js';
import {
  ImageEmbeddingDimensionMismatchError,
  toUserFacingEmbeddingError,
} from './embedding-error-message.js';
import { ImageIndexRunSchema } from '@compendiq/contracts';
import type { ImageIndexRun, ImageSkipCounts, PageSource } from '@compendiq/contracts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Per-image latency budget, covering queue wait — `rerank-client.ts`'s rule. */
const IMAGE_EMBED_TIMEOUT_MS = 120_000;

/** Delay between pages, mirroring `processDirtyPages`' server-pressure valve. */
const INTER_PAGE_DELAY_MS = 200;

/** Pages per LIMIT/OFFSET window. Half the text worker's, since a page here can cost N requests. */
export const DIRTY_IMAGE_PAGE_BATCH_SIZE = 50;

/** Consecutive page failures before pausing, and for how long. */
const CONSECUTIVE_FAILURE_PAUSE_THRESHOLD = 5;
const CONSECUTIVE_FAILURE_PAUSE_MS = 30_000;

/** The one worker lock for the image index. Distinct from `embedding:lock:*`. */
export const IMAGE_INDEX_WORKER_LOCK = 'image-embedding-index';
const IMAGE_INDEX_LOCK_TTL_SECONDS = 600;

/**
 * How often the holder-epoch guard runs — on a TIMER armed for the whole run,
 * not at page boundaries (review r3).
 *
 * The lock's TTL is a wall-clock expiry, so its renewal has to be paced by the
 * same clock *and* has to be reachable while the run is busy. A page-count
 * cadence cannot be either: a page may legitimately issue up to
 * `rag_images_per_page_max` (default 20) sequential VL requests at
 * `IMAGE_EMBED_TIMEOUT_MS` each, so ONE slow page can outlive a 600 s TTL
 * before a 20-page counter has ticked once — the key expires mid-run, the next
 * sync tick or `Process now` acquires the free lock, and two scans walk the
 * same backlog, which is the single thing the lock exists to prevent.
 *
 * Re-paced in *time* but still evaluated between pages, the hole is identical:
 * the one page that can outlive the TTL is precisely the one during which no
 * page boundary occurs. So the guard is a `setInterval` living for the
 * lifetime of the run, cleared in the same `finally` that releases the lock,
 * and the loop's own check reads the flag that timer sets. A third of the TTL
 * leaves two whole intervals of slack for a transient Redis blip.
 */
const LOCK_GUARD_INTERVAL_MS = (IMAGE_INDEX_LOCK_TTL_SECONDS * 1000) / 3;

/** `admin_settings` key holding the last run's counters, as JSON. */
export const IMAGE_INDEX_LAST_RUN_KEY = 'image_index_last_run';

export type ImageEmbedStatus =
  /** The page was fully processed; the flag is cleared. */
  | 'ok'
  /** No `image_embedding` assignment — nothing ran, the flag STAYS. */
  | 'unassigned'
  /** Not a page this index covers (folder, soft-deleted, or gone). */
  | 'skipped'
  /** At least one image's embed call failed; the flag STAYS. */
  | 'failed'
  /** The index identity changed mid-embed; nothing was written, the flag STAYS. */
  | 'stale';

export interface ImageEmbedOutcome {
  status: ImageEmbedStatus;
  embedded: number;
  reused: number;
  removed: number;
  failed: number;
  skipped: ImageSkipCounts;
  /**
   * A CATEGORY, never the provider's body (#1184's rule — this string reaches
   * an admin card). `toUserFacingEmbeddingError` owns the mapping.
   */
  error?: string;
}

function emptySkips(): ImageSkipCounts {
  return { missing: 0, unsupported: 0, oversized: 0, tooLarge: 0, capped: 0, external: 0 };
}

function emptyOutcome(status: ImageEmbedStatus): ImageEmbedOutcome {
  return { status, embedded: 0, reused: 0, removed: 0, failed: 0, skipped: emptySkips() };
}

interface PageRow {
  id: number;
  confluence_id: string | null;
  source: PageSource;
  body_html: string | null;
  deleted_at: Date | null;
  page_type: string | null;
}

interface ExistingRow {
  source: string;
  attachment_key: string;
  sha256: string;
  model: string;
}

/** One image embedded in this pass and awaiting its row. */
interface PreparedImage {
  ref: PageImageReference;
  sha256: string;
  format: string;
  width: number | null;
  height: number | null;
  /** Snapshotted per row, like `llm_audit_log.model` — see migration 093. */
  model: string;
  embedding: number[];
}

/**
 * Embed every image one page's stored body references, and reconcile the rows
 * that body no longer points at.
 *
 * Never throws for anything the corpus can contain: a bad key, a missing file,
 * a format nothing can read and a provider failure are all outcomes, because
 * one page must not abort a corpus-wide scan. A DATABASE failure still throws
 * — that is not a fact about the page.
 */
export async function embedPageImages(pageId: number): Promise<ImageEmbedOutcome> {
  const pageRes = await query<PageRow>(
    `SELECT id, confluence_id, source, body_html, deleted_at, page_type
       FROM pages WHERE id = $1`,
    [pageId],
  );
  const page = pageRes.rows[0];
  if (!page || page.deleted_at !== null || (page.page_type ?? 'page') === 'folder') {
    // The worker's own query excludes all three, so reaching here means a
    // direct call. Nothing is written and nothing is cleared: a folder has no
    // body to enumerate, and a soft-deleted page may yet be restored with its
    // flag — and therefore its place in the queue — intact.
    return emptyOutcome('skipped');
  }

  const resolved = await resolveImageEmbeddingUsecase();
  if (!resolved) return emptyOutcome('unassigned');

  const [perPageMax, indexExternal, targetDimensions, identityBefore, indexDimensions] =
    await Promise.all([
      getRagImagesPerPageMax(),
      getRagImageIndexExternal(),
      getImageEmbeddingTargetDimensions(),
      readImageIndexIdentity(),
      readImageIndexDimensions(),
    ]);

  const skipped = emptySkips();
  const allRefs = extractImageReferencesFromHtml(page.body_html);

  // Order matters: the external filter runs BEFORE the cap, so turning the
  // knob off frees budget for the page's own images rather than leaving holes
  // where the excluded ones were.
  const eligible = indexExternal
    ? allRefs
    : allRefs.filter((ref) => {
        if (!isExternalImageKey(ref.key)) return true;
        skipped.external++;
        return false;
      });
  const refs = eligible.slice(0, perPageMax);
  skipped.capped = eligible.length - refs.length;

  const existingRes = await query<ExistingRow>(
    `SELECT source, attachment_key, sha256, model FROM page_image_embeddings WHERE page_id = $1`,
    [pageId],
  );
  const existing = new Map(
    existingRes.rows.map((r) => [`${r.source}:${r.attachment_key}`, r] as const),
  );

  const prepared: PreparedImage[] = [];
  let reused = 0;
  let failed = 0;
  let error: string | undefined;

  for (const ref of refs) {
    const bytes = await resolveAttachmentBytes({
      pageId: page.id,
      confluenceId: page.confluence_id,
      pageSource: page.source,
      source: ref.source,
      key: ref.key,
    });
    if (!bytes) {
      skipped.missing++;
      continue;
    }
    if (bytes.sniffedFormat === null) {
      // SVG, draw.io XML behind a `.png`, a PDF, a truncated download. All the
      // same verdict: this is not something a vision encoder can read.
      skipped.unsupported++;
      continue;
    }
    if (bytes.bytes.length > MAX_IMAGE_BYTES) {
      skipped.tooLarge++;
      continue;
    }
    const dims = readImageDimensions(bytes.bytes, bytes.sniffedFormat);
    if (!dims || dims.width <= 0 || dims.height <= 0) {
      // A header we cannot read is not a header we can clear the ceiling with,
      // so it joins `unsupported` rather than being embedded on trust.
      skipped.unsupported++;
      continue;
    }
    if (dims.width > MAX_IMAGE_DIMENSION || dims.height > MAX_IMAGE_DIMENSION) {
      skipped.oversized++;
      continue;
    }

    const sha256 = createHash('sha256').update(bytes.bytes).digest('hex');
    const prior = existing.get(`${ref.source}:${ref.key}`);
    if (prior && prior.sha256 === sha256 && prior.model === resolved.model) {
      reused++;
      continue;
    }

    try {
      const [embedding] = await embedImagesVl(
        resolved.config,
        resolved.model,
        [{ bytes: bytes.bytes, format: bytes.sniffedFormat }],
        {
          ...(targetDimensions !== null ? { dimensions: targetDimensions } : {}),
          timeoutMs: IMAGE_EMBED_TIMEOUT_MS,
        },
      );
      if (!embedding) throw new Error('The image-embedding response carried no embedding');
      // Width check BEFORE the write (review r1). Without it a vector of the
      // wrong length reaches the INSERT and pgvector raises — which is a
      // DATABASE error, so it escapes this function, aborts the whole scan and
      // records no run at all. The reachable case is the guarded-DDL branch,
      // where the assignment saved and the `ALTER` did not: the identity
      // recheck below passes (both sides are the OLD identity) and every page
      // with an image would die on the same first insert, forever.
      if (indexDimensions !== null && embedding.length !== indexDimensions) {
        throw new ImageEmbeddingDimensionMismatchError(
          resolved.model,
          indexDimensions,
          embedding.length,
        );
      }
      prepared.push({
        ref,
        sha256,
        format: bytes.sniffedFormat,
        width: dims.width,
        height: dims.height,
        model: resolved.model,
        embedding,
      });
    } catch (err) {
      failed++;
      error ??= toUserFacingEmbeddingError(err);
      logger.error(
        { err, pageId, source: ref.source, key: ref.key },
        'Image embedding failed — the page stays image_embedding_dirty',
      );
      // Stop after the first failure. A page's images share one endpoint, so
      // the rest of them are about to fail the same way — and each attempt
      // spends a queue slot and a breaker strike on the way there.
      break;
    }
  }

  // Reconcile against what the body REFERENCES, not against what this pass
  // managed to embed. The two differ in three ways, and each is deliberate:
  //
  //  - a **skipped** image keeps its row. `resolveAttachmentBytes` answers the
  //    same `null` for "the file is gone" and for "the read failed", so
  //    deleting on a miss would let one bad disk moment empty a page's index
  //    entries — and a stale row is recoverable (the next sync re-downloads the
  //    file, or the answer path degrades on a load it cannot make) where a
  //    deleted one costs a full re-embed.
  //  - an image the VL call never reached (the loop broke on a failure) keeps
  //    its row, because the page is still dirty and will be re-walked.
  //  - a **capped** or **externally-excluded** image loses its row, because the
  //    knob is a statement about what the index should contain.
  const keep = new Set(refs.map((ref) => `${ref.source}:${ref.key}`));
  const written = await writeImageRows(pageId, prepared, keep, identityBefore, failed === 0);
  if (written === 'stale') return emptyOutcome('stale');

  const outcome: ImageEmbedOutcome = {
    status: failed > 0 ? 'failed' : 'ok',
    embedded: prepared.length,
    reused,
    removed: written.removed,
    failed,
    skipped,
    ...(error ? { error } : {}),
  };
  logger.info({ pageId, ...outcome }, 'Page images embedded');
  return outcome;
}

/**
 * The write half, in one transaction: upsert what was embedded, delete the
 * rows the body no longer references, and clear the flag when — and only when
 * — nothing failed.
 *
 * The identity recheck sits after the DELETE for the reason `embedPage`'s
 * epoch recheck sits after its own: the DELETE takes a ROW EXCLUSIVE lock that
 * conflicts with the rebuild's ACCESS EXCLUSIVE, so by the time it returns the
 * rebuild has either already committed (and this read sees its new identity)
 * or is queued behind this transaction and cannot land before the COMMIT.
 * Reading first would hold no conflicting lock and see nothing.
 */
async function writeImageRows(
  pageId: number,
  prepared: PreparedImage[],
  keep: Set<string>,
  identityBefore: string | null,
  clearDirty: boolean,
): Promise<{ removed: number } | 'stale'> {
  const client: PoolClient = await getPool().connect();
  try {
    await client.query('BEGIN');

    const keepSources = [...keep].map((k) => k.slice(0, k.indexOf(':')));
    const keepKeys = [...keep].map((k) => k.slice(k.indexOf(':') + 1));
    const removedRes = await client.query(
      `DELETE FROM page_image_embeddings
        WHERE page_id = $1
          AND (source, attachment_key) <> ALL (
                SELECT s, k FROM unnest($2::text[], $3::text[]) AS t(s, k)
              )`,
      [pageId, keepSources, keepKeys],
    );

    const identityNow = await imageIndexIdentityFromClient(client);
    if (identityNow !== identityBefore) {
      await client.query('ROLLBACK');
      logger.warn(
        { pageId, identityBefore, identityNow },
        'Image index identity changed mid-embed — nothing written, page left image_embedding_dirty',
      );
      return 'stale';
    }

    for (const item of prepared) {
      await client.query(
        `INSERT INTO page_image_embeddings
           (page_id, source, attachment_key, sha256, format, width, height, model, embedding, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         ON CONFLICT (page_id, source, attachment_key) DO UPDATE SET
           sha256 = EXCLUDED.sha256,
           format = EXCLUDED.format,
           width = EXCLUDED.width,
           height = EXCLUDED.height,
           model = EXCLUDED.model,
           embedding = EXCLUDED.embedding,
           created_at = NOW()`,
        [
          pageId,
          item.ref.source,
          item.ref.key,
          item.sha256,
          item.format,
          item.width,
          item.height,
          item.model,
          pgvector.toSql(item.embedding),
        ],
      );
    }

    if (clearDirty) {
      await client.query(`UPDATE pages SET image_embedding_dirty = FALSE WHERE id = $1`, [pageId]);
    }

    await client.query('COMMIT');
    return { removed: removedRes.rowCount ?? 0 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ── The worker ────────────────────────────────────────────────────────────

export interface ProcessDirtyPageImagesResult {
  /** Pages visited in this run. */
  pages: number;
  embedded: number;
  reused: number;
  removed: number;
  /** Images whose embed call failed. Their pages stay dirty. */
  failed: number;
  /**
   * Pages that THREW — a database error, not a fact about an image (review r1).
   *
   * Counted separately from `failed` because the two are different outages
   * with different remedies, and because a page that threw embedded nothing at
   * all: folding it into an image counter would report "1 image failed" for a
   * page whose eight successful embeds were rolled back.
   */
  pagesFailed: number;
  skipped: ImageSkipCounts;
  /** Another process holds the worker lock; this call did nothing. */
  alreadyRunning?: boolean;
  /** No `image_embedding` assignment; this call did nothing and cleared nothing. */
  unassigned?: boolean;
}

export interface ProcessDirtyPageImagesOptions {
  /** Ceiling on pages visited in this run. Unset walks the whole backlog. */
  maxPages?: number;
  /**
   * Test seam — pages per LIMIT/OFFSET window, defaulting to
   * {@link DIRTY_IMAGE_PAGE_BATCH_SIZE}.
   *
   * Exposed because the offset-advance rule is only observable once a window
   * FILLS: below the batch size the loop always exits on the short read and
   * the offset is never read a second time, so the property that stops an
   * all-pages-stayed-dirty run re-walking the same 50 rows forever cannot be
   * asserted without seeding 51 pages per case.
   */
  batchSize?: number;
  /**
   * Test seam — milliseconds between holder-epoch lock checks, defaulting to
   * {@link LOCK_GUARD_INTERVAL_MS}. It paces both halves of the guard: the
   * timer that renews *during* a page, and the check the page loop makes
   * before each page. `0` checks before every page.
   */
  lockGuardIntervalMs?: number;
}

/**
 * Logged once per process, not once per tick.
 *
 * The worker is kicked after every sync, so on the overwhelming majority of
 * deployments — where `image_embedding` is unassigned, which is its default
 * and ADR-021's "the leg is off" state — an unconditional line would be pure
 * noise at whatever `SYNC_INTERVAL_MIN` is set to.
 */
let loggedUnassigned = false;

/** Test seam: lets a suite assert the once-per-process log more than once. */
export function _resetImageWorkerNoticeForTests(): void {
  loggedUnassigned = false;
}

/**
 * Walk the `image_embedding_dirty` backlog, newest-modified first.
 *
 * Mirrors `processDirtyPages`' shape — batched LIMIT/OFFSET, an offset that
 * advances past pages which stayed dirty (or the same window is re-read
 * forever), a consecutive-failure pause and an inter-page delay — over a
 * DISTINCT lock. It deliberately does not borrow `embedding:lock:<userId>`:
 * that key's holders are listed by `listActiveEmbeddingLocks`, and
 * `processDirtyPages` backs off when it finds another one, so an image run
 * would have silently blocked every text embed on the instance.
 */
export async function processDirtyPageImages(
  opts: ProcessDirtyPageImagesOptions = {},
): Promise<ProcessDirtyPageImagesResult> {
  const totals: ProcessDirtyPageImagesResult = {
    pages: 0,
    embedded: 0,
    reused: 0,
    removed: 0,
    failed: 0,
    pagesFailed: 0,
    skipped: emptySkips(),
  };
  const batchSize = opts.batchSize ?? DIRTY_IMAGE_PAGE_BATCH_SIZE;
  const guardIntervalMs = opts.lockGuardIntervalMs ?? LOCK_GUARD_INTERVAL_MS;

  // Fast path BEFORE the lock: the common case is an instance that never
  // assigned the leg, and taking a Redis lock to discover that on every sync
  // is a round-trip for nothing.
  if (!(await resolveImageEmbeddingUsecase())) {
    if (!loggedUnassigned) {
      loggedUnassigned = true;
      logger.info(
        'Image embedding is unassigned — the image index worker is idle. Assign it under Settings → AI Models to fill the index.',
      );
    }
    return { ...totals, unassigned: true };
  }
  loggedUnassigned = false;

  const token = await acquireWorkerLock(IMAGE_INDEX_WORKER_LOCK, IMAGE_INDEX_LOCK_TTL_SECONDS);
  if (!token) {
    logger.info('Image index scan already running elsewhere — skipping this trigger');
    return { ...totals, alreadyRunning: true };
  }

  let consecutiveFailures = 0;
  let offset = 0;
  let aborted = false;

  // ── The holder-epoch guard ──────────────────────────────────────────────
  //
  // It renews the TTL and detects a force-release or an expiry-and-re-acquire,
  // and two scans walking the same backlog is the duplicated-work case the
  // lock exists for. It runs on a TIMER (review r3), because the failure it
  // prevents is a lock expiring while a slow page is in flight — and a page
  // slow enough to reach that is, by definition, one no page boundary occurs
  // during. The loop's own check below is what turns a lost lock into a clean
  // stand-down; the timer is what stops the lock being lost in the first place.
  let lockLost = false;
  let guardInFlight = false;
  let lastGuardAt = Date.now();
  const runGuard = async (): Promise<void> => {
    // One in flight at a time: the interval keeps firing while a slow Redis
    // reply is outstanding, and a queue of renewals is not a renewal.
    if (guardInFlight || lockLost) return;
    guardInFlight = true;
    lastGuardAt = Date.now();
    try {
      const holder = await refreshWorkerLock(
        IMAGE_INDEX_WORKER_LOCK,
        token,
        IMAGE_INDEX_LOCK_TTL_SECONDS,
      );
      if (holder !== token) {
        lockLost = true;
        logger.warn(
          { expected: token, actual: holder },
          'Image index worker lock was force-released or re-acquired — aborting the scan',
        );
      }
    } catch (err) {
      // A failed READ is not evidence the lock moved — `processDirtyPages`'
      // guard logs and continues rather than aborting, and so does this.
      logger.error({ err }, 'Image index holder-epoch guard failed — continuing');
    } finally {
      guardInFlight = false;
    }
  };
  // `0` is the test seam's "check before every page", which as an interval
  // period means "as often as the timer allows".
  const guardTimer = setInterval(() => void runGuard(), Math.max(1, guardIntervalMs));
  // Unref'd: the timer must never be the reason a process stays alive. It
  // still fires for as long as this run is awaiting anything, which is the
  // whole window it has to cover.
  guardTimer.unref();

  try {
    for (;;) {
      if (aborted) break;
      const batch = await query<{ id: number }>(
        `SELECT id FROM pages
          WHERE image_embedding_dirty = TRUE
            AND deleted_at IS NULL
            AND COALESCE(page_type, 'page') != 'folder'
          ORDER BY last_modified_at DESC NULLS LAST, id DESC
          LIMIT $1 OFFSET $2`,
        [batchSize, offset],
      );
      if (batch.rows.length === 0) break;

      let stillDirty = 0;
      for (const row of batch.rows) {
        if (opts.maxPages !== undefined && totals.pages >= opts.maxPages) {
          aborted = true;
          break;
        }
        // The page-boundary half: an awaited check when the timer has not run
        // inside the cadence, so a stolen lock is noticed deterministically
        // here rather than whenever a timer callback happens to land.
        if (Date.now() - lastGuardAt >= guardIntervalMs) await runGuard();
        if (lockLost) {
          aborted = true;
          break;
        }

        // Per-page try/catch, exactly as `processDirtyPages` wraps `embedPage`
        // (review r1). `embedPageImages` swallows everything the corpus can
        // contain, but a DATABASE error still escapes it by design — and a
        // width mismatch against the live column is PERMANENT, so a bare call
        // let one page abort the corpus scan on every future trigger and
        // record nothing at all on the card. A thrown page is counted, left
        // dirty, and stepped past.
        let outcome: ImageEmbedOutcome;
        try {
          outcome = await embedPageImages(row.id);
        } catch (err) {
          totals.pages++;
          totals.pagesFailed++;
          stillDirty++;
          consecutiveFailures++;
          logger.error(
            { err, pageId: row.id },
            'Image indexing threw for a page — it stays image_embedding_dirty; continuing',
          );
          if (consecutiveFailures >= CONSECUTIVE_FAILURE_PAUSE_THRESHOLD) {
            logger.warn(
              { consecutiveFailures },
              `${consecutiveFailures} consecutive image-embedding failures — pausing ${CONSECUTIVE_FAILURE_PAUSE_MS / 1000}s`,
            );
            await sleep(CONSECUTIVE_FAILURE_PAUSE_MS);
            consecutiveFailures = 0;
          }
          await sleep(INTER_PAGE_DELAY_MS);
          continue;
        }
        totals.pages++;
        totals.embedded += outcome.embedded;
        totals.reused += outcome.reused;
        totals.removed += outcome.removed;
        totals.failed += outcome.failed;
        for (const reason of Object.keys(totals.skipped) as Array<keyof ImageSkipCounts>) {
          totals.skipped[reason] += outcome.skipped[reason];
        }

        if (outcome.status === 'unassigned') {
          // The assignment was removed mid-scan. Every remaining page would
          // answer the same way, and each answer leaves its flag set.
          aborted = true;
          break;
        }
        if (outcome.status === 'ok') {
          consecutiveFailures = 0;
        } else {
          // 'failed', 'stale' and 'skipped' all leave the flag set, so the
          // window has to step past them or the same page is re-read forever.
          stillDirty++;
          if (outcome.status === 'failed') consecutiveFailures++;
        }

        if (consecutiveFailures >= CONSECUTIVE_FAILURE_PAUSE_THRESHOLD) {
          logger.warn(
            { consecutiveFailures },
            `${consecutiveFailures} consecutive image-embedding failures — pausing ${CONSECUTIVE_FAILURE_PAUSE_MS / 1000}s`,
          );
          await sleep(CONSECUTIVE_FAILURE_PAUSE_MS);
          consecutiveFailures = 0;
        }
        await sleep(INTER_PAGE_DELAY_MS);
      }

      offset += stillDirty;
      if (batch.rows.length < batchSize) break;
    }
  } finally {
    clearInterval(guardTimer);
    await releaseWorkerLock(IMAGE_INDEX_WORKER_LOCK, token);
  }

  if (totals.pages > 0) {
    await recordImageIndexRun(totals);
  }
  logger.info({ ...totals }, 'Image index scan complete');
  return totals;
}

/**
 * Persist what the run did, for the Embeddings-tab card.
 *
 * One `admin_settings` row rather than a table: it is a single latest-value
 * document with no history requirement, exactly like
 * `image_embedding_index_model` beside it, and a table would be a migration
 * plus a retention question for one row.
 *
 * Written only when the run VISITED a page. A no-op trigger — the sync kick on
 * a corpus with nothing dirty — must not overwrite the last real run's
 * counters with zeroes, which would read as "the last scan found nothing" on
 * the card that exists to explain the row count.
 */
async function recordImageIndexRun(totals: ProcessDirtyPageImagesResult): Promise<void> {
  const run: ImageIndexRun = {
    at: new Date().toISOString(),
    pages: totals.pages,
    embedded: totals.embedded,
    reused: totals.reused,
    removed: totals.removed,
    failed: totals.failed,
    pagesFailed: totals.pagesFailed,
    skipped: totals.skipped,
  };
  try {
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW()`,
      [IMAGE_INDEX_LAST_RUN_KEY, JSON.stringify(run)],
    );
  } catch (err) {
    // Bookkeeping, not the work. A scan that embedded a thousand images and
    // failed to write its own summary has still embedded a thousand images.
    logger.warn({ err }, 'Failed to record the image index run summary');
  }
}

/** The last recorded run, or null when none has been recorded or it is unreadable. */
export async function readImageIndexLastRun(): Promise<ImageIndexRun | null> {
  const r = await query<{ setting_value: string }>(
    `SELECT setting_value FROM admin_settings WHERE setting_key = $1`,
    [IMAGE_INDEX_LAST_RUN_KEY],
  );
  const raw = r.rows[0]?.setting_value;
  if (!raw) return null;
  try {
    // Parsed through the contract, so a row hand-edited in psql or left by an
    // older shape cannot reach the card as a half-populated object.
    return ImageIndexRunSchema.parse(JSON.parse(raw));
  } catch (err) {
    logger.warn({ err }, 'Ignoring an unreadable image_index_last_run row');
    return null;
  }
}

/**
 * Mark every live, non-folder page for a re-scan (the card's "Re-scan all").
 *
 * `embedding_dirty` is deliberately untouched — the whole reason migration 093
 * gave the two flags separate columns. Re-scanning images must never enqueue a
 * text re-embed of the corpus.
 */
export async function markAllPagesImageDirty(): Promise<number> {
  const r = await query(
    `UPDATE pages SET image_embedding_dirty = TRUE
      WHERE deleted_at IS NULL AND COALESCE(page_type, 'page') != 'folder'`,
  );
  return r.rowCount ?? 0;
}
