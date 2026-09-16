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
 *      far along and refuses a malformed row, and `pilotCheck` reads ψ over
 *      the first 30 image-dependent A/B pairs in `judgedAt` order — the
 *      ADR's pilot, runnable while judging is under way so a ψ below 0.20
 *      stops the judge rather than being discovered after 714 rows.
 *   3. `assertFullyJudged` refuses un-blinding until every item has EXACTLY
 *      ONE judgment by ONE judge. Only then does `unblind` join the mapping,
 *      and only then is every answer run's `provenance-<runId>.json` held to
 *      its arm's retrieval report.
 *   4. `scoreJudgedPair` runs the paired endpoints — McNemar exact on the
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
  provenancePath,
  readAnswerProvenance,
  readAnswers,
  readMapping,
  serializeAnswers,
  sha256File,
  type AnswerItem,
  type AnswerRunProvenance,
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
  /** The exact `--merge` command line. */
  command: z.string().min(1),
  /** Every source run merged in, with the hashes of the files as they were read. */
  sources: z.array(z.object({
    /** The run id `run-arm-answers.ts` wrote the three files under. */
    runId: z.string().min(1),
    arm: z.enum(EVAL_ARMS),
    answersSha256: z.string().regex(/^[0-9a-f]{64}$/),
    mappingSha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** sha256 of `provenance-<runId>.json` as merged; `--unblind` re-reads the file and refuses a changed one. */
    provenanceSha256: z.string().regex(/^[0-9a-f]{64}$/),
    items: z.number().int().nonnegative(),
  })),
  items: z.number().int().nonnegative(),
  answersSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Recorded here, before judging starts; `--unblind` refuses a mapping that no longer hashes to it. */
  mappingSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type SheetProvenance = z.infer<typeof SheetProvenanceSchema>;

export interface MergeSource {
  answersPath: string;
  mappingPath: string;
  provenancePath: string;
}

/**
 * One blinded sheet from several arms' answer runs: the union of their rows in
 * item-id order (a random permutation across arms — see `generateArmAnswers`),
 * the union of their mappings, and a provenance file hashing all of it.
 * Refuses a source whose mapping names more than one arm, an item id that
 * appears twice, an answers row that is not blinded, or a run whose
 * `provenance-<runId>.json` is missing or does not hash the two files it is
 * merged with (the run's own record of what it wrote is the sheet's record of
 * what it read).
 */
