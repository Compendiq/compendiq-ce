import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { armReport, armRun, heldFixedKnobs } from './arm-report-fixtures.js';
import {
  generateArmAnswers,
  sha256File,
  sha256Of,
  writeAnswerArtifacts,
  writeAnswerProvenance,
  type AnswerItem,
  type AnswerRunProvenance,
  type AskFn,
  type GeneratedAnswers,
  type Mapping,
  type WrittenAnswerArtifacts,
} from './answers.js';
import type { ImageFixture, ImageFixtureLabel } from './fixture.js';
import {
  CONTROL_PAIRS,
  JudgmentRowSchema,
  SINGLE_JUDGE_STATEMENT,
  assertFullyJudged,
  assertSheetIntegrity,
  auditSample,
  buildArmVerdict,
  decideGate,
  formatArmVerdict,
  judgmentProgress,
  judgmentsPath,
  mergeSheets,
  pilotCheck,
  readJudgments,
  readSheet,
  scoreControls,
  scoreLegacyRevisionControls,
  scoreJudgedPair,
  sheetPath,
  unblind,
  type ControlEndpoints,
  type JudgedPairEndpoints,
  type JudgmentRow,
  type TextGateControl,
} from './judgments.js';
import type { AbsoluteLeakage, ArmRunReport, PairedBinaryEndpoint } from './arms.js';
import type { ClusterBootstrapCi } from './metrics.js';

/**
 * #1614 PR2 — the judging protocol's order of operations and the paired
 * scoring, on synthetic data with hand-computed answers. The end-to-end
 * block at the bottom drives answers → merge → judgments → un-blind → verdict
 * with a MOCKED ask boundary: it verifies the tooling and its labels
 * (`toolingVerificationOnly`), and none of its numbers describe a model.
 */

const uuid = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;

function judgment(over: Partial<JudgmentRow> & { itemId: string }): JudgmentRow {
  return { judge: 'simon', correctness: 'correct', citationFaithful: 'yes', unsupportedClaim: false, notes: '', judgedAt: '2026-09-15T12:00:00.000Z', ...over };
}

function item(itemId: string, over: Partial<AnswerItem> = {}): AnswerItem {
  return { itemId, question: 'q', answer: 'a', refused: false, sources: [], evidenceImages: [], ...over };
}

function label(over: Partial<ImageFixtureLabel> & { id: string }): ImageFixtureLabel {
  return { query: `Frage ${over.id}`, lang: 'de', expectedFiles: ['page-1.md'], expectedImages: ['images/page-1__1.png'], style: 'image', rationale: '', imageDependent: true, ...over };
}

describe('JudgmentRowSchema (ADR-027 judgment sheet)', () => {
  it('accepts the ADR row and refuses an adjudication field or a second-rater shape', () => {
    expect(JudgmentRowSchema.safeParse(judgment({ itemId: uuid(1) })).success).toBe(true);
    expect(JudgmentRowSchema.safeParse({ ...judgment({ itemId: uuid(1) }), adjudicates: uuid(2) }).success).toBe(false);
    expect(JudgmentRowSchema.safeParse({ ...judgment({ itemId: uuid(1) }), correctness: 'mostly' }).success).toBe(false);
  });
});

describe('judgmentProgress / assertFullyJudged (ADR-027 --unblind refusal)', () => {
  const answers = [item(uuid(1)), item(uuid(2)), item(uuid(3))];

  it('reports missing, duplicate and unknown judgments', () => {
    const progress = judgmentProgress(answers, [judgment({ itemId: uuid(1) }), judgment({ itemId: uuid(1) }), judgment({ itemId: uuid(9) })]);
    expect(progress).toEqual({ total: 3, judged: 1, missing: [uuid(2), uuid(3)], duplicates: [uuid(1)], unknown: [uuid(9)], judges: ['simon'] });
  });

  it('refuses to un-blind until every item has exactly one judgment by one judge', () => {
    const one = judgment({ itemId: uuid(1) });
    const two = judgment({ itemId: uuid(2) });
    const three = judgment({ itemId: uuid(3) });
    expect(() => assertFullyJudged(answers, [one, two])).toThrow(/1 of 3 items have no judgment/);
    expect(() => assertFullyJudged(answers, [one, two, three, three])).toThrow(/more than one judgment/);
    expect(() => assertFullyJudged(answers, [one, two, three, judgment({ itemId: uuid(9) })])).toThrow(/not on this sheet/);
    expect(() => assertFullyJudged(answers, [one, two, { ...three, judge: 'second-rater' }])).toThrow(/2 judges signed rows/);
    expect(assertFullyJudged(answers, [one, two, three]).judged).toBe(3);
  });

  it('joins the mapping only after that gate, coding correct = 1 and everything else 0', () => {
    const mapping: Mapping = { [uuid(1)]: { arm: 'A', queryId: 'q1' }, [uuid(2)]: { arm: 'B', queryId: 'q1' }, [uuid(3)]: { arm: 'B', queryId: 'q2' } };
    const judged = [judgment({ itemId: uuid(1) }), judgment({ itemId: uuid(2), correctness: 'partial' }), judgment({ itemId: uuid(3), correctness: 'refused' })];
    const items = unblind(answers, judged, mapping);
    expect(items.map((i) => [i.arm, i.queryId, i.correct])).toEqual([['A', 'q1', 1], ['B', 'q1', 0], ['B', 'q2', 0]]);
    expect(() => unblind(answers, judged.slice(0, 2), mapping)).toThrow(/Refusing to un-blind/);
  });
});

describe('scoreJudgedPair', () => {
  const fixture: ImageFixture = {
    corpusManifestSha: 'c', labeledBy: 'l', notUsable: [],
    labels: [
      label({ id: 'q1', expectedFiles: ['p1.md'] }),
      label({ id: 'q2', expectedFiles: ['p1.md'] }),
      label({ id: 'q3', expectedFiles: ['p2.md'] }),
      label({ id: 'q4', expectedFiles: ['p3.md'], imageDependent: false }),
    ],
  };
  const items = (rows: Array<[string, 'A' | 'B', JudgmentRow['correctness'], boolean]>) =>
    rows.map(([queryId, arm, correctness, unsupported], i) => ({
      itemId: uuid(i + 1), arm, queryId, refused: correctness === 'refused',
      judgment: judgment({ itemId: uuid(i + 1), correctness, unsupportedClaim: unsupported, citationFaithful: arm === 'B' ? 'yes' : 'no' }),
      correct: (correctness === 'correct' ? 1 : 0) as 0 | 1,
    }));

  it('scores correctness on the image-dependent labels only, with McNemar over the discordant pairs', () => {
    const scored = scoreJudgedPair(items([
      ['q1', 'A', 'incorrect', false], ['q1', 'B', 'correct', true],
      ['q2', 'A', 'partial', false], ['q2', 'B', 'correct', false],
      ['q3', 'A', 'correct', false], ['q3', 'B', 'refused', false],
      ['q4', 'A', 'incorrect', false], ['q4', 'B', 'correct', false], // not image-dependent: excluded from the primary
    ]), fixture, { baseline: 'A', candidate: 'B' }, { seed: 1, iterations: 200 });
    // Primary over q1..q3: A 1/3 correct, B 2/3; B wins q1, q2 and loses q3 → 2W/1L, p = 2·P(X≤1 | Bin(3,½)) = 1.
    expect(scored.correctness).toMatchObject({ n: 3, wins: 2, losses: 1, ties: 0, pValue: 1 });
    expect(scored.correctness.delta).toBeCloseTo(1 / 3, 10);
    expect(scored.correctness.ci.clusters).toBe(2);
    // Partial is reported separately: A had one partial of 3, B none.
    expect(scored.partialRate).toEqual({ baseline: 1 / 3, candidate: 0 });
    // Unsupported claims and refusals run over ALL four judged pairs.
    expect(scored.unsupportedClaim).toMatchObject({ n: 4, baselineRate: 0, candidateRate: 0.25 });
    expect(scored.refusal).toMatchObject({ n: 4, baselineRate: 0, candidateRate: 0.25 });
    expect(scored.citationFaithful).toMatchObject({ n: 4, baselineRate: 0, candidateRate: 1 });
    expect(scored.pilot.evaluated).toBe(false);
  });

  it('refuses a pair with no query judged on both arms', () => {
    expect(() => scoreJudgedPair(items([['q1', 'A', 'correct', false]]), fixture, { baseline: 'A', candidate: 'B' }, { seed: 1 })).toThrow(/No query was judged on both/);
  });
});

