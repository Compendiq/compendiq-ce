import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SearchResult } from './rag-service.js';
// #1718 — the pin stage's own trigger, unstubbed: a stub leg pins exactly
// when the real stage would (see `pinStageLeg` below).
import { detectIdentifiers } from './identifier-shortcircuit.js';

// Closed stubs: this suite is about the wrapper, so retrieval and the chat
// client are boundaries. Nothing below them is exercised here — the legs'
// own behaviour is rag-service's suite.
const mockHybridSearch = vi.fn();
const mockTrackSearchAnalytics = vi.fn();
vi.mock('./rag-service.js', () => ({
  hybridSearch: (...args: unknown[]) => mockHybridSearch(...args),
  trackSearchAnalytics: (...args: unknown[]) => mockTrackSearchAnalytics(...args),
}));

const mockChat = vi.fn();
vi.mock('./openai-compatible-client.js', () => ({
  chat: (...args: unknown[]) => mockChat(...args),
}));

const mockResolveUsecase = vi.fn(async () => ({
  config: {
    providerId: 'p1', baseUrl: 'http://x/v1', apiKey: null,
    authType: 'none', verifySsl: true, name: 'X', defaultModel: 'm',
  },
  model: 'm',
}));
vi.mock('./llm-provider-resolver.js', () => ({
  resolveUsecase: (...args: unknown[]) => mockResolveUsecase(...(args as [])),
}));

const {
  multiQuerySearch,
  mergeMultiQueryResults,
  parseReformulations,
  shouldExpandQuery,
  looksLikeErrorText,
  ORIGINAL_QUERY_WEIGHT,
  PARAPHRASE_QUERY_WEIGHT,
  MULTI_QUERY_RRF_K,
  DEEP_SEARCH_LEG_TOPK,
  DEEP_SEARCH_RERANK_CANDIDATES,
  REFORMULATION_TIMEOUT_MS,
  PARAPHRASE_COUNT,
} = await import('./multi-query-search.js');
const { RAG_RERANK_CANDIDATES_DEFAULT } = await import('../../../core/services/admin-settings-service.js');
// The formula's own leaf module (#1268): rag-service is stubbed above, so the
// verdict this suite compares against has to come from where the wrapper
// imports it — not from the stub.
const { computeRetrievalConfidence } = await import('./retrieval-confidence.js');

function row(pageId: number, over: Partial<SearchResult> = {}): SearchResult {
  return {
    pageId,
    confluenceId: `c${pageId}`,
    chunkText: `chunk ${pageId}`,
    pageTitle: `Page ${pageId}`,
    sectionTitle: `Section ${pageId}`,
    spaceKey: 'ENG',
    score: 0.0328,
    vectorScore: 0.5,
    keywordRank: null,
    ...over,
  } as SearchResult;
}

/** A leg's ranking, given as page ids in order. */
const leg = (weight: number, ...pageIds: number[]) => ({
  results: pageIds.map((id) => row(id)),
  weight,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockHybridSearch.mockResolvedValue([]);
});

