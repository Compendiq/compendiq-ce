import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { armReport, armRun } from './arm-report-fixtures.js';
import { generateArmAnswers, sha256File, writeAnswerArtifacts, type AnswerItem, type AskFn, type Mapping } from './answers.js';
import type { ImageFixture, ImageFixtureLabel } from './fixture.js';
import {
  JudgmentRowSchema,
  SINGLE_JUDGE_STATEMENT,
  assertFullyJudged,
  buildArmVerdict,
  decideGate,
  formatArmVerdict,
  judgmentProgress,
  judgmentsPath,
  mergeSheets,
  readJudgments,
  scoreControls,
  scoreJudgedPair,
  sheetPath,
  unblind,
  type JudgedPairEndpoints,
  type JudgmentRow,
} from './judgments.js';
import type { PairedBinaryEndpoint } from './arms.js';
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

function ci(over: Partial<ClusterBootstrapCi>): ClusterBootstrapCi {
  return { observedDelta: 0, lower: -0.1, upper: 0.1, excludesZero: false, iterations: 1, confidence: 0.95, clusters: 1, queries: 1, oneSidedLower: -0.05, oneSidedUpper: 0.05, ...over };
}
function endpoint(over: Partial<PairedBinaryEndpoint> & { ci?: Partial<ClusterBootstrapCi> }): PairedBinaryEndpoint {
  const { ci: ciOver, ...rest } = over;
  return { baselineRate: 0.5, candidateRate: 0.5, delta: 0, wins: 0, losses: 0, ties: 1, pValue: 1, n: 1, ...rest, ci: ci(ciOver ?? {}) };
}
function judgedPair(over: Partial<JudgedPairEndpoints>): JudgedPairEndpoints {
  return {
    baseline: 'A', candidate: 'B',
    correctness: endpoint({ delta: 0.12, ci: { lower: 0.03, upper: 0.2, excludesZero: true } }),
    partialRate: { baseline: 0, candidate: 0 },
    citationFaithful: endpoint({}),
    unsupportedClaim: endpoint({ delta: 0.01, ci: { oneSidedUpper: 0.025 } }),
    refusal: endpoint({}),
    pilot: { pairs: 30, discordant: 9, psi: 0.3, evaluated: true, stop: false },
    ...over,
  };
}
const controls = {
  recallAt5: endpoint({ delta: -0.005, ci: { oneSidedLower: -0.015 } }),
  mrr: { baselineMean: 0.8, candidateMean: 0.8, delta: 0, ci: ci({ oneSidedLower: -0.01 }), n: 394 },
  languages: ['en', 'de'],
  n: 394,
};
const leakage = endpoint({ delta: 0.02, ci: { oneSidedUpper: 0.04 } });
const imageEvidence = endpoint({ delta: 0.01, ci: { oneSidedLower: -0.03 } });

