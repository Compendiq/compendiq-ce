/**
 * #1102 — the eval runner: drives real retrieval over the seeded corpus and
 * records what came back, for `metrics.ts` to score.
 *
 * The guards below are the point of this module, not decoration. `hybridSearch`
 * catches everything except `CircuitBreakerOpenError` into
 * `logger.warn('Embedding failed, falling back to keyword-only')` and continues
 * with an empty vector leg. `resolveUsecase('embedding')` throws when no
 * provider row exists, and `truncateAllTables()` removes `llm_providers`. So
 * the DEFAULT failure mode of a misconfigured harness is: no provider → warn →
 * keyword-only → non-empty results → a confident Recall@K computed entirely
 * from Postgres FTS, with nothing red anywhere. Asserting "results came back"
 * does not detect it; asserting the vector leg participated does.
 */
import { hybridSearch, getEmbeddingCoverage } from '../services/rag-service.js';
import {
  multiQuerySearch,
  type ExpansionOutcome,
  type MultiQuerySearchOptions,
} from '../services/multi-query-search.js';
import { trigrams, jaccard } from '../services/mmr.js';

/**
 * Similarity at which a result counts as a near-duplicate of a higher-ranked
 * one. Same measure and threshold the MMR stage uses, so the metric and the
 * mechanism cannot drift apart.
 */
const REDUNDANT_SIMILARITY = 0.7;
import type { QueryRun } from './metrics.js';
import type { Fixture } from './fixture.js';

export class VectorLegSilentError extends Error {}

export interface EvalRunOptions {
  userId: string;
  /** Corpus filename → page id, resolved at seed time. */
  pageIdByFile: Map<string, number>;
  topK: number;
  /**
   * Request the #1104 rerank stage per query. It still only runs when the
   * eval database carries a `rerank` use-case assignment — the harness
   * measures whatever pipeline the DB configures, same as production.
   */
  rerank?: boolean;
  /**
   * Request #1106 PR 2's sibling assembly per query (default TRUE — the
   * rig measures the shipped chat configuration). Exposed as an option so
   * the zero-discordant identity A/B is re-runnable from committed code
   * (#1270 review F10), and guarded like the neighbouring stages: assembly
   * is soft-fail at every layer, so without a participation check a broken
   * sibling SELECT or a stray budget-0 row publishes green numbers while
   * the measured configuration silently was not the shipped one.
   */
  assembleContext?: boolean;
  /** #1107: request identifier pinning (default true — the shipped chat
   * config); exposed so the stage is A/B-able within one tree (#1273 M10). */
  pinIdentifiers?: boolean;
  /** #1109: force the MMR narrow for this run (the DB default is off). */
  mmr?: { enabled: boolean; lambda?: number };
  /**
   * #1112: run every query through multi-query expansion (the `deepSearch`
   * request flag). Needs a `chat` use-case assignment in the eval DB — the
   * reformulation call is real, like the embedder. Without one, expansion
   * soft-fails per query and the run would measure plain retrieval under a
   * deep label, which the participation guard below refuses to do quietly.
   */
  deepSearch?: boolean;
  /**
   * Fraction of queries that must show at least one vector-leg hit.
   *
   * Deliberately not "> 0": on a fully embedded corpus a healthy vector leg
   * contributes to essentially every query, so a single lucky hit across 120
   * queries is evidence of a broken leg, not a working one. The default admits
   * genuinely keyword-shaped queries while still failing a dead leg loudly.
   */
  minVectorParticipation?: number;
}