describe('mergeMultiQueryResults (#1112) — the merge rule', () => {
  /**
   * The reason this feature sums instead of de-duplicating, pinned as a test
   * because it is invisible in the output shape: both merges return the same
   * SET of pages, in a different ORDER.
   *
   * Page 20 is ranked 5th by all three phrasings — nobody's favourite, but
   * everybody's candidate. Page 10 is the original phrasing's top hit and
   * neither paraphrase found it at all. Agreement across phrasings is the
   * only new evidence multi-query expansion produces, so page 20 must win;
   * under any merge that keeps one entry per page and ranks by its best
   * position (a plain dedupe, or a max instead of a sum) page 10 leads and
   * the feature has retrieved three times for nothing.
   */
  it('ranks a page found mid-pack by ALL THREE phrasings above one top-ranked by a single leg', () => {
    const legs = [
      leg(ORIGINAL_QUERY_WEIGHT, 10, 11, 12, 13, 20),
      leg(PARAPHRASE_QUERY_WEIGHT, 31, 32, 33, 34, 20),
      leg(PARAPHRASE_QUERY_WEIGHT, 41, 42, 43, 44, 20),
    ];

    const merged = mergeMultiQueryResults(legs, 5);
    expect(merged[0]!.pageId).toBe(20);

    // And the two rejected merges, computed here rather than described, so
    // the assertion above is known to DISCRIMINATE rather than merely pass.
    const dedupeByFirstAppearance = [
      ...new Map(legs.flatMap((l) => l.results).map((r) => [r.pageId, r])).values(),
    ];
    expect(dedupeByFirstAppearance[0]!.pageId).toBe(10);

    const bestContributionPerPage = new Map<number, number>();
    for (const l of legs) {
      l.results.forEach((r, rank) => {
        const c = l.weight / (MULTI_QUERY_RRF_K + rank + 1);
        bestContributionPerPage.set(r.pageId, Math.max(bestContributionPerPage.get(r.pageId) ?? 0, c));
      });
    }
    const byMax = [...bestContributionPerPage.entries()].sort((a, b) => b[1] - a[1]);
    expect(byMax[0]![0]).toBe(10);
  });

  it('holds even when the single-leg rival outranks the consensus page in its own leg', () => {
    // Page 11 is the original's rank 3 — better than page 20's rank 5 in
    // every leg it appears in, so max-of-contributions still prefers it.
    // Summing is what turns three mid-pack appearances into a lead.
    const legs = [
      leg(ORIGINAL_QUERY_WEIGHT, 10, 11, 20),
      leg(PARAPHRASE_QUERY_WEIGHT, 31, 32, 20),
      leg(PARAPHRASE_QUERY_WEIGHT, 41, 42, 20),
    ];
    const merged = mergeMultiQueryResults(legs, 5).map((r) => r.pageId);
    expect(merged.indexOf(20)).toBeLessThan(merged.indexOf(11));
  });

  it('weights the original above a paraphrase: one rewrite never outvotes it at equal rank, two agreeing rewrites do', () => {
    const singleRewrite = mergeMultiQueryResults(
      [leg(ORIGINAL_QUERY_WEIGHT, 10), leg(PARAPHRASE_QUERY_WEIGHT, 20)],
      5,
    );
    expect(singleRewrite.map((r) => r.pageId)).toEqual([10, 20]);

    const twoAgreeing = mergeMultiQueryResults(
      [leg(ORIGINAL_QUERY_WEIGHT, 10), leg(PARAPHRASE_QUERY_WEIGHT, 20), leg(PARAPHRASE_QUERY_WEIGHT, 20)],
      5,
    );
    expect(twoAgreeing.map((r) => r.pageId)).toEqual([20, 10]);
    expect(PARAPHRASE_QUERY_WEIGHT).toBeLessThan(ORIGINAL_QUERY_WEIGHT);
    expect(2 * PARAPHRASE_QUERY_WEIGHT).toBeGreaterThan(ORIGINAL_QUERY_WEIGHT);

    // The behavioural half of the same rule, and the one that fails if the
    // weights are ever equalised: a paraphrase's TOP hit does not displace
    // the original's second — one rewrite is a guess about what the user
    // meant, and the user's own words outrank it by a rank's worth of margin.
    const paraphraseTopVsOriginalSecond = mergeMultiQueryResults(
      [leg(ORIGINAL_QUERY_WEIGHT, 9, 10), leg(PARAPHRASE_QUERY_WEIGHT, 20)],
      5,
    );
    expect(paraphraseTopVsOriginalSecond.map((r) => r.pageId)).toEqual([9, 10, 20]);
  });

  it('keeps the ORIGINAL leg\'s row object for a page both legs returned', () => {
    // The original leg is the only one whose assembled context was built
    // against the query the user actually typed.
    const legs = [
      { results: [row(7, { contextText: 'assembled for the real question' })], weight: ORIGINAL_QUERY_WEIGHT },
      { results: [row(7, { contextText: 'assembled for a paraphrase' })], weight: PARAPHRASE_QUERY_WEIGHT },
    ];
    const [merged] = mergeMultiQueryResults(legs, 5);
    expect(merged!.contextText).toBe('assembled for the real question');
    // …carrying the SUMMED score, which is the merged ordering value.
    expect(merged!.score).toBeCloseTo(
      (ORIGINAL_QUERY_WEIGHT + PARAPHRASE_QUERY_WEIGHT) / (MULTI_QUERY_RRF_K + 1),
      9,
    );
  });

  it('is total and reproducible: equal sums break toward the original leg', () => {
    const legs = [leg(ORIGINAL_QUERY_WEIGHT, 10, 11), leg(ORIGINAL_QUERY_WEIGHT, 11, 10)];
    expect(mergeMultiQueryResults(legs, 5).map((r) => r.pageId)).toEqual([10, 11]);
    expect(mergeMultiQueryResults([...legs].reverse(), 5).map((r) => r.pageId)).toEqual([11, 10]);
  });

  it('slices to topK', () => {
    expect(mergeMultiQueryResults([leg(1, 1, 2, 3, 4)], 2)).toHaveLength(2);
    expect(mergeMultiQueryResults([leg(1, 1, 2)], 0)).toHaveLength(0);
  });
});

