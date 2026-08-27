/**
 * #1112 — multi-query expansion ("deep search").
 *
 * One chat call turns the user's question into two PARAPHRASES, all three
 * queries are retrieved independently, and the three ranked lists are fused.
 * The gap it exists to close is vocabulary: a page that says "graceful
 * shutdown" answers "how do I stop the server without dropping requests", and
 * neither the embedding nor FTS reliably bridges that on its own — the
 * fixture's `vocabulary-gap` slice measures exactly this.
 *
 * Four decisions are load-bearing.
 *
 * (1) **Expansion happens HERE, in front of retrieval — never inside
 * `hybridSearch`.** `/api/search` paginates, and a paginated surface must not
 * silently change what "page 2" means; the chat path is the only caller that
 * can afford three retrievals and one extra model call. Putting the stage in
 * the shared function would have made it a property of retrieval rather than
 * of the request.
 *
 * (2) **The ORIGINAL query is always one of the legs.** Deep search therefore
 * cannot lose on a query that was already lexically perfect: the worst case is
 * that the paraphrases contribute nothing and the original leg's evidence
 * carries the merge. It is also why the original carries the larger weight
 * (see MERGE weights below).
 *
 * (3) **The merge SUMS per-leg RRF contributions per page.** Concatenating and
 * de-duplicating by pageId would throw away the entire signal: each leg has
 * already deduplicated per page (`reciprocalRankFusion`), so a page ranked
 * mid-pack in all three legs and a page ranked first in one leg and absent
 * from the other two look identical to a de-duplicating merge. Agreement
 * ACROSS phrasings is the evidence multi-query expansion produces, and summing
 * is what reads it.
 *
 * (4) **Reformulation is soft-fail, like every neighbouring stage.** A
 * timeout, an open breaker, an unassigned `chat` use case or unparseable
 * output all degrade to the single-leg path — which is today's search, exactly
 * — and never fail the ask.
 */
import { logger } from '../../../core/utils/logger.js';
import { sanitizeLlmInput } from '../../../core/utils/sanitize-llm-input.js';
import { withSpan } from '../../../telemetry.js';
import { resolveUsecase } from './llm-provider-resolver.js';
import { chat, type ChatMessage } from './openai-compatible-client.js';
import { detectIdentifiers } from './identifier-shortcircuit.js';
import {
  hybridSearch,
  trackSearchAnalytics,
  type EmbeddingCoverage,
  type HybridSearchOptions,
  type RetrievalMeta,
  type SearchResult,
} from './rag-service.js';
// The formula's own dependency-free leaf module (#1268), not rag-service's
// re-export: this file's suite stubs rag-service to a closed list, and the
// recorded verdict must be the REAL one.
import { computeRetrievalConfidence } from './retrieval-confidence.js';

/** How many paraphrases the one reformulation call is asked for. */
export const PARAPHRASE_COUNT = 2;

/**
 * Merge weights. The original is 1 and each paraphrase 0.6, which encodes one
 * property deliberately: a SINGLE paraphrase never outvotes the original at
 * the same rank, and two AGREEING paraphrases do. That is the whole bet of
 * this feature — one model rewrite is a guess, two rewrites converging on the
 * same page is evidence — expressed as arithmetic instead of prose. Equal
 * halves (0.5) would have made two agreeing paraphrases exactly tie the
 * original, i.e. leave the outcome to the tie-break, and anything above ~0.9
 * would let a single rewrite of a well-phrased question displace its head.
 */
export const ORIGINAL_QUERY_WEIGHT = 1;
export const PARAPHRASE_QUERY_WEIGHT = 0.6;

/**
 * RRF constant for the cross-leg merge. Deliberately the same k=60 the
 * in-leg fusion uses: two RRF stages with different flatness in one pipeline
 * would make the merged score impossible to reason about, and k=60 is the
 * value every measurement on this rig was taken against.
 */
export const MULTI_QUERY_RRF_K = 60;

/**
 * Each leg is retrieved this wide (or the caller's topK, whichever is
 * larger) before the merge slices back to topK. Retrieving each leg at the
 * final topK would leave the merge nothing to work with: the page the
 * paraphrase was written to find typically sits just outside the original's
 * top 5, which is the entire premise. Constant, not a knob — #1118 owns the
 * knobs; this is the width every #1112 measurement is taken at.
 */
export const DEEP_SEARCH_LEG_TOPK = 20;