export interface EvalRunResult {
  runs: QueryRun[];
  /** Queries where at least one returned page carried a vector-leg score. */
  vectorParticipatingQueries: number;
  /** #1104: queries in which at least one returned result carried a rerankScore. */
  rerankParticipatingQueries: number;
  /** #1106 PR 2: queries in which at least one returned result carried an
   * assembled contextText. */
  assemblyParticipatingQueries: number;
  /** #1107: queries in which a verified identifier pin led the results.
   * No hard guard — pins legitimately fire on only the fixture's few
   * identifier-style queries — but the COUNT is recorded so a silently
   * dead pin path is visible in the report (the F10 lesson applied). */
  pinParticipatingQueries: number;
  /**
   * #1112: queries whose deep search actually retrieved paraphrase legs.
   * Skips are legitimate and expected (identifier and error-text queries are
   * excluded by design), so this is reported rather than floored — but zero
   * across a whole `--deep-search` run is guarded below.
   */
  expansionParticipatingQueries: number;
  /** #1112: queries where expansion stood down BY DESIGN (identifier,
   * error-text, over-long) rather than failing. Reported so a run that
   * expanded nothing can be read as "the fixture is all identifiers" or as
   * "the provider is down" without re-running it. */
  expansionSkippedQueries: number;
  /**
   * #1109's acceptance metric, and the reason it is computed HERE rather
   * than by post-hoc SQL: the corpus is re-seeded per run, so page ids are
   * not comparable between reports and any cross-run join silently matches
   * nothing. Redundancy is a property of a run and has to be measured
   * inside it.
   *
   * `redundantSlots` counts returned results that are near-duplicates
   * (trigram Jaccard > 0.7, the same measure the stage itself uses) of a
   * HIGHER-ranked result in the same query. `meanPairwiseSimilarity` is the
   * figure the issue's Corrections name.
   */
  redundantSlots: number;
  returnedSlots: number;
  meanPairwiseSimilarity: number;
  totalQueries: number;
}