describe('shouldExpandQuery (#1112) — what must never be paraphrased', () => {
  it('skips exact-identifier queries, which #1107 pins instead', () => {
    expect(shouldExpandQuery('"Deployment Runbook"')).toEqual({ expand: false, reason: 'identifier' });
    expect(shouldExpandQuery('page called Detecting When Clients Abort')).toEqual({ expand: false, reason: 'identifier' });
    expect(shouldExpandQuery('INC-2203')).toEqual({ expand: false, reason: 'identifier' });
    expect(shouldExpandQuery('page 123456')).toEqual({ expand: false, reason: 'identifier' });
  });

  it('does NOT skip on a space-key detection alone — a space is not a page, and the pin stage ignores them too', () => {
    expect(shouldExpandQuery('deployment steps in ENG').expand).toBe(true);
  });

  it('skips pasted error text, where the literal IS the match', () => {
    for (const q of [
      'FST_ERR_DEC_ALREADY_PRESENT',
      'ReferenceError: __dirname is not defined',
      'Error: ENOSPC: System limit for number of file watchers reached',
      'Segmentation fault (core dumped) running vitest',
      'Traceback (most recent call last)\n  File "x.py", line 3',
      '    at handler (/srv/app/routes.js:31:14)',
      // The shapes the first #1112 measurement caught this list missing —
      // three of its ten R@5 regressions were error-text queries whose
      // literals FTS was matching and the paraphrases threw away.
      '// bad, nothing is assignable to never (except for itself)',
      'You cannot use this option with --watch enabled',
      'Fastify process remaining stuck after receiving Content-Type application/json',
      "body should have required property 'name'",
      "Cannot access '__vi_import_0__' before initialization",
      'Timeout leaking in test/checkout-screen.test.tsx',
      'new MockedClass() instanceof MockedClass returns false',
      'vitest ui localhost:51204 token error',
    ]) {
      expect(shouldExpandQuery(q), q).toEqual({ expand: false, reason: 'error_text' });
    }
  });

  /**
   * The widened rules' own failure mode. A single-quoted identifier is a
   * literal; a prose apostrophe is not, and the two are the same character.
   * What separates them is that the quoted-run character class cannot cross a
   * space, so "the server's job" offers no closing quote — worth pinning,
   * because widening the class to admit `'user id'` would silently turn this
   * guard into one that suppresses ordinary English.
   */
  it('does not read prose apostrophes, hyphens or filenames as pasted error text', () => {
    for (const q of [
      "what's the difference between vite's ssr build and the client's",
      "why doesn't fastify's decorator survive the plugin's scope",
      'how to load values from a .env file inside vite.config.js',
      'fastify — what does the docs style guide say about wording',
      'client/server split in a vite app',
      'when should I use typeof versus instanceof in typescript',
    ]) {
      expect(shouldExpandQuery(q).expand, q).toBe(true);
    }
  });

  it('skips a paste rather than a question, and an empty query', () => {
    expect(shouldExpandQuery('x '.repeat(600))).toEqual({ expand: false, reason: 'too_long' });
    expect(shouldExpandQuery('   ')).toEqual({ expand: false, reason: 'empty' });
  });

  /**
   * The false-positive test, run against the real #1102 fixture rather than
   * against invented examples: a detector that quietly disabled expansion for
   * ordinary questions would leave the feature measuring as a no-op, and the
   * `vocabulary-gap` slice is the exact population it exists to serve.
   */
  it('expands every question, how-to, keyword and vocabulary-gap query in the fixture', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('../eval/fixture.json', import.meta.url), 'utf8'),
    ) as { labels: Array<{ query: string; style: string }> };
    const mustExpand = fixture.labels.filter((l) =>
      ['question', 'how-to', 'keywords', 'vocabulary-gap', 'identifier-negative'].includes(l.style),
    );
    expect(mustExpand.length).toBeGreaterThan(150);
    expect(mustExpand.filter((l) => !shouldExpandQuery(l.query).expand)).toEqual([]);
  });

  it('recognises the fixture\'s literal error strings', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('../eval/fixture.json', import.meta.url), 'utf8'),
    ) as { labels: Array<{ query: string; style: string }> };
    const errors = fixture.labels.filter((l) => l.style === 'error-text');
    // 17 of 20, measured. The three left are prose ABOUT an error carrying no
    // literal at all ("pino-pretty needs to be installed as a dev dependency")
    // and are deliberately not chased: the only rule that reaches them is a
    // phrase rule, and a phrase rule measured on this same fixture fires on
    // ordinary questions. Ratchet, not a range — a widening that drops one of
    // the 17 should have to say so.
    expect(errors.filter((l) => looksLikeErrorText(l.query)).length).toBeGreaterThanOrEqual(17);
  });
});

describe('parseReformulations (#1112)', () => {
  it('takes two clean lines', () => {
    expect(parseReformulations('how do I stop the server cleanly\ngraceful shutdown fastify', 'q'))
      .toEqual(['how do I stop the server cleanly', 'graceful shutdown fastify']);
  });

  it('strips numbering, bullets and the quotes models add anyway', () => {
    expect(parseReformulations('1. "first rewrite"\n- second rewrite', 'q'))
      .toEqual(['first rewrite', 'second rewrite']);
  });

  it('drops a preamble line and blank lines', () => {
    expect(parseReformulations('Here are two rewrites:\n\nfirst rewrite\n\nsecond rewrite\n', 'q'))
      .toEqual(['first rewrite', 'second rewrite']);
  });

  it('strips a reasoning block a model emits despite thinking being off', () => {
    expect(parseReformulations('<think>the user wants…</think>\nfirst rewrite\nsecond rewrite', 'q'))
      .toEqual(['first rewrite', 'second rewrite']);
  });

  it('drops a rewrite that merely repeats the original — it would double the original\'s weight under a paraphrase label', () => {
    expect(parseReformulations('  How Do I   Restart It?\nrestart procedure', 'how do i restart it?'))
      .toEqual(['restart procedure']);
  });

  it('drops duplicates, over-long lines and returns at most two', () => {
    expect(parseReformulations('a rewrite\na rewrite\nanother rewrite\na third rewrite', 'q'))
      .toEqual(['a rewrite', 'another rewrite']);
    expect(parseReformulations(`${'x'.repeat(300)}\nshort rewrite`, 'q')).toEqual(['short rewrite']);
  });

  it('returns [] for anything unusable — the caller\'s only response is the soft-fail path', () => {
    expect(parseReformulations('', 'q')).toEqual([]);
    expect(parseReformulations('Sure, here you go:', 'q')).toEqual([]);
  });
});

