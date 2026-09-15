/**
 * #1614 PR2 — the judgment sheet, `--unblind`, and the paired verdict
 * (ADR-027 "Judging protocol", "Endpoints", "Decision rule", O1–O7, O12).
 *
 * The order of operations is the whole protocol, so it is the shape of this
 * module:
 *
 *   1. `mergeSheets` shuffles several arms' answers into ONE blinded sheet
 *      and records every source's sha256 and the sheet's own in
 *      `sheet-<id>.json` — before a single judgment exists.
 *   2. The judge fills `judgments-<id>.jsonl`; `judgmentProgress` says how
 *      far along and refuses a malformed row.
 *   3. `assertFullyJudged` refuses un-blinding until every item has EXACTLY
 *      ONE judgment by ONE judge. Only then does `unblind` join the mapping.
 *   4. `scoreArmPairs` runs the paired endpoints — McNemar exact on the
 *      discordant pairs, the page-cluster bootstrap for every interval, the
 *      one-sided margins — and `decideGate` applies the three-part rule.
 *
 * Every correctness figure is labelled single-judge and the report carries
 * `SINGLE_JUDGE_STATEMENT` verbatim: there is no second rater, no
 * adjudicator and no κ, and none is substituted.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  ARM_MARGINS,
  ARM_SAMPLE,
  EVAL_ARMS,
  assertComparableArms,
  compareArmRetrieval,
  imageEvidenceGuardrailPower,
  pairedBinaryEndpoint,
  pairedGradedEndpoint,
  primaryEndpointPower,
  type ArmRetrievalComparison,
  type ArmRunReport,
  type EvalArm,
  type PairedBinaryEndpoint,
  type PairedGradedEndpoint,
} from './arms.js';
import {
  answersPath,
  assertBlinded,
  mappingPath,
  readAnswers,
  readMapping,
  serializeAnswers,
  sha256File,
  type AnswerItem,
  type Mapping,
} from './answers.js';
import type { ImageFixture, ImageFixtureLabel } from './fixture.js';
import {
  nonInferiorityVerdict,
  pilotDiscordance,
  recallAtK,
  meanReciprocalRank,
  safetyVerdict,
  type DiscordanceCheck,
  type MarginVerdict,
  type QueryRun,
} from './metrics.js';

export const SINGLE_JUDGE_STATEMENT =
  'Single-judge protocol (ADR-027 O12): every correctness, faithfulness and unsupported-claim figure in ' +
  'this report was judged by ONE named judge, blind to arm, against the source image and page. There is ' +
  'no second rater and no adjudicator, so no inter-rater statistic (Cohen\'s κ or any substitute) exists ' +
  'or is reported; that is the protocol\'s stated limitation.';

export const JudgmentRowSchema = z.object({
  itemId: z.string().uuid(),
  judge: z.string().min(1),
  correctness: z.enum(['correct', 'partial', 'incorrect', 'refused']),
  citationFaithful: z.enum(['yes', 'no', 'na']),
  unsupportedClaim: z.boolean(),
  notes: z.string().default(''),
  judgedAt: z.string().datetime(),
}).strict();
export type JudgmentRow = z.infer<typeof JudgmentRowSchema>;

export function judgmentsPath(dir: string, runId: string): string {
  return join(dir, `judgments-${runId}.jsonl`);
}
export function sheetPath(dir: string, runId: string): string {
  return join(dir, `sheet-${runId}.json`);
}

/** Parse a judgments file; a malformed row names its line. */
export function readJudgments(path: string): JudgmentRow[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, i) => {
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        throw new Error(`${path}:${i + 1} is not JSON`);
      }
      const parsed = JudgmentRowSchema.safeParse(json);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`${path}:${i + 1}: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid judgment row'}`);
      }
      return parsed.data;
    });
}

// ---------------------------------------------------------------------------
// The blinded sheet.
// ---------------------------------------------------------------------------

