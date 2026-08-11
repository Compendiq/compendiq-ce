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
  let vectorParticipatingQueries = 0;
  let rerankParticipatingQueries = 0;
  let assemblyParticipatingQueries = 0;
  let pinParticipatingQueries = 0;

  for (const label of fixture.labels) {
    // assembleContext mirrors the shipped chat configuration (#1106 PR 2).
    // It provably cannot move any metric: assembly runs after the topK
    // slice and touches no ranking field, and the runner scores pageIds
    // only — the one-time zero-discordant A/B on the rig is the recorded
    // evidence for that claim (PR body).
    const results = await hybridSearch(opts.userId, label.query, opts.topK, undefined, {
      rerank: opts.rerank === true,
      assembleContext: opts.assembleContext !== false,
      // #1107 mirrors the shipped chat configuration; the fixture's
      // negative cases (NL queries carrying identifier-shaped tokens) are
      // what make "natural-language queries unaffected" measurable.
      pinIdentifiers: true,
    });

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
  return { runs, vectorParticipatingQueries, rerankParticipatingQueries, assemblyParticipatingQueries, pinParticipatingQueries, totalQueries: fixture.labels.length };
}