describe('pilotCheck (ADR-027 "Sample size": ψ over the FIRST 30 JUDGED pairs)', () => {
  // 40 image-dependent labels; C correct everywhere; B wrong on q31..q40.
  // C, not A: the #1619 amendment registers the pair as C → B, and that is
  // the pair `pilotCheck` defaults to.
  const ids = Array.from({ length: 40 }, (_, i) => `q${String(i + 1).padStart(2, '0')}`);
  const fixture: ImageFixture = { corpusManifestSha: 'c', labeledBy: 'l', notUsable: [], labels: ids.map((id, i) => label({ id, expectedFiles: [`p${i % 8}.md`] })) };
  const answers: AnswerItem[] = [];
  const mapping: Mapping = {};
  ids.forEach((queryId, i) => {
    for (const [arm, offset] of [['C', 1], ['B', 101]] as const) {
      answers.push(item(uuid(i + offset)));
      mapping[uuid(i + offset)] = { arm, queryId };
    }
  });
  // judgedAt: B's discordant q31..q40 were judged FIRST (hour 0), everything else later (hour 1 + i).
  const at = (hour: number) => `2026-09-15T${String(hour).padStart(2, '0')}:00:00.000Z`;
  const judgmentsFor = (queries: readonly string[]): JudgmentRow[] => queries.flatMap((queryId) => {
    const i = ids.indexOf(queryId);
    const early = i >= 30;
    return [
      judgment({ itemId: uuid(i + 1), judgedAt: at(early ? 0 : 1 + (i % 20)) }),
      judgment({ itemId: uuid(i + 101), correctness: early ? 'incorrect' : 'correct', judgedAt: at(early ? 0 : 1 + (i % 20)) }),
    ];
  });

  it('orders pairs by the moment they were completed, not by item id: the pilot is what the judge saw first', () => {
    const pilot = pilotCheck(answers, judgmentsFor(ids), mapping, fixture);
    // First 30 by judgedAt = the 10 early discordant pairs + 20 later concordant ones → ψ = 10/30.
    expect(pilot).toMatchObject({ pairs: 30, discordant: 10, evaluated: true, stop: false });
    expect(pilot.psi).toBeCloseTo(1 / 3, 10);
    // In item-id order (uuid(1..30) first) the same sheet would read ψ = 0 and STOP — the bug review r1 named.
    expect(scoreJudgedPair(unblind(answers, judgmentsFor(ids), mapping), fixture, { baseline: 'C', candidate: 'B' }, { seed: 1, iterations: 10 }).pilot.psi).toBeCloseTo(1 / 3, 10);
  });

  it('runs on a partly judged sheet — before --unblind is possible — and says when the pilot is not yet reached', () => {
    const partial = pilotCheck(answers, judgmentsFor(ids.slice(0, 20)), mapping, fixture);
    expect(partial).toMatchObject({ pairs: 20, evaluated: false, stop: false });
    // A pair needs BOTH sides judged: 30 C-side rows alone are 0 pairs.
    const oneSided = judgmentsFor(ids.slice(0, 30)).filter((j) => mapping[j.itemId]!.arm === 'C');
    expect(pilotCheck(answers, oneSided, mapping, fixture).pairs).toBe(0);
  });

  it('stops below the floor once 30 pairs are in', () => {
    // Only the 30 concordant pairs judged → ψ = 0 < 0.20.
    expect(pilotCheck(answers, judgmentsFor(ids.slice(0, 30)), mapping, fixture)).toMatchObject({ pairs: 30, discordant: 0, psi: 0, evaluated: true, stop: true });
  });
});

function ci(over: Partial<ClusterBootstrapCi>): ClusterBootstrapCi {
  return { observedDelta: 0, lower: -0.1, upper: 0.1, excludesZero: false, iterations: 1, confidence: 0.95, clusters: 1, queries: 1, oneSidedLower: -0.05, oneSidedUpper: 0.05, ...over };
}
function endpoint(over: Partial<PairedBinaryEndpoint> & { ci?: Partial<ClusterBootstrapCi> }): PairedBinaryEndpoint {
  const { ci: ciOver, ...rest } = over;
  return { baselineRate: 0.5, candidateRate: 0.5, delta: 0, wins: 0, losses: 0, ties: 1, pValue: 1, n: 1, ...rest, ci: ci(ciOver ?? {}) };
}
function judgedPair(over: Partial<JudgedPairEndpoints>): JudgedPairEndpoints {
  return {
    baseline: 'C', candidate: 'B',
    correctness: endpoint({ delta: 0.12, ci: { lower: 0.03, upper: 0.2, excludesZero: true } }),
    partialRate: { baseline: 0, candidate: 0 },
    citationFaithful: endpoint({}),
    unsupportedClaim: endpoint({ delta: 0.01, ci: { oneSidedUpper: 0.025 } }),
    refusal: endpoint({}),
    pilot: { pairs: 30, discordant: 9, psi: 0.3, evaluated: true, stop: false },
    ...over,
  };
}
const controls: ControlEndpoints = {
  pair: CONTROL_PAIRS.bVsC,
  recallAt5: endpoint({ delta: -0.005, ci: { oneSidedLower: -0.015 } }),
  mrr: { baselineMean: 0.8, candidateMean: 0.8, delta: 0, ci: ci({ oneSidedLower: -0.01 }), n: 394 },
  languages: ['en', 'de'],
  perLanguage: { en: 197, de: 197 },
  n: 394,
  revisions: { baseline: null, candidate: null },
};
const legacyControls: ControlEndpoints = {
  ...controls,
  pair: CONTROL_PAIRS.legacyC,
  revisions: { baseline: '7feb4af2aaaa', candidate: '91fbec59bbbb' },
};
const bothControls = { bVsC: controls, legacyC: legacyControls };
/** O7 as amended: an absolute cap on B's own leakage, inside 2 of 48. */
const leakage: AbsoluteLeakage = { queries: 1, denominator: 48, rate: 1 / 48 };