export const SheetProvenanceSchema = z.object({
  runId: z.string().min(1),
  createdAt: z.string().datetime(),
  /** Every source run merged in, with the hashes of the files as they were read. */
  sources: z.array(z.object({
    runId: z.string().min(1),
    arm: z.enum(EVAL_ARMS),
    answersSha256: z.string().regex(/^[0-9a-f]{64}$/),
    mappingSha256: z.string().regex(/^[0-9a-f]{64}$/),
    items: z.number().int().nonnegative(),
  })),
  items: z.number().int().nonnegative(),
  answersSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Recorded here, before judging starts; `--unblind` refuses a mapping that no longer hashes to it. */
  mappingSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type SheetProvenance = z.infer<typeof SheetProvenanceSchema>;

export interface MergeSource {
  runId: string;
  answersPath: string;
  mappingPath: string;
}

/**
 * One blinded sheet from several arms' answer runs: the union of their rows in
 * item-id order (a random permutation across arms — see `generateArmAnswers`),
 * the union of their mappings, and a provenance file hashing all of it.
 * Refuses a source whose mapping names more than one arm, an item id that
 * appears twice, or an answers row that is not blinded.
 */
export function mergeSheets(dir: string, runId: string, sources: readonly MergeSource[], now = new Date()): SheetProvenance {
  if (sources.length === 0) throw new Error('--merge needs at least one answers/mapping pair');
  const answers: AnswerItem[] = [];
  const mapping: Mapping = {};
  const provenanceSources: SheetProvenance['sources'] = [];
  for (const source of sources) {
    const rows = readAnswers(source.answersPath);
    const map = readMapping(source.mappingPath);
    const arms = new Set(Object.values(map).map((m) => m.arm));
    if (arms.size !== 1) {
      throw new Error(`${source.mappingPath} names ${arms.size} arms — one answer run is one arm`);
    }
    for (const row of rows) {
      if (!map[row.itemId]) throw new Error(`${source.answersPath}: item ${row.itemId} has no mapping entry`);
      if (mapping[row.itemId]) throw new Error(`item ${row.itemId} appears in two sources`);
      mapping[row.itemId] = map[row.itemId]!;
      answers.push(row);
    }
    provenanceSources.push({
      runId: source.runId,
      arm: [...arms][0]!,
      answersSha256: sha256File(source.answersPath),
      mappingSha256: sha256File(source.mappingPath),
      items: rows.length,
    });
  }
  answers.sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
  assertBlinded(answers);
  const answersFile = answersPath(dir, runId);
  const mappingFile = mappingPath(dir, runId);
  writeFileSync(answersFile, serializeAnswers(answers));
  writeFileSync(mappingFile, `${JSON.stringify(mapping, null, 2)}\n`);
  const provenance: SheetProvenance = {
    runId,
    createdAt: now.toISOString(),
    sources: provenanceSources,
    items: answers.length,
    answersSha256: sha256File(answersFile),
    mappingSha256: sha256File(mappingFile),
  };
  writeFileSync(sheetPath(dir, runId), `${JSON.stringify(provenance, null, 2)}\n`);
  return provenance;
}

// ---------------------------------------------------------------------------
// Progress and the un-blinding refusal.
// ---------------------------------------------------------------------------

export interface JudgmentProgress {
  total: number;
  judged: number;
  missing: string[];
  duplicates: string[];
  /** Judgments for item ids the sheet does not carry. */
  unknown: string[];
  judges: string[];
}

export function judgmentProgress(answers: readonly AnswerItem[], judgments: readonly JudgmentRow[]): JudgmentProgress {
  const items = new Set(answers.map((a) => a.itemId));
  const counts = new Map<string, number>();
  const unknown: string[] = [];
  for (const j of judgments) {
    if (!items.has(j.itemId)) {
      unknown.push(j.itemId);
      continue;
    }
    counts.set(j.itemId, (counts.get(j.itemId) ?? 0) + 1);
  }
  const missing = answers.filter((a) => !counts.has(a.itemId)).map((a) => a.itemId);
  const duplicates = [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  return {
    total: answers.length,
    judged: counts.size,
    missing,
    duplicates,
    unknown,
    judges: [...new Set(judgments.map((j) => j.judge))].sort(),
  };
}

/**
 * The `--unblind` gate: every item has exactly one judgment, every judgment
 * names an item on the sheet, and one judge signed all of them.
 */
export function assertFullyJudged(answers: readonly AnswerItem[], judgments: readonly JudgmentRow[]): JudgmentProgress {
  const progress = judgmentProgress(answers, judgments);
  const problems: string[] = [];
  if (progress.missing.length > 0) {
    problems.push(`${progress.missing.length} of ${progress.total} items have no judgment (first: ${progress.missing.slice(0, 3).join(', ')})`);
  }
  if (progress.duplicates.length > 0) {
    problems.push(`${progress.duplicates.length} items have more than one judgment (first: ${progress.duplicates.slice(0, 3).join(', ')})`);
  }
  if (progress.unknown.length > 0) {
    problems.push(`${progress.unknown.length} judgments name items not on this sheet (first: ${progress.unknown.slice(0, 3).join(', ')})`);
  }
  if (progress.judges.length !== 1) {
    problems.push(
      progress.judges.length === 0
        ? 'no judgments at all'
        : `${progress.judges.length} judges signed rows (${progress.judges.join(', ')}) — the protocol is one judge (O12)`,
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `Refusing to un-blind: ${problems.join('; ')}. ADR-027: un-blinding waits until every item has ` +
        'exactly one judgment, and paired scoring runs only after that.',
    );
  }
  return progress;
}

export interface UnblindedItem {
  itemId: string;
  arm: EvalArm;
  queryId: string;
  refused: boolean;
  judgment: JudgmentRow;
  /** The primary endpoint's coding: `correct` is 1, everything else 0. */
  correct: 0 | 1;
}

/** Join the sheet, the judgments and the mapping. Call only after `assertFullyJudged`. */
export function unblind(answers: readonly AnswerItem[], judgments: readonly JudgmentRow[], mapping: Mapping): UnblindedItem[] {
  assertFullyJudged(answers, judgments);
  const byItem = new Map(judgments.map((j) => [j.itemId, j]));
  return answers.map((a) => {
    const entry = mapping[a.itemId];
    if (!entry) throw new Error(`item ${a.itemId} has no mapping entry — the mapping does not belong to this sheet`);
    const judgment = byItem.get(a.itemId)!;
    return {
      itemId: a.itemId,
      arm: entry.arm,
      queryId: entry.queryId,
      refused: a.refused,
      judgment,
      correct: judgment.correctness === 'correct' ? 1 : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Scoring.
// ---------------------------------------------------------------------------

export interface JudgedPairEndpoints {
  baseline: EvalArm;
  candidate: EvalArm;
  /** Image-dependent labels only. */
  correctness: PairedBinaryEndpoint;
  /** `partial` reported separately, as the runbook promises. */
  partialRate: { baseline: number; candidate: number };
  /** Over items where either side's citation was judged (not `na`). */
  citationFaithful: PairedBinaryEndpoint;
  unsupportedClaim: PairedBinaryEndpoint;
  refusal: PairedBinaryEndpoint;
  pilot: DiscordanceCheck;
}

interface LabelFacts {
  cluster: string;
  style: 'image' | 'image-negative';
  imageDependent: boolean;
}

function labelFacts(fixture: ImageFixture): Map<string, LabelFacts> {
  return new Map(
    fixture.labels.map((l: ImageFixtureLabel) => [
      l.id,
      { cluster: l.expectedFiles[0]!, style: l.style, imageDependent: l.imageDependent === true },
    ]),
  );
}

/** The judged endpoints for one pair of arms over the un-blinded items. */
export function scoreJudgedPair(
  items: readonly UnblindedItem[],
  fixture: ImageFixture,
  pair: { baseline: EvalArm; candidate: EvalArm },
  opts: { seed: number; iterations?: number },
): JudgedPairEndpoints {
  const facts = labelFacts(fixture);
  const byArm = (arm: EvalArm) => new Map(items.filter((i) => i.arm === arm).map((i) => [i.queryId, i]));
  const base = byArm(pair.baseline);
  const cand = byArm(pair.candidate);
  const queryIds = [...base.keys()].filter((id) => cand.has(id));
  if (queryIds.length === 0) {
    throw new Error(`No query was judged on both arm ${pair.baseline} and arm ${pair.candidate}`);
  }
  const rows = queryIds.map((queryId) => {
    const f = facts.get(queryId);
    if (!f) throw new Error(`query ${queryId} is not in the fixture — the mapping and the fixture disagree`);
    return { queryId, cluster: f.cluster, style: f.style, imageDependent: f.imageDependent, b: base.get(queryId)!, c: cand.get(queryId)! };
  });
  const primary = rows.filter((r) => r.imageDependent);
  const binary = (
    subset: typeof rows,
    score: (item: UnblindedItem) => 0 | 1,
  ) => pairedBinaryEndpoint(
    subset.map((r) => ({ queryId: r.queryId, cluster: r.cluster, baseline: score(r.b), candidate: score(r.c) })),
    opts,
  );
  const rate = (subset: typeof rows, pick: (r: (typeof rows)[number]) => UnblindedItem, pred: (i: UnblindedItem) => boolean) =>
    subset.length === 0 ? 0 : subset.filter((r) => pred(pick(r))).length / subset.length;
  const cited = rows.filter((r) => r.b.judgment.citationFaithful !== 'na' || r.c.judgment.citationFaithful !== 'na');
  return {
    baseline: pair.baseline,
    candidate: pair.candidate,
    correctness: binary(primary, (i) => i.correct),
    partialRate: {
      baseline: rate(primary, (r) => r.b, (i) => i.judgment.correctness === 'partial'),
      candidate: rate(primary, (r) => r.c, (i) => i.judgment.correctness === 'partial'),
    },
    citationFaithful: binary(cited, (i) => (i.judgment.citationFaithful === 'yes' ? 1 : 0)),
    unsupportedClaim: binary(rows, (i) => (i.judgment.unsupportedClaim ? 1 : 0)),
    refusal: binary(rows, (i) => (i.judgment.correctness === 'refused' || i.refused ? 1 : 0)),
    pilot: pilotDiscordance(
      primary.map((r) => ({ baseline: r.b.correct, candidate: r.c.correct })),
      { pilotPairs: ARM_MARGINS.pilotPairs, floor: ARM_MARGINS.pilotDiscordanceFloor },
    ),
  };
}

/** A text-gate report's slice the pooled control test reads. */
export interface TextGateControl {
  language: string;
  ftsLanguage: string;
  corpusManifestSha: string;
  model: string;
  runs: QueryRun[];
}

export interface ControlEndpoints {
  /** EN + DE pooled, B vs C (O4). */
  recallAt5: PairedBinaryEndpoint;
  mrr: PairedGradedEndpoint;
  languages: string[];
  n: number;
}

/**
 * The pooled EN + DE control (O4): the same text-gate reports the #1102 gate
 * writes, one per language per arm, paired by query id within a language and
 * clustered by the query's first expected page. Refuses a pair whose language,
 * FTS configuration, corpus or text embedder differ.
 */
export function scoreControls(
  baseline: readonly TextGateControl[],
  candidate: readonly TextGateControl[],
  opts: { seed: number; iterations?: number },
): ControlEndpoints {
  if (baseline.length !== candidate.length || baseline.length === 0) {
    throw new Error('Controls need the same languages on both arms, at least one');
  }
  const binaryRows: Array<{ queryId: string; cluster: string; baseline: 0 | 1; candidate: 0 | 1 }> = [];
  const gradedRows: Array<{ queryId: string; cluster: string; baseline: number; candidate: number }> = [];
  const languages: string[] = [];
  let n = 0;
  for (const b of baseline) {
    const c = candidate.find((x) => x.language === b.language);
    if (!c) throw new Error(`Control ${b.language} has no counterpart on the other arm`);
    for (const [field, l, r] of [
      ['ftsLanguage', b.ftsLanguage, c.ftsLanguage],
      ['corpusManifestSha', b.corpusManifestSha, c.corpusManifestSha],
      ['model', b.model, c.model],
    ] as const) {
      if (l !== r) throw new Error(`Control ${b.language}: ${field} differs (${l} vs ${r}) — not a paired control`);
    }
    const byId = new Map(c.runs.map((r) => [r.queryId, r]));
    for (const run of b.runs) {
      const other = byId.get(run.queryId);
      if (!other) throw new Error(`Control ${b.language}: query ${run.queryId} is missing on the other arm`);
      const key = `${b.language}:${run.queryId}`;
      const cluster = `${b.language}:${run.expected[0] ?? run.queryId}`;
      binaryRows.push({
        queryId: key,
        cluster,
        baseline: recallAtK([run], 5) === 1 ? 1 : 0,
        candidate: recallAtK([other], 5) === 1 ? 1 : 0,
      });
      gradedRows.push({ queryId: key, cluster, baseline: meanReciprocalRank([run]), candidate: meanReciprocalRank([other]) });
      n++;
    }
    languages.push(b.language);
  }
  return {
    recallAt5: pairedBinaryEndpoint(binaryRows, opts),
    mrr: pairedGradedEndpoint(gradedRows, opts),
    languages,
    n,
  };
}

// ---------------------------------------------------------------------------
// The decision rule.
// ---------------------------------------------------------------------------

export interface GateCondition {
  name: string;
  verdict: MarginVerdict;
  detail: string;
}

export interface GateDecision {
  verdict: 'pass' | 'fail' | 'inconclusive' | 'inconclusive-by-design';
  conditions: GateCondition[];
}

const pp = (x: number): string => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)} pp`;

/**
 * ADR-027 "Decision rule": pass requires (1) the primary point estimate ≥ the
 * margin AND its cluster-bootstrap 95% CI excluding 0; (2) every
 * non-inferiority endpoint's one-sided lower bound above its margin; (3)
 * neither safety endpoint worse than its margin at the one-sided 95% level.
 * A pilot ψ below the floor is "inconclusive by design" and pre-empts all
 * three. Cost enters nowhere.
 */
export function decideGate(input: {
  primary: JudgedPairEndpoints;
  imageEvidence: PairedBinaryEndpoint | null;
  leakage: PairedBinaryEndpoint;
  controls: ControlEndpoints | null;
}): GateDecision {
  const conditions: GateCondition[] = [];
  const { primary } = input;
  if (primary.pilot.stop) {
    return {
      verdict: 'inconclusive-by-design',
      conditions: [{
        name: 'pilot discordance',
        verdict: 'inconclusive',
        detail: `ψ = ${primary.pilot.psi.toFixed(2)} over the first ${primary.pilot.pairs} judged pairs is below ` +
          `${ARM_MARGINS.pilotDiscordanceFloor} — the pre-registered power calculation does not hold; stop and report.`,
      }],
    };
  }
  const c = primary.correctness;
  const primaryPass = c.delta >= ARM_MARGINS.primaryPoints && c.ci.excludesZero;
  conditions.push({
    name: 'primary: image-dependent answer correctness, B vs A (single-judge)',
    verdict: primaryPass ? 'pass' : c.ci.excludesZero ? 'fail' : 'inconclusive',
    detail: `${pp(c.delta)} (margin ${pp(ARM_MARGINS.primaryPoints)}), cluster-bootstrap 95% CI [${pp(c.ci.lower)}, ${pp(c.ci.upper)}], ` +
      `McNemar exact p = ${c.pValue.toFixed(4)} over ${c.wins + c.losses} discordant of ${c.n} pairs`,
  });
  if (input.controls) {
    const r5 = nonInferiorityVerdict(input.controls.recallAt5.ci, ARM_MARGINS.textNonInferiority);
    const mrr = nonInferiorityVerdict(input.controls.mrr.ci, ARM_MARGINS.textNonInferiority);
    conditions.push({
      name: `non-inferiority: ordinary-text R@5, ${input.controls.languages.join(' + ')} pooled, B vs C`,
      verdict: r5,
      detail: `${pp(input.controls.recallAt5.delta)}, one-sided 95% lower bound ${pp(input.controls.recallAt5.ci.oneSidedLower)} vs margin −${pp(ARM_MARGINS.textNonInferiority).slice(1)}`,
    });
    conditions.push({
      name: `non-inferiority: ordinary-text MRR, ${input.controls.languages.join(' + ')} pooled, B vs C`,
      verdict: mrr,
      detail: `${pp(input.controls.mrr.delta)}, one-sided 95% lower bound ${pp(input.controls.mrr.ci.oneSidedLower)} vs margin −${pp(ARM_MARGINS.textNonInferiority).slice(1)}`,
    });
  } else {
    conditions.push({
      name: 'non-inferiority: ordinary-text controls',
      verdict: 'inconclusive',
      detail: 'no --control-b/--control-c reports were given, so the endpoint is unmeasured and blocks the gate',
    });
  }
  if (input.imageEvidence) {
    conditions.push({
      name: 'non-inferiority: image-evidence R@5, B vs A (underpowered guardrail, O5)',
      verdict: nonInferiorityVerdict(input.imageEvidence.ci, ARM_MARGINS.imageEvidenceNonInferiority),
      detail: `${pp(input.imageEvidence.delta)}, one-sided 95% lower bound ${pp(input.imageEvidence.ci.oneSidedLower)} vs margin −${pp(ARM_MARGINS.imageEvidenceNonInferiority).slice(1)}; ` +
        `power ≈ ${imageEvidenceGuardrailPower(input.imageEvidence.n).toFixed(2)} at δ = 0 — a pass reads "no collapse", never parity`,
    });
  }
  const u = primary.unsupportedClaim;
  conditions.push({
    name: 'safety: unsupported-claim rate, B vs A',
    verdict: safetyVerdict(u.ci, ARM_MARGINS.unsupportedClaimPoints),
    detail: `${pp(u.delta)}, one-sided 95% upper bound ${pp(u.ci.oneSidedUpper)} vs margin ${pp(ARM_MARGINS.unsupportedClaimPoints)}`,
  });
  const leakMargin = ARM_MARGINS.leakageQueries / ARM_MARGINS.leakageDenominator;
  conditions.push({
    name: 'safety: image-negative leakage@1, B vs A',
    verdict: safetyVerdict(input.leakage.ci, leakMargin),
    detail: `${pp(input.leakage.delta)}, one-sided 95% upper bound ${pp(input.leakage.ci.oneSidedUpper)} vs margin ` +
      `${ARM_MARGINS.leakageQueries}/${ARM_MARGINS.leakageDenominator} (${pp(leakMargin)}) over ${input.leakage.n} negatives`,
  });
  const verdicts = conditions.map((x) => x.verdict);
  const verdict = verdicts.every((v) => v === 'pass') ? 'pass' : verdicts.includes('fail') ? 'fail' : 'inconclusive';
  return { verdict, conditions };
}

// ---------------------------------------------------------------------------
// The whole verdict document.
// ---------------------------------------------------------------------------

export interface ArmVerdictInput {
  dir: string;
  runId: string;
  fixture: ImageFixture;
  querySetSha: string;
  armReports: Partial<Record<EvalArm, ArmRunReport>>;
  controls: { b: TextGateControl[]; c: TextGateControl[] } | null;
  allowUnderpowered: boolean;
  seed: number;
  iterations?: number;
  now?: Date;
}

export interface ArmVerdictReport {
  kind: 'adr-027-arm-verdict';
  runId: string;
  producedAt: string;
  /** Set when the sheet is below O2's counts: the document decides nothing. */
  toolingVerificationOnly: boolean;
  singleJudgeStatement: string;
  judge: string;
  sheet: SheetProvenance;
  sample: { imageDependent: number; imageNegative: number; required: typeof ARM_SAMPLE; primaryPower: number };
  provenance: Record<EvalArm, ArmRunReport | null>;
  judged: { primary: JudgedPairEndpoints; secondary: JudgedPairEndpoints[] };
  retrieval: { primary: ArmRetrievalComparison; others: ArmRetrievalComparison[] };
  controls: ControlEndpoints | null;
  decision: GateDecision;
  /** Every un-blinded item, for audit — after the verdict, never before. */
  items: UnblindedItem[];
}

/**
 * `--unblind`, end to end. Refuses (in this order) a sheet whose mapping no
 * longer hashes to what was recorded before judging, a sheet that is not
 * fully judged, arm reports that do not parse or do not pair, a fixture
 * whose sha is not the reports' query set, and a sample below O2 unless
 * `allowUnderpowered` labels the output as tooling verification.
 */
export function buildArmVerdict(input: ArmVerdictInput): ArmVerdictReport {
  const { dir, runId, fixture } = input;
  const sheet = SheetProvenanceSchema.parse(JSON.parse(readFileSync(sheetPath(dir, runId), 'utf8')));
  const mappingFile = mappingPath(dir, runId);
  const mappingSha = sha256File(mappingFile);
  if (mappingSha !== sheet.mappingSha256) {
    throw new Error(
      `mapping-${runId}.json hashes to ${mappingSha} but sheet-${runId}.json recorded ${sheet.mappingSha256} before ` +
        'judging started — the mapping changed under the judge. Refused.',
    );
  }
  const answers = readAnswers(answersPath(dir, runId));
  const judgments = readJudgments(judgmentsPath(dir, runId));
  const progress = assertFullyJudged(answers, judgments);
  const mapping = readMapping(mappingFile);
  const items = unblind(answers, judgments, mapping);

  const a = input.armReports.A;
  const b = input.armReports.B;
  if (!a || !b) throw new Error('--unblind needs at least the arm A and arm B retrieval reports (--arm-report A=…,B=…)');
  const c = input.armReports.C ?? null;
  for (const report of [a, b, ...(c ? [c] : [])]) {
    if (report.querySetSha !== input.querySetSha) {
      throw new Error(`Arm ${report.arm}'s report was measured on query set ${report.querySetSha}, but the fixture in this checkout hashes to ${input.querySetSha}`);
    }
    if (report.hardware === null) {
      throw new Error(`Arm ${report.arm}'s report records no hardware (EVAL_HARDWARE was unset) — ADR-027 "Report provenance" refuses it`);
    }
  }
  assertComparableArms(a, b, { baseline: 'A', candidate: 'B' });
  if (c) {
    assertComparableArms(c, b, { baseline: 'C', candidate: 'B' });
    assertComparableArms(a, c, { baseline: 'A', candidate: 'C' });
  }

  const imageDependent = fixture.labels.filter((l) => l.imageDependent === true).length;
  const imageNegative = fixture.labels.filter((l) => l.style === 'image-negative').length;
  const underpowered = imageDependent < ARM_SAMPLE.imageDependent || imageNegative < ARM_SAMPLE.imageNegative;
  if (underpowered && !input.allowUnderpowered) {
    throw new Error(
      `The fixture carries ${imageDependent} image-dependent and ${imageNegative} image-negative labels; ADR-027 O2 ` +
        `pre-registers ${ARM_SAMPLE.imageDependent} and ${ARM_SAMPLE.imageNegative} (O15's independent labelling pass ` +
        'supplies them — the harness never invents a label). Refused. --allow-underpowered scores the sheet as ' +
        'tooling verification only.',
    );
  }

  const stats = { seed: input.seed, ...(input.iterations ? { iterations: input.iterations } : {}) };
  const primary = scoreJudgedPair(items, fixture, { baseline: 'A', candidate: 'B' }, stats);
  const secondary: JudgedPairEndpoints[] = [];
  const others: ArmRetrievalComparison[] = [];
  const retrievalPrimary = compareArmRetrieval(a, b, stats);
  if (c) {
    secondary.push(scoreJudgedPair(items, fixture, { baseline: 'C', candidate: 'B' }, stats));
    secondary.push(scoreJudgedPair(items, fixture, { baseline: 'A', candidate: 'C' }, stats));
    others.push(compareArmRetrieval(c, b, stats), compareArmRetrieval(a, c, stats));
  }
  const controls = input.controls ? scoreControls(input.controls.c, input.controls.b, stats) : null;
  const decision = decideGate({
    primary,
    imageEvidence: retrievalPrimary.imageEvidenceRecallAt5,
    leakage: retrievalPrimary.leakageAt1,
    controls,
  });

  return {
    kind: 'adr-027-arm-verdict',
    runId,
    producedAt: (input.now ?? new Date()).toISOString(),
    toolingVerificationOnly: underpowered,
    singleJudgeStatement: SINGLE_JUDGE_STATEMENT,
    judge: progress.judges[0]!,
    sheet,
    sample: { imageDependent, imageNegative, required: ARM_SAMPLE, primaryPower: primaryEndpointPower(imageDependent) },
    provenance: { A: a, B: b, C: c },
    judged: { primary, secondary },
    retrieval: { primary: retrievalPrimary, others },
    controls,
    decision,
    items,
  };
}

/** The verdict as the operator reads it on the console. */
export function formatArmVerdict(report: ArmVerdictReport): string[] {
  const lines: string[] = [];
  if (report.toolingVerificationOnly) {
    lines.push('*** TOOLING VERIFICATION ONLY — the sheet is below ADR-027 O2\'s counts; this document decides nothing. ***');
  }
  lines.push(`ADR-027 arm verdict ${report.runId} — judge ${report.judge} — ${report.decision.verdict.toUpperCase()}`);
  lines.push(report.singleJudgeStatement);
  lines.push(
    `sample: ${report.sample.imageDependent} image-dependent (O2: ${report.sample.required.imageDependent}, floor ` +
      `${report.sample.required.imageDependentFloor}; primary power ≈ ${report.sample.primaryPower.toFixed(2)}), ` +
      `${report.sample.imageNegative} image-negative (O2: ${report.sample.required.imageNegative})`,
  );
  for (const condition of report.decision.conditions) {
    lines.push(`[${condition.verdict.toUpperCase().padEnd(12)}] ${condition.name}`);
    lines.push(`    ${condition.detail}`);
  }
  const p = report.judged.primary;
  lines.push(
    `partial (reported separately): A ${(100 * p.partialRate.baseline).toFixed(1)}%, B ${(100 * p.partialRate.candidate).toFixed(1)}%; ` +
      `pilot ψ = ${p.pilot.psi.toFixed(2)} over ${p.pilot.pairs} pairs${p.pilot.evaluated ? '' : ' (pilot not yet reached)'}`,
  );
  lines.push('Cost figures are reported by benchmark-query-latency.ts and the backfill card; none enters the rule above (O11).');
  return lines;
}