describe('multiQuerySearch (#1112)', () => {
  const optsIn = { rerank: true, assembleContext: true, pinIdentifiers: true };

  it('issues NO chat call and exactly one retrieval when expansion is skipped', async () => {
    mockHybridSearch.mockResolvedValue([row(1)]);
    const out = await multiQuerySearch('u1', 'INC-2203', 5, undefined, optsIn);

    expect(mockChat).not.toHaveBeenCalled();
    expect(mockHybridSearch).toHaveBeenCalledTimes(1);
    // Byte-identical to the single-query path, options untouched: no widened
    // leg, no rerank floor, and the leg keeps its own analytics row.
    expect(mockHybridSearch).toHaveBeenCalledWith('u1', 'INC-2203', 5, undefined, optsIn);
    expect(mockTrackSearchAnalytics).not.toHaveBeenCalled();
    expect(out).toEqual([row(1)]);
  });

  it('soft-fails to the original query alone when reformulation throws', async () => {
    mockHybridSearch.mockResolvedValue([row(1)]);
    mockChat.mockRejectedValue(new Error('circuit breaker open'));

    const out = await multiQuerySearch('u1', 'how do I restart the ingest worker', 5, undefined, optsIn);

    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(mockHybridSearch).toHaveBeenCalledTimes(1);
    expect(mockHybridSearch).toHaveBeenCalledWith('u1', 'how do I restart the ingest worker', 5, undefined, optsIn);
    expect(out).toEqual([row(1)]);
  });

  it('soft-fails the same way when the provider is unassigned, or answers with nothing usable', async () => {
    mockHybridSearch.mockResolvedValue([row(1)]);
    mockResolveUsecase.mockRejectedValueOnce(new Error('no chat assignment'));
    await multiQuerySearch('u1', 'how do I restart the ingest worker', 5, undefined, optsIn);
    expect(mockHybridSearch).toHaveBeenCalledTimes(1);
    expect(mockChat).not.toHaveBeenCalled();

    mockHybridSearch.mockClear();
    mockChat.mockResolvedValue('Sure, here are some rewrites:');
    await multiQuerySearch('u1', 'how do I restart the ingest worker', 5, undefined, optsIn);
    expect(mockHybridSearch).toHaveBeenCalledTimes(1);
  });

  it('retrieves three legs from ONE chat call, and only the original leg reports health', async () => {
    mockChat.mockResolvedValue('restarting the ingest worker\ningest worker restart procedure');
    mockHybridSearch.mockResolvedValue([row(1)]);
    const onRetrievalMeta = vi.fn();

    await multiQuerySearch('u1', 'how do I restart the ingest worker', 5, undefined, {
      ...optsIn,
      onRetrievalMeta,
    });

    expect(mockChat).toHaveBeenCalledTimes(1);
    // The budget covers queue wait — a raced timer would strand a queue slot.
    expect(mockChat.mock.calls[0]![3]).toMatchObject({ timeoutMs: REFORMULATION_TIMEOUT_MS });
    expect(mockHybridSearch).toHaveBeenCalledTimes(3);

    const queries = mockHybridSearch.mock.calls.map((c) => c[1]);
    expect(queries).toEqual([
      'how do I restart the ingest worker',
      'restarting the ingest worker',
      'ingest worker restart procedure',
    ]);
    for (const call of mockHybridSearch.mock.calls) {
      expect(call[2]).toBe(DEEP_SEARCH_LEG_TOPK);
      expect(call[4]).toMatchObject({
        rerank: true,
        assembleContext: true,
        rerankCandidatesOverride: DEEP_SEARCH_RERANK_CANDIDATES,
        // One gesture, one analytics row — see below.
        recordAnalytics: false,
      });
    }
    // #1718: the caller's pin request reaches the ORIGINAL leg only; a
    // paraphrase leg is a model's words, and never pins.
    expect(mockHybridSearch.mock.calls[0]![4].pinIdentifiers).toBe(true);
    expect(mockHybridSearch.mock.calls[1]![4].pinIdentifiers).toBe(false);
    expect(mockHybridSearch.mock.calls[2]![4].pinIdentifiers).toBe(false);
    expect(mockHybridSearch.mock.calls[0]![4].onRetrievalMeta).toBeTypeOf('function');
    expect(mockHybridSearch.mock.calls[1]![4].onRetrievalMeta).toBeUndefined();
    expect(mockHybridSearch.mock.calls[2]![4].onRetrievalMeta).toBeUndefined();
  });

  it('expands the TEXT legs only — no leg carries an image-leg knob (#1618 stage 2)', async () => {
    // #1115 P3 ran a VL image query on the ORIGINAL leg and forced it off on
    // the paraphrases, because this merge SUMS weighted per-leg ranks: the
    // same image evidence fed to all three would have entered at
    // 1 + 0.6 + 0.6, as if three phrasings had independently agreed. The leg
    // is retired, so the surviving property is that expansion asks three TEXT
    // legs and passes no image knob at all — `hybridSearch` would ignore one
    // silently, and a reviewer would read it as still live.
    mockChat.mockResolvedValue('restarting the ingest worker\ningest worker restart procedure');
    mockHybridSearch.mockResolvedValue([row(1)]);

    await multiQuerySearch('u1', 'how do I restart the ingest worker', 5, undefined, optsIn);

    expect(mockHybridSearch).toHaveBeenCalledTimes(3);
    for (const call of mockHybridSearch.mock.calls) {
      expect(Object.keys(call[4] as object)).not.toContain('imageLeg');
    }
  });

  /**
   * The pool arithmetic, pinned as arithmetic rather than as a magic number.
   * The legs run CONCURRENTLY against one provider and one RERANK_TIMEOUT_MS,
   * so what the reranker sees per gesture is legs x pool — the quantity that
   * has to stay near a single search's, not the per-leg figure.
   */
  it('keeps the whole gesture\'s rerank pool near ONE search\'s, not N times it (#1112)', async () => {
    const legs = PARAPHRASE_COUNT + 1;
    // Measured on the #1102 rig (bge-reranker-v2-m3, 2000-char chunks):
    // 3 x 20 docs = 4.8s, 3 x 30 = 7.2s, 3 x 60 = 14.9s, against a 5s budget.
    expect(legs * DEEP_SEARCH_RERANK_CANDIDATES).toBeLessThanOrEqual(2 * RAG_RERANK_CANDIDATES_DEFAULT);
    // …and never below what the leg is about to hand the merge: the stage
    // rebuilds its result from the pool alone, so a pool under the leg's own
    // topK would rescore a strict subset of the merge's input.
    expect(DEEP_SEARCH_RERANK_CANDIDATES).toBeGreaterThanOrEqual(DEEP_SEARCH_LEG_TOPK);
  });

  it('files ONE analytics row, under the user\'s own query and its own unit', async () => {
    mockChat.mockResolvedValue('first rewrite\nsecond rewrite');
    mockHybridSearch.mockImplementation(async (_u, _q, _k, _c, opts) => {
      opts?.onRetrievalMeta?.({
        degradedReason: null, healthCaveat: null, searchType: 'hybrid',
        embeddingCoverage: 1, aclEmptied: false,
      });
      return [row(1, { rerankScore: 0.71 })];
    });

    await multiQuerySearch('u1', 'the user question', 5, undefined, optsIn);

    expect(mockTrackSearchAnalytics).toHaveBeenCalledTimes(1);
    const [userId, queryText, count, maxScore, type, extras] = mockTrackSearchAnalytics.mock.calls[0]!;
    expect(userId).toBe('u1');
    // NEVER a paraphrase: those are a model's words, and recorded as rows
    // they would read as questions a user asked.
    expect(queryText).toBe('the user question');
    expect(count).toBe(1);
    expect(type).toBe('hybrid_multi_query');
    expect(maxScore).toBeCloseTo(
      (ORIGINAL_QUERY_WEIGHT + 2 * PARAPHRASE_QUERY_WEIGHT) / (MULTI_QUERY_RRF_K + 1),
      9,
    );
    expect(extras).toMatchObject({ rerankScore: 0.71, degradedReason: null, embeddingCoverage: 1 });
  });

  /**
   * #1284 — deep search is the second `search_analytics` writer, and it must
   * record the same verdict the route's gate computes. The gate runs
   * `computeRetrievalConfidence` over the MERGED set with the ORIGINAL leg's
   * health caveat, so this row does too.
   */
  it('records the merged set\'s confidence, its basis and the caller\'s surface (#1284)', async () => {
    mockChat.mockResolvedValue('first rewrite\nsecond rewrite');
    /*
     * The fixture DISCRIMINATES the merged set from the original leg (review
     * r2), and it has to: with all three legs answering the same row,
     * `merged`, `legs[0]` and every intermediate set carry the identical max
     * score and basis, so substituting `computeRetrievalConfidence(legs[0],
     * …)` for the merged set left all 35 tests in this file green. The
     * difference is real at runtime — each leg retrieves at
     * `DEEP_SEARCH_LEG_TOPK` 20 while the merge slices to the caller's topK,
     * so a paraphrase-leg row absent from leg 0 routinely leads the merge —
     * and it is exactly what makes the recorded number equal to the one
     * `llm-ask.ts` gates on.
     *
     * Page 2 is reached only by the two paraphrases and outranks page 1 in
     * the merge (2 x 0.6/61 > 1/61), so it leads `merged` and carries the max
     * cosine; page 1 is all the original leg saw.
     */
    mockHybridSearch.mockImplementation(async (_u: string, q: string, _k: number, _c: unknown, opts: { onRetrievalMeta?: (m: unknown) => void }) => {
      opts?.onRetrievalMeta?.({
        degradedReason: null, healthCaveat: null, searchType: 'hybrid',
        embeddingCoverage: 1, aclEmptied: false,
      });
      return q === 'the user question'
        ? [row(1, { vectorScore: 0.83 })]
        : [row(2, { vectorScore: 0.95 })];
    });

    const merged = await multiQuerySearch('u1', 'the user question', 5, undefined, {
      ...optsIn,
      surface: 'ask',
    });

    const [, , , , , extras] = mockTrackSearchAnalytics.mock.calls[0]!;
    expect(computeRetrievalConfidence(merged, null)).toEqual({ score: 0.95, basis: 'similarity' });
    // The verdict the ORIGINAL leg alone would have produced — different, so
    // the assertion below names one set rather than agreeing with all of them.
    expect(computeRetrievalConfidence([row(1, { vectorScore: 0.83 })], null))
      .toEqual({ score: 0.83, basis: 'similarity' });
    expect(extras).toMatchObject({ confidence: 0.95, confidenceBasis: 'similarity', surface: 'ask' });
  });

  /*
   * The health caveat is the writer's SECOND argument, and an empty merged
   * set is the only place it changes the answer on its own: healthy-empty is
   * the measurement "the KB has nothing" (score 0), caveated-empty is an
   * outage symptom (score null). Without this pair, dropping the caveat
   * argument entirely also left the suite green.
   */
  it('records 0 for an empty merged set retrieved healthily (#1284)', async () => {
    mockChat.mockResolvedValue('first rewrite\nsecond rewrite');
    mockHybridSearch.mockImplementation(async (_u: string, _q: string, _k: number, _c: unknown, opts: { onRetrievalMeta?: (m: unknown) => void }) => {
      opts?.onRetrievalMeta?.({
        degradedReason: null, healthCaveat: null, searchType: 'hybrid',
        embeddingCoverage: 1, aclEmptied: false,
      });
      return [];
    });

    await multiQuerySearch('u1', 'the user question', 5, undefined, { ...optsIn, surface: 'ask' });

    const [, , , , , extras] = mockTrackSearchAnalytics.mock.calls[0]!;
    expect(extras).toMatchObject({ confidence: 0, confidenceBasis: 'none' });
  });

  it('records NULL for an empty merged set under the original leg\'s health caveat (#1284)', async () => {
    mockChat.mockResolvedValue('first rewrite\nsecond rewrite');
    mockHybridSearch.mockImplementation(async (_u: string, _q: string, _k: number, _c: unknown, opts: { onRetrievalMeta?: (m: unknown) => void }) => {
      opts?.onRetrievalMeta?.({
        degradedReason: 'no_embeddings', healthCaveat: 'no_embeddings', searchType: 'hybrid',
        embeddingCoverage: 0, aclEmptied: false,
      });
      return [];
    });

    await multiQuerySearch('u1', 'the user question', 5, undefined, { ...optsIn, surface: 'ask' });

    const [, , , , , extras] = mockTrackSearchAnalytics.mock.calls[0]!;
    expect(extras).toMatchObject({ confidence: null, confidenceBasis: 'none' });
  });

  it('records basis none with a NULL score when the merged set is unmeasurable (#1284)', async () => {
    mockChat.mockResolvedValue('first rewrite\nsecond rewrite');
    mockHybridSearch.mockImplementation(async (_u: string, _q: string, _k: number, _c: unknown, opts: { onRetrievalMeta?: (m: unknown) => void }) => {
      opts?.onRetrievalMeta?.({
        degradedReason: 'embedding_failed', healthCaveat: 'embedding_failed', searchType: 'keyword_fallback',
        embeddingCoverage: 1, aclEmptied: false,
      });
      return [row(1, { vectorScore: null, keywordRank: 0.5 })];
    });

    await multiQuerySearch('u1', 'the user question', 5, undefined, { ...optsIn, surface: 'ask' });

    const [, , , , , extras] = mockTrackSearchAnalytics.mock.calls[0]!;
    expect(extras).toMatchObject({ confidence: null, confidenceBasis: 'none' });
  });

  it('does not file analytics when an internal replay opts out', async () => {
    mockChat.mockResolvedValue('first rewrite\nsecond rewrite');
    mockHybridSearch.mockResolvedValue([row(1)]);

    await multiQuerySearch('u1', 'replayed production question', 5, undefined, {
      ...optsIn,
      recordAnalytics: false,
    });

    expect(mockTrackSearchAnalytics).not.toHaveBeenCalled();
  });

  it('returns the merged head, sliced to the caller\'s topK', async () => {
    mockChat.mockResolvedValue('first rewrite\nsecond rewrite');
    mockHybridSearch
      .mockResolvedValueOnce([row(10), row(11), row(12), row(13), row(20)])
      .mockResolvedValueOnce([row(31), row(32), row(33), row(34), row(20)])
      .mockResolvedValueOnce([row(41), row(42), row(43), row(44), row(20)]);

    const out = await multiQuerySearch('u1', 'the user question', 3, undefined, optsIn);
    expect(out).toHaveLength(3);
    expect(out[0]!.pageId).toBe(20);
  });

  it('reports the expansion outcome to its observer, distinguishing skip from failure', async () => {
    const onExpansion = vi.fn();
    mockHybridSearch.mockResolvedValue([]);

    await multiQuerySearch('u1', 'INC-2203', 5, undefined, { onExpansion });
    expect(onExpansion).toHaveBeenLastCalledWith({ expanded: false, reason: 'identifier' });

    mockChat.mockRejectedValue(new Error('down'));
    await multiQuerySearch('u1', 'an ordinary question about ingest', 5, undefined, { onExpansion });
    expect(onExpansion).toHaveBeenLastCalledWith({ expanded: false, reason: 'unavailable' });

    mockChat.mockReset();
    mockChat.mockResolvedValue('first rewrite\nsecond rewrite');
    await multiQuerySearch('u1', 'an ordinary question about ingest', 5, undefined, { onExpansion });
    expect(onExpansion).toHaveBeenLastCalledWith({
      expanded: true,
      paraphrases: ['first rewrite', 'second rewrite'],
    });
  });

  it('survives a throwing observer — an observer must not turn a completed retrieval into a 500', async () => {
    mockHybridSearch.mockResolvedValue([row(1)]);
    const out = await multiQuerySearch('u1', 'INC-2203', 5, undefined, {
      onExpansion: () => { throw new Error('observer blew up'); },
    });
    expect(out).toEqual([row(1)]);
  });
});