export function mergeSheets(dir: string, runId: string, sources: readonly MergeSource[], command: string, now = new Date()): SheetProvenance {
  if (sources.length === 0) throw new Error('--merge needs at least one answers/mapping pair');
  const answers: AnswerItem[] = [];
  const mapping: Mapping = {};
  const provenanceSources: SheetProvenance['sources'] = [];
  for (const source of sources) {
    const rows = readAnswers(source.answersPath);
    const map = readMapping(source.mappingPath);
    const provenance = readAnswerProvenance(source.provenancePath);
    const arms = new Set(Object.values(map).map((m) => m.arm));
    if (arms.size !== 1) {
      throw new Error(`${source.mappingPath} names ${arms.size} arms — one answer run is one arm`);
    }
    const arm = [...arms][0]!;
    const answersSha256 = sha256File(source.answersPath);
    const mappingSha256 = sha256File(source.mappingPath);
    const problems: string[] = [];
    if (provenance.arm !== arm) problems.push(`provenance says arm ${provenance.arm}, the mapping says arm ${arm}`);
    if (provenance.answersSha256 !== answersSha256) problems.push(`answers file hashes to ${answersSha256}, provenance recorded ${provenance.answersSha256}`);
    if (provenance.mappingSha256 !== mappingSha256) problems.push(`mapping file hashes to ${mappingSha256}, provenance recorded ${provenance.mappingSha256}`);
    if (provenance.items !== rows.length) problems.push(`provenance recorded ${provenance.items} items, the answers file carries ${rows.length}`);
    if (problems.length > 0) {
      throw new Error(`${source.provenancePath} does not describe ${source.answersPath}: ${problems.join('; ')}. Refused — a run whose files changed after it wrote them is not evidence.`);
    }
    for (const row of rows) {
      if (!map[row.itemId]) throw new Error(`${source.answersPath}: item ${row.itemId} has no mapping entry`);
      if (mapping[row.itemId]) throw new Error(`item ${row.itemId} appears in two sources`);
      mapping[row.itemId] = map[row.itemId]!;
      answers.push(row);
    }
    provenanceSources.push({
      runId: provenance.runId,
      arm,
      answersSha256,
      mappingSha256,
      provenanceSha256: sha256File(source.provenancePath),
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
    command,
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

/**
 * Join whatever IS judged with the mapping — the un-blinded view of a sheet
 * mid-judging. Only `pilotCheck` reads it, for one aggregate number; the
 * per-item join the verdict scores is `unblind`, which gates on
 * `assertFullyJudged` first.
 */
export function joinJudged(answers: readonly AnswerItem[], judgments: readonly JudgmentRow[], mapping: Mapping): UnblindedItem[] {
  const byItem = new Map(judgments.map((j) => [j.itemId, j]));
  const items: UnblindedItem[] = [];
  for (const a of answers) {
    const judgment = byItem.get(a.itemId);
    if (!judgment) continue;
    const entry = mapping[a.itemId];
    if (!entry) throw new Error(`item ${a.itemId} has no mapping entry — the mapping does not belong to this sheet`);
    items.push({ itemId: a.itemId, arm: entry.arm, queryId: entry.queryId, refused: a.refused, judgment, correct: judgment.correctness === 'correct' ? 1 : 0 });
  }
  return items;
}

/** Join the sheet, the judgments and the mapping. Call only after `assertFullyJudged`. */
export function unblind(answers: readonly AnswerItem[], judgments: readonly JudgmentRow[], mapping: Mapping): UnblindedItem[] {
  assertFullyJudged(answers, judgments);
  return joinJudged(answers, judgments, mapping);
}

// ---------------------------------------------------------------------------
// The pilot (ADR-027 "Sample size": ψ over the first 30 judged pairs).
// ---------------------------------------------------------------------------

/**
 * The pairs of one arm comparison in the order they were JUDGED: a pair
 * exists once both its items carry a judgment, at the later of the two
 * `judgedAt` stamps. Item-id order is a random permutation, so "the first 30
 * judged pairs" can only mean this order.
 */
function pairsInJudgedOrder(
  items: readonly UnblindedItem[],
  pair: { baseline: EvalArm; candidate: EvalArm },
): Array<{ queryId: string; b: UnblindedItem; c: UnblindedItem; completedAt: string }> {
  const byArm = (arm: EvalArm) => new Map(items.filter((i) => i.arm === arm).map((i) => [i.queryId, i]));
  const base = byArm(pair.baseline);
  const cand = byArm(pair.candidate);
  const pairs: Array<{ queryId: string; b: UnblindedItem; c: UnblindedItem; completedAt: string }> = [];
  for (const [queryId, b] of base) {
    const c = cand.get(queryId);
    if (!c) continue;
    const completedAt = b.judgment.judgedAt > c.judgment.judgedAt ? b.judgment.judgedAt : c.judgment.judgedAt;
    pairs.push({ queryId, b, c, completedAt });
  }
  return pairs.sort((x, y) => (x.completedAt < y.completedAt ? -1 : x.completedAt > y.completedAt ? 1 : x.queryId < y.queryId ? -1 : 1));
}

/**
 * The pilot rule on a sheet mid-judging: ψ over the first `pilotPairs`
 * image-dependent pairs judged on both arm A and arm B, in `judgedAt` order.
 * Runs BEFORE full judging — `judge-arms.ts --check --mapping` prints it —
 * so the ADR's "stop rather than judge more" can be acted on. Aggregate
 * only: nothing per item leaves this function.
 */
export function pilotCheck(
  answers: readonly AnswerItem[],
  judgments: readonly JudgmentRow[],
  mapping: Mapping,
  fixture: ImageFixture,
  pair: { baseline: EvalArm; candidate: EvalArm } = { baseline: 'A', candidate: 'B' },
): DiscordanceCheck {
  const facts = labelFacts(fixture);
  const items = joinJudged(answers, judgments, mapping);
  const primary = pairsInJudgedOrder(items, pair).filter((p) => facts.get(p.queryId)?.imageDependent === true);
  return pilotDiscordance(
    primary.map((p) => ({ baseline: p.b.correct, candidate: p.c.correct })),
    { pilotPairs: ARM_MARGINS.pilotPairs, floor: ARM_MARGINS.pilotDiscordanceFloor },
  );
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
  const ordered = pairsInJudgedOrder(items, pair);
  if (ordered.length === 0) {
    throw new Error(`No query was judged on both arm ${pair.baseline} and arm ${pair.candidate}`);
  }
  const rows = ordered.map(({ queryId, b, c }) => {
    const f = facts.get(queryId);
    if (!f) throw new Error(`query ${queryId} is not in the fixture — the mapping and the fixture disagree`);
    return { queryId, cluster: f.cluster, style: f.style, imageDependent: f.imageDependent, b, c };
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
    // `primary` is in judged order (`pairsInJudgedOrder`), so the first 30 ARE the pilot.
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
  /** Which arms the control pairs (ADR endpoint table: B vs C, C vs A). */
  baseline: EvalArm;
  candidate: EvalArm;
  /** EN + DE pooled (O4). */
  recallAt5: PairedBinaryEndpoint;
  mrr: PairedGradedEndpoint;
  languages: string[];
  /** Paired queries per language — O2 pre-registers 197 each. */
  perLanguage: Record<string, number>;
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
  pair: { baseline: EvalArm; candidate: EvalArm } = { baseline: 'C', candidate: 'B' },
): ControlEndpoints {
  if (baseline.length !== candidate.length || baseline.length === 0) {
    throw new Error('Controls need the same languages on both arms, at least one');
  }
  const binaryRows: Array<{ queryId: string; cluster: string; baseline: 0 | 1; candidate: 0 | 1 }> = [];
  const gradedRows: Array<{ queryId: string; cluster: string; baseline: number; candidate: number }> = [];
  const languages: string[] = [];
  const perLanguage: Record<string, number> = {};
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
    perLanguage[b.language] = b.runs.length;
  }
  return {
    baseline: pair.baseline,
    candidate: pair.candidate,
    recallAt5: pairedBinaryEndpoint(binaryRows, opts),
    mrr: pairedGradedEndpoint(gradedRows, opts),
    languages,
    perLanguage,
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
 * non-inferiority endpoint's one-sided lower bound above its margin — the
 * text controls for BOTH pairs the endpoint table names (B vs C, C vs A)
 * and the image-evidence guardrail; (3) neither safety endpoint worse than
 * its margin at the one-sided 95% level. A pilot ψ below the floor is
 * "inconclusive by design" and pre-empts all three. An unmeasured endpoint
 * is inconclusive and blocks. Cost enters nowhere.
 */
export function decideGate(input: {
  primary: JudgedPairEndpoints;
  imageEvidence: PairedBinaryEndpoint | null;
  leakage: PairedBinaryEndpoint;
  controls: { bVsC: ControlEndpoints | null; cVsA: ControlEndpoints | null };
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
  for (const [control, label, flags] of [
    [input.controls.bVsC, 'B vs C', '--control-b/--control-c'],
    [input.controls.cVsA, 'C vs A', '--control-a/--control-c'],
  ] as const) {
    if (control) {
      const margin = `−${pp(ARM_MARGINS.textNonInferiority).slice(1)}`;
      conditions.push({
        name: `non-inferiority: ordinary-text R@5, ${control.languages.join(' + ')} pooled, ${label}`,
        verdict: nonInferiorityVerdict(control.recallAt5.ci, ARM_MARGINS.textNonInferiority),
        detail: `${pp(control.recallAt5.delta)}, one-sided 95% lower bound ${pp(control.recallAt5.ci.oneSidedLower)} vs margin ${margin}`,
      });
      conditions.push({
        name: `non-inferiority: ordinary-text MRR, ${control.languages.join(' + ')} pooled, ${label}`,
        verdict: nonInferiorityVerdict(control.mrr.ci, ARM_MARGINS.textNonInferiority),
        detail: `${pp(control.mrr.delta)}, one-sided 95% lower bound ${pp(control.mrr.ci.oneSidedLower)} vs margin ${margin}`,
      });
    } else {
      conditions.push({
        name: `non-inferiority: ordinary-text controls, ${label}`,
        verdict: 'inconclusive',
        detail: `no ${flags} reports were given, so the endpoint is unmeasured and blocks the gate`,
      });
    }
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
    detail: `${pp(u.delta)}, one-sided 95% upper bound ${pp(u.ci.oneSidedUpper)} vs margin ${pp(ARM_MARGINS.unsupportedClaimPoints)} (O6: B may exceed A by at most 3 pp)`,
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
// O2's sample, checked rather than serialised.
// ---------------------------------------------------------------------------

export interface SampleAudit {
  imageDependent: number;
  imageNegative: number;
  /** Distinct pages (first expected file) carrying an image-dependent label. */
  pages: number;
  /** The most image-dependent labels any one page carries. */
  maxLabelsPerPage: number;
  /** Every way the sample falls short of O2/O3; empty when it is the pre-registered one. */
  shortfalls: string[];
  required: typeof ARM_SAMPLE;
  primaryPower: number;
}

/**
 * O2 as a check: N image-dependent (190), N image-negative (48), ≥ 45 pages
 * and ≤ 5 image-dependent labels per page (the m = 5 the design effect is
 * computed under, O3), and 197 queries per language on every control given.
 * Below any of them the verdict decides nothing.
 */
export function auditSample(fixture: ImageFixture, controls: readonly ControlEndpoints[]): SampleAudit {
  const dependent = fixture.labels.filter((l) => l.imageDependent === true);
  const perPage: Record<string, number> = {};
  for (const l of dependent) perPage[l.expectedFiles[0]!] = (perPage[l.expectedFiles[0]!] ?? 0) + 1;
  const pages = Object.keys(perPage).length;
  const maxLabelsPerPage = Object.values(perPage).reduce((a, b) => Math.max(a, b), 0);
  const imageNegative = fixture.labels.filter((l) => l.style === 'image-negative').length;
  const shortfalls: string[] = [];
  if (dependent.length < ARM_SAMPLE.imageDependent) shortfalls.push(`${dependent.length} image-dependent labels (O2: ${ARM_SAMPLE.imageDependent}, floor ${ARM_SAMPLE.imageDependentFloor})`);
  if (imageNegative < ARM_SAMPLE.imageNegative) shortfalls.push(`${imageNegative} image-negative labels (O2: ${ARM_SAMPLE.imageNegative})`);
  if (pages < ARM_SAMPLE.minPages) shortfalls.push(`image-dependent labels on ${pages} pages (O2: ≥ ${ARM_SAMPLE.minPages})`);
  if (maxLabelsPerPage > ARM_SAMPLE.maxLabelsPerPage) {
    shortfalls.push(`${Object.values(perPage).filter((n) => n > ARM_SAMPLE.maxLabelsPerPage).length} page(s) carry more than ${ARM_SAMPLE.maxLabelsPerPage} image-dependent labels (O2/O3: ≤ ${ARM_SAMPLE.maxLabelsPerPage}, the m the design effect assumes)`);
  }
  for (const control of controls) {
    for (const [language, n] of Object.entries(control.perLanguage)) {
      if (n !== ARM_SAMPLE.controlPerLanguage) shortfalls.push(`control ${language} (${control.candidate} vs ${control.baseline}) pairs ${n} queries (O2: ${ARM_SAMPLE.controlPerLanguage})`);
    }
  }
  return {
    imageDependent: dependent.length,
    imageNegative,
    pages,
    maxLabelsPerPage,
    shortfalls,
    required: ARM_SAMPLE,
    primaryPower: primaryEndpointPower(dependent.length),
  };
}

/**
 * The answer side of "Report provenance": one answer run per arm, made under
 * the SAME held-fixed configuration as that arm's retrieval report — same
 * revision, corpus, query set, hardware, answer model and every knob both
 * recorded — and hashing to what the sheet recorded before judging.
 */
export function assertAnswerRunMatches(
  provenance: AnswerRunProvenance,
  source: SheetProvenance['sources'][number],
  report: ArmRunReport,
): void {
  const problems: string[] = [];
  if (provenance.runId !== source.runId) problems.push(`run id ${provenance.runId} vs the sheet's ${source.runId}`);
  if (provenance.arm !== source.arm) problems.push(`arm ${provenance.arm} vs the sheet's ${source.arm}`);
  if (provenance.arm !== report.arm) problems.push(`arm ${provenance.arm} paired with arm ${report.arm}'s retrieval report`);
  if (provenance.answersSha256 !== source.answersSha256) problems.push('answers sha256 differs from the sheet\'s record');
  if (provenance.mappingSha256 !== source.mappingSha256) problems.push('mapping sha256 differs from the sheet\'s record');
  if (provenance.items !== source.items) problems.push(`${provenance.items} items vs the sheet's ${source.items}`);
  if (provenance.revisionSha !== report.revisionSha) problems.push(`revision ${provenance.revisionSha} vs the retrieval report's ${report.revisionSha}`);
  if (provenance.corpusManifestSha !== report.corpusManifestSha) problems.push('corpus manifest sha differs from the retrieval report');
  if (provenance.querySetSha !== report.querySetSha) problems.push('query-set sha differs from the retrieval report');
  if (provenance.hardware === null) problems.push('hardware is null (EVAL_HARDWARE was unset, O9)');
  else if (provenance.hardware !== report.hardware) problems.push(`hardware "${provenance.hardware}" vs the retrieval report's "${report.hardware}"`);
  if (!report.answerModel) problems.push('the retrieval report records no answer model, so the answers cannot be that arm\'s');
  else if (provenance.answerModel.identity !== report.answerModel.identity) problems.push(`answer model ${provenance.answerModel.identity} vs the retrieval report's ${report.answerModel.identity}`);
  if (provenance.retrieval.rag_answer_max_images !== 0) problems.push(`rag_answer_max_images ${JSON.stringify(provenance.retrieval.rag_answer_max_images)} (O10: 0 in every arm)`);
  for (const knob of Object.keys(provenance.retrieval).sort()) {
    if (knob in report.retrieval && JSON.stringify(report.retrieval[knob]) !== JSON.stringify(provenance.retrieval[knob])) {
      problems.push(`retrieval.${knob}: ${JSON.stringify(provenance.retrieval[knob])} vs the retrieval report's ${JSON.stringify(report.retrieval[knob])}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Answer run ${source.runId} (arm ${source.arm}) was not made under arm ${report.arm}'s held-fixed configuration ` +
        `(ADR-027 "Report provenance"): ${problems.join('; ')}. Refused.`,
    );
  }
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
  /** B's and C's controls come together; A's (for C vs A) may be absent, which leaves that endpoint unmeasured. */
  controls: { a: TextGateControl[] | null; b: TextGateControl[]; c: TextGateControl[] } | null;
  allowUnderpowered: boolean;
  /** The exact `--unblind` command line, recorded on the verdict. */
  command: string;
  seed: number;
  iterations?: number;
  now?: Date;
}

export interface ArmVerdictReport {
  kind: 'adr-027-arm-verdict';
  runId: string;
  producedAt: string;
  command: string;
  /** Set when the sample is below O2 in any respect (`sample.shortfalls`): the document decides nothing. */
  toolingVerificationOnly: boolean;
  singleJudgeStatement: string;
  judge: string;
  sheet: SheetProvenance;
  sample: SampleAudit;
  provenance: Record<EvalArm, ArmRunReport | null>;
  /** The answer runs behind the sheet, as re-read from `provenance-<runId>.json` at un-blinding. */
  answerRuns: AnswerRunProvenance[];
  judged: { primary: JudgedPairEndpoints; secondary: JudgedPairEndpoints[] };
  retrieval: { primary: ArmRetrievalComparison; others: ArmRetrievalComparison[] };
  controls: { bVsC: ControlEndpoints | null; cVsA: ControlEndpoints | null };
  decision: GateDecision;
  /** Every un-blinded item, for audit — after the verdict, never before. */
  items: UnblindedItem[];
}

/**
 * `--unblind`, end to end. Refuses (in this order) a sheet whose mapping no
 * longer hashes to what was recorded before judging, a sheet that is not
 * fully judged, arm reports that do not parse or do not pair, a fixture
 * whose sha is not the reports' query set, an answer run whose
 * `provenance-<runId>.json` is missing, changed, or not made under its arm
 * report's configuration, and a sample below O2 unless `allowUnderpowered`
 * labels the output as tooling verification.
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
  const reports: Partial<Record<EvalArm, ArmRunReport>> = { A: a, B: b, ...(c ? { C: c } : {}) };
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

  // The answer side of the provenance: every run behind the sheet, re-read
  // from `provenance-<runId>.json` in the artifacts directory, hashed to what
  // the sheet recorded, and held to its arm's retrieval report.
  const answerRuns: AnswerRunProvenance[] = [];
  for (const source of sheet.sources) {
    const file = provenancePath(dir, source.runId);
    const provenance = readAnswerProvenance(file);
    const sha = sha256File(file);
    if (sha !== source.provenanceSha256) {
      throw new Error(`${file} hashes to ${sha} but sheet-${runId}.json recorded ${source.provenanceSha256} at --merge — the run's provenance changed. Refused.`);
    }
    const report = reports[source.arm];
    if (!report) throw new Error(`The sheet carries arm ${source.arm}'s answers (run ${source.runId}) but no --arm-report ${source.arm}=<file> was given`);
    assertAnswerRunMatches(provenance, source, report);
    answerRuns.push(provenance);
  }
  for (const arm of [a.arm, b.arm, ...(c ? [c.arm] : [])]) {
    if (!sheet.sources.some((s) => s.arm === arm)) throw new Error(`--arm-report ${arm} was given but the sheet carries no arm ${arm} answers`);
  }

  const stats = { seed: input.seed, ...(input.iterations ? { iterations: input.iterations } : {}) };
  const controls = {
    bVsC: input.controls ? scoreControls(input.controls.c, input.controls.b, stats, { baseline: 'C', candidate: 'B' }) : null,
    cVsA: input.controls?.a ? scoreControls(input.controls.a, input.controls.c, stats, { baseline: 'A', candidate: 'C' }) : null,
  };
  const sample = auditSample(fixture, [controls.bVsC, controls.cVsA].filter((x): x is ControlEndpoints => x !== null));
  if (sample.shortfalls.length > 0 && !input.allowUnderpowered) {
    throw new Error(
      `The sample is not the one ADR-027 O2 pre-registers: ${sample.shortfalls.join('; ')} (O15's independent labelling ` +
        'pass supplies the labels — the harness never invents one). Refused. --allow-underpowered scores the sheet as ' +
        'tooling verification only.',
    );
  }

  const primary = scoreJudgedPair(items, fixture, { baseline: 'A', candidate: 'B' }, stats);
  const secondary: JudgedPairEndpoints[] = [];
  const others: ArmRetrievalComparison[] = [];
  const retrievalPrimary = compareArmRetrieval(a, b, stats);
  if (c) {
    secondary.push(scoreJudgedPair(items, fixture, { baseline: 'C', candidate: 'B' }, stats));
    secondary.push(scoreJudgedPair(items, fixture, { baseline: 'A', candidate: 'C' }, stats));
    others.push(compareArmRetrieval(c, b, stats), compareArmRetrieval(a, c, stats));
  }
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
    command: input.command,
    toolingVerificationOnly: sample.shortfalls.length > 0,
    singleJudgeStatement: SINGLE_JUDGE_STATEMENT,
    judge: progress.judges[0]!,
    sheet,
    sample,
    provenance: { A: a, B: b, C: c },
    answerRuns,
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
    lines.push('*** TOOLING VERIFICATION ONLY — the sample is below ADR-027 O2; this document decides nothing. ***');
    for (const shortfall of report.sample.shortfalls) lines.push(`    short of O2: ${shortfall}`);
  }
  lines.push(`ADR-027 arm verdict ${report.runId} — judge ${report.judge} — ${report.decision.verdict.toUpperCase()}`);
  lines.push(report.singleJudgeStatement);
  lines.push(
    `sample: ${report.sample.imageDependent} image-dependent on ${report.sample.pages} pages, ≤ ${report.sample.maxLabelsPerPage} per page ` +
      `(O2: ${report.sample.required.imageDependent}, floor ${report.sample.required.imageDependentFloor}, ≥ ${report.sample.required.minPages} pages, ` +
      `≤ ${report.sample.required.maxLabelsPerPage} per page; primary power ≈ ${report.sample.primaryPower.toFixed(2)}), ` +
      `${report.sample.imageNegative} image-negative (O2: ${report.sample.required.imageNegative})`,
  );
  for (const condition of report.decision.conditions) {
    lines.push(`[${condition.verdict.toUpperCase().padEnd(12)}] ${condition.name}`);
    lines.push(`    ${condition.detail}`);
  }
  const p = report.judged.primary;
  lines.push(
    `partial (reported separately): A ${(100 * p.partialRate.baseline).toFixed(1)}%, B ${(100 * p.partialRate.candidate).toFixed(1)}%; ` +
      `pilot ψ = ${p.pilot.psi.toFixed(2)} over the first ${p.pilot.pairs} pairs by judgedAt${p.pilot.evaluated ? '' : ' (pilot not yet reached)'}`,
  );
  lines.push('Cost figures are reported by benchmark-query-latency.ts and the backfill card; none enters the rule above (O11).');
  return lines;
}