export async function runEval(fixture: Fixture, opts: EvalRunOptions): Promise<EvalRunResult> {
  const minParticipation = opts.minVectorParticipation ?? 0.5;

  // A partially embedded corpus inflates every metric: the pages that failed
  // to embed cannot be retrieved by the vector leg, so the queries pointing at
  // them are scored against a corpus that effectively does not contain their
  // answer. Fail before measuring rather than publishing a number that means
  // something other than what it says.
  const coverage = await getEmbeddingCoverage(opts.userId);
  if (coverage.coverage < 1) {
    throw new VectorLegSilentError(
      `Corpus is only ${(coverage.coverage * 100).toFixed(1)}% embedded (${coverage.embeddedPages}/${coverage.totalPages}). ` +
        'Metrics measured on a partial corpus are not comparable to anything — embed it fully first.',
    );
  }

  const runs: QueryRun[] = [];
  // #1109 acceptance metric, accumulated per query. Computed inside the run
  // because the corpus is re-seeded each time: page ids are not comparable
  // between reports, so any cross-run join silently matches nothing.
  let redundantSlots = 0;
  let returnedSlots = 0;
  let pairSimTotal = 0;
  let pairCount = 0;
  let vectorParticipatingQueries = 0;
  let rerankParticipatingQueries = 0;
  let assemblyParticipatingQueries = 0;
  let pinParticipatingQueries = 0;
  let expansionParticipatingQueries = 0;
  let expansionSkippedQueries = 0;

  for (const label of fixture.labels) {
    // assembleContext mirrors the shipped chat configuration (#1106 PR 2).
    // It provably cannot move any metric: assembly runs after the topK
    // slice and touches no ranking field, and the runner scores pageIds
    // only — the one-time zero-discordant A/B on the rig is the recorded
    // evidence for that claim (PR body).
    // #1112: the deep-search axis swaps the wrapper in, exactly as the ask
    // route does for a `deepSearch` request — same options, same widths.
    const search = opts.deepSearch === true ? multiQuerySearch : hybridSearch;
    // Declared as the wider type rather than passed inline: `onExpansion` is
    // meaningless to `hybridSearch`, and a fresh object literal carrying it
    // would not type-check against that half of the union.
    const searchOpts: MultiQuerySearchOptions = {
      rerank: opts.rerank === true,
      assembleContext: opts.assembleContext !== false,
      // #1107 mirrors the shipped chat configuration; the fixture's
      // negative cases (NL queries carrying identifier-shaped tokens) are
      // what make "natural-language queries unaffected" measurable.
      pinIdentifiers: opts.pinIdentifiers !== false,
      ...(opts.mmr ? { mmr: opts.mmr } : {}),
      onExpansion: (outcome: ExpansionOutcome) => {
        if (outcome.expanded) expansionParticipatingQueries++;
        else if (outcome.reason !== 'unavailable') expansionSkippedQueries++;
      },
    };
    const results = await search(opts.userId, label.query, opts.topK, undefined, searchOpts);

    if (results.some((r) => r.vectorScore !== null)) vectorParticipatingQueries++;
    if (results.some((r) => r.rerankScore != null)) rerankParticipatingQueries++;
    if (results.some((r) => r.contextText !== undefined)) assemblyParticipatingQueries++;
    if (results.some((r) => r.pinned === true)) pinParticipatingQueries++;

    const expected = label.expectedFiles.map((file) => {
      const pageId = opts.pageIdByFile.get(file);
      if (pageId === undefined) {
        // loadFixture already checks names against the corpus, so reaching
        // here means the SEED is incomplete rather than the fixture wrong.
        throw new Error(`Corpus page was never seeded: ${file}`);
      }
      return pageId;
    });

    const texts = results.map((r) => trigrams(`${r.pageTitle ?? ''} ${r.contextText ?? r.chunkText ?? ''}`));
    for (let a = 0; a < texts.length; a += 1) {
      let redundant = false;
      for (let b = 0; b < a; b += 1) {
        const sim = jaccard(texts[a]!, texts[b]!);
        pairSimTotal += sim;
        pairCount += 1;
        if (sim > REDUNDANT_SIMILARITY) redundant = true;
      }
      if (redundant) redundantSlots += 1;
    }
    returnedSlots += texts.length;

    runs.push({ queryId: label.id, retrieved: results.map((r) => r.pageId), expected });
  }

  const participation = fixture.labels.length === 0 ? 0 : vectorParticipatingQueries / fixture.labels.length;
  if (participation < minParticipation) {
    throw new VectorLegSilentError(
      `Vector leg participated in ${vectorParticipatingQueries}/${fixture.labels.length} queries ` +
        `(${(participation * 100).toFixed(1)}%, floor ${(minParticipation * 100).toFixed(0)}%). ` +
        'hybridSearch falls back to keyword-only on ANY embedding failure and still returns results, ' +
        'so this run would otherwise have reported a confident score computed from Postgres FTS alone. ' +
        'Check that an embedding provider row exists and that the model is reachable.',
    );
  }

  // A --rerank run in which the stage never executed once (unassigned,
  // erroring, always past the budget) is a plain run wearing the wrong
  // label — the same class of silent lie the vector-participation guard
  // exists for (#1267 verification, 5).
  if (opts.rerank === true && rerankParticipatingQueries === 0 && fixture.labels.length > 0) {
    throw new VectorLegSilentError(
      'A rerank run was requested but the rerank stage participated in 0 queries — '
      + 'check the rerank use-case assignment and the provider endpoint before trusting this measurement.',
    );
  }
  // Same silent-lie class as the rerank guard: an assembly-on run in which
  // the stage never assembled once (broken SELECT, budget-0 row in the rig
  // DB, truncated budget) is a chunk-level run wearing the wrong label
  // (#1270 review F10).
  if (opts.assembleContext !== false && assemblyParticipatingQueries === 0 && fixture.labels.length > 0) {
    throw new VectorLegSilentError(
      'An assembly-on run was requested but the sibling-assembly stage participated in 0 queries — '
      + 'check rag_context_chars_per_page and the page_embeddings sibling fetch before trusting this measurement.',
    );
  }
  // #1112, same silent-lie class as the two guards above: expansion is
  // soft-fail by design, so a `--deep-search` run against a DB with no `chat`
  // assignment (or an unreachable one) returns perfectly ordinary numbers
  // labelled "deep". Every query skipping BY DESIGN is a different fact and
  // is allowed — that is what the skipped count separates.
  if (
    opts.deepSearch === true
    && expansionParticipatingQueries === 0
    && expansionSkippedQueries < fixture.labels.length
  ) {
    throw new VectorLegSilentError(
      'A deep-search run was requested but query expansion participated in 0 queries '
      + `(${expansionSkippedQueries}/${fixture.labels.length} skipped by design) — `
      + 'check the chat use-case assignment and the provider endpoint before trusting this measurement.',
    );
  }
  return {
    runs,
    vectorParticipatingQueries,
    rerankParticipatingQueries,
    assemblyParticipatingQueries,
    pinParticipatingQueries,
    expansionParticipatingQueries,
    expansionSkippedQueries,
    redundantSlots,
    returnedSlots,
    meanPairwiseSimilarity: pairCount === 0 ? 0 : pairSimTotal / pairCount,
    totalQueries: fixture.labels.length,
  };
}
