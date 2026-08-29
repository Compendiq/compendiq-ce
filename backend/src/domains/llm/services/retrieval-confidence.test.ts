/**
 * #1521 — which `basis: 'none'` verdict carries a NUMBER, and which carries
 * `null`.
 *
 * Five branches of `computeRetrievalConfidence` answer `basis: 'none'`, and
 * exactly ONE of them puts a number in `score`. That asymmetry is load-bearing
 * prose in five places — migration 098's header, `analytics.ts`'s JSDoc,
 * `docs/architecture/09-flow-rag-chat.md`, CLAUDE.md and the on-screen rerank
 * note — and the `/llm/ask` endpoint cannot detect a change to it, because it
 * filters by BASIS: a threshold is applied only where the basis is `rerank` or
 * `similarity`, so moving a number into or out of a `none` verdict is
 * invisible there.
 *
 * The five, in source order:
 *
 *   1. pinned head          → { score: null,  basis: 'none' }
 *   2. empty + caveat       → { score: null,  basis: 'none' }
 *   3. empty + healthy      → { score: 0,     basis: 'none' }   ← the only number
 *   4. all image-only       → { score: null,  basis: 'none' }
 *   5. keyword-led / no cosine → { score: null, basis: 'none' }
 *
 * Read as a table on purpose. Each verdict is separately pinned in
 * `rag-service.test.ts`'s `computeRetrievalConfidence (#1105)` block, one cell
 * per retrieval scenario; what no assertion anywhere stated is the
 * CROSS-BRANCH claim the prose actually makes — that the five are enumerated,
 * that four of them are unmeasurable, and that the measurable one is the empty
 * HEALTHY corpus and its number is exactly `0`. Giving a second branch a
 * score, or taking 0 away from this one, breaks a documented invariant rather
 * than one scenario.
 *
 * Deliberately dependency-free, like the module it tests: the only runtime
 * import is the formula itself (`SearchResult` is a type-only import, erased
 * at build). No mocks, no module graph — which is the other half of why this
 * file exists next to the same assertions inside a 3,000-line suite that has
 * to mock `rag-service`'s whole graph to reach them.
 */
import { describe, expect, it } from 'vitest';
import type { SearchResult } from './rag-service.js';
import {
  computeRetrievalConfidence,
  type RetrievalConfidence,
  type RetrievalHealthCaveat,
} from './retrieval-confidence.js';

function row(pageId: number, over: Partial<SearchResult> = {}): SearchResult {
  return {
    pageId,
    confluenceId: `c-${pageId}`,
    chunkText: 'text',
    pageTitle: `Page ${pageId}`,
    sectionTitle: 'Section',
    spaceKey: 'DEV',
    score: 0.03,
    vectorScore: null,
    keywordRank: null,
    ...over,
  };
}

interface NoneBranch {
  /** Source order in `computeRetrievalConfidence`. */
  ordinal: number;
  name: string;
  results: SearchResult[];
  caveat: RetrievalHealthCaveat | null;
  expected: RetrievalConfidence;
}

/**
 * Every branch that answers `basis: 'none'`, with the input that reaches it.
 * Adding a sixth `none` branch means adding a row here — which is the point:
 * the enumeration is the contract the five prose surfaces describe.
 */
