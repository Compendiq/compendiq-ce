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
 * 1. **INTERLEAVED per query, and the arm that goes FIRST alternates** — never
 *    off-for-everything and then on-for-everything, and never off-first every
 *    time. The rig warms up: `admin-settings-service`'s TTL caches,
 *    `getUserAccessibleSpacesMemoized`, the vector pool's connections and
 *    Postgres's own buffer cache all fill during the first handful of queries,
 *    and each query then pays its own first-touch cost — its heap and index
 *    pages, its chunk rows — on whichever arm reaches it first. A block design
 *    hands the whole of that to whichever arm runs first and then publishes the
 *    difference as the leg's query cost. Interleaving fixes the block half;
 *    alternating (`offFirst = index % 2 === 0`) is what fixes the rest, because
 *    a fixed off-then-on order assigns 100% of every query's first touch to the
 *    off arm and biases `queryCostMs` toward UNDERSTATING the leg — the one
 *    direction a rig measuring a feature must never be biased in. The
 *    alternation is deterministic on the label index, so a re-run's per-query
 *    numbers stay comparable, and each pair records both the order it was
 *    measured in (`ImageQueryPair.offFirst`) and each arm's start stamp
 *    (`ImageArmRun.startedAt`) — the second because the first is recomputed
 *    from the index and therefore agrees with itself whichever branch below
 *    runs, so it can pin nothing on its own (review r3).
 * 2. **`imageLeg` is FORCED on both arms**, never toggled through
 *    `admin_settings.rag_image_leg_enabled`. Writing the global setting per
 *    query would change what every other request on the instance retrieves for
 *    the duration of the run — which is the reason P3 put the request-level
 *    override there in the first place. BOTH directions are pinned (review r2):
 *    the off arm by the refusal in decision 4, and the on arm by a case that
 *    disables the setting and expects image hits anyway. An on arm that merely
 *    omitted the flag and inherited the knob would run leg-off against leg-off
 *    on any database whose knob is false — a restored dump, or a knob an
 *    operator flipped while debugging P3 — and that is the identical-arms state
 *    every refusal here exists to prevent.
 * 3. **`recordAnalytics: false` on both arms.** Each question is asked twice
 *    and only one of the two is a question anybody asked; recording both would
 *    double every image-axis query in `search_analytics` and file a leg-off
 *    variant nobody typed beside it. `benchmark-query-latency.ts` already does
 *    this, for the same reason.
 * 4. **The off arm carrying image hits is a REFUSAL, not a curiosity.** Every
 *    failure mode of this leg — unassigned model, empty index, dead endpoint,
 *    a forcing flag that stopped forcing — produces two identical arms and a
 *    delta of exactly zero, which reads as "the leg does not help" rather than
 *    "the leg never ran". Both directions are guarded, and they are guarded at
 *    DIFFERENT times: the off arm must be clean and is checked on the FIRST
 *    pair, because a forcing flag that does not force is a property of this
 *    code path and every remaining query would answer the same way (review r3);
 *    participation on the on arm has a fractional floor and is checked after
 *    the loop, because a bypass is legitimately intermittent.
 */
