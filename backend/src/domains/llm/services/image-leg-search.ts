/**
 * #1115 P3 — the image leg: a third, IMAGE-BASED retrieval leg over
 * `page_image_embeddings`, fused into page ranking by rank (ADR-025 §5).
 *
 * It lives beside `rag-service.ts` rather than inside it for one reason:
 * `hybridSearch` is already the longest function in the codebase, and the leg
 * is a self-contained gate + one embed + one kNN. Everything about FUSION —
 * how the ranks combine, what a page reached only by an image gets as text —
 * stays in `rag-service.ts`, because that is where the other two legs' ranking
 * decisions live and splitting them would put half a ranking rule in each file.
 *
 * ── The gate ─────────────────────────────────────────────────────────────
 *
 * Four conditions, in this order, and when any of them fails the leg does no
 * RETRIEVAL work — no query embed, no kNN, no row:
 *
 *  1. `opts.imageLeg !== false`. `undefined` follows the admin setting;
 *     `true`/`false` FORCE it. The forcing form is what lets the P5b eval run
 *     leg-on and leg-off paired inside one process without writing to
 *     `admin_settings` — an eval that flipped a global setting would change
 *     what every other request on the instance retrieves for the duration of
 *     the run.
 *  2. `rag_image_leg_enabled` (default on), skipped when `imageLeg === true`.
 *  3. `resolveImageEmbeddingUsecase()` is non-null. ADR-021's rule for the
 *     non-inheriting use cases: unassigned means the leg is off, never that it
 *     borrows the text embedder — a text model's vectors and a VL model's are
 *     different spaces and the cosine between them is noise.
 *  4. `page_image_embeddings` is non-empty.
 *
 * A shut gate is not literally FREE, and the standing cost is worth naming
 * because every `/llm/ask`, every `/api/search?mode=hybrid` and deep search's
 * original leg pays it on EVERY deployment: one cached boolean for (2), then
 * (3)'s uncached two-table lookup — which on the majority deployment, no VL
 * model, answers `null` and stops there. So it is one indexed round-trip per
 * hybrid search, and (4) is not reached at all until a model IS assigned.
 *
 * (4) is a `SELECT EXISTS(...)` **per request, deliberately uncached**. The
 * table's emptiness is exactly the thing that flips at the two moments the
 * answer matters most: the first page the worker embeds, and a rebuild's
 * `TRUNCATE`. A 60-second cache would leave the leg dark for a minute after
 * the index starts filling, and — worse — leave it LIT for a minute after a
 * model change emptied the table, running a kNN against a column whose type
 * has just changed. It is an index-only existence probe on a primary key, and
 * it is reached only on a deployment that has already assigned a VL model —
 * the resolver above it answers `null` and returns first everywhere else.
 *
 * The ORDER is resolver-before-EXISTS rather than the other way round because
 * the two verdicts are not interchangeable: a resolver THROW is a degradation
 * this leg must record (see below), and an empty index short-circuiting in
 * front of it would report a broken assignment as "off". It costs one extra
 * round-trip in exactly one state — assigned, index empty — which is the
 * minutes between assigning a model and the worker's first write.
 *
 * ── Failure ──────────────────────────────────────────────────────────────
 *
 * Everything soft-fails to "leg bypassed", the temperament every neighbouring
 * stage has: an image leg is an ADDITION to retrieval, and no addition is
 * worth failing an answer over. The difference from the other stages is that
 * a bypass is RECORDED — `degraded_reason = 'image_leg_unavailable'` — because
 * unlike a rerank bypass it changes which PAGES come back, not merely their
 * order.
 *
 * **Both DB reads in the gate are failures, not verdicts, when they throw.**
 * The resolver's throw-vs-null distinction is the one this module was written
 * around, and the `EXISTS` above has exactly the same shape: an unanswerable
 * probe is not an empty index. Each therefore has its own catch, so a broken
 * gate is recorded as a degradation instead of reported as "off" — which is
 * what a single try around the retrieval work alone gave it.
 */