/**
 * Rerank pool PER LEG (#1118 owns the knob later). The arithmetic, which is
 * the whole reason this number is what it is:
 *
 *   a single-leg search reranks `rag_rerank_candidates` = 30 documents;
 *   deep search runs 3 legs CONCURRENTLY, each with its own
 *   `RERANK_TIMEOUT_MS` = 5s budget, against one provider;
 *   so the pool the provider actually sees per gesture is 3 x this constant.
 *
 * At the original 60 that was 180 documents inside a 5s budget. Measured on
 * the #1102 rig against a local bge-reranker-v2-m3 (2000-char chunks, the
 * client's own truncation): 30 docs 2.4s, 3 x 20 = 60 docs 4.8s, 3 x 30 = 90
 * docs 7.2s, 3 x 60 = 180 docs 14.9s. The last one is why the first
 * deep+rerank measurement was void — every leg blew the budget, the aborts
 * counted as breaker failures, and the stage participated in 7 of 197
 * queries while the run still reported a number.
 *
 * 20 keeps the gesture's total at 3 x 20 = 60 documents — the same order as
 * one ordinary search, and inside the budget with ~4% headroom on that rig.
 * It is also the floor of what is useful rather than an arbitrary shrink:
 * a leg returns `DEEP_SEARCH_LEG_TOPK` = 20 rows to the merge, and the rerank
 * stage rebuilds its result from the pool alone, so a pool below 20 could
 * only rescore part of what the leg is about to hand over. Below 20 the stage
 * would be reordering a strict subset of the merge's own input; above it the
 * extra recall is bought with latency the budget does not have.
 */
export const DEEP_SEARCH_RERANK_CANDIDATES = 20;

/**
 * Reformulation budget, covering queue wait plus the request (see
 * `StreamChatOptions.timeoutMs`). Deliberately the same 5s as the rerank
 * stage: both sit in front of the user's answer, and both bypass rather than
 * delay it. A slow provider costs a deep search that behaves like a normal
 * one, never a slow ask.
 */
export const REFORMULATION_TIMEOUT_MS = 5_000;

/** Reply cap. Two short queries; anything longer is a model ignoring the brief. */
const REFORMULATION_MAX_TOKENS = 160;

/** A query longer than this is a paste, not a question — see shouldExpandQuery. */
export const MAX_EXPANDABLE_QUERY_CHARS = 1_000;

/** Longest accepted paraphrase. Longer lines are prose about the query, not a query. */
const MAX_PARAPHRASE_CHARS = 200;

/**
 * Error-message shapes. A pasted error is a LITERAL that FTS matches
 * character for character; paraphrasing it ("why does my import fail")
 * discards the one token that identifies the page, and the model reliably
 * "helpfully" rewrites error codes into prose.
 *
 * Deliberately CONSERVATIVE — every rule below needs a structural marker, not
 * a vibe. The asymmetry justifies it: a miss costs a paraphrase leg alongside
 * an original leg that still carries the literal (deep search cannot lose the
 * exact match, decision 2 above), while a false positive would silently
 * disable the feature for ordinary questions. `multi-query-search.test.ts`
 * runs this over the whole #1102 fixture and asserts zero hits on the
 * question / how-to / keywords / vocabulary-gap styles.
 *
 * Measured on that fixture: 17 of the 20 `error-text` labels, 0 of the 162
 * question / how-to / keywords / vocabulary-gap / identifier-negative ones.
 * The three it still misses are prose ABOUT an error carrying no literal at
 * all ("pino-pretty needs to be installed as a dev dependency"), and they are
 * left alone on purpose: catching them needs a phrase rule, and a phrase rule
 * measured on the same fixture takes ordinary questions with it.
 */