import { hybridSearch, getEmbeddingCoverage, type SearchResult } from '../services/rag-service.js';
import {
  multiQuerySearch,
  type ExpansionOutcome,
  type MultiQuerySearchOptions,
} from '../services/multi-query-search.js';
import { VectorLegSilentError } from './runner.js';
import { imageAttachmentKey } from './seed-images.js';
import { rankedEvidence, type ArmQueryRun, type EvalArm } from './arms.js';
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
  /**
   * REFUSED BY THE ENTRYPOINT on this axis (`assertImageAxisStagesPairable`,
   * review r2), and the option survives only because the refusal is about a
   * missing seam rather than about deep search itself.
   *
   * Every other flag here names a stage that runs identically in both arms.
   * This one does not: `multiQuerySearch` calls `reformulateQuery` per REQUEST,
   * uncached and unseeded, so each arm is paraphrased separately and two of its
   * three fused legs become different questions — a difference `pairedDelta`
   * then attributes to the image leg. The day `MultiQuerySearchOptions` grows a
   * `paraphrases` seam, `runImageEval` reformulates once per label, hands both
   * arms the same list and this becomes true again; until then the counters
   * below stay per-arm because that is what they will be counting.
   */
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
  /** #1106: queries where each arm's sibling assembly produced context text. */
  assemblyParticipatingQueries: { off: number; on: number };
  /** #1107: queries each arm led with a verified identifier pin. */
  pinParticipatingQueries: { off: number; on: number };
  /**
   * #1112: expansions that produced paraphrase legs, PER ARM.
   *
   * Per arm rather than summed, because the report denominates every
   * participation figure it publishes by `totalQueries` — one label, one query.
   * A sum over both arms is a count of ARM-queries, and reporting it against N
   * labels prints participation above 100% on a `--deep-search --images` run
   * (review r1). The refusal below still reads both arms, where the unit is
   * arm-queries and says so.
   */
  expansionParticipatingQueries: { off: number; on: number };
  /** #1112: expansions that stood down BY DESIGN, per arm and for that reason. */
  expansionSkippedQueries: { off: number; on: number };
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
  /** #1106 / #1107: both stages really run on this axis, so both are counted. */
  assembly: number;
  pin: number;
  /** #1112 — both arms expand, and both are real work. */
  expanded: number;
  expansionSkipped: number;
}