import pgvector from 'pgvector';
import { query, getVectorPool } from '../../../core/db/postgres.js';
import { logger } from '../../../core/utils/logger.js';
import { withSpan } from '../../../telemetry.js';
import { visiblePagesPredicate } from '../../../core/services/page-visibility.js';
import { getUserAccessibleSpacesMemoized as getUserAccessibleSpaces } from '../../../core/services/rbac-service.js';
import { getRagImageLegEnabled } from '../../../core/services/admin-settings-service.js';
import { getImageEmbeddingTargetDimensions } from '../../../core/services/image-embedding-target-dimensions.js';
import {
  buildPageImageUrl,
  type PageImageReference,
} from '../../../core/services/image-references.js';
import { resolveImageEmbeddingUsecase } from './llm-provider-resolver.js';
import { embedTextsVl, VL_QUERY_INSTRUCTION } from './vl-embedding-client.js';
import { efSearchFor } from './hnsw-ef-search.js';
import type { PageSource } from '@compendiq/contracts';

/**
 * Latency budget for the query embed, covering QUEUE WAIT plus the request
 * (`VlEmbedOptions.timeoutMs`'s contract — the signal starts at call time, so
 * a backlogged queue spends the budget waiting rather than admitting a request
 * that is already too late).
 *
 * **3s, not the 5s the rerank stage and the deep-search reformulation use**,
 * and the difference is where the stage sits. Those two run in SERIES in front
 * of the answer at a point where their input already exists, and their 5s buys
 * a cross-encoder pass over 30 documents or a chat completion. This one runs
 * in PARALLEL with the text legs, which typically settle in a few hundred
 * milliseconds — so every millisecond it spends past them is added to the
 * user's wait on EVERY question, including the overwhelming majority that were
 * never going to be answered by a picture. What it buys is one short text
 * through a chat template: on the reference stack that is well under a second,
 * and an endpoint that cannot manage it in three is one whose vectors were
 * going to arrive too late to be worth having.
 *
 * An abort counts as a breaker failure, which is the feedback loop that turns
 * a persistently dead VL endpoint off for its cool-down instead of paying 3s
 * on every question.
 */
export const IMAGE_LEG_TIMEOUT_MS = 3_000;

/**
 * Latency budget for the kNN, as a `SET LOCAL statement_timeout` inside the
 * transaction it already opens.
 *
 * The constant above bounds the query EMBED and nothing else, and the two
 * halves of this leg are not the same kind of risk. On an indexed column the
 * kNN is single-digit milliseconds; on the **unindexed tier** it is not a
 * fault but a shipped configuration — `ensureImageEmbeddingColumn` deliberately
 * builds no HNSW index above 4000 dimensions (there is no opclass), and the
 * gate here has no `indexed` condition, so the leg runs against a SEQUENTIAL
 * SCAN of `page_image_embeddings` that grows with the corpus. `hybridSearch`
 * awaits this between the text legs and fusion, so with no bound an optional
 * leg can stall every `/llm/ask`, every deep search and every
 * `/api/search?mode=hybrid` on the instance. The same is reachable with an
 * index, for a different reason: the statement takes ACCESS SHARE on a table a
 * concurrent rebuild holds ACCESS EXCLUSIVE on, and a lock wait counts as
 * statement time.
 *
 * **2s, and deliberately not the embed's 3.** There is no queue in front of
 * this one and no remote hop — it is a local index probe with three orders of
 * magnitude of headroom at 2s — while the leg has already been allowed to
 * spend 3s upstream, so the two compose to a ~5s worst case rather than
 * doubling the larger number. A timeout throws into the same catch every other
 * failure here lands in and becomes the ordinary `image_leg_unavailable`
 * bypass.
 *
 * The two GATE reads are still unbounded by this leg: they run through the
 * shared `query()` helper on the main pool, which carries whatever
 * `PG_STATEMENT_TIMEOUT` the deployment set. Only the statement this module
 * opens its own transaction for can carry its own budget.
 */
export const IMAGE_LEG_KNN_TIMEOUT_MS = 2_000;

/**
 * How many image hits one page carries onto its `SearchResult`.
 *
 * The wire cap (`MAX_IMAGE_SOURCES` in `llm-ask.ts`) is the one a user sees;
 * this is the per-page bound behind it, so a page with forty screenshots
 * cannot fill an answer's whole source list on its own. Three is the number of
 * pictures a person can take in beside a title without the source list
 * becoming a gallery.
 */