const ERROR_TEXT_PATTERNS: RegExp[] = [
  // `ReferenceError: x is not defined`, `Error: ENOSPC: ...`, `TypeError:`.
  // The optional prefix is what admits a BARE `Error:` — the commonest form
  // of all, and the one an earlier version of this pattern silently could not
  // match (it required at least one character before the word). Case is a
  // signal: lowercase `error:` is prose.
  /\b(?:[A-Z][A-Za-z]*)?(?:Error|Exception)\s*:/,
  // Screaming-snake error codes: FST_ERR_DEC_UNDECLARED, ERR_REQUIRE_ESM.
  // Three or more segments — two-segment shapes (NODE_ENV, MAX_RETRIES) are
  // ordinary configuration names people ask about in prose.
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}\b/,
  // Stack frames and runtime crash banners.
  /^\s*at\s+\S+\s*\(.*:\d+:\d+\)/m,
  /Traceback \(most recent call last\)/,
  /\bSegmentation fault\b|\bcore dumped\b/i,
  /\bpanic:\s|\bnil pointer dereference\b/,
  /\berror\[E\d{3,4}\]/,
  // ── Widened after the first #1112 measurement ────────────────────────────
  // Three of the ten R@5 regressions were error-text queries this list did
  // not catch, and each carried a structural marker the rules above simply
  // did not name. Every rule below is still a MARKER, not a vibe: a phrase
  // detector ("cannot", "failed to", "is not defined") was measured on the
  // fixture and fired on three ordinary questions, so it was rejected.
  //
  // A pasted code comment. `//` and `/*` only — a bare `#` is prose ("# of
  // retries") far more often than it is a shell comment.
  /^\s*(?:\/\/|\/\*)/,
  // A GNU long option (`--watch`, `--no-color`). A flag is a literal the
  // user copied out of a terminal, and FTS matches it character for
  // character. Anchored to start-or-space so an em-dash typed as `--` and a
  // hyphenated word cannot match.
  /(?:^|\s)--[a-z][a-z0-9]+(?:-[a-z0-9]+)*\b/,
  // An IANA media type (`application/json`, `text/html`). Closed list of
  // top-level types, so an ordinary `and/or` or `client/server` cannot hit.
  /\b(?:application|text|image|audio|video|multipart)\/[a-z0-9][a-z0-9.+-]*\b/,
  // A single-quoted contiguous identifier — the shape validators and runtimes
  // quote in their messages (`required property 'name'`, `Cannot access
  // '__vi_import_0__'`). DOUBLE-quoted text is already handled upstream:
  // `detectIdentifiers` reads a quoted phrase as a title, so `shouldExpandQuery`
  // skips it as `identifier`. The character class excludes whitespace, which is
  // what keeps prose apostrophes out: "it's the server's job" offers no
  // closing quote for a run that cannot cross a space.
  /'[A-Za-z_$][\w$.]*'/,
  // A SOURCE PATH — a directory separator AND a code extension. The
  // separator is load-bearing: a bare filename is something people ask about
  // in prose (the fixture's own "how to load values from a .env file inside
  // vite.config.js"), a path is something they pasted out of a stack trace.
  /\b[\w.-]+\/[\w.-]+\.(?:[jt]sx?|mjs|cjs|json|ya?ml|toml|py|go|rs|rb|php|sh|css|scss|html)\b/,
  // A constructor expression (`new MockedClass()`). Deliberately not the JS
  // keywords `typeof` / `instanceof`, which are legitimate things to ASK
  // about; an instantiated call is code that was copied, not typed.
  /\bnew\s+[A-Z][\w$]*\s*\(/,
  // A host:port literal (`localhost:51204`). The port is the token.
  /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)[:/]\d{2,5}\b/,
];

export function looksLikeErrorText(query: string): boolean {
  return ERROR_TEXT_PATTERNS.some((p) => p.test(query));
}

/** Why expansion stood down — recorded on the span, and the unit under test. */
export type ExpansionSkipReason = 'identifier' | 'error_text' | 'too_long' | 'empty';

/**
 * Whether this query should be paraphrased at all. Returns the reason when
 * not, because "skipped" and "failed" are different facts and a trace that
 * cannot tell them apart cannot answer "is deep search working here".
 *
 * Identifier queries are excluded because #1107 pins a VERIFIED exact match
 * ahead of the fused order for them: an exact identifier has nothing to gain
 * from a paraphrase, and paraphrasing "INC-2203" produces legs that dilute
 * the very row the pin exists to lead with. Detection, not the pin itself, is
 * the test available here — expansion runs BEFORE retrieval — and that is the
 * conservative direction: detection is the pin's necessary condition, so
 * every query that WOULD pin is skipped, plus a few that would not.
 * `spaceKey` detections are excluded from the check exactly as the pin stage
 * excludes them (a space is not a page, and they verify nothing).
 */
