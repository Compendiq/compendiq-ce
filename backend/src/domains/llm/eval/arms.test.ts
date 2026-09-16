import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { armReport, armRun, heldFixedKnobs } from './arm-report-fixtures.js';
import {
  ARM_MARGINS,
  ARM_SAMPLE,
  ArmRunReportSchema,
  HELD_FIXED_KNOBS,
  armProvenanceProblems,
  assertComparableArms,
  assertSingleAnalysisVersionPair,
  commandLine,
  compareArmRetrieval,
  evidenceKeysOf,
  imageAnalysisIdentityHash,
  imageEvidenceGuardrailPower,
  imageEvidenceRecallAtK,
  imageNegativeLeakAt1,
  isRegressionControlPair,
  parseArmFlag,
  parseArmRunReport,
  primaryEndpointPower,
  rankedEvidence,
  revisionSpecificKnobs,
  readArmImageEnv,
  readRevisionSha,
  type RetrievalKnobs,
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
    // Review r1 finding 1: a RAG knob that drifted between arms reached a verdict.
    ['retrieval.rag_fetch_width', { retrieval: heldFixedKnobs({ rag_fetch_width: 99 }) }],
    ['retrieval.rag_answer_max_images', { retrieval: heldFixedKnobs({ rag_answer_max_images: 2 }) }],
    // A knob recorded on one side only is a drift too, never a default —
    // on the SAME revision, which A and B share in these fixtures.
    ['retrieval.topK', { retrieval: heldFixedKnobs({ topK: 10 }) }],
  ] as const)('refuses a pair whose %s differs, naming the field', (field, over) => {
    expect(() => assertComparableArms(armReport('A'), armReport('B', over))).toThrow(new RegExp(`held-fixed[\\s\\S]*${field.replace('.', '\\.')}`));
  });

  it('requires the ADR\'s named knobs of every report, so "neither side recorded it" cannot pass the comparison', () => {
    // Review r2 finding 4: `retrieval` was a keyless record, so two reports
    // that both omitted a knob compared nothing at all.
    const partial: Record<string, number | string | boolean | null> = { ...heldFixedKnobs() };
    delete partial.rag_mmr_lambda;
    expect(() => parseArmRunReport({ ...armReport('B'), retrieval: partial }, 'arm-B.json'))
      .toThrow(/arm-B\.json is not an arm run report \(retrieval\.rag_mmr_lambda/);
    expect(ArmRunReportSchema.safeParse({ ...armReport('B'), retrieval: partial }).success).toBe(false);
    // Two reports that BOTH omit it compare nothing — which is why the schema,
    // not the comparison, is where the named set is enforced.
    const knobs = partial as RetrievalKnobs;
    expect(() => assertComparableArms({ ...armReport('A'), retrieval: knobs }, { ...armReport('B'), retrieval: knobs })).not.toThrow();
    expect(HELD_FIXED_KNOBS).toContain('rag_mmr_lambda');
  });

  it('records — never refuses — a knob only one REVISION defines, and still refuses one-sided knobs within a revision', () => {
    // Arm A runs on the legacy revision by design, so a knob that exists only
    // on the candidate revision can never be made to agree: refusing it would
    // block the gate with no re-run that fixes it (review r2 finding 4).
    const legacyA = armReport('A', { revisionSha: 'abcdef0' });
    const candidateB = armReport('B', { retrieval: heldFixedKnobs({ rag_derived_chunk_boost: 0.25 }) });
    expect(revisionSpecificKnobs(legacyA, candidateB)).toEqual(['rag_derived_chunk_boost']);
    expect(() => assertComparableArms(legacyA, candidateB, { baseline: 'A', candidate: 'B' })).not.toThrow();
    expect(compareArmRetrieval(legacyA, candidateB, { seed: 1, iterations: 10 }).revisionSpecificKnobs).toEqual(['rag_derived_chunk_boost']);
    // A named knob is never revision-specific, whatever the revisions are.
    expect(revisionSpecificKnobs(legacyA, armReport('B', { retrieval: heldFixedKnobs({ rag_fetch_width: 99 }) }))).toEqual([]);
    expect(() => assertComparableArms(legacyA, armReport('B', { retrieval: heldFixedKnobs({ rag_fetch_width: 99 }) }))).toThrow(/retrieval\.rag_fetch_width/);
    // B and C share the candidate revision, so a one-sided knob there is a drift.
    expect(revisionSpecificKnobs(armReport('C'), candidateB)).toEqual([]);
    expect(() => assertComparableArms(armReport('C'), candidateB, { baseline: 'C', candidate: 'B' })).toThrow(/retrieval\.rag_derived_chunk_boost/);
    expect(compareArmRetrieval(armReport('A'), armReport('B'), { seed: 1, iterations: 10 }).revisionSpecificKnobs).toEqual([]);
  });

  it('refuses a report that does not carry its own arm\'s provenance, whichever side it is on', () => {
    expect(() => assertComparableArms(armReport('A'), armReport('B', { imageAnalysisMaxOutputTokens: null }))).toThrow(/arm B must record imageAnalysisMaxOutputTokens/);
    expect(() => assertComparableArms(armReport('A'), armReport('B', { visionModel: null }))).toThrow(/arm B must record visionModel/);
    expect(() => assertComparableArms(armReport('C', { imageAnalysisMaxOutputTokens: 8192 }), armReport('B'))).toThrow(/arm C must not carry imageAnalysisMaxOutputTokens/);
  });

  it('admits the legacy-C control against the candidate C as a descriptive regression control, and nowhere else', () => {
    const legacy = armReport('C', { control: 'legacy-revision-C', revisionSha: 'abcdef0' });
    const candidate = armReport('C');
    expect(isRegressionControlPair(legacy, candidate)).toBe(true);
    expect(isRegressionControlPair(candidate, candidate)).toBe(false);
    expect(() => assertComparableArms(legacy, candidate)).not.toThrow();
    const cmp = compareArmRetrieval(legacy, candidate, { seed: 1, iterations: 10 });
    expect(cmp.regressionControl).toBe(true);
    expect(compareArmRetrieval(armReport('A'), armReport('B'), { seed: 1, iterations: 10 }).regressionControl).toBe(false);
    // The un-blind step names its pairs; a control is refused there even as C vs C.
    expect(() => assertComparableArms(legacy, candidate, { baseline: 'C', candidate: 'C' })).toThrow(/never substituted/);
    // Two controls, or a control against A or B, are not that pairing.
    expect(() => assertComparableArms(legacy, armReport('C', { control: 'legacy-revision-C' }))).toThrow(/never substituted/);
    expect(() => assertComparableArms(legacy, armReport('B', { revisionSha: 'abcdef0' }))).toThrow(/never substituted/);
  });
});

