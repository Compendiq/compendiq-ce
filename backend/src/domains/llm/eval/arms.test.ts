import { describe, expect, it } from 'vitest';
import { armReport, armRun } from './arm-report-fixtures.js';
import {
  ARM_MARGINS,
  ARM_SAMPLE,
  ArmRunReportSchema,
  assertComparableArms,
  compareArmRetrieval,
  evidenceKeysOf,
  imageEvidenceGuardrailPower,
  imageEvidenceRecallAtK,
  imageNegativeLeakAt1,
  parseArmFlag,
  parseArmRunReport,
  primaryEndpointPower,
  rankedEvidence,
  readArmImageEnv,
} from './arms.js';

/**
 * #1614 PR2 — the arm axis's refusals and its evidence rule, without a
 * database. The pairing guard is exercised one mismatched field at a time:
 * ADR-027 "Held fixed" names each of them, and a guard that fires on the
 * first mismatch it finds would let the other seven go untested.
 */

describe('parseArmFlag', () => {
  it('reads a valid arm on top of --images and nothing without the flag', () => {
    expect(parseArmFlag(['--images', '--arm', 'C'])).toBe('C');
    expect(parseArmFlag(['--images', '--arm=A'])).toBe('A');
    expect(parseArmFlag(['--images'])).toBeNull();
  });

  it('refuses an unknown arm and an arm without --images', () => {
    expect(() => parseArmFlag(['--images', '--arm', 'D'])).toThrow(/A\|B\|C/);
    expect(() => parseArmFlag(['--arm', 'C'])).toThrow(/needs --images/);
  });
});

describe('readArmImageEnv', () => {
  const vl = { EVAL_IMAGE_EMBEDDING_BASE_URL: 'http://vl/v1', EVAL_IMAGE_EMBEDDING_MODEL: 'vl' };

  it('requires the VL pair on arm A', () => {
    expect(readArmImageEnv('A', vl as NodeJS.ProcessEnv)).toMatchObject({ baseUrl: 'http://vl/v1', model: 'vl' });
    expect(() => readArmImageEnv('A', {} as NodeJS.ProcessEnv)).toThrow(/EVAL_IMAGE_EMBEDDING_BASE_URL/);
  });

  it('refuses ANY VL variable on arms B and C, and returns null without them', () => {
    for (const arm of ['B', 'C'] as const) {
      expect(readArmImageEnv(arm, {} as NodeJS.ProcessEnv)).toBeNull();
      expect(() => readArmImageEnv(arm, vl as NodeJS.ProcessEnv)).toThrow(/no image leg/);
      // Even a lone dimensions variable: it would be read by nobody and
      // recorded by nobody, and a report that silently ignores an operator's
      // configuration is the drift the flag guard exists to stop.
      expect(() => readArmImageEnv(arm, { EVAL_IMAGE_EMBEDDING_DIMENSIONS: '512' } as NodeJS.ProcessEnv)).toThrow(/EVAL_IMAGE_EMBEDDING_DIMENSIONS/);
    }
  });
});

describe('the owner decisions as constants', () => {
  it('carry O1–O7 as confirmed on 2026-09-15', () => {
    expect(ARM_MARGINS).toMatchObject({
      primaryPoints: 0.05, textNonInferiority: 0.02, imageEvidenceNonInferiority: 0.05,
      unsupportedClaimPoints: 0.03, leakageQueries: 2, leakageDenominator: 48, pilotPairs: 30, pilotDiscordanceFloor: 0.2,
    });
    expect(ARM_SAMPLE).toMatchObject({ imageDependent: 190, imageDependentFloor: 144, imageNegative: 48, controlPerLanguage: 197, primaryDesignEffect: 1.4 });
  });

  it('state the powers the ADR states', () => {
    expect(primaryEndpointPower(190)).toBeCloseTo(0.9, 1);
    expect(imageEvidenceGuardrailPower(190)).toBeCloseTo(0.44, 1);
  });
});