export function shouldExpandQuery(
  query: string,
): { expand: true } | { expand: false; reason: ExpansionSkipReason } {
  const trimmed = query.trim();
  if (trimmed.length === 0) return { expand: false, reason: 'empty' };
  if (trimmed.length > MAX_EXPANDABLE_QUERY_CHARS) return { expand: false, reason: 'too_long' };
  if (looksLikeErrorText(trimmed)) return { expand: false, reason: 'error_text' };
  if (detectIdentifiers(trimmed).some((d) => d.kind !== 'spaceKey')) {
    return { expand: false, reason: 'identifier' };
  }
  return { expand: true };
}

const REFORMULATION_SYSTEM_PROMPT = [
  'You rewrite a knowledge-base search query into alternative phrasings of the SAME question.',
  `Reply with exactly ${PARAPHRASE_COUNT} rewrites, one per line, and nothing else:`,
  'no numbering, no bullets, no quotes, no commentary, no blank lines.',
  'Each rewrite must be a standalone search query in the same language as the original,',
  'must keep every literal identifier, product name, error code and version number unchanged,',
  'and should prefer different wording for the concepts (synonyms, the formal term, the',
  'colloquial term) so that a different phrasing of the same page can be found.',
  'Never answer the question.',
].join(' ');

/** Numbering, bullets, and the wrapping quotes models add despite the brief. */
const LIST_MARKER = /^\s*(?:[-*•–]|\d+[.)])\s*/;
const WRAPPING_QUOTES = /^["'“”‘’`]+|["'“”‘’`]+$/g;
const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi;

/**
 * Turn a reply into at most {@link PARAPHRASE_COUNT} usable queries.
 *
 * Pure and total: anything unusable is dropped rather than thrown on, because
 * the caller's only response to "unparseable" is the same soft-fail as a
 * timeout. A line that merely repeats the original is dropped too — it would
 * cost a full retrieval to add a duplicate of leg 0 and, worse, would DOUBLE
 * the original's weight in the merge under a paraphrase's label.
 */
export function parseReformulations(reply: string, original: string): string[] {
  const normalized = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const seen = new Set<string>([normalized(original)]);
  const out: string[] = [];
  for (const rawLine of reply.replace(THINK_BLOCK, '').split('\n')) {
    const line = rawLine
      .replace(LIST_MARKER, '')
      .replace(WRAPPING_QUOTES, '')
      .trim()
      .replace(/\s+/g, ' ');
    if (line.length < 3 || line.length > MAX_PARAPHRASE_CHARS) continue;
    // A trailing colon marks a preamble ("Here are two rewrites:"), never a query.
    if (line.endsWith(':')) continue;
    const key = normalized(line);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length === PARAPHRASE_COUNT) break;
  }
  return out;
}

/**
 * One chat call, on the `chat` use case (ADR-021). Deliberately NOT a new use
 * case: reformulation is a one-sentence rewrite that any model serving chat
 * can do, and a sixth assignment would be a knob every operator has to
 * understand before deep search works at all.
 *
 * Soft-fail is total — an unassigned provider, an open breaker, a timeout, a
 * refusal, or two lines of apology all return `[]`, and `[]` means the caller
 * runs exactly today's single-query search.
 */
export async function reformulateQuery(question: string): Promise<string[]> {
  try {
    const { config, model } = await resolveUsecase('chat');
    // The question is user input on its way to a model: same guard the ask
    // prompt gets. The paraphrases derived from it are only ever used as
    // RETRIEVAL queries (parameterized SQL, embeddings, the rerank query),
    // never spliced back into a prompt.
    const { sanitized } = sanitizeLlmInput(question);
    const messages: ChatMessage[] = [
      { role: 'system', content: REFORMULATION_SYSTEM_PROMPT },
      { role: 'user', content: sanitized },
    ];
    const reply = await chat(config, model, messages, {
      maxTokens: REFORMULATION_MAX_TOKENS,
      timeoutMs: REFORMULATION_TIMEOUT_MS,
    });
    const paraphrases = parseReformulations(reply, question);
    if (paraphrases.length === 0) {
      logger.warn(
        { reply: reply.slice(0, 200) },
        'Query reformulation produced no usable paraphrase — deep search degrades to the original query',
      );
    }
    return paraphrases;
  } catch (err) {
    // Every neighbouring stage's contract: a ranking nicety is never worth
    // failing a retrieval over.
    logger.warn({ err }, 'Query reformulation failed — deep search degrades to the original query');
    return [];
  }
}