/**
 * #1718 — a stand-in for `hybridSearch` that reproduces its #1107 pin stage
 * on exactly the two facts the wrapper controls: the stage runs only when the
 * leg's options carry `pinIdentifiers`, and it pins only when the leg's OWN
 * text detects a non-spaceKey identifier (`rag-service.ts`, the
 * `opts?.pinIdentifiers && …` branch, and `detectIdentifiers` itself,
 * unstubbed). Verification always succeeds here, and the pinned page MOVES to
 * the head keeping its row — the stage's own rule. Every leg reports healthy
 * retrieval, so the confidence verdict depends on the rows alone.
 */
function pinStageLeg(rankings: Record<string, SearchResult[]>, pinPageId: number) {
  return async (
    _u: string,
    q: string,
    _k: number,
    _c: unknown,
    opts?: { pinIdentifiers?: boolean; onRetrievalMeta?: (m: unknown) => void },
  ): Promise<SearchResult[]> => {
    opts?.onRetrievalMeta?.({
      degradedReason: null, healthCaveat: null, searchType: 'hybrid',
      embeddingCoverage: 1, aclEmptied: false,
    });
    const ranked = rankings[q] ?? [];
    const pins = opts?.pinIdentifiers === true && detectIdentifiers(q).some((d) => d.kind !== 'spaceKey');
    if (!pins) return ranked;
    const hit = ranked.find((r) => r.pageId === pinPageId) ?? row(pinPageId, { vectorScore: null });
    return [{ ...hit, pinned: true as const }, ...ranked.filter((r) => r.pageId !== pinPageId)];
  };
}