describe('decideGate (ADR-027 "Decision rule", re-registered B vs C by #1619)', () => {
  it('passes only when every live part holds, over BOTH control pairs the amended endpoint table names', () => {
    const decision = decideGate({ primary: judgedPair({}), leakage, controls: bothControls });
    expect(decision.verdict).toBe('pass');
    // Eight conditions, one of them the RETIRED guardrail — which is printed
    // and excluded from the aggregation, never omitted.
    expect(decision.conditions.map((c) => c.verdict)).toEqual([
      'pass', 'pass', 'pass', 'pass', 'pass', 'retired', 'pass', 'pass',
    ]);
    expect(decision.conditions.map((c) => c.name).filter((n) => n.includes('ordinary-text'))).toEqual([
      'non-inferiority: ordinary-text R@5, en + de pooled, B vs C',
      'non-inferiority: ordinary-text MRR, en + de pooled, B vs C',
      'non-inferiority: ordinary-text R@5, en + de pooled, C (candidate revision) vs C (legacy revision)',
      'non-inferiority: ordinary-text MRR, en + de pooled, C (candidate revision) vs C (legacy revision)',
    ]);
    // The primary and both safety rows name the arms they actually scored.
    expect(decision.conditions[0]!.name).toBe('primary: image-dependent answer correctness, B vs C (single-judge)');
    expect(decision.conditions.map((c) => c.name)).toContain('safety: unsupported-claim rate, B vs C');
    // The legacy control's detail carries the two revisions it spanned.
    expect(decision.conditions[3]!.detail).toContain('7feb4af2aaaa → 91fbec59bbbb');
  });

  it('prints the retired O5 guardrail as retired, and lets the gate pass without it', () => {
    const decision = decideGate({ primary: judgedPair({}), leakage, controls: bothControls });
    const retired = decision.conditions.find((c) => c.name.includes('image-evidence'))!;
    expect(retired).toMatchObject({ verdict: 'retired', name: 'RETIRED (O5): non-inferiority: image-evidence R@5 guardrail' });
    // It still states what was retired, including the power the guardrail had.
    expect(retired.detail).toMatch(/power ≈ \d\.\d\d/);
    expect(retired.detail).toMatch(/no comparator exists/);
    expect(decision.verdict).toBe('pass');
  });

  it('is inconclusive — not a pass — when the primary CI straddles 0', () => {
    const straddle = decideGate({ primary: judgedPair({ correctness: endpoint({ delta: 0.06, ci: { lower: -0.01, upper: 0.13 } }) }), leakage, controls: bothControls });
    expect(straddle.verdict).toBe('inconclusive');
  });

  it('reads O7 as an ABSOLUTE cap in queries, and refuses to decide it below O2\'s 48 negatives', () => {
    const atCap = decideGate({ primary: judgedPair({}), leakage: { queries: 2, denominator: 48, rate: 2 / 48 }, controls: bothControls });
    expect(atCap.conditions.find((c) => c.name.includes('leakage'))!.verdict).toBe('pass');
    const over = decideGate({ primary: judgedPair({}), leakage: { queries: 3, denominator: 48, rate: 3 / 48 }, controls: bothControls });
    expect(over.conditions.find((c) => c.name.includes('leakage'))!.verdict).toBe('fail');
    expect(over.verdict).toBe('fail');
    // A smaller negative slice is not the pre-registered sample: the cap is
    // not decidable, and saying "0 of 24 — pass" would be the claim O2 sized.
    const short = decideGate({ primary: judgedPair({}), leakage: { queries: 0, denominator: 24, rate: 0 }, controls: bothControls });
    const row = short.conditions.find((c) => c.name.includes('leakage'))!;
    expect(row.verdict).toBe('inconclusive');
    expect(row.detail).toMatch(/24 negatives is not the sample O2 pre-registered/);
    expect(short.verdict).toBe('inconclusive');
  });

  it('fails on a primary that excludes 0 below the margin, and on a safety interval wholly beyond it', () => {
    const below = decideGate({ primary: judgedPair({ correctness: endpoint({ delta: 0.03, ci: { lower: 0.01, upper: 0.05, excludesZero: true } }) }), leakage, controls: bothControls });
    expect(below.verdict).toBe('fail');
    const unsafe = decideGate({ primary: judgedPair({ unsupportedClaim: endpoint({ delta: 0.08, ci: { oneSidedLower: 0.05, oneSidedUpper: 0.11 } }) }), leakage, controls: bothControls });
    expect(unsafe.verdict).toBe('fail');
  });

  it('applies O6 as ≤ C + 3 pp on the one-sided upper bound — 3.1 pp is not a pass', () => {
    const edge = decideGate({ primary: judgedPair({ unsupportedClaim: endpoint({ delta: 0.01, ci: { oneSidedLower: -0.01, oneSidedUpper: 0.031 } }) }), leakage, controls: bothControls });
    expect(edge.conditions.find((c) => c.name.includes('unsupported'))!.verdict).toBe('inconclusive');
    const inside = decideGate({ primary: judgedPair({ unsupportedClaim: endpoint({ delta: 0.01, ci: { oneSidedLower: -0.01, oneSidedUpper: 0.03 } }) }), leakage, controls: bothControls });
    expect(inside.conditions.find((c) => c.name.includes('unsupported'))!.verdict).toBe('pass');
  });

  it('prints every condition UNDER a pilot stop — the pre-emption decides the aggregate, not what is reported', () => {
    // Review r1 W-6: the branch used to return one condition, so a run that
    // stopped on ψ published neither the retired row nor a measured safety
    // failure. O7's cap is absolute and read off the candidate's own retrieval
    // report, so 9 of 48 negatives leaking is a fact no power argument hides.
    const decision = decideGate({
      primary: judgedPair({ pilot: { pairs: 30, discordant: 4, psi: 4 / 30, evaluated: true, stop: true } }),
      leakage: { queries: 9, denominator: 48, rate: 9 / 48 },
      controls: bothControls,
    });
    expect(decision.verdict).toBe('inconclusive-by-design');
    expect(decision.conditions[0]!.name).toBe('pilot discordance');
    expect(decision.conditions).toHaveLength(9);
    expect(decision.conditions.find((c) => c.name.includes('leakage'))).toMatchObject({
      verdict: 'fail', detail: expect.stringContaining('9 of 48'),
    });
    expect(decision.conditions.find((c) => c.name.includes('image-evidence'))!.verdict).toBe('retired');
    // The primary is the one row the stop DOES invalidate: its interval was
    // sized under a design the pilot says does not hold, so it is reported
    // rather than decided — never `pass` on a stopped run.
    const primaryRow = decision.conditions.find((c) => c.name.startsWith('primary:'))!;
    expect(primaryRow.verdict).toBe('inconclusive');
    expect(primaryRow.detail).toContain('reported, not decided');
  });

  it('treats a missing control pair as an unmeasured — therefore blocking — endpoint', () => {
    const none = decideGate({ primary: judgedPair({}), leakage, controls: { bVsC: null, legacyC: null } });
    expect(none.verdict).toBe('inconclusive');
    // B vs C alone is not the amended endpoint table: the legacy-revision
    // control is the only text-regression detector left and still blocks.
    const half = decideGate({ primary: judgedPair({}), leakage, controls: { bVsC: controls, legacyC: null } });
    expect(half.verdict).toBe('inconclusive');
    expect(half.conditions.find((c) => c.name === `non-inferiority: ordinary-text controls, ${CONTROL_PAIRS.legacyC}`))
      .toMatchObject({ verdict: 'inconclusive', detail: expect.stringContaining('--control-legacy-c') });
  });
});