describe('evidence attribution (ADR-027 endpoint table)', () => {
  const row = { pageId: 7, imageHits: [{ key: 'leg.png' }], derived: { attachmentKey: 'derived.png' } };

  it('reads the leg on A, the derived provenance on B, nothing on C', () => {
    expect(evidenceKeysOf('A', row)).toEqual(['leg.png']);
    expect(evidenceKeysOf('B', row)).toEqual(['derived.png']);
    expect(evidenceKeysOf('C', row)).toEqual([]);
  });

  it('reads no B evidence from a row without derived provenance — this revision\'s rows', () => {
    expect(evidenceKeysOf('B', { pageId: 7, imageHits: [{ key: 'leg.png' }] })).toEqual([]);
    expect(evidenceKeysOf('B', { pageId: 7, derived: { attachmentKey: '' } })).toEqual([]);
    expect(evidenceKeysOf('B', { pageId: 7, derived: null })).toEqual([]);
  });

  it('ranks evidence by PAGE, so a page repeated across rows keeps one rank', () => {
    const rows = [
      { pageId: 1, imageHits: [{ key: 'a.png' }] },
      { pageId: 1, imageHits: [{ key: 'b.png' }] },
      { pageId: 2, imageHits: [] },
      { pageId: 3, imageHits: [{ key: 'c.png' }] },
    ];
    expect(rankedEvidence('A', rows)).toEqual([
      { key: 'a.png', rank: 1 }, { key: 'b.png', rank: 1 }, { key: 'c.png', rank: 3 },
    ]);
  });

  it('scores image-evidence R@K inside the window and reports arm C as none', () => {
    const runs = [
      armRun({ queryId: 'hit', evidence: [{ key: 'img-1.png', rank: 5 }] }),
      armRun({ queryId: 'outside', evidence: [{ key: 'img-1.png', rank: 6 }] }),
      armRun({ queryId: 'wrong', evidence: [{ key: 'other.png', rank: 1 }] }),
      armRun({ queryId: 'negative', style: 'image-negative', expectedImageKeys: [], evidence: [{ key: 'x.png', rank: 1 }] }),
    ];
    // 1 of the 3 image-labelled runs has the expected image at rank ≤ 5; the negative is not scored.
    expect(imageEvidenceRecallAtK('A', runs, 5)).toBeCloseTo(1 / 3, 10);
    expect(imageEvidenceRecallAtK('A', runs, 6)).toBeCloseTo(2 / 3, 10);
    expect(imageEvidenceRecallAtK('C', runs, 5)).toBeNull();
    // Leakage@1: the one negative carried evidence at rank 1.
    expect(imageNegativeLeakAt1(runs)).toBe(1);
    expect(imageNegativeLeakAt1([armRun({ queryId: 'n', style: 'image-negative', expectedImageKeys: [], evidence: [{ key: 'x', rank: 2 }] })])).toBe(0);
  });
});

describe('assertComparableArms (ADR-027 "Held fixed across arms")', () => {
  it('accepts two different arms under one held-fixed configuration', () => {
    expect(() => assertComparableArms(armReport('A'), armReport('B'))).not.toThrow();
    expect(() => assertComparableArms(armReport('A'), armReport('B'), { baseline: 'A', candidate: 'B' })).not.toThrow();
  });

  it('refuses two runs of the same arm', () => {
    expect(() => assertComparableArms(armReport('B'), armReport('B'))).toThrow(/Both reports are arm B/);
  });

  it('refuses a report that is not the arm the pair names it as', () => {
    expect(() => assertComparableArms(armReport('C'), armReport('B'), { baseline: 'A', candidate: 'B' })).toThrow(/baseline report is arm C/);
  });

  it('refuses B and C on different revisions, and does not require A to share one', () => {
    expect(() => assertComparableArms(armReport('C', { revisionSha: 'abcdef0' }), armReport('B'))).toThrow(/SAME candidate revision/);
    expect(() => assertComparableArms(armReport('A', { revisionSha: 'abcdef0' }), armReport('B'))).not.toThrow();
  });

  it('refuses a legacy-revision C control as either side of a pair', () => {
    expect(() => assertComparableArms(armReport('C', { control: 'legacy-revision-C' }), armReport('B'))).toThrow(/never substituted for arm C/);
    expect(() => assertComparableArms(armReport('A'), armReport('C', { control: 'legacy-revision-C' }))).toThrow(/never substituted/);
  });

  it.each([
    ['corpusManifestSha', { corpusManifestSha: 'other' }],
    ['querySetSha', { querySetSha: 'b'.repeat(64) }],
    ['embedder', { embedder: { identity: 'x', model: 'bge-m3', endpoint: 'http://embed/v1', dims: 1024 } }],
    ['ftsLanguage', { ftsLanguage: 'simple' }],
    ['rerank', { rerank: 'jina:rerank@http://rr/v1' }],
    ['answerModel', { answerModel: null }],
  ] as const)('refuses a pair whose %s differs, naming the field', (field, over) => {
    expect(() => assertComparableArms(armReport('A'), armReport('B', over))).toThrow(new RegExp(`held-fixed[\\s\\S]*${field}`));
  });
});