const NONE_BRANCHES: NoneBranch[] = [
  {
    ordinal: 1,
    name: 'a PINNED head — a verified exact-identifier match is never measurable',
    // The MOVED pin is the sharp case: it keeps its measured cosine, and a
    // number here would let pinning CAUSE a refusal the unpinned ranking
    // would not have produced.
    results: [
      row(1, { vectorScore: 0.24, pinned: true }),
      row(2, { vectorScore: 0.9 }),
    ],
    caveat: null,
    expected: { score: null, basis: 'none' },
  },
  {
    ordinal: 2,
    name: 'an EMPTY set under a health caveat — an outage symptom, not a measurement',
    results: [],
    caveat: 'embedding_failed',
    expected: { score: null, basis: 'none' },
  },
  {
    ordinal: 3,
    name: 'an EMPTY set from HEALTHY retrieval — the one none-verdict that carries a number',
    results: [],
    caveat: null,
    expected: { score: 0, basis: 'none' },
  },
  {
    ordinal: 4,
    name: 'a set of nothing but IMAGE-ONLY rows — pages came back, nothing measurable did',
    results: [
      row(1, { imageOnly: true }),
      row(2, { imageOnly: true, imageTextSynthesized: true }),
    ],
    caveat: null,
    expected: { score: null, basis: 'none' },
  },
  {
    ordinal: 5,
    name: 'a KEYWORD-LED set — the grounding the prompt gets was never measured',
    results: [
      row(1, { keywordRank: 0.6 }),
      row(2, { keywordRank: 0.5 }),
      row(3, { vectorScore: 0.09 }),
    ],
    caveat: null,
    expected: { score: null, basis: 'none' },
  },
];

describe("#1521 computeRetrievalConfidence — the five basis:'none' branches", () => {
  it.each(NONE_BRANCHES)('branch $ordinal: $name', ({ results, caveat, expected }) => {
    expect(computeRetrievalConfidence(results, caveat)).toEqual(expected);
  });

  it('exactly ONE of the five carries a number, and that number is 0', () => {
    const verdicts = NONE_BRANCHES.map((branch) => ({
      ordinal: branch.ordinal,
      score: computeRetrievalConfidence(branch.results, branch.caveat).score,
    }));

    // Every branch really did land on the `none` basis — otherwise the count
    // below would be counting something else's verdict.
    for (const branch of NONE_BRANCHES) {
      expect(computeRetrievalConfidence(branch.results, branch.caveat).basis).toBe('none');
    }

    const numeric = verdicts.filter((v) => v.score !== null);
    expect(numeric).toEqual([{ ordinal: 3, score: 0 }]);
    // …stated the other way round too, because "0" and "null" are one typo
    // apart and `0` is falsy: a reader of the prose has to be able to rely on
    // "unmeasurable means there is no number", not "means the number is low".
    expect(verdicts.filter((v) => v.score === null).map((v) => v.ordinal)).toEqual([1, 2, 4, 5]);
  });

  /**
   * The empty-set arms are the pair the caveat actually switches between, and
   * `coverage_unknown` is the arm that exists because health that could not be
   * VERIFIED must not be reported as a verified-empty corpus.
   */
  it.each<[RetrievalHealthCaveat, number | null]>([
    ['embedding_failed', null],
    ['no_embeddings', null],
    ['partial_embeddings', null],
    ['coverage_unknown', null],
  ])('an empty set under %s scores %s', (caveat, score) => {
    expect(computeRetrievalConfidence([], caveat)).toEqual({ score, basis: 'none' });
  });

  it('defaults the caveat to null, so the no-argument empty call is the HEALTHY verdict', () => {
    // The default parameter is what every call site that has no health signal
    // relies on; flipping it would turn "the KB has nothing" into an outage
    // report for every one of them.
    expect(computeRetrievalConfidence([])).toEqual({ score: 0, basis: 'none' });
  });

  /**
   * The counterweight: the two measurable bases still produce numbers with
   * their own basis names. Without this, every assertion above is satisfiable
   * by a formula that answers `{ score: null, basis: 'none' }` for everything.
   */
  it('still measures what it can — the none verdicts are not the whole formula', () => {
    expect(computeRetrievalConfidence([row(1, { vectorScore: 0.58 })])).toEqual({
      score: 0.58,
      basis: 'similarity',
    });
    expect(
      computeRetrievalConfidence([row(1, { vectorScore: 0.3, rerankScore: 0.71 })]),
    ).toEqual({ score: 0.71, basis: 'rerank' });
  });
});