describe('auditSample (O2/O3 as a check, not a serialised constant)', () => {
  const labels = (n: number, perPage: number, negatives: number): ImageFixture => ({
    corpusManifestSha: 'c', labeledBy: 'l', notUsable: [],
    labels: [
      ...Array.from({ length: n }, (_, i) => label({ id: `d${i}`, expectedFiles: [`p${Math.floor(i / perPage)}.md`] })),
      ...Array.from({ length: negatives }, (_, i) => label({ id: `n${i}`, style: 'image-negative', expectedImages: [], imageDependent: false })),
    ],
  });

  it('accepts the pre-registered sample and names every shortfall otherwise', () => {
    expect(auditSample(labels(190, 4, 48), [controls, legacyControls])).toMatchObject({ imageDependent: 190, imageNegative: 48, pages: 48, maxLabelsPerPage: 4, shortfalls: [], powerMode: 'full', powerNote: null });
    // 190 labels on 20 pages (m = 9.5) pass the two counts and fail the design the power was computed under.
    expect(auditSample(labels(190, 10, 48), []).shortfalls).toEqual([
      'image-dependent labels on 19 pages (O2: ≥ 45)',
      '19 page(s) carry more than 5 image-dependent labels (O2/O3: ≤ 5, the m the design effect assumes)',
    ]);
    expect(auditSample(labels(3, 2, 1), []).shortfalls).toEqual([
      '3 image-dependent labels (O2: 190, below the hard floor 144)',
      '1 image-negative labels (O2: 48)',
      'image-dependent labels on 2 pages (O2: ≥ 45)',
    ]);
    expect(auditSample(labels(190, 4, 48), [{ ...controls, perLanguage: { en: 197, de: 196 } }]).shortfalls).toEqual(['control de (B vs C) pairs 196 queries (O2: 197)']);
  });

  // Review r2 finding 2: `auditSample` thresholded on 190 and only PRINTED
  // the floor, so a floor-sized labelling pass — which ADR-027 "Sample size"
  // pre-registers at power ≈ 0.80 — could only produce a document that
  // "decides nothing". O2's two sizes are two modes now.
  it.each([
    [143, 'undecidable'],
    [144, 'reduced-power'],
    [189, 'reduced-power'],
    [190, 'full'],
  ] as const)('reads %i image-dependent labels as %s', (n, expected) => {
    const audit = auditSample(labels(n, 3, 48), []);
    expect(audit.imageDependent).toBe(n);
    expect(audit.powerMode).toBe(expected);
    if (expected === 'undecidable') {
      expect(audit.shortfalls).toEqual(['143 image-dependent labels (O2: 190, below the hard floor 144)']);
      // Review r3 finding 4: the mode used to stay `full` here and the
      // achieved power was still computed, so a document whose own banner
      // says it decides nothing printed `power ≈ 0.799 vs ≈ 0.900`.
      expect(audit.primaryPower).toBeNull();
      expect(audit.powerNote).toMatch(/decides\s+nothing and no achieved power is reported/);
      return;
    }
    expect(audit.shortfalls).toEqual([]);
    if (expected === 'full') {
      expect(audit.powerNote).toBeNull();
      expect(audit.primaryPower).toBe(audit.targetPower);
    } else {
      expect(audit.powerNote).toMatch(/DECIDES, at power ≈ 0\.\d{3} instead of ≈ 0\.900/);
      expect(audit.primaryPower).toBeLessThan(audit.targetPower);
      expect(audit.primaryPower).toBeGreaterThanOrEqual(0.8);
    }
  });

  // A shortfall in any of O2's other conditions makes the document decide
  // nothing just as a below-floor N does, so it must not carry a mode that
  // says it decided at the pre-registered power either.
  it('is undecidable — with no achieved power — when a non-floor condition falls short at a full-sized N', () => {
    const audit = auditSample(labels(190, 4, 47), [{ ...controls, perLanguage: { en: 197, de: 196 } }]);
    expect(audit.imageDependent).toBe(190);
    expect(audit.shortfalls).toEqual([
      '47 image-negative labels (O2: 48)',
      'control de (B vs C) pairs 196 queries (O2: 197)',
    ]);
    expect(audit.powerMode).toBe('undecidable');
    expect(audit.primaryPower).toBeNull();
    expect(audit.powerNote).toContain('2 of O2\'s sample conditions are unmet');
  });

  it('states the floor\'s power as the ADR does: 0.80 at 144, 0.90 at 190', () => {
    expect(auditSample(labels(144, 3, 48), []).primaryPower).toBeCloseTo(0.8023, 4);
    expect(auditSample(labels(190, 4, 48), []).primaryPower).toBeCloseTo(0.8996, 4);
    expect(auditSample(labels(144, 3, 48), []).targetPower).toBeCloseTo(0.8996, 4);
  });
});