describe('parseArmRunReport (ADR-027 "Report provenance")', () => {
  it('refuses a report missing a provenance field, naming it', () => {
    const withoutQuerySet: Record<string, unknown> = { ...armReport('A') };
    delete withoutQuerySet.querySetSha;
    expect(() => parseArmRunReport(withoutQuerySet, 'arm-A.json')).toThrow(/arm-A\.json is not an arm run report \(querySetSha/);
    expect(() => parseArmRunReport({ axis: 'images' }, 'x.json')).toThrow(/not an arm run report/);
  });

  it('accepts a complete report and keeps hardware nullable for the un-blind step to refuse', () => {
    expect(ArmRunReportSchema.parse(armReport('C', { hardware: null })).hardware).toBeNull();
  });
});

describe('compareArmRetrieval', () => {
  it('pairs by query id, scores the retrieval rows and reports image evidence as none against C', () => {
    const runsA = [
      armRun({ queryId: 'q1', retrieved: [9, 1], expected: [1], cluster: 'p1', evidence: [{ key: 'img-1.png', rank: 2 }] }),
      armRun({ queryId: 'q2', retrieved: [2], expected: [2], cluster: 'p1', evidence: [] }),
      armRun({ queryId: 'n1', retrieved: [5], expected: [3], cluster: 'p2', style: 'image-negative', expectedImageKeys: [], evidence: [{ key: 'z', rank: 1 }] }),
    ];
    const runsB = [
      armRun({ queryId: 'q1', retrieved: [1], expected: [1], cluster: 'p1', evidence: [{ key: 'img-1.png', rank: 1 }] }),
      armRun({ queryId: 'q2', retrieved: [9], expected: [2], cluster: 'p1', evidence: [] }),
      armRun({ queryId: 'n1', retrieved: [3], expected: [3], cluster: 'p2', style: 'image-negative', expectedImageKeys: [], evidence: [] }),
    ];
    const cmp = compareArmRetrieval(armReport('A', { runs: runsA }), armReport('B', { runs: runsB }), { seed: 1, iterations: 100 });
    // R@1: q1 0→1 (win), q2 1→0 (loss), n1 0→1 (win) → 2W/1L over 3 pairs.
    expect(cmp.recallAt['@1']).toMatchObject({ wins: 2, losses: 1, ties: 0, n: 3 });
    expect(cmp.recallAt['@1']!.pValue).toBeCloseTo(mcnemarP(2, 1), 10);
    // Image evidence: both image labels; A hits within 5 on q1 (rank 2), B too → tie; q2 neither.
    expect(cmp.imageEvidenceRecallAt5).toMatchObject({ n: 2, wins: 0, losses: 0, ties: 2 });
    expect(cmp.imageEvidenceGuardrailPower).toBeGreaterThan(0);
    // Leakage@1 over the one negative: A leaked, B did not → one loss for B's rate (a win for safety).
    expect(cmp.leakageAt1).toMatchObject({ n: 1, baselineRate: 1, candidateRate: 0 });
    const vsC = compareArmRetrieval(armReport('C', { runs: runsA.map((r) => ({ ...r, evidence: [] })) }), armReport('B', { runs: runsB }), { seed: 1, iterations: 100 });
    expect(vsC.imageEvidenceRecallAt5).toBeNull();
    expect(vsC.imageEvidenceGuardrailPower).toBeNull();
  });

  it('refuses query sets that do not pair one-to-one', () => {
    expect(() => compareArmRetrieval(
      armReport('A', { runs: [armRun({ queryId: 'q1' }), armRun({ queryId: 'q2' })] }),
      armReport('B', { runs: [armRun({ queryId: 'q1' })] }),
      { seed: 1, iterations: 10 },
    )).toThrow(/do not pair one-to-one/);
  });
});

/** 2·P(X ≤ min) for X ~ Bin(n, ½) — the exact test's definition, restated here. */
function mcnemarP(wins: number, losses: number): number {
  const n = wins + losses;
  const k = Math.min(wins, losses);
  let cumulative = 0;
  for (let i = 0; i <= k; i++) cumulative += choose(n, i) / 2 ** n;
  return Math.min(1, 2 * cumulative);
}
function choose(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}