describe('armProvenanceProblems (ADR-027 "Report provenance", per arm)', () => {
  it('accepts each arm\'s own shape and names what is missing or foreign', () => {
    for (const arm of ['A', 'B', 'C'] as const) expect(armProvenanceProblems(armReport(arm))).toEqual([]);
    expect(armProvenanceProblems(armReport('B', { visionModel: null, imageAnalysisMaxOutputTokens: null })).map((p) => p.field))
      .toEqual(['visionModel', 'imageAnalysisMaxOutputTokens']);
    expect(armProvenanceProblems(armReport('A', { imageIndexIdentity: null })).map((p) => p.field)).toEqual(['imageIndexIdentity']);
    expect(armProvenanceProblems(armReport('C', { visionModel: armReport('B').visionModel })).map((p) => p.field)).toEqual(['visionModel']);
  });

  it('is the schema\'s rule too: a B report without the ceiling does not parse', () => {
    expect(() => parseArmRunReport(armReport('B', { imageAnalysisMaxOutputTokens: null }), 'arm-B.json')).toThrow(/arm-B\.json is not an arm run report \(imageAnalysisMaxOutputTokens: arm B must record/);
    expect(() => parseArmRunReport(armReport('C', { imageAnalysisVersions: { prompt: 1, schema: 1 } }), 'arm-C.json')).toThrow(/imageAnalysisVersions: arm C must not carry/);
    expect(ArmRunReportSchema.safeParse(armReport('B')).success).toBe(true);
  });

  it('hashes D5\'s retained identity in canonical form', () => {
    // `printf 'p\nm\nhttp://x' | shasum -a 256` — the three-tuple joined by newlines, nothing else.
    expect(imageAnalysisIdentityHash('p', 'm', 'http://x')).toBe('37977b9082e0f733ca94d937453823516e332111cd20f4addc15b92975d07ede');
    expect(imageAnalysisIdentityHash('p', 'm', 'http://y')).not.toBe(imageAnalysisIdentityHash('p', 'm', 'http://x'));
  });

  it('refuses a backfill that straddled a version bump, and a complete count with no pair (D5)', () => {
    // The version-straddle refusal used to live inside `awaitArmBBackfill`, a
    // script-private function no test can call, so it was pinned only as
    // source text — which a query whose result is ignored also passes (review
    // r2 finding 6).
    expect(assertSingleAnalysisVersionPair({ analyzed: 187, versions: 1, prompt: 3, schema: 2 })).toEqual({ prompt: 3, schema: 2 });
    expect(() => assertSingleAnalysisVersionPair({ analyzed: 187, versions: 2, prompt: 3, schema: 2 }))
      .toThrow(/the 187 valid analyses carry 2 distinct \(prompt_version, schema_version\) pairs/);
    expect(() => assertSingleAnalysisVersionPair({ analyzed: 0, versions: 0, prompt: null, schema: null })).toThrow(/straddled a version bump/);
    expect(() => assertSingleAnalysisVersionPair({ analyzed: 187, versions: 1, prompt: null, schema: 1 })).toThrow(/no row carries it/);
  });
});

describe('readRevisionSha (the sha pins the prompts)', () => {
  const root = mkdtempSync(join(tmpdir(), 'arm-revision-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

  const repo = join(root, 'repo');
  const bare = join(root, 'no-git');
  execFileSync('mkdir', ['-p', repo, bare]);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'prompt.txt'), 'v1\n');
  git(repo, 'add', 'prompt.txt');
  git(repo, 'commit', '-q', '-m', 'one');
  const head = git(repo, 'rev-parse', 'HEAD');

  it('records HEAD of a clean checkout and ignores untracked files', () => {
    expect(readRevisionSha({ env: {}, cwd: repo })).toBe(head);
    writeFileSync(join(repo, 'scratch.json'), '{}');
    expect(readRevisionSha({ env: {}, cwd: repo })).toBe(head);
  });

  it('refuses a tree with uncommitted changes to tracked files', () => {
    writeFileSync(join(repo, 'prompt.txt'), 'v2\n');
    try {
      expect(() => readRevisionSha({ env: {}, cwd: repo })).toThrow(/uncommitted changes to tracked files \(.*prompt\.txt/);
      // The override cannot relabel a dirty checkout either.
      expect(() => readRevisionSha({ env: { EVAL_REVISION_SHA: head }, cwd: repo })).toThrow(/uncommitted changes/);
    } finally {
      git(repo, 'checkout', '--', 'prompt.txt');
    }
  });

  it('accepts EVAL_REVISION_SHA only where git cannot answer, and refuses one that disagrees with HEAD', () => {
    expect(() => readRevisionSha({ env: {}, cwd: bare })).toThrow(/EVAL_REVISION_SHA/);
    expect(readRevisionSha({ env: { EVAL_REVISION_SHA: 'abcdef0123' }, cwd: bare })).toBe('abcdef0123');
    expect(() => readRevisionSha({ env: { EVAL_REVISION_SHA: 'not-a-sha' }, cwd: bare })).toThrow(/not a commit sha/);
    expect(() => readRevisionSha({ env: { EVAL_REVISION_SHA: 'abcdef0123' }, cwd: repo })).toThrow(/does not name this checkout's HEAD/);
    expect(readRevisionSha({ env: { EVAL_REVISION_SHA: head.slice(0, 12) }, cwd: repo })).toBe(head);
  });
});

describe('commandLine (ADR-027 "Report provenance": commands)', () => {
  it('records the script relative to the working directory and every argument, quoting whitespace', () => {
    expect(commandLine(['/usr/bin/node', '/w/backend/scripts/run-retrieval-eval.ts', '--images', '--arm', 'C', '--out', 'arm C.json'], '/w/backend'))
      .toBe('scripts/run-retrieval-eval.ts --images --arm C --out "arm C.json"');
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