describe('scoreControls (O4, pooled EN + DE)', () => {
  const control = (language: string, retrievedFor: (id: string) => number[]) => ({
    language, ftsLanguage: language === 'de' ? 'german' : 'simple', corpusManifestSha: `sha-${language}`, model: 'qwen3',
    runs: ['a', 'b', 'c'].map((id) => ({ queryId: id, retrieved: retrievedFor(id), expected: [1] })),
  });

  it('pools both languages, pairs within a language, labels the pair and refuses a mismatched configuration', () => {
    const c = [control('en', () => [1]), control('de', (id) => (id === 'a' ? [1] : [9]))];
    const b = [control('en', (id) => (id === 'c' ? [9] : [1])), control('de', () => [1])];
    const scored = scoreControls(c, b, { seed: 1, iterations: 100 });
    // en: c loses on B (1 loss); de: b and c win on B (2 wins) → pooled 2W/1L over 6.
    expect(scored).toMatchObject({ n: 6, languages: ['en', 'de'], pair: CONTROL_PAIRS.bVsC, perLanguage: { en: 3, de: 3 } });
    expect(scored.recallAt5).toMatchObject({ wins: 2, losses: 1, ties: 3, n: 6 });
    expect(scoreControls(c, b, { seed: 1, iterations: 10 }, CONTROL_PAIRS.legacyC)).toMatchObject({ pair: CONTROL_PAIRS.legacyC });
    expect(() => scoreControls(c, [{ ...b[0]!, model: 'bge-m3' }, b[1]!], { seed: 1, iterations: 10 })).toThrow(/model differs/);
    expect(() => scoreControls(c, [b[0]!], { seed: 1, iterations: 10 })).toThrow(/same languages/);
  });

  // Amendment A-3: `--control-a` scored a pair it did not name — nothing in
  // the harness checked the revision, so same-revision reports passed as the
  // legacy side and the document labelled them "C vs A".
  it('certifies the legacy pair as cross-revision, and refuses a side with no revision or a shared one', () => {
    const c = [control('en', () => [1]), control('de', () => [1])];
    const b = [control('en', () => [1]), control('de', () => [1])];
    const at = (sha: string, side: TextGateControl[]) => side.map((s) => ({ ...s, revisionSha: sha }));
    const scored = scoreLegacyRevisionControls(at('7feb4af2', c), at('91fbec59', b), { seed: 1, iterations: 10 });
    expect(scored).toMatchObject({ pair: CONTROL_PAIRS.legacyC, revisions: { baseline: '7feb4af2', candidate: '91fbec59' } });
    expect(() => scoreLegacyRevisionControls(c, at('91fbec59', b), { seed: 1, iterations: 10 }))
      .toThrow(/legacy text controls record no revision \(en, de\)/);
    expect(() => scoreLegacyRevisionControls(at('7feb4af2', c), b, { seed: 1, iterations: 10 }))
      .toThrow(/candidate text controls record no revision/);
    expect(() => scoreLegacyRevisionControls(at('91fbec59', c), at('91fbec59', b), { seed: 1, iterations: 10 }))
      .toThrow(/one revision measured twice/);
  });
});

// ---------------------------------------------------------------------------
// End to end, with a MOCKED ask boundary — tooling verification only.
// ---------------------------------------------------------------------------