export const MAX_IMAGE_HITS_PER_PAGE = 3;

/**
 * Raw-row over-fetch for the page-denominated leg — `PAGE_FANOUT`'s argument
 * from `rag-service.ts`, applied to images.
 *
 * The kNN is over IMAGE rows and the leg is denominated in PAGES, so without
 * an over-fetch a page carrying several pictures consumes ranks its single
 * best image should have cost one of, and the leg reports fewer pages than the
 * caller asked for.
 *
 * **4 is PROVISIONAL, by analogy, and not the measured constant its neighbour
 * is** (review r3). `PAGE_FANOUT`'s 4 comes from the observed chunk-per-page
 * density near the top of the post-#1265 ranking, with the eval rig as the
 * arbiter of any retune; the image axis has no such measurement, because
 * #1115 P5b — the `--images` axis that would produce one — is not wired yet.
 * And the density it is guessing at is an ADMIN KNOB here, not a property of
 * the chunker: `rag_images_per_page_max` defaults to 20, so at the default
 * stage limit of 10 the raw window is 40 rows and two galleries can fill it
 * between them, leaving the leg reporting two pages where ten were asked for.
 * That shortfall is reachable at shipped defaults. It is bounded — a page
 * cannot take more of the window than it has images — and it degrades the leg
 * rather than the search, so it is left as a number for P5b's axis to retune
 * rather than mitigated here with an untested second mechanism. Do not read it
 * as measured.
 *
 * {@link IMAGE_RAW_LIMIT_CAP} is a separate argument and mitigates something
 * else entirely: it keeps `2 x rawLimit` inside pgvector's `ef_search` ceiling
 * of 1000 at every reachable stage limit, exactly as `VECTOR_RAW_LIMIT_CAP`
 * does. It says nothing about fan-out.
 */
export const IMAGE_PAGE_FANOUT = 4;
export const IMAGE_RAW_LIMIT_CAP = 500;

export function imageRawLimit(limit: number): number {
  return Math.max(Number(limit), Math.min(IMAGE_PAGE_FANOUT * Number(limit), IMAGE_RAW_LIMIT_CAP));
}

/**
 * One matched image on one page.
 *
 * It extends {@link PageImageReference} rather than restating its two fields
 * under new names: `{source, key}` is the shape `buildPageImageUrl` and
 * `resolveAttachmentBytes` both take, so a hit spreads straight into either.
 * `key` is `page_image_embeddings.attachment_key` — the on-disk filename.
 */
export interface ImageHit extends PageImageReference {
  /**
   * Cross-modal cosine in [-1, 1]. **Orders images WITHIN this leg and
   * nothing else.** It never reaches `retrieval-confidence.ts` and it is never
   * put on the wire (the `sources[]` entry carries `similarity: null`): the
   * published worked examples put text→image similarities around 0.46–0.72
   * against text↔text ones as high as 0.81 with no gap between the bands
   * (ADR-025 §8), so a threshold tuned on text cosines has no defined meaning
   * on this number and a display that shows both invites exactly that
   * comparison.
   */
  similarity: number;
  /**
   * The `<img src>` the authenticated attachment routes serve for these bytes,
   * built by `buildPageImageUrl` from the page row the kNN already joined.
   *
   * Built HERE rather than at the consumer because this is the only place that
   * holds all three inputs at once (`pages.source`, `pages.confluence_id`,
   * `pages.id`); `/llm/ask` has a `SearchResult`, which carries no
   * `pages.source`, and inferring it from `confluence_id` is the exact rule
   * `attachment-store.ts` documents as wrong.
   */
  attachmentUrl: string;
}

/** One page the image leg reached, with its best hits first. */
export interface ImageLegPage {
  pageId: number;
  /** Best-first, capped at {@link MAX_IMAGE_HITS_PER_PAGE}. */
  hits: ImageHit[];
  /**
   * Position of this page's BEST image in the distance-ordered RAW row stream,
   * before `groupByPage` collapsed it.
   *
   * It is not a rank — the page's rank is its position in the returned array —
   * and the leg itself never reads it. It exists so `fuseWithStableHead` can
   * reconstruct what a NARROWER request's image leg would have contained
   * (#1103/#1269): a narrow request reads only `imageRawLimit(rankWidth)` raw
   * rows, so on a page-crowded window (two pages carrying
   * `rag_images_per_page_max` pictures each fill the whole default 40-row
   * narrow window) a plain prefix of the wide result reports pages the narrow
   * request never reached, and those pages then dilute the stable head. The
   * vector leg redoes exactly this arithmetic with
   * `truncateAtDistinctPages(… slice(0, vectorRawLimit(rankWidth)) …)`; it can
   * do it on the rows themselves because its raw stream IS its result, and
   * this leg's is not, so the position has to be carried.
   */
  bestRawIndex: number;
}