describe('multiQuerySearch (#1718) — paraphrase legs never pin', () => {
  /*
   * The RF4 fixture: an 11-token question that detects nothing (so it
   * expands), and two paraphrases that each introduce `INC-2203` — an
   * identifier the user never typed. Page 99 is the INC page; the paraphrase
   * legs reach it unpinned through the ordinary legs, below the template
   * pages 3 and 4. The original leg never sees it.
   */
  const QUESTION = 'what did we learn from the database failover incident last spring';
  const PARAPHRASES = ['INC-2203 postmortem review', 'INC-2203 incident postmortem'];
  const INC_PAGE = 99;
  const PARAPHRASE_RANKING = [
    row(3, { vectorScore: 0.6 }),
    row(4, { vectorScore: 0.58 }),
    row(INC_PAGE, { vectorScore: null, keywordRank: 0.4, pageTitle: 'INC-2203 postmortem' }),
  ];
  const RF4_RANKINGS: Record<string, SearchResult[]> = {
    [QUESTION]: [row(1, { vectorScore: 0.7 }), row(2, { vectorScore: 0.65 })],
    [PARAPHRASES[0]!]: PARAPHRASE_RANKING,
    [PARAPHRASES[1]!]: PARAPHRASE_RANKING,
  };
  const optsIn = { rerank: true, assembleContext: true, pinIdentifiers: true };

  beforeEach(() => {
    mockChat.mockResolvedValue(PARAPHRASES.join('\n'));
    mockHybridSearch.mockImplementation(pinStageLeg(RF4_RANKINGS, INC_PAGE));
  });

  it('passes pinIdentifiers true to the original leg and false to each paraphrase leg, other options unchanged', async () => {
    // `deepSearch` is the ask-body flag that selects this wrapper; carried
    // here as the criterion states it, and spread through like any other key.
    const callerOpts = { ...optsIn, deepSearch: true };
    await multiQuerySearch('u1', QUESTION, 5, undefined, callerOpts);

    expect(mockHybridSearch.mock.calls.map((c) => c[1])).toEqual([QUESTION, ...PARAPHRASES]);
    const [original, ...paraphraseLegs] = mockHybridSearch.mock.calls.map((c) => c[4]);
    expect(original).toEqual({
      ...callerOpts,
      rerankCandidatesOverride: DEEP_SEARCH_RERANK_CANDIDATES,
      recordAnalytics: false,
      onRetrievalMeta: expect.any(Function),
    });
    expect(paraphraseLegs).toHaveLength(2);
    for (const opts of paraphraseLegs) {
      expect(opts).toEqual({
        ...callerOpts,
        rerankCandidatesOverride: DEEP_SEARCH_RERANK_CANDIDATES,
        recordAnalytics: false,
        onRetrievalMeta: undefined,
        pinIdentifiers: false,
      });
    }
  });

  it.each([true, false, undefined])(
    'the original leg keeps the caller\'s pinIdentifiers (%s); paraphrase legs always pass false',
    async (callerValue) => {
      await multiQuerySearch('u1', QUESTION, 5, undefined, { rerank: true, pinIdentifiers: callerValue });

      expect(mockHybridSearch).toHaveBeenCalledTimes(3);
      expect(mockHybridSearch.mock.calls[0]![4].pinIdentifiers).toBe(callerValue);
      expect(mockHybridSearch.mock.calls[1]![4].pinIdentifiers).toBe(false);
      expect(mockHybridSearch.mock.calls[2]![4].pinIdentifiers).toBe(false);
    },
  );

  it('a paraphrase that detects an identifier pins nothing and leaves confidence measurable (RF4)', async () => {
    // The fixture is the RF4 shape only if the original detects nothing and
    // each paraphrase does — otherwise this test proves nothing.
    expect(shouldExpandQuery(QUESTION)).toEqual({ expand: true });
    for (const p of PARAPHRASES) expect(detectIdentifiers(p).map((d) => d.kind)).toContain('issueKey');

    const merged = await multiQuerySearch('u1', QUESTION, 5, undefined, { ...optsIn, surface: 'ask' });

    expect(merged.filter((r) => r.pinned === true)).toEqual([]);
    // The single-query path on the same question, same options.
    const single = await pinStageLeg(RF4_RANKINGS, INC_PAGE)('u1', QUESTION, 5, undefined, optsIn);
    const singleConfidence = computeRetrievalConfidence(single, null);
    expect(singleConfidence).toEqual({ score: 0.7, basis: 'similarity' });
    expect(computeRetrievalConfidence(merged, null)).toEqual(singleConfidence);
    // …and the verdict the one analytics row records is that same one.
    const [, , , , , extras] = mockTrackSearchAnalytics.mock.calls[0]!;
    expect(extras).toMatchObject({ confidence: 0.7, confidenceBasis: 'similarity', surface: 'ask' });
  });

  it('the identifier page stays reachable at its plain RRF position — no pin bonus', async () => {
    const merged = await multiQuerySearch('u1', QUESTION, 5, undefined, optsIn);

    // What the merge makes of the legs as they rank WITHOUT a pin stage.
    const expected = mergeMultiQueryResults(
      [
        { results: RF4_RANKINGS[QUESTION]!, weight: ORIGINAL_QUERY_WEIGHT },
        { results: PARAPHRASE_RANKING, weight: PARAPHRASE_QUERY_WEIGHT },
        { results: PARAPHRASE_RANKING, weight: PARAPHRASE_QUERY_WEIGHT },
      ],
      5,
    );
    expect(merged).toEqual(expected);
    expect(merged.map((r) => r.pageId)).toEqual([3, 4, INC_PAGE, 1, 2]);
    const inc = merged.find((r) => r.pageId === INC_PAGE)!;
    expect(inc.pinned).toBeUndefined();
    // Rank 3 in both paraphrase legs, the score rewritten by the merge.
    expect(inc.score).toBeCloseTo((2 * PARAPHRASE_QUERY_WEIGHT) / (MULTI_QUERY_RRF_K + 3), 12);
  });

  it('an identifier query still skips expansion and keeps its caller-requested pinned head', async () => {
    mockHybridSearch.mockImplementation(
      pinStageLeg({ 'INC-2203': [row(5, { vectorScore: 0.8 }), row(INC_PAGE, { vectorScore: 0.4 })] }, INC_PAGE),
    );
    const onExpansion = vi.fn();
    const callerOpts = { ...optsIn, onExpansion };

    const out = await multiQuerySearch('u1', 'INC-2203', 5, undefined, callerOpts);

    expect(onExpansion).toHaveBeenCalledWith({ expanded: false, reason: 'identifier' });
    expect(mockChat).not.toHaveBeenCalled();
    expect(mockHybridSearch).toHaveBeenCalledTimes(1);
    expect(mockHybridSearch).toHaveBeenCalledWith('u1', 'INC-2203', 5, undefined, callerOpts);
    expect(out.map((r) => [r.pageId, r.pinned])).toEqual([[INC_PAGE, true], [5, undefined]]);
    // #1107's guard, untouched: a pinned head is never auto-refused.
    expect(computeRetrievalConfidence(out, null)).toEqual({ score: null, basis: 'none' });
  });

  it('leaves the merged order unchanged when no leg detects an identifier', async () => {
    const q = 'how do I restart the ingest worker';
    const p = ['restarting the ingest worker', 'ingest worker restart procedure'];
    mockChat.mockResolvedValue(p.join('\n'));
    const rankings: Record<string, SearchResult[]> = {
      [q]: [row(1), row(2), row(3)],
      [p[0]!]: [row(2), row(1), row(5)],
      [p[1]!]: [row(2), row(1), row(6)],
    };
    mockHybridSearch.mockImplementation(pinStageLeg(rankings, INC_PAGE));

    const merged = await multiQuerySearch('u1', q, 5, undefined, optsIn);

    // Order as recorded on dev before #1718; pages 5 and 6 tie on score and
    // break toward the earlier leg.
    expect(merged.map((r) => r.pageId)).toEqual([2, 1, 3, 5, 6]);
    expect(merged).toEqual(
      mergeMultiQueryResults(
        [
          { results: rankings[q]!, weight: ORIGINAL_QUERY_WEIGHT },
          { results: rankings[p[0]!]!, weight: PARAPHRASE_QUERY_WEIGHT },
          { results: rankings[p[1]!]!, weight: PARAPHRASE_QUERY_WEIGHT },
        ],
        5,
      ),
    );
    expect(merged.some((r) => r.pinned === true)).toBe(false);
  });
});