/**
 * What expansion did on this request. `unavailable` is the soft-fail branch
 * (no `chat` assignment, breaker open, timeout, unusable reply) and is
 * deliberately distinct from every `skip` reason: skipping is a decision about
 * the query, failing is a fact about the provider, and a rig that cannot tell
 * them apart reports a plain run as a deep one.
 */
export type ExpansionOutcome =
  | { expanded: true; paraphrases: string[] }
  | { expanded: false; reason: ExpansionSkipReason | 'unavailable' };

export interface MultiQuerySearchOptions extends HybridSearchOptions {
  /**
   * Observer for {@link ExpansionOutcome}, fired once per search. The eval
   * runner's participation guard reads it: a `--deep-search` run in which
   * expansion never once happened is a plain run wearing the wrong label —
   * the silent-lie class the vector-participation and rerank guards exist
   * for. Guarded like `onRetrievalMeta`: a throwing observer must not turn a
   * completed retrieval into a 500.
   */
  onExpansion?: (outcome: ExpansionOutcome) => void;
}

/** One retrieved leg and the weight its ranks carry into the merge. */
export interface MultiQueryLeg {
  results: SearchResult[];
  weight: number;
}

/**
 * Fuse the legs by SUMMING each page's weighted reciprocal rank.
 *
 * Rank, not the incoming `score`: a leg's array order is the pipeline's final
 * verdict (rerank, ranking prior and MMR all reorder rows whose fusion
 * `score` no longer describes that order), so position is the only per-leg
 * ranking signal that stays true. The row OBJECT kept for a page is the one
 * from the earliest leg it appeared in — the original leg first, which is
 * also the only leg whose assembled context, pins and confidence were
 * computed against the query the user actually typed.
 *
 * Ties break toward the original leg (leg index, then rank, then pageId) so
 * the order is total and reproducible: a coin-flip between two equal sums
 * would make two identical deep searches return different heads.
 */
export function mergeMultiQueryResults(
  legs: MultiQueryLeg[],
  topK: number,
  k: number = MULTI_QUERY_RRF_K,
): SearchResult[] {
  const merged = new Map<
    number,
    { score: number; row: SearchResult; legIndex: number; rank: number }
  >();
  legs.forEach((leg, legIndex) => {
    leg.results.forEach((row, rank) => {
      const contribution = leg.weight / (k + rank + 1);
      const existing = merged.get(row.pageId);
      if (existing) {
        existing.score += contribution;
      } else {
        merged.set(row.pageId, { score: contribution, row, legIndex, rank });
      }
    });
  });
  return [...merged.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.legIndex - b.legIndex ||
        a.rank - b.rank ||
        a.row.pageId - b.row.pageId,
    )
    .slice(0, Math.max(0, topK))
    .map((e) => ({ ...e.row, score: e.score }));
}

/**
 * Deep search: a drop-in for `hybridSearch` — same parameter list, same return
 * type, same soft-fail temperament — used by the ask path when `deepSearch` is
 * set. The signature is copied deliberately: when expansion is skipped or
 * fails, this function IS `hybridSearch(...arguments)`, analytics row
 * included, and a matching signature is what keeps that claim checkable at the
 * call site instead of resting on an adapter.
 */
