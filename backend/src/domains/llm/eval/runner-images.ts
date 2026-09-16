/**
 * #1614 PR2 — the ADR-027 arm runner: every fixture label once, on ONE arm of
 * the image corpus, in one process over one seeded database.
 *
 * `runner.ts` measures one pipeline against the text fixture; this module does
 * the same over the German image corpus, with the arm deciding what counts as
 * image evidence (`rankedEvidence`). The pairing happens later, across report
 * files (`assertComparableArms`, `judge-arms.ts --unblind`).
 *
 * **#1115 P5b's PAIRED runner is gone** (#1618 stage 2). It ran every query
 * twice in one process, leg-off against leg-on, because ADR-025's image leg was
 * a request flag rather than a checkout; with the leg and its index retired
 * there is no second arm to force, and every refusal that guarded the forcing
 * flag went with it. What survives is the per-arm participation floor below,
 * which is the same argument one arm at a time.
 *
 * **`recordAnalytics: false`.** An eval question is not a question anybody
 * asked, and recording it would file corpus queries into `search_analytics`
 * beside real ones. `benchmark-query-latency.ts` does the same, for the same
 * reason.
 */
import { hybridSearch, getEmbeddingCoverage, type SearchResult } from '../services/rag-service.js';
import type { MultiQuerySearchOptions } from '../services/multi-query-search.js';
import { VectorLegSilentError } from './runner.js';
import { imageAttachmentKey } from './seed-images.js';
import { rankedEvidence, type ArmQueryRun, type EvalArm } from './arms.js';
import type { ImageFixture } from './fixture.js';

/** The one class every refusal in this module throws. */
export class ImageLegSilentError extends Error {}

interface ArmCounters {
  vector: number;
  rerank: number;
  /** #1106 / #1107: both stages really run on this axis, so both are counted. */
  assembly: number;
  pin: number;
}

function emptyCounters(): ArmCounters {
  return { vector: 0, rerank: 0, assembly: 0, pin: 0 };
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
  opts: ArmEvalOptions,
  counters: ArmCounters,
  search: typeof hybridSearch,
): Promise<{ results: SearchResult[]; ms: number }> {
  const searchOpts: MultiQuerySearchOptions = {
    rerank: opts.rerank === true,
    assembleContext: opts.assembleContext !== false,
    pinIdentifiers: opts.pinIdentifiers !== false,
    ...(opts.mmr ? { mmr: opts.mmr } : {}),
    recordAnalytics: false,
  };

  const started = performance.now();
  const results = await search(opts.userId, question, opts.topK, undefined, searchOpts);
  const ms = performance.now() - started;

  if (results.some((r) => r.vectorScore !== null)) counters.vector++;
  if (results.some((r) => r.rerankScore != null)) counters.rerank++;
  // Counted, never hardcoded (review r1). Both stages really run here —
  // `assembleContext` and `pinIdentifiers` are passed in above — and the
  // report publishes these two in fields whose ZERO is a refusal condition on
  // the text gate (`runner.ts`'s assembly guard). Publishing a constant 0
  // there asserts, in the harness's own vocabulary, the broken state the
  // harness refuses to publish.
  if (results.some((r) => r.contextText !== undefined)) counters.assembly++;
  if (results.some((r) => r.pinned === true)) counters.pin++;

  return { results, ms };
}

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
   * on an arm that HAS an evidence source (B: derived rows). A backfill that
   * never ran leaves ordinary text retrieval wearing the candidate's name, and
   * nothing about the search says so — it returns results either way. Not
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
 * Every fixture label once, on ONE arm, with the evidence attributed by the
 * arm's own rule (`rankedEvidence`). Deep search is not an option here: the
 * entrypoint refuses it on every image-corpus run
 * (`assertImageAxisStagesPairable`), because the pairing happens across runs
 * and each run would paraphrase separately.
 *
 * The refusals are the text gate's, applied per arm — partial coverage, a dead
 * vector leg, a rerank or assembly stage that never ran — plus this axis's
 * own: an arm C that carried any image evidence at all is not an ablation.
 */
export async function runArmEval(fixture: ImageFixture, opts: ArmEvalOptions): Promise<ArmEvalResult> {
  const minEvidenceParticipation = opts.minEvidenceParticipation ?? 0.5;
  const minVectorParticipation = opts.minVectorParticipation ?? 0.5;
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
  const runs: ArmQueryRun[] = [];
  let imageEvidenceParticipatingQueries = 0;
  let imageLabelled = 0;

  for (const label of fixture.labels) {
    const expected = expectedPageIds(label.expectedFiles, opts.pageIdByFile);
    const { results, ms } = await searchOnce(label.query, opts, counters, search);

    // Arm C reports no evidence BY RULE (`evidenceKeysOf` returns none), so
    // the ablation state is checked on the rows themselves: a derived chunk
    // (D11's `derived` provenance) surfacing on C means `image_analysis` was
    // assigned and the backfill wrote rows, which is arm B's state.
    if (opts.arm === 'C') {
      const derived = rankedEvidence('B', results);
      if (derived.length > 0) {
        throw new ImageLegSilentError(
          `Query "${label.id}" came back on arm C carrying image evidence (${derived.map((e) => e.key).join(', ')}) — ` +
            'the ablation has no derived chunks by definition (ADR-027 "Arms and revisions"), so this ' +
            'database is not in arm C\'s index state. Check that image_analysis is unassigned.',
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

  // The participation floor, per arm: on B a backfill that never produced a
  // derived row leaves ordinary text retrieval wearing the candidate's name.
  if (opts.arm !== 'C' && imageLabelled > 0) {
    const participation = imageEvidenceParticipatingQueries / total;
    if (participation < minEvidenceParticipation) {
      throw new ImageLegSilentError(
        `Arm ${opts.arm} carried image evidence in only ${imageEvidenceParticipatingQueries}/${total} queries ` +
          `(${(participation * 100).toFixed(1)}%, floor ${(minEvidenceParticipation * 100).toFixed(0)}%). ` +
          'Derived chunks reach the top-K only when the backfill wrote them — check that image_analysis ' +
          'is assigned, the backfill completed on this corpus, and the revision carries #1617\'s ' +
          'derived provenance.',
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