export interface ImageLegOutcome {
  /** The gate opened AND the leg completed. */
  ran: boolean;
  /**
   * The gate opened and the leg did NOT complete — an embed failure, a
   * timeout, an open breaker, an assignment pulled mid-flight, a kNN error.
   * `deriveDegradedReason` turns this into `image_leg_unavailable`.
   *
   * Never true when the gate simply stayed shut: "off" is a configuration, not
   * a degradation, and recording it as one would light the analytics column on
   * every instance that has no VL model.
   */
  failed: boolean;
  /** Page-denominated and rank-ordered: best image first, one entry per page. */
  pages: ImageLegPage[];
}

const OFF: ImageLegOutcome = { ran: false, failed: false, pages: [] };

export interface ImageLegOptions {
  /** Distinct PAGES to return — the text legs' stage limit. */
  limit: number;
  /** #1351 — narrow to one Confluence space, exactly as the two text legs do. */
  spaceKey?: string;
  /** `undefined` follows the admin setting; `true`/`false` force. */
  imageLeg?: boolean;
}

interface ImageRow {
  pageId: number;
  source: PageImageReference['source'];
  key: string;
  similarity: number;
  attachmentUrl: string;
}

/**
 * Run the image leg for one query, or answer `OFF` when the gate is shut.
 *
 * Never throws: every failure is a bypass, and the caller reads `failed` to
 * record it. That is the same contract the rerank stage, the ranking prior,
 * MMR and sibling assembly all have.
 */
export async function searchImageLeg(
  userId: string,
  question: string,
  opts: ImageLegOptions,
): Promise<ImageLegOutcome> {
  if (opts.imageLeg === false) return OFF;
  const trimmed = question.trim();
  if (!trimmed) return OFF;

  return withSpan('rag.image_leg', async (span) => {
    // The cached boolean first, then two DB reads, and all three before
    // anything that costs an HTTP request. A forced `true` skips the knob
    // (that is what forcing means) but never the two conditions below, which
    // are facts about the deployment rather than preferences. The two DB reads
    // are NOT ordered by cost — see the header for why the resolver goes
    // first.
    if (opts.imageLeg !== true && !(await getRagImageLegEnabled())) {
      span?.setAttribute('rag.image_leg', 'disabled');
      return OFF;
    }

    let cfg: Awaited<ReturnType<typeof resolveImageEmbeddingUsecase>>;
    try {
      cfg = await resolveImageEmbeddingUsecase();
    } catch (err) {
      // A resolver failure is NOT "unassigned": the row may be there and
      // merely unreadable (an undecryptable api_key after a key rotation).
      // That is a degradation, and it is recorded as one.
      logger.warn({ err }, 'Image leg bypassed — the image_embedding assignment could not be resolved');
      span?.setAttribute('rag.image_leg', 'failed');
      return { ran: false, failed: true, pages: [] };
    }
    if (!cfg) {
      span?.setAttribute('rag.image_leg', 'unassigned');
      return OFF;
    }

    let hasRows: boolean;
    try {
      hasRows = await imageIndexHasRows();
    } catch (err) {
      // The resolver's argument one rung down, and the reason this probe is
      // not inside the try below: an EXISTS that could not be ANSWERED is not
      // evidence of an empty index. The statement needs ACCESS SHARE on
      // `page_image_embeddings`, which a concurrent rebuild holds ACCESS
      // EXCLUSIVE on, so a `lock_timeout` — or any pool-level error — reaches
      // here on a deployment whose leg is configured, assigned and full. Left
      // to propagate it also broke this function's "never throws" contract,
      // and the caller's `.catch` then recorded a live outage as "off".
      logger.warn({ err }, 'Image leg bypassed — the image index could not be probed (degraded_reason: image_leg_unavailable)');
      span?.setAttribute('rag.image_leg', 'failed');
      return { ran: false, failed: true, pages: [] };
    }
    if (!hasRows) {
      span?.setAttribute('rag.image_leg', 'empty_index');
      return OFF;
    }

    try {
      const dimensions = (await getImageEmbeddingTargetDimensions()) ?? undefined;
      // ONE call per request. The instruction is the client's own exported
      // constant, not a second copy: the query/corpus asymmetry IS the
      // retrieval design (`VL_QUERY_INSTRUCTION` on the query,
      // `VL_DEFAULT_INSTRUCTION` on the images P2 stored), and two spellings
      // of it would be two different query spaces over one index.
      const [vector] = await embedTextsVl(
        cfg.config, cfg.model, [trimmed], VL_QUERY_INSTRUCTION,
        { dimensions, timeoutMs: IMAGE_LEG_TIMEOUT_MS },
      );
      if (!vector || vector.length === 0) {
        throw new Error('the image-embedding endpoint returned no query vector');
      }
      const rows = await imageKnn(userId, vector, opts);
      const pages = groupByPage(rows, opts.limit);
      span?.setAttribute('rag.image_leg', 'ran');
      span?.setAttribute('rag.image_hits', rows.length);
      span?.setAttribute('rag.image_pages', pages.length);
      return { ran: true, failed: false, pages };
    } catch (err) {
      // ONE warn per failure, carrying the CATEGORY and never the provider's
      // body (#1184's rule): this line reaches ordinary application logs, and
      // the body can echo request fragments and internal topology.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), model: cfg.model, providerId: cfg.config.providerId },
        'Image leg bypassed — the image query embed or its kNN failed (degraded_reason: image_leg_unavailable)',
      );
      span?.setAttribute('rag.image_leg', 'failed');
      return { ran: false, failed: true, pages: [] };
    }
  }, { 'rag.limit': opts.limit });
}