function emptyCounters(): ArmCounters {
  return { vector: 0, rerank: 0, assembly: 0, pin: 0, expanded: 0, expansionSkipped: 0 };
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

/** One search, wall-clocked, its stage participation counted. */
async function searchOnce(
  question: string,
  imageLeg: boolean,
  opts: ImageEvalOptions,
  counters: ArmCounters,
  search: typeof hybridSearch | typeof multiQuerySearch,
): Promise<{ results: SearchResult[]; ms: number; started: number }> {
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
  // Counted, never hardcoded (review r1). Both stages really run here —
  // `assembleContext` and `pinIdentifiers` are passed into every arm above —
  // and the report publishes these two in fields whose ZERO is a refusal
  // condition on the text gate (`runner.ts`'s assembly guard). Publishing a
  // constant 0 there asserts, in the harness's own vocabulary, the broken
  // state the harness refuses to publish.
  if (results.some((r) => r.contextText !== undefined)) counters.assembly++;
  if (results.some((r) => r.pinned === true)) counters.pin++;

  return { results, ms, started };
}

/** One arm of one query, wall-clocked. */
async function runArm(
  question: string,
  imageLeg: boolean,
  opts: ImageEvalOptions,
  counters: ArmCounters,
): Promise<ImageArmRun> {
  const search = opts.deepSearch === true ? multiQuerySearch : hybridSearch;
  const { results, ms, started } = await searchOnce(question, imageLeg, opts, counters, search);

  const imageHits: ImageHitRecord[] = results.flatMap((result) =>
    (result.imageHits ?? []).map((hit) => ({
      pageId: result.pageId,
      source: hit.source,
      key: hit.key,
      similarity: hit.similarity,
    })),
  );

  // `startedAt` is what makes the alternation testable: `offFirst` is derived
  // from the label index and recorded from the same expression, so it agrees
  // with itself whatever branch below actually ran (review r3).
  return { retrieved: results.map((r) => r.pageId), ms, startedAt: started, imageHits };
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
  const off = emptyCounters();
  const on = emptyCounters();
  let imageLegParticipatingQueries = 0;
  let completed = 0;

  for (const [index, label] of fixture.labels.entries()) {
    const expected = expectedPageIds(label.expectedFiles, opts.pageIdByFile);
    // Interleaved AND alternating — see decision 1. Whichever arm runs first
    // pays this query's first-touch cost, so a fixed order would charge all of
    // it to one arm and publish the difference as the leg's; the alternation is
    // on the label index rather than random so two runs of the same fixture
    // charge the same queries to the same arms.
    const offFirst = index % 2 === 0;
    let offArm: ImageArmRun;
    let onArm: ImageArmRun;
    if (offFirst) {
      offArm = await runArm(label.query, opts._forceOffArmLegOn === true, opts, off);
      onArm = await runArm(label.query, true, opts, on);
    } else {
      onArm = await runArm(label.query, true, opts, on);
      offArm = await runArm(label.query, opts._forceOffArmLegOn === true, opts, off);
    }

    // Decision 4, the direction that invalidates the comparison outright, and
    // it is checked HERE rather than after the loop (review r3). An "off" arm
    // that came back with image hits means `imageLeg: false` is not forcing the
    // leg off, which is a property of this code path and not of the endpoint:
    // it is fully decided by the first query, and every remaining one would
    // answer the same way. The participation floor below is the opposite case
    // and stays post-loop, because a bypass is legitimately intermittent.
    if (offArm.imageHits.length > 0) {
      throw new ImageLegSilentError(
        `Query "${label.id}" came back from the leg-off arm carrying ${offArm.imageHits.length} image hit(s) — ` +
          '`imageLeg: false` did not force the leg off, so both arms are measuring the same pipeline and ' +
          'every paired verdict would be a coin flip reported as "no credible change". Refused here ' +
          `rather than after all ${fixture.labels.length} labels: this is a fact about the forcing ` +
          'flag and not about the endpoint, so the rest of the run would cost two more searches per ' +
          'remaining label to learn nothing new.',
      );
    }
    if (onArm.imageHits.length > 0) imageLegParticipatingQueries++;

    pairs.push({
      queryId: label.id,
      style: label.style,
      lang: label.lang,
      expected,
      expectedImageKeys: label.expectedImages.map(imageAttachmentKey),
      offFirst,
      off: offArm,
      on: onArm,
    });
    completed++;
    opts.onProgress?.(completed, fixture.labels.length);
  }

  const total = fixture.labels.length;

  // The direction that makes the whole run a no-op. Checked after the
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
    // `runner.ts`'s assembly guard, unchanged in substance and applied per arm.
    // The report publishes this count, so a stage that never assembled is a
    // chunk-level run wearing an assembly-on label — and on this axis it would
    // be published as a zero in a field the text gate refuses to write.
    if (opts.assembleContext !== false && total > 0 && counters.assembly === 0) {
      throw new VectorLegSilentError(
        `An assembly-on run was requested but the sibling-assembly stage participated in 0 queries on ` +
          `the ${arm} arm — check rag_context_chars_per_page and the page_embeddings sibling fetch ` +
          'before trusting this measurement.',
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
    assemblyParticipatingQueries: { off: off.assembly, on: on.assembly },
    pinParticipatingQueries: { off: off.pin, on: on.pin },
    expansionParticipatingQueries: { off: off.expanded, on: on.expanded },
    expansionSkippedQueries: { off: off.expansionSkipped, on: on.expansionSkipped },
  };
}

// ---------------------------------------------------------------------------
// #1614 PR2 — the single-arm runner for the ADR-027 arm axis.
// ---------------------------------------------------------------------------

export interface ArmEvalOptions {
  arm: EvalArm;
  userId: string;
  pageIdByFile: Map<string, number>;
  topK: number;
  rerank?: boolean;
  assembleContext?: boolean;
  pinIdentifiers?: boolean;
  mmr?: { enabled: boolean; lambda?: number };
  /**
   * Fraction of image-labelled queries whose top-K must carry image evidence
   * on an arm that HAS an evidence source (A: the leg; B: derived rows). The
   * paired runner's `minImageLegParticipation`, one arm at a time and for the
   * same reason: the leg bypasses itself silently and a backfill that never
   * ran leaves ordinary text retrieval wearing the candidate's name. Not
   * applied to arm C, which must carry NONE.
   */
  minEvidenceParticipation?: number;
  minVectorParticipation?: number;
  onProgress?: (done: number, total: number) => void;
  /**
   * TEST SEAM. The search this arm runs, defaulting to the product's
   * `hybridSearch`. `runner-images.integration.test.ts` wraps the real one to
   * decorate rows with D11's `derived` provenance, which no row on this
   * revision carries (#1617), so arm B's attribution rule has something to be
   * right about. Nothing outside that file may set it.
   */
  _search?: typeof hybridSearch;
}

export interface ArmEvalResult {
  runs: ArmQueryRun[];
  totalQueries: number;
  /** Queries whose top-K carried at least one piece of image evidence. Always 0 on C. */
  imageEvidenceParticipatingQueries: number;
  vectorParticipatingQueries: number;
  rerankParticipatingQueries: number;
  assemblyParticipatingQueries: number;
  pinParticipatingQueries: number;
}

/**
 * Every fixture label once, on ONE arm, with the image leg forced by the arm
 * (`A` on, `B`/`C` off) and the evidence attributed by the arm's rule
 * (`rankedEvidence`). Deep search is not an option here: the entrypoint
 * refuses it on every image-corpus run (`assertImageAxisStagesPairable`),
 * because the pairing happens across runs and each run would paraphrase
 * separately.
 *
 * The refusals are the paired runner's, applied per arm: partial coverage,
 * a dead vector leg, a rerank or assembly stage that never ran — and two of
 * this axis's own: an arm without an image leg that came back with image
 * hits (the forcing flag did not force), and an arm C that carried any
 * evidence at all (the ablation is not an ablation).
 */
export async function runArmEval(fixture: ImageFixture, opts: ArmEvalOptions): Promise<ArmEvalResult> {
  const minEvidenceParticipation = opts.minEvidenceParticipation ?? 0.5;
  const minVectorParticipation = opts.minVectorParticipation ?? 0.5;
  const imageLeg = opts.arm === 'A';
  const search = opts._search ?? hybridSearch;

  const coverage = await getEmbeddingCoverage(opts.userId);
  if (coverage.coverage < 1) {
    throw new VectorLegSilentError(
      `Corpus is only ${(coverage.coverage * 100).toFixed(1)}% embedded ` +
        `(${coverage.embeddedPages}/${coverage.totalPages}). Metrics measured on a partial corpus are ` +
        'not comparable to anything — embed it fully first.',
    );
  }

  const counters = emptyCounters();
  const searchOpts: ImageEvalOptions = {
    userId: opts.userId,
    pageIdByFile: opts.pageIdByFile,
    topK: opts.topK,
    ...(opts.rerank !== undefined ? { rerank: opts.rerank } : {}),
    ...(opts.assembleContext !== undefined ? { assembleContext: opts.assembleContext } : {}),
    ...(opts.pinIdentifiers !== undefined ? { pinIdentifiers: opts.pinIdentifiers } : {}),
    ...(opts.mmr ? { mmr: opts.mmr } : {}),
  };
  const runs: ArmQueryRun[] = [];
  let imageEvidenceParticipatingQueries = 0;
  let imageLabelled = 0;

  for (const label of fixture.labels) {
    const expected = expectedPageIds(label.expectedFiles, opts.pageIdByFile);
    const { results, ms } = await searchOnce(label.query, imageLeg, searchOpts, counters, search);

    const legHits = results.reduce((n, r) => n + (r.imageHits?.length ?? 0), 0);
    if (!imageLeg && legHits > 0) {
      throw new ImageLegSilentError(
        `Query "${label.id}" came back on arm ${opts.arm} carrying ${legHits} image-leg hit(s) — ` +
          '`imageLeg: false` did not force the leg off, so this arm is measuring the legacy leg under ' +
          `arm ${opts.arm}'s name. Refused on the first query: this is a fact about the forcing flag.`,
      );
    }
    // Arm C reports no evidence BY RULE (`evidenceKeysOf` returns none), so
    // the ablation state is checked on the rows themselves: a derived chunk
    // (D11's `derived` provenance) surfacing on C means `image_analysis` was
    // assigned and the backfill wrote rows, which is arm B's state.
    if (opts.arm === 'C') {
      const derived = rankedEvidence('B', results);
      if (derived.length > 0) {
        throw new ImageLegSilentError(
          `Query "${label.id}" came back on arm C carrying image evidence (${derived.map((e) => e.key).join(', ')}) — ` +
            'the ablation has no image leg and no derived chunks by definition (ADR-027 "Arms and revisions"), ' +
            'so this database is not in arm C\'s index state. Check page_image_embeddings is empty and ' +
            'image_analysis is unassigned.',
        );
      }
    }
    const evidence = rankedEvidence(opts.arm, results);
    if (evidence.length > 0) imageEvidenceParticipatingQueries++;
    if (label.expectedImages.length > 0) imageLabelled++;

    runs.push({
      queryId: label.id,
      retrieved: results.map((r) => r.pageId),
      expected,
      style: label.style,
      lang: label.lang,
      cluster: label.expectedFiles[0]!,
      ...(label.imageDependent !== undefined ? { imageDependent: label.imageDependent } : {}),
      ...(label.class !== undefined ? { class: label.class } : {}),
      expectedImageKeys: label.expectedImages.map(imageAttachmentKey),
      evidence,
      ms,
    });
    opts.onProgress?.(runs.length, fixture.labels.length);
  }

  const total = fixture.labels.length;

  // The paired runner's participation floor, per arm. On A it is the leg's
  // silent bypass; on B it is a backfill that never produced a derived row —
  // both leave ordinary text retrieval wearing the arm's name.
  if (opts.arm !== 'C' && imageLabelled > 0) {
    const participation = imageEvidenceParticipatingQueries / total;
    if (participation < minEvidenceParticipation) {
      throw new ImageLegSilentError(
        `Arm ${opts.arm} carried image evidence in only ${imageEvidenceParticipatingQueries}/${total} queries ` +
          `(${(participation * 100).toFixed(1)}%, floor ${(minEvidenceParticipation * 100).toFixed(0)}%). ` +
          (opts.arm === 'A'
            ? 'The leg bypasses itself on ANY failure and the search still returns results — check the ' +
              'image_embedding assignment, that page_image_embeddings is non-empty, and that the VL endpoint ' +
              'answers inside IMAGE_LEG_TIMEOUT_MS.'
            : 'Derived chunks reach the top-K only when the backfill wrote them — check that image_analysis ' +
              'is assigned, the backfill completed on this corpus, and the revision carries #1617\'s ' +
              'derived provenance.'),
      );
    }
  }

  const vectorParticipation = total === 0 ? 0 : counters.vector / total;
  if (total > 0 && vectorParticipation < minVectorParticipation) {
    throw new VectorLegSilentError(
      `Vector leg participated in ${counters.vector}/${total} queries on arm ${opts.arm} ` +
        `(${(vectorParticipation * 100).toFixed(1)}%, floor ${(minVectorParticipation * 100).toFixed(0)}%). ` +
        'hybridSearch falls back to keyword-only on ANY embedding failure and still returns results, ' +
        'so this run would otherwise have reported a confident score computed from Postgres FTS alone.',
    );
  }
  if (opts.rerank === true && total > 0 && counters.rerank / total < 0.9) {
    throw new VectorLegSilentError(
      `A rerank run was requested but the stage participated in only ${counters.rerank}/${total} ` +
        `queries on arm ${opts.arm} — the stage bypasses itself on any failure and still returns the ` +
        'fused order, so this run would report a confident score for a pipeline it does not name.',
    );
  }
  if (opts.assembleContext !== false && total > 0 && counters.assembly === 0) {
    throw new VectorLegSilentError(
      `An assembly-on run was requested but the sibling-assembly stage participated in 0 queries on ` +
        `arm ${opts.arm} — check rag_context_chars_per_page and the page_embeddings sibling fetch ` +
        'before trusting this measurement.',
    );
  }

  return {
    runs,
    totalQueries: total,
    imageEvidenceParticipatingQueries,
    vectorParticipatingQueries: counters.vector,
    rerankParticipatingQueries: counters.rerank,
    assemblyParticipatingQueries: counters.assembly,
    pinParticipatingQueries: counters.pin,
  };
}
