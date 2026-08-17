/**
 * #1115 P5b — the paired image runner: every fixture query, twice, in one
 * process, over one seeded database.
 *
 * `runner.ts` measures ONE pipeline against a fixture and the comparison is
 * made later, between two reports. That cannot work here. Leg-on and leg-off
 * are not two checkouts; they are one request flag (`HybridSearchOptions.
 * imageLeg`), and the only honest way to attribute a difference to the leg is
 * to run both arms against the same rows, the same vectors, the same fused
 * text legs and the same process — which is also the precondition McNemar's
 * paired test needs.
 *
 * ── Four decisions ────────────────────────────────────────────────────────
 *
 * 1. **INTERLEAVED per query, off then on** — never off-for-everything and
 *    then on-for-everything. The rig warms up: `admin-settings-service`'s TTL
 *    caches, `getUserAccessibleSpacesMemoized`, the vector pool's connections
 *    and Postgres's own buffer cache all fill during the first handful of
 *    queries. A block design hands that entire warm-up cost to whichever arm
 *    runs first and then publishes the difference as the leg's query cost.
 *    Interleaving spreads it across both arms, where it cancels.
 * 2. **`imageLeg` is FORCED on both arms**, never toggled through
 *    `admin_settings.rag_image_leg_enabled`. Writing the global setting per
 *    query would change what every other request on the instance retrieves for
 *    the duration of the run — which is the reason P3 put the request-level
 *    override there in the first place.
 * 3. **`recordAnalytics: false` on both arms.** Each question is asked twice
 *    and only one of the two is a question anybody asked; recording both would
 *    double every image-axis query in `search_analytics` and file a leg-off
 *    variant nobody typed beside it. `benchmark-query-latency.ts` already does
 *    this, for the same reason.
 * 4. **The off arm carrying image hits is a REFUSAL, not a curiosity.** Every
 *    failure mode of this leg — unassigned model, empty index, dead endpoint,
 *    a forcing flag that stopped forcing — produces two identical arms and a
 *    delta of exactly zero, which reads as "the leg does not help" rather than
 *    "the leg never ran". Both directions are guarded: participation on the on
 *    arm has a floor, and the off arm must be clean.
 */
import { hybridSearch, getEmbeddingCoverage } from '../services/rag-service.js';
import {
  multiQuerySearch,
  type ExpansionOutcome,
  type MultiQuerySearchOptions,
} from '../services/multi-query-search.js';
import { VectorLegSilentError } from './runner.js';
import { imageAttachmentKey } from './seed-images.js';
import type { ImageArmRun, ImageHitRecord, ImageQueryPair } from './images-metrics.js';
import type { ImageFixture } from './fixture.js';

/** The one class every refusal in this module throws. */
export class ImageLegSilentError extends Error {}

export interface ImageEvalOptions {
  userId: string;
  /** Corpus filename → page id, resolved at seed time. */
  pageIdByFile: Map<string, number>;
  topK: number;
  /** Applied to BOTH arms, or the pairing would compare two pipelines. */
  rerank?: boolean;
  assembleContext?: boolean;
  pinIdentifiers?: boolean;
  deepSearch?: boolean;
  mmr?: { enabled: boolean; lambda?: number };
  /**
   * Fraction of queries whose leg-on arm must show at least one image hit.
   *
   * `runner.ts`'s `minVectorParticipation` argument, one leg over: the leg
   * bypasses itself silently on every failure and the search still returns
   * results, so a run with a dead VL endpoint reports two identical arms and a
   * confident "no credible change". A fraction rather than "> 0" for that
   * file's reason too — a handful of hits between breaker cool-downs is
   * evidence of a broken leg, not a working one.
   *
   * The floor is 0.5 rather than the rerank stage's 0.9 because this leg's
   * participation is measured on what SURVIVES into the returned top-K: the
   * leg is page-denominated and fused by rank, so a query whose text legs
   * dominate can legitimately push every image-reached page out of the window.
   */
  minImageLegParticipation?: number;
  /** Same floor as `runner.ts`, applied to each arm. */
  minVectorParticipation?: number;
  onProgress?: (done: number, total: number) => void;
  /**
   * TEST SEAM. Runs the "off" arm with the leg forced ON, so the invariant in
   * decision 4 above has something to fail against. Nothing outside
   * `runner-images.integration.test.ts` may set it: it makes the two arms the
   * same configuration, which is precisely what the refusal exists to catch.
   */
  _forceOffArmLegOn?: boolean;
}

export interface ImageEvalResult {
  pairs: ImageQueryPair[];
  totalQueries: number;
  /** Queries whose leg-on arm returned at least one image hit. */
  imageLegParticipatingQueries: number;
  /** Queries where each arm showed a vector-leg score. */
  vectorParticipatingQueries: { off: number; on: number };
  /** #1104: queries where each arm carried a rerank score. */
  rerankParticipatingQueries: { off: number; on: number };
  /** #1112: expansions that produced paraphrase legs, summed over both arms. */
  expansionParticipatingQueries: number;
  /** #1112: expansions that stood down BY DESIGN, summed over both arms. */
  expansionSkippedQueries: number;
}