export async function multiQuerySearch(
  userId: string,
  question: string,
  topK = 5,
  precomputedCoverage?: EmbeddingCoverage | null,
  opts?: MultiQuerySearchOptions,
): Promise<SearchResult[]> {
  return withSpan('rag.multi_query_search', async (span) => {
    const report = (outcome: ExpansionOutcome) => {
      try {
        opts?.onExpansion?.(outcome);
      } catch (err) {
        logger.warn({ err }, 'onExpansion observer threw — ignored');
      }
    };
    const decision = shouldExpandQuery(question);
    if (!decision.expand) {
      span?.setAttribute('rag.expansion', 'skipped');
      span?.setAttribute('rag.expansion_skip_reason', decision.reason);
      report({ expanded: false, reason: decision.reason });
      return hybridSearch(userId, question, topK, precomputedCoverage, opts);
    }

    const paraphrases = await reformulateQuery(question);
    if (paraphrases.length === 0) {
      span?.setAttribute('rag.expansion', 'unavailable');
      report({ expanded: false, reason: 'unavailable' });
      return hybridSearch(userId, question, topK, precomputedCoverage, opts);
    }
    span?.setAttribute('rag.expansion', 'expanded');
    span?.setAttribute('rag.expansion_legs', paraphrases.length + 1);
    report({ expanded: true, paraphrases });

    const legTopK = Math.max(topK, DEEP_SEARCH_LEG_TOPK);
    const legOpts: HybridSearchOptions = {
      ...opts,
      rerankCandidatesOverride: DEEP_SEARCH_RERANK_CANDIDATES,
      // One gesture, one analytics row — written below for the merged set.
      recordAnalytics: false,
    };
    // The ORIGINAL leg alone reports retrieval health to the caller: the
    // #1105 gate asks "was retrieval healthy for this ask", and three
    // callbacks would hand it three answers for one question. Its meta also
    // fills the analytics row's degraded/coverage columns.
    //
    // Object holder, not a bare `let`, for the reason the ask route documents
    // at its own call site: TS cannot see the synchronous callback assignment
    // and narrows a bare variable to its `null` initializer.
    const retrieval: { meta: RetrievalMeta | null } = { meta: null };
    const legs = await Promise.all([
      hybridSearch(userId, question, legTopK, precomputedCoverage, {
        ...legOpts,
        onRetrievalMeta: (meta) => {
          retrieval.meta = meta;
          opts?.onRetrievalMeta?.(meta);
        },
      }),
      ...paraphrases.map((p) =>
        // The caller's coverage reading travels to every leg (one corpus, one
        // probe); the caller's onRetrievalMeta does not — see above.
        hybridSearch(userId, p, legTopK, precomputedCoverage, {
          ...legOpts,
          onRetrievalMeta: undefined,
          // #1115 P3 — the image leg runs on the ORIGINAL question only, and
          // exactly once per deep search. Two reasons, and the first is the
          // one that matters at query time: paraphrasing is a TEXT technique
          // (see the vocabulary-gap premise above), so three VL calls would
          // buy three near-identical query vectors at 3x the cost and 3x the
          // chance of blowing IMAGE_LEG_TIMEOUT_MS.
          //
          // The second is about ranking rather than cost. This merge SUMS
          // weighted per-leg ranks, so a page fed to all three legs by the
          // same image evidence would collect 1 + 0.6 + 0.6 = 2.2 of it —
          // agreement across phrasings is the signal this feature reads, and
          // one piece of evidence repeated three times is not agreement. On
          // the original leg alone it enters once at weight 1, exactly like
          // the original leg's text evidence, and the merged row keeps its
          // `imageHits` because `mergeMultiQueryResults` keeps the object from
          // the earliest leg a page appeared in — which is this one.
          imageLeg: false,
        }),
      ),
    ]);

    const merged = mergeMultiQueryResults(
      legs.map((results, i) => ({
        results,
        weight: i === 0 ? ORIGINAL_QUERY_WEIGHT : PARAPHRASE_QUERY_WEIGHT,
      })),
      topK,
    );

    // The one row this gesture files, under the USER's query and under the
    // `hybrid_multi_query` unit — its max_score is a summed multi-leg value
    // and is not comparable with a single-query fusion score.
    const meta = retrieval.meta;
    // Benchmark and other internal callers can deliberately opt out of
    // analytics. The ordinary chat path keeps the one-gesture/one-row
    // contract; a benchmark must not make its synthetic replays look like
    // real user searches or pollute the query distribution it measures.
    if (opts?.recordAnalytics !== false) {
      // #1284 — the verdict recorded here is the one the ROUTE's gate will
      // compute: over the MERGED set (what the caller gets back and what the
      // gate measures), with the ORIGINAL leg's health caveat (the same
      // reason that leg alone reports health — three legs would hand the gate
      // three answers to one question). Computing it from a leg, or from the
      // legs' own suppressed rows, would publish a distribution the gate
      // never used.
      const confidence = computeRetrievalConfidence(merged, meta?.healthCaveat ?? null);
      trackSearchAnalytics(
        userId,
        question,
        merged.length,
        merged.length > 0 ? Math.max(...merged.map((r) => r.score)) : null,
        'hybrid_multi_query',
        {
          rerankScore: merged.reduce<number | null>(
            (max, r) => (r.rerankScore != null && (max === null || r.rerankScore > max) ? r.rerankScore : max),
            null,
          ),
          degradedReason: meta?.degradedReason ?? null,
          embeddingCoverage: meta?.embeddingCoverage ?? null,
          confidence: confidence.score,
          confidenceBasis: confidence.basis,
          surface: opts?.surface ?? null,
        },
      );
    }
    return merged;
  }, { 'rag.top_k': topK });
}