/**
 * Is there anything to search? See the module header for why this is per
 * request and never cached.
 *
 * `EXISTS` rather than `COUNT`: the planner stops at the first row, so this is
 * an index probe whether the table holds nothing or two million rows.
 */
async function imageIndexHasRows(): Promise<boolean> {
  const r = await query<{ present: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM page_image_embeddings) AS present`,
  );
  return r.rows[0]?.present === true;
}

/**
 * kNN over the image index under **the same visibility predicate the vector
 * leg uses** — `visiblePagesPredicate`, the shared fragment, never a copy.
 *
 * That is the one line in this file that must not be got wrong: an image row
 * carries no ACL of its own, so without the join and the predicate a picture
 * on a restricted page would surface that page's title, its space and a
 * thumbnail URL to any user whose question happened to match the image. The
 * EE per-page ACL post-filter in `hybridSearch` runs over the fused set
 * afterwards, exactly as it does for the two text legs.
 *
 * **No explicit vector cast, on purpose.** The `<=>` operand type is resolved
 * from the COLUMN, so the parameter is coerced to whatever
 * `ensureImageEmbeddingColumn` typed it — `vector` under 2000 dims, `halfvec`
 * up to 4000 — and the query follows a tier change with no second place to
 * update. A hardcoded `::vector` would silently fail on a `halfvec` column,
 * and one read from `admin_settings` can disagree with the live column type.
 * This is exactly what `vectorSearch` does against the text column, which is
 * `halfvec` on every Qwen3 deployment.
 */
async function imageKnn(
  userId: string,
  vector: number[],
  opts: ImageLegOptions,
): Promise<ImageRow[]> {
  const spaces = await getUserAccessibleSpaces(userId);
  const rawLimit = imageRawLimit(opts.limit);
  // The dedicated vector pool, like `vectorSearch`: a similarity scan must not
  // starve the main pool the CRUD routes share.
  //
  // It is worth stating what that costs, because it is a cost this leg ADDS
  // and no default was raised for it: a hybrid search that reaches here holds
  // TWO of the pool's connections at once (`PG_VECTOR_POOL_MAX`, default 5),
  // since `rag-service` starts this leg specifically so its transaction
  // overlaps `vectorSearch`'s. Effective per-request headroom on that pool
  // therefore roughly halves when the leg is live, and the two sides are not
  // symmetric about losing the race — a `connectionTimeoutMillis` here is a
  // bypass, while the same failure in the vector leg is `embedding_failed`,
  // which `/llm/ask` refuses the turn on. Raise `PG_VECTOR_POOL_MAX` when
  // enabling the leg on a busy instance; the runbook's §6 cost section says so.
  const client = await getVectorPool().connect();
  try {
    await client.query('BEGIN');
    // ef_search must cover the RAW fetch — HNSW returns at most `ef_search`
    // rows, so a LIMIT above it silently plateaus. 2x for graph-walk headroom;
    // `efSearchFor` clamps to pgvector's [1, 1000].
    await client.query(`SET LOCAL hnsw.ef_search = ${await efSearchFor(rawLimit)}`);
    // …and the leg's own budget for the scan below (see the constant). The
    // vector leg has no equivalent because a bypass there is not equivalent:
    // it sets `embeddingFailed`, which `/llm/ask` refuses the turn on. This
    // leg is an ADDITION, so giving up on it costs an ordinary answer nothing
    // and stalling on it costs every answer on the instance.
    await client.query(`SET LOCAL statement_timeout = ${IMAGE_LEG_KNN_TIMEOUT_MS}`);
    const result = await client.query<{
      page_id: number;
      source: string;
      attachment_key: string;
      similarity: number;
      page_source: PageSource;
      confluence_id: string | null;
    }>(
      `SELECT pie.page_id, pie.source, pie.attachment_key,
              1 - (pie.embedding <=> $2) AS similarity,
              cp.source AS page_source, cp.confluence_id
         FROM page_image_embeddings pie
         JOIN pages cp ON cp.id = pie.page_id
        WHERE ${visiblePagesPredicate(1, 4)}
          AND cp.deleted_at IS NULL${opts.spaceKey ? ' AND cp.space_key = $5' : ''}
        ORDER BY pie.embedding <=> $2
        LIMIT $3`,
      opts.spaceKey
        ? [spaces, pgvector.toSql(vector), rawLimit, userId, opts.spaceKey]
        : [spaces, pgvector.toSql(vector), rawLimit, userId],
    );
    await client.query('COMMIT');
    return result.rows.map((row) => ({
      pageId: row.page_id,
      source: row.source === 'local' ? 'local' : 'confluence',
      key: row.attachment_key,
      similarity: Number(row.similarity),
      attachmentUrl: buildPageImageUrl({
        source: row.source === 'local' ? 'local' : 'confluence',
        key: row.attachment_key,
        pageId: row.page_id,
        pageSource: row.page_source,
        confluenceId: row.confluence_id,
      }),
    }));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Page-denominate the distance-ordered row stream: a page's BEST image decides
 * its rank, and it counts ONCE (#1106's rule, applied to the third leg).
 *
 * Without this a page carrying five near-identical screenshots would occupy
 * five of the leg's ranks and, under RRF, out-score a page whose single image
 * is a better match — image COUNT beating image QUALITY, the same head
 * dilution the vector leg's best-chunk-only rule exists to prevent.
 *
 * The rows arrive distance-ordered, so a page's first occurrence IS its best
 * image and its position IS its rank. Later hits on an already-seen page are
 * kept (up to {@link MAX_IMAGE_HITS_PER_PAGE}) because the answer's source
 * list wants them, but they add no rank and no score.
 */
export function groupByPage(rows: ImageRow[], limit: number): ImageLegPage[] {
  const byPage = new Map<number, ImageLegPage>();
  for (const [rawIndex, row] of rows.entries()) {
    const hit: ImageHit = {
      source: row.source,
      key: row.key,
      similarity: row.similarity,
      attachmentUrl: row.attachmentUrl,
    };
    const existing = byPage.get(row.pageId);
    if (existing) {
      if (existing.hits.length < MAX_IMAGE_HITS_PER_PAGE) existing.hits.push(hit);
      continue;
    }
    if (byPage.size >= Math.max(0, limit)) continue;
    byPage.set(row.pageId, { pageId: row.pageId, hits: [hit], bestRawIndex: rawIndex });
  }
  return [...byPage.values()];
}