/**
 * There is deliberately NO `vlQueryEmbeds` field on the result.
 *
 * `searchImageLeg` embeds the question once per request whose gate opens, so a
 * count derived here would be `imageLegParticipatingQueries === 0 ? 0 : total`
 * — a restatement of the participation counter dressed up as a measurement,
 * and wrong in exactly the state that matters (a leg that ran and whose pages
 * lost the fusion embedded a query and contributed no hit). The client exposes
 * no per-call counter, so the one place the claim can actually be checked is a
 * stub server's request log, and `runner-images.integration.test.ts` checks it
 * there: 0 requests for the off arm, one per query for the on arm.
 */

interface ArmCounters {
  vector: number;
  rerank: number;
  /** #1112, summed across the pair — both arms expand, and both are real work. */
  expanded: number;
  expansionSkipped: number;
}

/**
 * Resolve a label's expected pages, refusing a name the seed never inserted.
 *
 * `loadImageFixture` already checked every `expectedFiles` entry against the
 * corpus manifest, so reaching here means the SEED is incomplete — most often
 * a `maxPages` left on from a test run.
 */
function expectedPageIds(files: readonly string[], pageIdByFile: Map<string, number>): number[] {
  return files.map((file) => {
    const pageId = pageIdByFile.get(file);
    if (pageId === undefined) {
      throw new ImageLegSilentError(
        `Corpus page was never seeded: ${file}. The fixture is validated against the corpus manifest, ` +
          'so this is the seed being short — check that the whole corpus was seeded (maxPages is a test seam).',
      );
    }
    return pageId;
  });
}

/** One arm of one query, wall-clocked. */
async function runArm(
  question: string,
  imageLeg: boolean,
  opts: ImageEvalOptions,
  counters: ArmCounters,
): Promise<ImageArmRun> {
  const search = opts.deepSearch === true ? multiQuerySearch : hybridSearch;
  const searchOpts: MultiQuerySearchOptions = {
    rerank: opts.rerank === true,
    assembleContext: opts.assembleContext !== false,
    pinIdentifiers: opts.pinIdentifiers !== false,
    ...(opts.mmr ? { mmr: opts.mmr } : {}),
    // Forced, never inherited from admin_settings — see decision 2.
    imageLeg,
    // See decision 3.
    recordAnalytics: false,
    // Meaningless to `hybridSearch` and ignored there; carried so a
    // `--deep-search --images` run can be refused when expansion never fired,
    // exactly as `runner.ts` refuses one (the callback is why `searchOpts` is
    // declared as the wider union type rather than passed inline).
    onExpansion: (outcome: ExpansionOutcome) => {
      if (outcome.expanded) counters.expanded++;
      else if (outcome.reason !== 'unavailable') counters.expansionSkipped++;
    },
  };

  const started = performance.now();
  const results = await search(opts.userId, question, opts.topK, undefined, searchOpts);
  const ms = performance.now() - started;

  if (results.some((r) => r.vectorScore !== null)) counters.vector++;
  if (results.some((r) => r.rerankScore != null)) counters.rerank++;

  const imageHits: ImageHitRecord[] = results.flatMap((result) =>
    (result.imageHits ?? []).map((hit) => ({
      pageId: result.pageId,
      source: hit.source,
      key: hit.key,
      similarity: hit.similarity,
    })),
  );

  return { retrieved: results.map((r) => r.pageId), ms, imageHits };
}

