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
 * Almost dependency-free, like the module it tests: the only runtime imports
 * are the formula itself and `node:fs`, which the enumeration cell uses to
 * read the two union DECLARATIONS (`SearchResult` is a type-only import,
 * erased at build). No mocks, no module graph — which is the other half of
 * why this file exists next to the same assertions inside a 3,000-line suite
 * that has to mock `rag-service`'s whole graph to reach them.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SearchResult } from './rag-service.js';
import {
  computeRetrievalConfidence,
  type RetrievalConfidence,
  type RetrievalHealthCaveat,
} from './retrieval-confidence.js';

/**
 * The `export type <name> = …;` declaration in a source file: its raw body and
 * the string literals it names, in source order.
 *
 * Union MEMBERSHIP is erased at build, so a test cannot iterate it — and
 * because backend's tsconfig excludes every `*.test.ts` from the tsc program,
 * a total `Record<Union, …>` in a test file is never compiled either, so the
 * compiler cannot check it. Reading the declaration is what is left, and it is
 * the technique `hnsw-ef-search.test.ts` uses to discover ef_search call
 * sites: assert against the source of truth, not against a copy of it.
 */
function unionDeclaration(relative: string, name: string): { body: string; members: string[] } {
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
  const match = new RegExp(`export type ${name} =([^;]*);`).exec(source);
  expect(match, `${relative} must declare 'export type ${name} = …;'`).not.toBeNull();
  const body = match?.[1] ?? '';
  return {
    body,
    members: [...body.matchAll(/'([^']+)'/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]])),
  };
}

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
   *
   * Every member of `RetrievalHealthCaveat` is listed — the four
   * `DegradedReason`s plus `coverage_unknown` — because the enumeration IS the
   * contract here too: the formula reads this field only as null-vs-non-null,
   * so any future arm that special-cases one member (giving it a number, or
   * the `image_leg_unavailable` reading that rag-service.ts's call-site
   * comment calls "deliberate and inert") has to red a row rather than a
   * reviewer's memory. `image_leg_unavailable` is the one that most invites
   * such an arm: it is a bypass of the IMAGE leg, not an outage of the index
   * the answer is grounded in, so "then it should still be measurable" is a
   * plausible-sounding future change. It is not measurable — there is nothing
   * to measure in an empty set — and this row is what says so.
   *
   * The table is a `Record<RetrievalHealthCaveat, …>` so the intent is stated
   * in the type, but the ENFORCEMENT is the source-derived cell below, not the
   * compiler: backend's tsconfig excludes every test file from the tsc
   * program, so a missing `Record` property here is never compiled (measured
   * in review r2: a fifth `DegradedReason` left `npm run typecheck -w backend`
   * at exit 0 with the tuple form AND with the `Record` form — the reason the
   * type-level fix two reviewers proposed is not the fix that works here).
   */
  const EMPTY_SET_CAVEAT_SCORES: Record<RetrievalHealthCaveat, number | null> = {
    embedding_failed: null,
    no_embeddings: null,
    partial_embeddings: null,
    image_leg_unavailable: null,
    coverage_unknown: null,
  };

  it.each(Object.entries(EMPTY_SET_CAVEAT_SCORES) as [RetrievalHealthCaveat, number | null][])(
    'an empty set under %s scores %s',
    (caveat, score) => {
      expect(computeRetrievalConfidence([], caveat)).toEqual({ score, basis: 'none' });
    },
  );

  it('enumerates every declared RetrievalHealthCaveat member — a new arm reds here', () => {
    // `RetrievalHealthCaveat` is a TYPE: no runtime members to iterate, and no
    // compiler looking at this file, so the only thing that can notice a
    // widened union is the declaration itself. Read it. A parse that finds
    // nothing yields an empty expectation and reds too, so renaming either
    // type cannot quietly disarm this cell.
    const caveat = unionDeclaration('./retrieval-confidence.ts', 'RetrievalHealthCaveat');
    const declared = new Set(caveat.members);
    // The caveat union is `DegradedReason | 'coverage_unknown'` today; follow
    // the reference so the four reasons count, and stay correct if a later
    // edit inlines them here instead.
    if (caveat.body.includes('DegradedReason')) {
      for (const member of unionDeclaration('./rag-service.ts', 'DegradedReason').members) {
        declared.add(member);
      }
    }

    expect(
      [...declared].sort(),
      'add the new caveat to EMPTY_SET_CAVEAT_SCORES with the score it must produce',
    ).toEqual(Object.keys(EMPTY_SET_CAVEAT_SCORES).sort());
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