describe('answers → merge → judgments → --unblind → verdict (mocked chat boundary; tooling verification only)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arm-judging-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // Three image-dependent labels on two pages plus one negative; a stub ask
  // per arm whose "answers" are a script, not a model.
  const fixture: ImageFixture = {
    corpusManifestSha: 'corpus-sha', labeledBy: 'test', notUsable: [],
    labels: [
      label({ id: 'q1', expectedFiles: ['p1.md'] }),
      label({ id: 'q2', expectedFiles: ['p1.md'] }),
      label({ id: 'q3', expectedFiles: ['p2.md'] }),
      label({ id: 'n1', expectedFiles: ['p3.md'], expectedImages: [], style: 'image-negative', imageDependent: false }),
    ],
  };
  const stubAsk = (arm: string): AskFn => async (question) => ({
    answer: `[stub ${arm}] ${question}`,
    refused: arm === 'C' && question.includes('q3'),
    refusalReason: arm === 'C' && question.includes('q3') ? 'weak_match' : null,
    sources: [{ pageTitle: 'Seite' }],
  });
  const querySetSha = 'f'.repeat(64);
  // The answer runs' provenance says what the arm reports say (`armReport`'s
  // defaults): same revision, hardware, corpus, query set and answer model.
  const provenanceFor = (arm: 'A' | 'B' | 'C', generated: GeneratedAnswers, written: WrittenAnswerArtifacts): AnswerRunProvenance => ({
    runId: `run-${arm}`, arm, revisionSha: 'e398de4a1234', command: `scripts/run-arm-answers.ts --arm ${arm} --run-id run-${arm}`,
    capturedAt: '2026-09-15T11:00:00.000Z', hardware: 'test host', corpusManifestSha: 'corpus-sha', querySetSha,
    answerModel: { identity: 'rtx:gemma@http://chat/v1', model: 'gemma', endpoint: 'http://chat/v1' }, temperature: 'provider default',
    ragAnswerMaxImages: 0, deepSearch: false, retrieval: heldFixedKnobs(),
    items: generated.answers.length, refused: generated.refused, refusalReasons: generated.refusalReasons,
    answersSha256: written.answersSha256, mappingSha256: written.mappingSha256,
  });
  const sources = (['A', 'B', 'C'] as const).map((arm) => ({
    answersPath: join(dir, `answers-run-${arm}.jsonl`), mappingPath: join(dir, `mapping-run-${arm}.json`), provenancePath: join(dir, `provenance-run-${arm}.json`),
  }));
  const runs = (arm: 'A' | 'B' | 'C') => fixture.labels.map((l) => armRun({
    queryId: l.id, cluster: l.expectedFiles[0]!, style: l.style, expectedImageKeys: l.expectedImages.map((p) => p.split('/').pop()!),
    evidence: arm === 'A' && l.style === 'image' ? [{ key: 'page-1__1.png', rank: 1 }] : [],
  }));
  const armReports: Record<'A' | 'B' | 'C', ArmRunReport> = {
    A: armReport('A', { querySetSha, runs: runs('A') }),
    B: armReport('B', { querySetSha, runs: runs('B') }),
    C: armReport('C', { querySetSha, runs: runs('C') }),
  };
  const input = { dir, runId: 'sheet', fixture, querySetSha, armReports, controls: null, command: 'scripts/judge-arms.ts --unblind --run-id sheet', seed: 1, iterations: 200 };
  let verdictLines: string[] = [];

  beforeAll(async () => {
    for (const arm of ['A', 'B', 'C'] as const) {
      const generated = await generateArmAnswers(stubAsk(arm), fixture, { arm });
      writeAnswerProvenance(dir, `run-${arm}`, provenanceFor(arm, generated, writeAnswerArtifacts(dir, `run-${arm}`, generated)));
    }
  });

  it('refuses to merge a run whose provenance does not hash the files beside it', () => {
    const drifted = join(dir, 'provenance-run-A-drifted.json');
    writeFileSync(drifted, readFileSync(join(dir, 'provenance-run-A.json'), 'utf8').replace(/"answersSha256": "[0-9a-f]{64}"/, `"answersSha256": "${'0'.repeat(64)}"`));
    expect(() => mergeSheets(dir, 'bad', [{ ...sources[0]!, provenancePath: drifted }], 'cmd')).toThrow(/does not describe .*answers-run-A\.jsonl: answers file hashes to/);
    expect(() => mergeSheets(dir, 'bad', [{ ...sources[0]!, provenancePath: join(dir, 'provenance-missing.json') }], 'cmd')).toThrow(/provenance-missing\.json: missing/);
  });

  it('merges into one blinded sheet whose mapping sha is recorded before any judgment exists', () => {
    const sheet = mergeSheets(dir, 'sheet', sources, 'scripts/judge-arms.ts --merge --run-id sheet');
    expect(sheet.items).toBe(12);
    expect(sheet.command).toBe('scripts/judge-arms.ts --merge --run-id sheet');
    expect(sheet.sources.map((s) => [s.arm, s.runId])).toEqual([['A', 'run-A'], ['B', 'run-B'], ['C', 'run-C']]);
    expect(sheet.sources[0]!.provenanceSha256).toBe(sha256File(join(dir, 'provenance-run-A.json')));
    expect(sheet.mappingSha256).toBe(sha256File(join(dir, 'mapping-sheet.json')));
    const rows = readFileSync(join(dir, 'answers-sheet.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as AnswerItem);
    // The judge's file: no arm anywhere, and the rows are not grouped by arm.
    expect(JSON.stringify(rows)).not.toMatch(/"arm"/);
    const mapping = JSON.parse(readFileSync(join(dir, 'mapping-sheet.json'), 'utf8')) as Mapping;
    const armsInOrder = rows.map((r) => mapping[r.itemId]!.arm).join('');
    expect(armsInOrder).not.toBe('AAAABBBBCCCC');
    expect(JSON.parse(readFileSync(sheetPath(dir, 'sheet'), 'utf8'))).toMatchObject({ runId: 'sheet', items: 12 });
  });

  it('refuses to un-blind an unjudged or partly judged sheet', () => {
    const rows = readFileSync(join(dir, 'answers-sheet.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as AnswerItem);
    writeFileSync(judgmentsPath(dir, 'sheet'), rows.slice(0, 5).map((r) => JSON.stringify(judgment({ itemId: r.itemId }))).join('\n') + '\n');
    expect(() => buildArmVerdict({ ...input, allowUnderpowered: true })).toThrow(/7 of 12 items have no judgment/);
  });

  it('un-blinds a fully judged sheet, refuses below O2 without the flag, and labels the flagged run as tooling verification', () => {
    const rows = readFileSync(join(dir, 'answers-sheet.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as AnswerItem);
    const mapping = JSON.parse(readFileSync(join(dir, 'mapping-sheet.json'), 'utf8')) as Mapping;
    // The judge (a script here) marks B correct everywhere, A correct on q3 only, C as answered.
    const verdictFor = (r: AnswerItem): JudgmentRow['correctness'] => {
      const { arm, queryId } = mapping[r.itemId]!;
      if (r.refused) return 'refused';
      if (arm === 'B') return 'correct';
      if (arm === 'A') return queryId === 'q3' ? 'correct' : 'incorrect';
      return 'partial';
    };
    writeFileSync(judgmentsPath(dir, 'sheet'), rows.map((r) => JSON.stringify(judgment({ itemId: r.itemId, correctness: verdictFor(r) }))).join('\n') + '\n');
    expect(readJudgments(judgmentsPath(dir, 'sheet'))).toHaveLength(12);

    // Below O2's hard floor (3 image-dependent on 2 pages, 1 negative of 48): refused outright, naming each shortfall.
    expect(() => buildArmVerdict({ ...input, allowUnderpowered: false })).toThrow(/below what ADR-027 O2 makes decidable: 3 image-dependent labels \(O2: 190, below the hard floor 144\); 1 image-negative labels \(O2: 48\); image-dependent labels on 2 pages \(O2: ≥ 45\)/);
    // A report without hardware provenance is refused too (O9).
    expect(() => buildArmVerdict({ ...input, allowUnderpowered: true, armReports: { ...armReports, A: armReport('A', { querySetSha, runs: runs('A'), hardware: null }) } })).toThrow(/records no hardware/);

    const report = buildArmVerdict({ ...input, allowUnderpowered: true });
    expect(report.toolingVerificationOnly).toBe(true);
    expect(report.command).toBe(input.command);
    expect(report.judge).toBe('simon');
    expect(report.singleJudgeStatement).toBe(SINGLE_JUDGE_STATEMENT);
    expect(report.sample).toMatchObject({ imageDependent: 3, imageNegative: 1, pages: 2, maxLabelsPerPage: 2 });
    expect(report.sample.shortfalls).toHaveLength(3);
    expect(report.answerRuns.map((r) => r.runId)).toEqual(['run-A', 'run-B', 'run-C']);
    // Primary B vs C over q1..q3 (#1619: the registered pair): C is `partial`
    // on q1/q2 and refused q3, B is correct everywhere → 3W/0L, +100 pp.
    expect(report.judged.primary.correctness).toMatchObject({ n: 3, wins: 3, losses: 0, ties: 0 });
    expect(report.judged.primary.correctness.delta).toBeCloseTo(1, 10);
    // Arm A is optional and no longer the primary's baseline; supplied, it is
    // scored as the two secondary pairings.
    expect(report.judged.secondary.map((s) => `${s.candidate}-${s.baseline}`)).toEqual(['B-A', 'C-A']);
    // C refused q3 (the stub's refusal frame) → its refusal rate against A is 1/4.
    expect(report.judged.secondary[1]!.refusal.candidateRate).toBe(0.25);
    // Controls were not given: the gate cannot pass, whatever the primary says.
    expect(report.decision.verdict).not.toBe('pass');
    expect(report.decision.conditions.filter((c) => c.name.includes('controls') && c.verdict === 'inconclusive')).toHaveLength(2);
    expect(report.items).toHaveLength(12);
    verdictLines = formatArmVerdict(report);
    expect(verdictLines[0]).toMatch(/TOOLING VERIFICATION ONLY/);
    expect(verdictLines.join('\n')).toContain('short of O2: image-dependent labels on 2 pages');
    expect(verdictLines.join('\n')).toContain('Single-judge protocol');
    // Review r3 finding 4: the banner says this document decides nothing, so
    // the sample line must not quote an achieved power beside the target's —
    // it used to print `primary power ≈ 0.799 vs ≈ 0.900` two lines under it.
    expect(report.sample.powerMode).toBe('undecidable');
    expect(report.reducedPower).toBe(false);
    expect(report.sample.primaryPower).toBeNull();
    const sampleLine = verdictLines.find((l) => l.startsWith('sample:'))!;
    expect(sampleLine).not.toMatch(/primary power/);
    expect(sampleLine).toContain('no achieved power (this sample decides nothing');
  });

  it('refuses an answer run that was not made under its arm report\'s configuration (review r1 finding 2)', () => {
    // Every arm report names another chat model than the answer runs recorded — the pair is consistent, the sheet is not.
    const other = { identity: 'rtx:llama@http://chat/v1', model: 'llama', endpoint: 'http://chat/v1' };
    const drifted = { A: { ...armReports.A, answerModel: other }, B: { ...armReports.B, answerModel: other }, C: { ...armReports.C, answerModel: other } };
    expect(() => buildArmVerdict({ ...input, allowUnderpowered: true, armReports: drifted })).toThrow(/Answer run run-A \(arm A\) was not made under arm A's held-fixed configuration.*answer model rtx:gemma@http:\/\/chat\/v1 vs the retrieval report's rtx:llama/);
    // A knob the answer run read differently from the retrieval run is a drift too.
    const knob = { ...armReports, A: { ...armReports.A, retrieval: { ...armReports.A.retrieval, rag_fetch_width: 12 } }, B: { ...armReports.B, retrieval: { ...armReports.B.retrieval, rag_fetch_width: 12 } }, C: { ...armReports.C, retrieval: { ...armReports.C.retrieval, rag_fetch_width: 12 } } };
    expect(() => buildArmVerdict({ ...input, allowUnderpowered: true, armReports: knob })).toThrow(/retrieval\.rag_fetch_width: 10 vs the retrieval report's 12/);
    // A sheet carrying arm A's answers needs arm A's report — even though the
    // primary no longer reads it.
    expect(() => buildArmVerdict({ ...input, allowUnderpowered: true, armReports: { B: armReports.B, C: armReports.C } })).toThrow(/carries arm A's answers \(run run-A\) but no --arm-report A/);
    // And a run with no comparator for the primary is refused outright.
    expect(() => buildArmVerdict({ ...input, allowUnderpowered: true, armReports: { B: armReports.B } })).toThrow(/needs the arm B and arm C retrieval reports/);
  });

  it('refuses a provenance file that changed after the sheet recorded its sha', () => {
    const file = join(dir, 'provenance-run-B.json');
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, original.replace(/\n$/, ' \n'));
    try {
      expect(() => buildArmVerdict({ ...input, allowUnderpowered: true })).toThrow(/provenance-run-B\.json hashes to .* the run's provenance changed/);
    } finally {
      writeFileSync(file, original);
    }
  });

  it('refuses a mapping that changed after the sheet recorded its sha', () => {
    const mappingFile = join(dir, 'mapping-sheet.json');
    const original = readFileSync(mappingFile, 'utf8');
    writeFileSync(mappingFile, original.replace(/\n$/, ' \n'));
    try {
      expect(() => buildArmVerdict({ ...input, allowUnderpowered: true, iterations: 50 })).toThrow(/mapping changed under the judge/);
    } finally {
      writeFileSync(mappingFile, original);
    }
  });

  // Review r2 finding 1: the sheet recorded the judge's file's sha256 and
  // nothing ever read it back, so 200 rows could be rewritten after --merge
  // and the verdict came out with no complaint (the refusal endpoint moved by
  // 24 points). Both halves of the anchor are exercised here: the recorded
  // hash, and the re-derivation that makes the sheet not its own witness.
  it('refuses a judge\'s file whose rows were rewritten after --merge — even with the sheet\'s own hash updated to match', () => {
    const answersFile = join(dir, 'answers-sheet.jsonl');
    const sheetFile = sheetPath(dir, 'sheet');
    const originalAnswers = readFileSync(answersFile, 'utf8');
    const originalSheet = readFileSync(sheetFile, 'utf8');
    const rewritten = originalAnswers.trim().split('\n')
      .map((line) => JSON.stringify({ ...(JSON.parse(line) as AnswerItem), answer: 'rewritten after the merge', refused: true }))
      .join('\n') + '\n';
    try {
      writeFileSync(answersFile, rewritten);
      expect(() => buildArmVerdict({ ...input, allowUnderpowered: true, iterations: 50 }))
        .toThrow(/answers-sheet\.jsonl hashes to [0-9a-f]{64} but sheet-sheet\.json recorded [0-9a-f]{64} at --merge/);
      // The same hand can update the sheet's record; the rows still have to
      // re-derive from each arm's own answers file, which was not touched.
      writeFileSync(sheetFile, originalSheet.replace(/"answersSha256": "[0-9a-f]{64}",\n {2}"mappingSha256"/, `"answersSha256": "${sha256File(answersFile)}",\n  "mappingSha256"`));
      expect(JSON.parse(readFileSync(sheetFile, 'utf8')).answersSha256).toBe(sha256File(answersFile));
      expect(() => buildArmVerdict({ ...input, allowUnderpowered: true, iterations: 50 }))
        .toThrow(/12 of 12 rows of .*answers-sheet\.jsonl differ from the answer runs they were merged from \(first: item [0-9a-f-]+\)/);
    } finally {
      writeFileSync(answersFile, originalAnswers);
      writeFileSync(sheetFile, originalSheet);
    }
  });

  it('refuses one rewritten row, a removed row, and an arm\'s answers file that is no longer beside the sheet', () => {
    const answersFile = join(dir, 'answers-sheet.jsonl');
    const sheetFile = sheetPath(dir, 'sheet');
    const originalAnswers = readFileSync(answersFile, 'utf8');
    const originalSheet = readFileSync(sheetFile, 'utf8');
    const lines = originalAnswers.trim().split('\n');
    const retag = (text: string) => writeFileSync(sheetFile, originalSheet.replace(/"answersSha256": "[0-9a-f]{64}",\n {2}"mappingSha256"/, `"answersSha256": "${sha256Of(text)}",\n  "mappingSha256"`));
    try {
      // ONE row, with the sheet's hash kept consistent: the re-derivation is what catches it.
      const oneEdited = [JSON.stringify({ ...(JSON.parse(lines[4]!) as AnswerItem), answer: 'edited' }), ...lines.slice(0, 4), ...lines.slice(5)]
        .sort((a, b) => ((JSON.parse(a) as AnswerItem).itemId < (JSON.parse(b) as AnswerItem).itemId ? -1 : 1)).join('\n') + '\n';
      writeFileSync(answersFile, oneEdited);
      retag(oneEdited);
      expect(() => buildArmVerdict({ ...input, allowUnderpowered: true, iterations: 50 })).toThrow(/1 of 12 rows of .*answers-sheet\.jsonl differ/);
      // A removed row is caught by the count.
      const shorter = lines.slice(1).join('\n') + '\n';
      writeFileSync(answersFile, shorter);
      retag(shorter);
      expect(() => buildArmVerdict({ ...input, allowUnderpowered: true, iterations: 50 })).toThrow(/carries 11 rows, the 3 answer runs it was merged from carry 12/);
    } finally {
      writeFileSync(answersFile, originalAnswers);
      writeFileSync(sheetFile, originalSheet);
    }
    // The re-derivation needs each run's own answers file in --out-dir.
    const armFile = join(dir, 'answers-run-B.jsonl');
    const armOriginal = readFileSync(armFile, 'utf8');
    try {
      rmSync(armFile);
      expect(() => buildArmVerdict({ ...input, allowUnderpowered: true, iterations: 50 })).toThrow(/answers-run-B\.jsonl is missing — the sheet's rows are re-derived/);
      writeFileSync(armFile, `${armOriginal}`.replace(/\n$/, '\n'));
      // A source file edited to match the tampered sheet fails its own recorded hash.
      writeFileSync(armFile, armOriginal.trim().split('\n').map((l) => JSON.stringify({ ...(JSON.parse(l) as AnswerItem), answer: 'x' })).join('\n') + '\n');
      expect(() => buildArmVerdict({ ...input, allowUnderpowered: true, iterations: 50 })).toThrow(/answers-run-B\.jsonl hashes to [0-9a-f]{64} but sheet-sheet\.json recorded [0-9a-f]{64} at --merge — arm B's answers changed/);
    } finally {
      writeFileSync(armFile, armOriginal);
    }
  });

  // Review r3 finding 2: `--check` validated the judgments against the file
  // passed as `--answers` but hashed the out-dir copy of the same name, so a
  // tampered judge's copy outside the artifacts directory was reported as
  // "still hashes to sheet-sheet.json". The check now takes the file it read.
  it('holds the answers file it was HANDED to the sheet, not the out-dir copy of that name', () => {
    const sheet = readSheet(dir, 'sheet');
    const elsewhere = mkdtempSync(join(tmpdir(), 'arm-judge-'));
    try {
      const pristine = join(elsewhere, 'answers-sheet.jsonl');
      writeFileSync(pristine, readFileSync(join(dir, 'answers-sheet.jsonl'), 'utf8'));
      // Content-addressed: a copy that is byte-identical passes, wherever it sits.
      expect(() => assertSheetIntegrity(dir, 'sheet', sheet, pristine)).not.toThrow();
      const tampered = join(elsewhere, 'tampered.jsonl');
      writeFileSync(tampered, readFileSync(pristine, 'utf8').trim().split('\n')
        .map((l) => JSON.stringify({ ...(JSON.parse(l) as AnswerItem), answer: 'judged from a rewritten copy' })).join('\n') + '\n');
      expect(() => assertSheetIntegrity(dir, 'sheet', sheet, tampered)).toThrow(/tampered\.jsonl hashes to [0-9a-f]{64} but sheet-sheet\.json recorded/);
      // …and the out-dir copy, which is intact, is not what vouches for it.
      expect(() => assertSheetIntegrity(dir, 'sheet', sheet)).not.toThrow();
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  // Review r3 finding 3: everything load-bearing is keyed on the file name,
  // so a sheet whose `runId` field named another run was copied into the
  // verdict document unchallenged — `runId: "sheet"` beside
  // `sheet.runId: "some-other-run"`.
  it('refuses a sheet whose recorded runId is not the run being read', () => {
    const foreign = sheetPath(dir, 'other');
    writeFileSync(foreign, readFileSync(sheetPath(dir, 'sheet'), 'utf8'));
    try {
      expect(() => readSheet(dir, 'other')).toThrow(/records runId "sheet", but it is the sheet for run "other"/);
    } finally {
      rmSync(foreign, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// O2's floor as a DECIDING mode (review r2 finding 2), end to end.
// ---------------------------------------------------------------------------

describe('a floor-sized sample decides, labelled REDUCED POWER (ADR-027 O2)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arm-floor-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const querySetSha = 'e'.repeat(64);
  // 144 image-dependent labels — O2's hard floor — spread 3 to a page over 48
  // pages (≥ 45, ≤ 5), plus the 48 image-negative labels O7's margin needs.
  const fixture: ImageFixture = {
    corpusManifestSha: 'corpus-sha', labeledBy: 'o15', notUsable: [],
    labels: [
      ...Array.from({ length: 144 }, (_, i) => label({ id: `d${i}`, expectedFiles: [`p${Math.floor(i / 3)}.md`] })),
      ...Array.from({ length: 48 }, (_, i) => label({ id: `n${i}`, expectedFiles: [`n${i}.md`], expectedImages: [], style: 'image-negative', imageDependent: false })),
    ],
  };
  const runsFor = (arm: 'C' | 'B') => fixture.labels.map((l) => armRun({
    queryId: l.id, cluster: l.expectedFiles[0]!, style: l.style, expectedImageKeys: l.expectedImages.map((p) => p.split('/').pop()!),
    evidence: arm === 'B' && l.style === 'image' ? [{ key: 'page-1__1.png', rank: 1 }] : [],
  }));
  const armReports = { C: armReport('C', { querySetSha, runs: runsFor('C') }), B: armReport('B', { querySetSha, runs: runsFor('B') }) };

  it('runs the whole rule at 144 labels without a flag, and says so on the document', async () => {
    for (const arm of ['C', 'B'] as const) {
      const generated = await generateArmAnswers(async (question) => ({ answer: `[stub ${arm}] ${question}`, refused: false, refusalReason: null, sources: [{ pageTitle: 'Seite' }] }), fixture, { arm });
      const written = writeAnswerArtifacts(dir, `run-${arm}`, generated);
      writeAnswerProvenance(dir, `run-${arm}`, {
        runId: `run-${arm}`, arm, revisionSha: 'e398de4a1234', command: `scripts/run-arm-answers.ts --arm ${arm}`,
        capturedAt: '2026-09-15T11:00:00.000Z', hardware: 'test host', corpusManifestSha: 'corpus-sha', querySetSha,
        answerModel: { identity: 'rtx:gemma@http://chat/v1', model: 'gemma', endpoint: 'http://chat/v1' }, temperature: 'provider default',
        ragAnswerMaxImages: 0, deepSearch: false, retrieval: heldFixedKnobs(),
        items: generated.answers.length, refused: generated.refused, refusalReasons: generated.refusalReasons,
        answersSha256: written.answersSha256, mappingSha256: written.mappingSha256,
      });
    }
    const sheet = mergeSheets(dir, 'floor', (['C', 'B'] as const).map((arm) => ({
      answersPath: join(dir, `answers-run-${arm}.jsonl`), mappingPath: join(dir, `mapping-run-${arm}.json`), provenancePath: join(dir, `provenance-run-${arm}.json`),
    })), 'scripts/judge-arms.ts --merge --run-id floor');
    expect(sheet.items).toBe(384);

    const rows = readFileSync(join(dir, 'answers-floor.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as AnswerItem);
    const mapping = JSON.parse(readFileSync(join(dir, 'mapping-floor.json'), 'utf8')) as Mapping;
    writeFileSync(judgmentsPath(dir, 'floor'), rows.map((r) => JSON.stringify(judgment({
      itemId: r.itemId,
      correctness: mapping[r.itemId]!.arm === 'B' || mapping[r.itemId]!.queryId.endsWith('0') ? 'correct' : 'incorrect',
    }))).join('\n') + '\n', 'utf8');

    // No `--allow-underpowered`: the floor decides.
    const report = buildArmVerdict({
      dir, runId: 'floor', fixture, querySetSha, armReports, controls: null,
      allowUnderpowered: false, command: 'scripts/judge-arms.ts --unblind --run-id floor', seed: 1, iterations: 60,
    });
    expect(report.toolingVerificationOnly).toBe(false);
    expect(report.reducedPower).toBe(true);
    expect(report.sample).toMatchObject({ imageDependent: 144, imageNegative: 48, pages: 48, powerMode: 'reduced-power' });
    expect(report.sample.primaryPower).toBeCloseTo(0.8023, 4);
    expect(report.judged.primary.correctness.n).toBe(144);
    // The rule ran: the primary endpoint has a verdict of its own.
    expect(report.decision.conditions[0]!.name).toContain('primary');
    expect(report.decision.conditions[0]!.verdict).toBe('pass');
    const lines = formatArmVerdict(report);
    expect(lines.join('\n')).not.toMatch(/TOOLING VERIFICATION ONLY/);
    expect(lines[0]).toMatch(/REDUCED POWER — this document DECIDES/);
    expect(lines.join('\n')).toMatch(/hard floor 144.*primary power ≈ 0\.802 vs ≈ 0\.900 at 190/);
  }, 60_000);
});