export async function runImageEval(
  fixture: ImageFixture,
  opts: ImageEvalOptions,
): Promise<ImageEvalResult> {
  const minImageParticipation = opts.minImageLegParticipation ?? 0.5;
  const minVectorParticipation = opts.minVectorParticipation ?? 0.5;

  // `runner.ts`'s first guard, and it applies unchanged: a partially embedded
  // corpus is scored against a corpus that effectively does not contain the
  // answer, and BOTH arms inherit that.
  const coverage = await getEmbeddingCoverage(opts.userId);
  if (coverage.coverage < 1) {
    throw new VectorLegSilentError(
      `Corpus is only ${(coverage.coverage * 100).toFixed(1)}% embedded ` +
        `(${coverage.embeddedPages}/${coverage.totalPages}). Metrics measured on a partial corpus are ` +
        'not comparable to anything — embed it fully first.',
    );
  }

  const pairs: ImageQueryPair[] = [];
  const off: ArmCounters = { vector: 0, rerank: 0, expanded: 0, expansionSkipped: 0 };
  const on: ArmCounters = { vector: 0, rerank: 0, expanded: 0, expansionSkipped: 0 };
  let imageLegParticipatingQueries = 0;
  let dirtyOffArm = 0;
  let completed = 0;

  for (const label of fixture.labels) {
    const expected = expectedPageIds(label.expectedFiles, opts.pageIdByFile);
    // Interleaved, off first — see decision 1. The order within a pair is
    // fixed rather than alternated: a page's rows are already in Postgres's
    // buffer cache after the first arm either way, so alternating would only
    // move which arm pays the miss, and a fixed order keeps a re-run's
    // per-query numbers comparable.
    const offArm = await runArm(label.query, opts._forceOffArmLegOn === true, opts, off);
    const onArm = await runArm(label.query, true, opts, on);

    if (offArm.imageHits.length > 0) dirtyOffArm++;
    if (onArm.imageHits.length > 0) imageLegParticipatingQueries++;

    pairs.push({
      queryId: label.id,
      style: label.style,
      lang: label.lang,
      expected,
      expectedImageKeys: label.expectedImages.map(imageAttachmentKey),
      off: offArm,
      on: onArm,
    });
    completed++;
    opts.onProgress?.(completed, fixture.labels.length);
  }

  const total = fixture.labels.length;

  // Decision 4, the direction that invalidates the comparison outright: an
  // "off" arm that ran the leg is the same configuration measured twice.
  if (dirtyOffArm > 0) {
    throw new ImageLegSilentError(
      `${dirtyOffArm}/${total} queries came back from the leg-off arm carrying image hits — ` +
        '`imageLeg: false` did not force the leg off, so both arms measured the same pipeline and ' +
        'every paired verdict below would be a coin flip reported as "no credible change".',
    );
  }

  // …and the direction that makes the whole run a no-op. Checked after the
  // loop rather than per query, because a bypass is legitimately intermittent
  // (a breaker cooling down) and the fraction is what separates that from a
  // leg that never ran.
  const participation = total === 0 ? 0 : imageLegParticipatingQueries / total;
  if (total > 0 && participation < minImageParticipation) {
    throw new ImageLegSilentError(
      `The image leg contributed hits to only ${imageLegParticipatingQueries}/${total} queries ` +
        `(${(participation * 100).toFixed(1)}%, floor ${(minImageParticipation * 100).toFixed(0)}%). ` +
        'The leg bypasses itself on ANY failure and the search still returns results, so this run ' +
        'would otherwise report two identical arms and a confident "no credible change". Check the ' +
        'image_embedding assignment, that page_image_embeddings is non-empty, and that the VL endpoint ' +
        `answers inside IMAGE_LEG_TIMEOUT_MS.`,
    );
  }

  for (const [arm, counters] of [['leg-off', off], ['leg-on', on]] as const) {
    const vectorParticipation = total === 0 ? 0 : counters.vector / total;
    if (total > 0 && vectorParticipation < minVectorParticipation) {
      throw new VectorLegSilentError(
        `Vector leg participated in ${counters.vector}/${total} queries on the ${arm} arm ` +
          `(${(vectorParticipation * 100).toFixed(1)}%, floor ${(minVectorParticipation * 100).toFixed(0)}%). ` +
          'hybridSearch falls back to keyword-only on ANY embedding failure and still returns results, ' +
          'so this run would otherwise have reported a confident score computed from Postgres FTS alone.',
      );
    }
    if (opts.rerank === true && total > 0 && counters.rerank / total < 0.9) {
      throw new VectorLegSilentError(
        `A rerank run was requested but the stage participated in only ${counters.rerank}/${total} ` +
          `queries on the ${arm} arm — the stage bypasses itself on any failure and still returns the ` +
          'fused order, so this run would report a confident score for a pipeline it does not name.',
      );
    }
  }

  // #1112's guard, unchanged in substance: expansion is soft-fail, so a
  // `--deep-search` run against a DB with no `chat` assignment returns
  // perfectly ordinary numbers under a deep label. Summed over both arms,
  // because both really run it.
  const expanded = off.expanded + on.expanded;
  const expansionSkipped = off.expansionSkipped + on.expansionSkipped;
  if (opts.deepSearch === true && expanded === 0 && expansionSkipped < total * 2) {
    throw new VectorLegSilentError(
      'A deep-search run was requested but query expansion participated in 0 of the ' +
        `${total * 2} arm-queries (${expansionSkipped} skipped by design) — check the chat use-case ` +
        'assignment and the provider endpoint before trusting this measurement.',
    );
  }

  return {
    pairs,
    totalQueries: total,
    imageLegParticipatingQueries,
    vectorParticipatingQueries: { off: off.vector, on: on.vector },
    rerankParticipatingQueries: { off: off.rerank, on: on.rerank },
    expansionParticipatingQueries: expanded,
    expansionSkippedQueries: expansionSkipped,
  };
}