describe('decideGate (ADR-027 "Decision rule")', () => {
  it('passes only when all three parts hold', () => {
    const decision = decideGate({ primary: judgedPair({}), imageEvidence, leakage, controls });
    expect(decision.verdict).toBe('pass');
    expect(decision.conditions.map((c) => c.verdict)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
  });

  it('is inconclusive — not a pass — when the primary CI straddles 0 or a margin interval straddles', () => {
    const straddle = decideGate({ primary: judgedPair({ correctness: endpoint({ delta: 0.06, ci: { lower: -0.01, upper: 0.13 } }) }), imageEvidence, leakage, controls });
    expect(straddle.verdict).toBe('inconclusive');
    const wideLeak = decideGate({ primary: judgedPair({}), imageEvidence, leakage: endpoint({ delta: 0.02, ci: { oneSidedLower: -0.01, oneSidedUpper: 0.06 } }), controls });
    expect(wideLeak.verdict).toBe('inconclusive');
    expect(wideLeak.conditions.find((c) => c.name.includes('leakage'))!.verdict).toBe('inconclusive');
  });

  it('fails on a primary that excludes 0 below the margin, and on a safety interval wholly beyond it', () => {
    const below = decideGate({ primary: judgedPair({ correctness: endpoint({ delta: 0.03, ci: { lower: 0.01, upper: 0.05, excludesZero: true } }) }), imageEvidence, leakage, controls });
    expect(below.verdict).toBe('fail');
    const unsafe = decideGate({ primary: judgedPair({ unsupportedClaim: endpoint({ delta: 0.08, ci: { oneSidedLower: 0.05, oneSidedUpper: 0.11 } }) }), imageEvidence, leakage, controls });
    expect(unsafe.verdict).toBe('fail');
  });

  it('stops as inconclusive by design when the pilot discordance is below the floor, before anything else is read', () => {
    const decision = decideGate({ primary: judgedPair({ pilot: { pairs: 30, discordant: 4, psi: 4 / 30, evaluated: true, stop: true } }), imageEvidence, leakage, controls });
    expect(decision.verdict).toBe('inconclusive-by-design');
    expect(decision.conditions).toHaveLength(1);
  });

  it('treats missing controls as an unmeasured — therefore blocking — endpoint, and prints the O5 power', () => {
    const decision = decideGate({ primary: judgedPair({}), imageEvidence, leakage, controls: null });
    expect(decision.verdict).toBe('inconclusive');
    expect(decision.conditions.find((c) => c.name.includes('image-evidence'))!.detail).toMatch(/power ≈ \d\.\d\d/);
  });
});

describe('scoreControls (O4, pooled EN + DE)', () => {
  const control = (language: string, retrievedFor: (id: string) => number[]) => ({
    language, ftsLanguage: language === 'de' ? 'german' : 'simple', corpusManifestSha: `sha-${language}`, model: 'qwen3',
    runs: ['a', 'b', 'c'].map((id) => ({ queryId: id, retrieved: retrievedFor(id), expected: [1] })),
  });

  it('pools both languages, pairs within a language and refuses a mismatched configuration', () => {
    const c = [control('en', () => [1]), control('de', (id) => (id === 'a' ? [1] : [9]))];
    const b = [control('en', (id) => (id === 'c' ? [9] : [1])), control('de', () => [1])];
    const scored = scoreControls(c, b, { seed: 1, iterations: 100 });
    // en: c loses on B (1 loss); de: b and c win on B (2 wins) → pooled 2W/1L over 6.
    expect(scored).toMatchObject({ n: 6, languages: ['en', 'de'] });
    expect(scored.recallAt5).toMatchObject({ wins: 2, losses: 1, ties: 3, n: 6 });
    expect(() => scoreControls(c, [{ ...b[0]!, model: 'bge-m3' }, b[1]!], { seed: 1, iterations: 10 })).toThrow(/model differs/);
    expect(() => scoreControls(c, [b[0]!], { seed: 1, iterations: 10 })).toThrow(/same languages/);
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
    sources: [{ pageTitle: 'Seite' }],
  });
  const querySetSha = 'f'.repeat(64);
  let verdictLines: string[] = [];

  beforeAll(async () => {
    for (const arm of ['A', 'B', 'C'] as const) {
      writeAnswerArtifacts(dir, `run-${arm}`, await generateArmAnswers(stubAsk(arm), fixture, { arm }));
    }
  });

  it('merges into one blinded sheet whose mapping sha is recorded before any judgment exists', () => {
    const sheet = mergeSheets(dir, 'sheet', (['A', 'B', 'C'] as const).map((arm) => ({
      runId: `run-${arm}`, answersPath: join(dir, `answers-run-${arm}.jsonl`), mappingPath: join(dir, `mapping-run-${arm}.json`),
    })));
    expect(sheet.items).toBe(12);
    expect(sheet.sources.map((s) => s.arm)).toEqual(['A', 'B', 'C']);
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
    expect(() => buildArmVerdict({
      dir, runId: 'sheet', fixture, querySetSha,
      armReports: { A: armReport('A', { querySetSha }), B: armReport('B', { querySetSha }) },
      controls: null, allowUnderpowered: true, seed: 1, iterations: 100,
    })).toThrow(/7 of 12 items have no judgment/);
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

    const runs = (arm: 'A' | 'B' | 'C') => fixture.labels.map((l) => armRun({
      queryId: l.id, cluster: l.expectedFiles[0]!, style: l.style, expectedImageKeys: l.expectedImages.map((p) => p.split('/').pop()!),
      evidence: arm === 'A' && l.style === 'image' ? [{ key: 'page-1__1.png', rank: 1 }] : [],
    }));
    const armReports = {
      A: armReport('A', { querySetSha, runs: runs('A') }),
      B: armReport('B', { querySetSha, runs: runs('B') }),
      C: armReport('C', { querySetSha, runs: runs('C') }),
    };
    const input = { dir, runId: 'sheet', fixture, querySetSha, armReports, controls: null, seed: 1, iterations: 200 };

    // Below O2 (3 image-dependent of 190, 1 negative of 48): refused outright.
    expect(() => buildArmVerdict({ ...input, allowUnderpowered: false })).toThrow(/O2 pre-registers 190 and 48/);
    // A report without hardware provenance is refused too (O9).
    expect(() => buildArmVerdict({ ...input, allowUnderpowered: true, armReports: { ...armReports, A: armReport('A', { querySetSha, runs: runs('A'), hardware: null }) } })).toThrow(/records no hardware/);

    const report = buildArmVerdict({ ...input, allowUnderpowered: true });
    expect(report.toolingVerificationOnly).toBe(true);
    expect(report.judge).toBe('simon');
    expect(report.singleJudgeStatement).toBe(SINGLE_JUDGE_STATEMENT);
    expect(report.sample).toMatchObject({ imageDependent: 3, imageNegative: 1 });
    // Primary B vs A over q1..q3: A 1/3, B 3/3 → B wins q1, q2; q3 tie → +66.7 pp, 2W/0L.
    expect(report.judged.primary.correctness).toMatchObject({ n: 3, wins: 2, losses: 0, ties: 1 });
    expect(report.judged.primary.correctness.delta).toBeCloseTo(2 / 3, 10);
    expect(report.judged.secondary.map((s) => `${s.candidate}-${s.baseline}`)).toEqual(['B-C', 'C-A']);
    // C refused q3 (the stub's refusal frame) → its refusal rate against A is 1/4.
    expect(report.judged.secondary[1]!.refusal.candidateRate).toBe(0.25);
    // Controls were not given: the gate cannot pass, whatever the primary says.
    expect(report.decision.verdict).not.toBe('pass');
    expect(report.decision.conditions.some((c) => c.name.includes('controls') && c.verdict === 'inconclusive')).toBe(true);
    expect(report.items).toHaveLength(12);
    verdictLines = formatArmVerdict(report);
    expect(verdictLines[0]).toMatch(/TOOLING VERIFICATION ONLY/);
    expect(verdictLines.join('\n')).toContain('Single-judge protocol');
  });

  it('refuses a mapping that changed after the sheet recorded its sha', () => {
    const mappingFile = join(dir, 'mapping-sheet.json');
    const original = readFileSync(mappingFile, 'utf8');
    writeFileSync(mappingFile, original.replace(/\n$/, ' \n'));
    try {
      expect(() => buildArmVerdict({
        dir, runId: 'sheet', fixture, querySetSha,
        armReports: { A: armReport('A', { querySetSha }), B: armReport('B', { querySetSha }) },
        controls: null, allowUnderpowered: true, seed: 1, iterations: 50,
      })).toThrow(/mapping changed under the judge/);
    } finally {
      writeFileSync(mappingFile, original);
    }
  });
});
