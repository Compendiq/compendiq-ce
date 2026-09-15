/**
 * #1614 PR2 — the ADR-027 arm axis: what `--arm A|B|C` selects, what one
 * arm's run records, and what a pair of arm runs is refused for.
 *
 * ADR-027 "Measurement plan" puts the three arms on different code revisions
 * and different index states (A: the legacy image leg on the pre-#1618
 * revision; B: the candidate with derived chunks; C: the same candidate
 * revision with `image_analysis` unassigned). They cannot share a process,
 * so — unlike the paired `--images` axis, which runs both legs of one query
 * in one loop — an arm run is ONE arm on the image corpus, written to its own
 * report, and the pairing happens later across files: `assertComparableArms`
 * for the retrieval endpoints here, `judge-arms.ts --unblind` for the
 * answer endpoints. Everything that must be held fixed across arms (the
 * ADR's "Held fixed" list) is a field of `ArmRunReportSchema` and a refusal
 * in `assertComparableArms`.
 *
 * The owner decisions O1–O7 are constants here (`ARM_MARGINS`,
 * `ARM_SAMPLE`), imported by the scorer and quoted by the runbook, so the
 * number the gate is decided against and the number the document states are
 * one definition.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  getRagAnswerMaxImages,
  getRagConfidenceThreshold,
  getRagConfidenceThresholdRerank,
  getRagContextCharsPerPage,
  getRagEfSearch,
  getRagFetchWidth,
  getRagMmrConfig,
  getRagPinIdentifiersEnabled,
  getRagRankingPriorWeight,
  getRagRerankCandidates,
} from '../../../core/services/admin-settings-service.js';
import { resolveRerankUsecase, resolveUsecase } from '../services/llm-provider-resolver.js';
import { flagValue } from './cli-flags.js';
import { IMAGE_AXIS_ENV, readImageAxisEnv, wantsImageAxis, type ImageAxisEnv } from './images-axis.js';
import { IMAGE_DEPENDENT_CLASSES, IMAGE_FIXTURE_PATH } from './fixture.js';
import {
  clusterBootstrapCi,
  mcnemarExactTwoSided,
  mcnemarPower,
  meanReciprocalRank,
  recallAtK,
  type ClusterBootstrapCi,
  type ClusteredDelta,
  type QueryRun,
} from './metrics.js';

export const EVAL_ARMS = ['A', 'B', 'C'] as const;
export type EvalArm = (typeof EVAL_ARMS)[number];

/** The flag, in one place so the usage text and the parser cannot disagree. */
export const ARM_FLAG = 'arm';

/** Read as a value flag on top of `--images`; refused anywhere else. */
export function parseArmFlag(argv: readonly string[]): EvalArm | null {
  const raw = flagValue(argv, ARM_FLAG);
  if (raw === undefined) return null;
  if (!(EVAL_ARMS as readonly string[]).includes(raw)) {
    throw new Error(`--${ARM_FLAG} must be one of ${EVAL_ARMS.join('|')}, got "${raw}"`);
  }
  if (!wantsImageAxis(argv)) {
    throw new Error(
      `--${ARM_FLAG} ${raw} needs --images: an arm is one configuration of the image corpus (ADR-027 ` +
        '"Arms and revisions"), and the text gate has no arms. The EN/DE controls are ordinary text-gate ' +
        'runs on each revision, paired by judge-arms.ts from their own reports.',
    );
  }
  return raw as EvalArm;
}

/**
 * The VL environment for an arm, or a refusal.
 *
 * Arm A is the legacy leg and REQUIRES `EVAL_IMAGE_EMBEDDING_*` — read
 * through `readImageAxisEnv`, so the refusal text and the width rules are the
 * paired axis's own. Arms B and C have no image leg by definition, so those
 * variables being SET is refused: a C run that quietly filled
 * `page_image_embeddings` would not be an ablation, and a B run that did
 * would be measuring both designs at once under the candidate's name.
 */
export function readArmImageEnv(arm: EvalArm, env: NodeJS.ProcessEnv = process.env): ImageAxisEnv | null {
  if (arm === 'A') return readImageAxisEnv(env);
  const set = Object.values(IMAGE_AXIS_ENV).filter((name) => env[name] !== undefined && env[name] !== '');
  if (set.length > 0) {
    throw new Error(
      `--arm ${arm} refuses ${set.join(', ')}: arm ${arm} has no image leg (ADR-027 "Arms and revisions" — ` +
        `${arm === 'C' ? 'page_image_embeddings stays empty' : 'the candidate retrieves derived chunks, never image vectors'}), ` +
        'so a VL endpoint here could only fill an index the arm must not have. Unset them, or run --arm A.',
    );
  }
  return null;
}

/** The owner decisions O1–O7 (ADR-027 "Owner decisions", confirmed 2026-09-15). */
export const ARM_MARGINS = {
  /** O1: primary point estimate ≥ +5 pp, B vs A, cluster-bootstrap 95% CI excluding 0. */
  primaryPoints: 0.05,
  /** O4: ordinary-text R@5 and MRR, EN + DE pooled, one-sided 95%. */
  textNonInferiority: 0.02,
  /** O5: image-evidence R@5, B vs A — an explicitly underpowered guardrail. */
  imageEvidenceNonInferiority: 0.05,
  /** O6: B's unsupported-claim rate may exceed A's by at most 3 pp (upper bound). */
  unsupportedClaimPoints: 0.03,
  /** O7: image-negative leakage@1 may exceed A's by at most 2 queries of 48. */
  leakageQueries: 2,
  leakageDenominator: 48,
  /** Pilot: the first 30 judged pairs; ψ below 0.20 stops the run. */
  pilotPairs: 30,
  pilotDiscordanceFloor: 0.2,
} as const;

/** O2 / O3: the sample the gate is powered for. */
export const ARM_SAMPLE = {
  imageDependent: 190,
  imageDependentFloor: 144,
  imageNegative: 48,
  controlPerLanguage: 197,
  maxLabelsPerPage: 5,
  minPages: 45,
  /** 1 + (m − 1)ρ with m = 5, ρ = 0.10 — applied to the primary set's N. */
  primaryDesignEffect: 1.4,
  /** The pre-registered assumptions the power figures are computed under. */
  primaryPsi: 0.3,
  primaryDelta: 0.15,
  imageEvidencePsi: 0.15,
} as const;

/** ≈ 0.44 at δ = 0 for the O5 guardrail; stated in the report beside the verdict. */
export function imageEvidenceGuardrailPower(n: number): number {
  return mcnemarPower({
    n,
    psi: ARM_SAMPLE.imageEvidencePsi,
    delta: ARM_MARGINS.imageEvidenceNonInferiority,
    designEffect: ARM_SAMPLE.primaryDesignEffect,
    zAlpha: 1.645,
  });
}

/** ≈ 0.90 at N = 190 under ψ = 0.30, δ = 0.15 — the primary endpoint's power. */
export function primaryEndpointPower(n: number): number {
  return mcnemarPower({
    n,
    psi: ARM_SAMPLE.primaryPsi,
    delta: ARM_SAMPLE.primaryDelta,
    designEffect: ARM_SAMPLE.primaryDesignEffect,
    zAlpha: 1.96,
  });
}

// ---------------------------------------------------------------------------
// The report one arm run writes.
// ---------------------------------------------------------------------------

export const ArmQueryRunSchema = z.object({
  queryId: z.string().min(1),
  retrieved: z.array(z.number().int()),
  expected: z.array(z.number().int()),
  style: z.enum(['image', 'image-negative']),
  lang: z.enum(['de', 'en']),
  /** The page cluster every CI resamples (O3): the label's first expected file. */
  cluster: z.string().min(1),
  imageDependent: z.boolean().optional(),
  class: z.enum(IMAGE_DEPENDENT_CLASSES).optional(),
  /** The label's expected images as attachment keys; empty for a negative. */
  expectedImageKeys: z.array(z.string()),
  /**
   * The image evidence this arm's top-K carried, per the ADR's endpoint table:
   * A — the leg's hit keys; B — `derived.attachmentKey` of derived rows (D11);
   * C — always empty. `rank` is the 1-based rank of the PAGE that carried
   * it, so image-evidence R@5 and leakage@1 read the same rows.
   */
  evidence: z.array(z.object({ key: z.string().min(1), rank: z.number().int().positive() })),
  ms: z.number().nonnegative(),
});
export type ArmQueryRun = z.infer<typeof ArmQueryRunSchema>;

const ProviderIdentitySchema = z.object({
  /** `provider:model@endpoint`, the shape every provenance line in the ADR asks for. */
  identity: z.string().min(1),
  model: z.string().min(1),
  endpoint: z.string().min(1),
});
export type ProviderIdentity = z.infer<typeof ProviderIdentitySchema>;

/**
 * Everything the ADR's "Report provenance" and "Held fixed" lists name for a
 * retrieval run, plus the per-query rows. `judge-arms.ts` refuses a verdict
 * whose arm reports do not parse against this — "refused if absent", not
 * annotated.
 */
export const ArmRunReportSchema = z.object({
  axis: z.literal('arm'),
  arm: z.enum(EVAL_ARMS),
  /**
   * A legacy-revision C (ADR-027: "a regression control for #1617's
   * authored-hit change, labelled as such, never substituted for C"). Set by
   * `--control legacy-revision-C`; a report carrying it is refused as the C
   * of any B−C or C−A pair.
   */
  control: z.literal('legacy-revision-C').optional(),
  /** `git rev-parse HEAD` of the checkout that ran; prompts are pinned by it. */
  revisionSha: z.string().regex(/^[0-9a-f]{7,40}$/),
  capturedAt: z.string().datetime(),
  /** Free text from `EVAL_HARDWARE` (O9): host, GPU, server software. */
  hardware: z.string().min(1).nullable(),
  corpusManifestSha: z.string().min(1),
  /** sha256 of the fixture file the queries came from. */
  querySetSha: z.string().regex(/^[0-9a-f]{64}$/),
  language: z.string().min(1),
  ftsLanguage: z.string().min(1),
  embedder: ProviderIdentitySchema.extend({ dims: z.number().int().positive() }),
  /** `off`, or the rerank assignment's identity — identical in every arm. */
  rerank: z.string().min(1),
  /** The `chat` assignment on the run's database, or null when none is assigned. */
  answerModel: ProviderIdentitySchema.nullable(),
  /** Arm A: the VL embedding endpoint. Arm B: the vision model the backfill ran under. C: null. */
  visionModel: ProviderIdentitySchema.nullable(),
  /** Arm A only: `imageIndexIdentityFor`'s `provider:model@baseUrl#dims`. */
  imageIndexIdentity: z.string().min(1).nullable(),
  /** Arm B only: `image_analysis_max_output_tokens` in force for the backfill. */
  imageAnalysisMaxOutputTokens: z.number().int().positive().nullable(),
  /** Every retrieval knob the run was made under, recorded rather than assumed. */
  retrieval: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()])),
  queries: z.number().int().nonnegative(),
  vectorParticipatingQueries: z.number().int().nonnegative(),
  rerankParticipatingQueries: z.number().int().nonnegative(),
  assemblyParticipatingQueries: z.number().int().nonnegative(),
  pinParticipatingQueries: z.number().int().nonnegative(),
  /** Arm A: queries whose top-K carried a leg hit; B: a derived row; C: 0. */
  imageEvidenceParticipatingQueries: z.number().int().nonnegative(),
  recallAtK: z.record(z.string(), z.number()),
  mrr: z.number(),
  /** Null on arm C — the ADR reports it "as none", never as 0. */
  imageEvidenceRecallAt5: z.number().nullable(),
  /** Fraction of image-negative labels whose rank-1 row carried image evidence. */
  imageNegativeLeakAt1: z.number(),
  queryCostMs: z.object({ p50: z.number(), p95: z.number() }),
  runs: z.array(ArmQueryRunSchema),
});
export type ArmRunReport = z.infer<typeof ArmRunReportSchema>;

/** Parse a report file's JSON, naming the file in the refusal. */
export function parseArmRunReport(json: unknown, source: string): ArmRunReport {
  const parsed = ArmRunReportSchema.safeParse(json);
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  throw new Error(
    `${source} is not an arm run report (${first ? `${first.path.join('.') || '<root>'}: ${first.message}` : 'invalid'}). ` +
      'ADR-027 "Report provenance" refuses a report missing any field rather than annotating it.',
  );
}

/** sha256 of the fixture file's bytes — the ADR's "query-set sha". */
export function querySetSha(path: string = IMAGE_FIXTURE_PATH): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** `provider:model@endpoint` for a resolved use case. */
export function providerIdentity(resolved: { config: { name: string; baseUrl: string }; model: string }): ProviderIdentity {
  return {
    identity: `${resolved.config.name}:${resolved.model}@${resolved.config.baseUrl}`,
    model: resolved.model,
    endpoint: resolved.config.baseUrl,
  };
}

export interface HeldFixedProvenance {
  rerank: string;
  answerModel: ProviderIdentity | null;
  retrieval: Record<string, number | string | boolean | null>;
}

/**
 * Read the held-fixed half of the provenance off the run's database: the
 * rerank assignment (`off` when none — the stage never inherits), the `chat`
 * assignment the answer harness will resolve, and every retrieval knob the
 * ADR lists, at the value the run actually made its queries under.
 */
export async function readHeldFixedProvenance(): Promise<HeldFixedProvenance> {
  const rerank = await resolveRerankUsecase();
  let answerModel: ProviderIdentity | null = null;
  try {
    answerModel = providerIdentity(await resolveUsecase('chat'));
  } catch {
    answerModel = null;
  }
  const mmr = await getRagMmrConfig();
  return {
    rerank: rerank ? providerIdentity(rerank).identity : 'off',
    answerModel,
    retrieval: {
      rag_ef_search: await getRagEfSearch(),
      rag_fetch_width: await getRagFetchWidth(),
      rag_rerank_candidates: await getRagRerankCandidates(),
      rag_context_chars_per_page: await getRagContextCharsPerPage(),
      rag_pin_identifiers: await getRagPinIdentifiersEnabled(),
      rag_confidence_threshold: await getRagConfidenceThreshold(),
      rag_confidence_threshold_rerank: await getRagConfidenceThresholdRerank(),
      rag_ranking_prior_weight: await getRagRankingPriorWeight(),
      rag_mmr_enabled: mmr.enabled,
      rag_mmr_lambda: mmr.lambda,
      rag_answer_max_images: await getRagAnswerMaxImages(),
    },
  };
}

// ---------------------------------------------------------------------------
// Evidence attribution.
// ---------------------------------------------------------------------------

/**
 * The slice of a `hybridSearch` row the evidence rule reads. `derived` is
 * D11's provenance object (#1617 — "an ordinary SearchResult with a `derived`
 * provenance object read from `metadata`"), typed structurally here because
 * that field does not exist on this revision: arm B is runnable only after
 * #1617, and until then every row reads as carrying none.
 */
export interface EvidenceRow {
  pageId: number;
  imageHits?: ReadonlyArray<{ key: string }> | undefined;
  derived?: { attachmentKey?: string | null | undefined } | null | undefined;
}

/** The ADR endpoint table's three rules, one per arm. */
export function evidenceKeysOf(arm: EvalArm, row: EvidenceRow): string[] {
  switch (arm) {
    case 'A':
      return (row.imageHits ?? []).map((hit) => hit.key);
    case 'B': {
      const key = row.derived?.attachmentKey;
      return typeof key === 'string' && key.length > 0 ? [key] : [];
    }
    case 'C':
      return [];
  }
}

/**
 * The evidence rows of one search result list, ranked by PAGE: `hybridSearch`
 * returns one row per page, so a row's index is its page rank. Recorded by
 * the runner from the returned window and read back by the two scorers below.
 */
export function rankedEvidence(arm: EvalArm, rows: readonly EvidenceRow[]): Array<{ key: string; rank: number }> {
  const out: Array<{ key: string; rank: number }> = [];
  const seenPages = new Set<number>();
  let rank = 0;
  for (const row of rows) {
    if (!seenPages.has(row.pageId)) {
      seenPages.add(row.pageId);
      rank++;
    }
    for (const key of evidenceKeysOf(arm, row)) out.push({ key, rank });
  }
  return out;
}

/** Whether a run's evidence inside the top-K names one of the label's expected images. */
export function evidenceHitAtK(run: ArmQueryRun, k: number): boolean {
  const wanted = new Set(run.expectedImageKeys);
  return run.evidence.some((e) => e.rank <= k && wanted.has(e.key));
}

/**
 * Image-evidence Recall@K: the fraction of labels that NAME an image whose
 * image is among the evidence the top-K rows carried. Null on arm C, which
 * the ADR reports "as none" — a 0 would read as a collapse.
 */
export function imageEvidenceRecallAtK(arm: EvalArm, runs: readonly ArmQueryRun[], k: number): number | null {
  if (arm === 'C') return null;
  const scored = runs.filter((r) => r.expectedImageKeys.length > 0);
  if (scored.length === 0) return 0;
  return scored.filter((r) => evidenceHitAtK(r, k)).length / scored.length;
}

/** Fraction of image-negative labels whose rank-1 page carried image evidence. */
export function imageNegativeLeakAt1(runs: readonly ArmQueryRun[]): number {
  const negatives = runs.filter((r) => r.style === 'image-negative');
  if (negatives.length === 0) return 0;
  return negatives.filter((r) => r.evidence.some((e) => e.rank === 1)).length / negatives.length;
}

// ---------------------------------------------------------------------------
// Pairing two arm runs.
// ---------------------------------------------------------------------------

/**
 * Refuse a pair of arm reports the ADR says is not a comparison.
 *
 * "The report refuses a pair whose arm, revision, corpus hash, query-set
 * hash, embedder, FTS language, rerank assignment or answer model differ."
 * Read as the design intends it: the two files must be two DIFFERENT arms
 * (two runs of one arm are a before/after on that arm, which the text gate
 * already does), each must be the arm the operator says it is, B and C must
 * share the candidate revision (that is what makes B − C the enrichment
 * alone), and everything in the "Held fixed" list must match. A
 * legacy-revision C control is refused as C of any pair: it is a regression
 * control, labelled, never substituted.
 */
export function assertComparableArms(
  baseline: ArmRunReport,
  candidate: ArmRunReport,
  expected?: { baseline: EvalArm; candidate: EvalArm },
): void {
  if (expected) {
    for (const [side, report, want] of [
      ['baseline', baseline, expected.baseline],
      ['candidate', candidate, expected.candidate],
    ] as const) {
      if (report.arm !== want) {
        throw new Error(`The ${side} report is arm ${report.arm}, but this pair names it as arm ${want}.`);
      }
    }
  }
  if (baseline.arm === candidate.arm) {
    throw new Error(
      `Both reports are arm ${baseline.arm} — two runs of one arm are a before/after on that arm, not an ` +
        'arm comparison. Pair A, B and C against each other.',
    );
  }
  for (const report of [baseline, candidate]) {
    if (report.control !== undefined) {
      throw new Error(
        `A ${report.control} report is a regression control for #1617's authored-hit change and is never ` +
          'substituted for arm C (ADR-027 "Arms and revisions"). Read it beside the pair, not inside it.',
      );
    }
  }
  const arms = new Set([baseline.arm, candidate.arm]);
  if (arms.has('B') && arms.has('C') && baseline.revisionSha !== candidate.revisionSha) {
    throw new Error(
      `Arm B ran on ${baseline.arm === 'B' ? baseline.revisionSha : candidate.revisionSha} and arm C on ` +
        `${baseline.arm === 'C' ? baseline.revisionSha : candidate.revisionSha} — the ablation is the SAME ` +
        'candidate revision with image_analysis unassigned, or B − C is not vision enrichment alone.',
    );
  }
  const mismatches: string[] = [];
  const check = (name: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) mismatches.push(`${name}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  };
  check('corpusManifestSha', baseline.corpusManifestSha, candidate.corpusManifestSha);
  check('querySetSha', baseline.querySetSha, candidate.querySetSha);
  check('embedder', baseline.embedder, candidate.embedder);
  check('ftsLanguage', baseline.ftsLanguage, candidate.ftsLanguage);
  check('rerank', baseline.rerank, candidate.rerank);
  check('answerModel', baseline.answerModel, candidate.answerModel);
  if (mismatches.length > 0) {
    throw new Error(
      `Arm ${baseline.arm} and arm ${candidate.arm} were not measured under the same held-fixed ` +
        `configuration (ADR-027 "Held fixed across arms"):\n  ${mismatches.join('\n  ')}\n` +
        'Re-run the side that drifted; the report refuses the pair rather than annotating it.',
    );
  }
}

export interface PairedBinaryEndpoint {
  baselineRate: number;
  candidateRate: number;
  /** candidate − baseline, in absolute points. */
  delta: number;
  wins: number;
  losses: number;
  ties: number;
  /** Exact two-sided McNemar over the discordant pairs. */
  pValue: number;
  ci: ClusterBootstrapCi;
  n: number;
}

/** Score a paired binary endpoint from per-query 0/1 outcomes with clusters. */
export function pairedBinaryEndpoint(
  pairs: ReadonlyArray<{ queryId: string; cluster: string; baseline: 0 | 1; candidate: 0 | 1 }>,
  opts: { seed: number; iterations?: number },
): PairedBinaryEndpoint {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let baselineHits = 0;
  let candidateHits = 0;
  const deltas: ClusteredDelta[] = pairs.map((p) => {
    baselineHits += p.baseline;
    candidateHits += p.candidate;
    if (p.candidate > p.baseline) wins++;
    else if (p.candidate < p.baseline) losses++;
    else ties++;
    return { queryId: p.queryId, cluster: p.cluster, delta: p.candidate - p.baseline };
  });
  const n = pairs.length;
  const ci = clusterBootstrapCi(deltas, { seed: opts.seed, ...(opts.iterations ? { iterations: opts.iterations } : {}) });
  return {
    baselineRate: n === 0 ? 0 : baselineHits / n,
    candidateRate: n === 0 ? 0 : candidateHits / n,
    delta: n === 0 ? 0 : (candidateHits - baselineHits) / n,
    wins,
    losses,
    ties,
    pValue: mcnemarExactTwoSided(wins, losses),
    ci,
    n,
  };
}

export interface PairedGradedEndpoint {
  baselineMean: number;
  candidateMean: number;
  delta: number;
  ci: ClusterBootstrapCi;
  n: number;
}

/** A graded endpoint (MRR): mean difference with a cluster-bootstrap CI, no McNemar. */
export function pairedGradedEndpoint(
  pairs: ReadonlyArray<{ queryId: string; cluster: string; baseline: number; candidate: number }>,
  opts: { seed: number; iterations?: number },
): PairedGradedEndpoint {
  const n = pairs.length;
  const baselineMean = n === 0 ? 0 : pairs.reduce((s, p) => s + p.baseline, 0) / n;
  const candidateMean = n === 0 ? 0 : pairs.reduce((s, p) => s + p.candidate, 0) / n;
  const ci = clusterBootstrapCi(
    pairs.map((p) => ({ queryId: p.queryId, cluster: p.cluster, delta: p.candidate - p.baseline })),
    { seed: opts.seed, ...(opts.iterations ? { iterations: opts.iterations } : {}) },
  );
  return { baselineMean, candidateMean, delta: candidateMean - baselineMean, ci, n };
}

/** Pair two arm reports' runs by query id, refusing a query set that differs. */
export function pairArmRuns(baseline: ArmRunReport, candidate: ArmRunReport): Array<{ baseline: ArmQueryRun; candidate: ArmQueryRun }> {
  const byId = new Map(candidate.runs.map((r) => [r.queryId, r]));
  if (byId.size !== baseline.runs.length || baseline.runs.some((r) => !byId.has(r.queryId))) {
    throw new Error(
      `Arm ${baseline.arm} recorded ${baseline.runs.length} queries and arm ${candidate.arm} ${candidate.runs.length}, ` +
        'and they do not pair one-to-one by query id — the query-set sha matched, so one run was cut short.',
    );
  }
  return baseline.runs.map((b) => ({ baseline: b, candidate: byId.get(b.queryId)! }));
}

export interface ArmRetrievalComparison {
  baseline: EvalArm;
  candidate: EvalArm;
  recallAt: Record<string, PairedBinaryEndpoint>;
  mrr: PairedGradedEndpoint;
  /** Null when either side is arm C (no image evidence by construction). */
  imageEvidenceRecallAt5: PairedBinaryEndpoint | null;
  imageEvidenceGuardrailPower: number | null;
  /** Over the image-negative labels only. */
  leakageAt1: PairedBinaryEndpoint;
}

/** The retrieval rows of the ADR endpoint table, for one pair of arm reports. */
export function compareArmRetrieval(
  baseline: ArmRunReport,
  candidate: ArmRunReport,
  opts: { seed: number; iterations?: number; ks?: readonly number[] },
): ArmRetrievalComparison {
  assertComparableArms(baseline, candidate);
  const pairs = pairArmRuns(baseline, candidate);
  const ks = opts.ks ?? [1, 5, 10];
  const binary = (score: (run: ArmQueryRun) => 0 | 1, subset = pairs) =>
    pairedBinaryEndpoint(
      subset.map((p) => ({ queryId: p.baseline.queryId, cluster: p.baseline.cluster, baseline: score(p.baseline), candidate: score(p.candidate) })),
      opts,
    );
  const asQueryRun = (r: ArmQueryRun): QueryRun => ({ queryId: r.queryId, retrieved: r.retrieved, expected: r.expected });
  const recallAt: Record<string, PairedBinaryEndpoint> = {};
  for (const k of ks) {
    // Per-query recall is binary on a single-expected-page label and graded on
    // a multi-page one; the ADR's McNemar row applies to the former, so a
    // graded hit is rounded to "fully recalled or not" for the sign test.
    recallAt[`@${k}`] = binary((r) => (recallAtK([asQueryRun(r)], k) === 1 ? 1 : 0));
  }
  const mrr = pairedGradedEndpoint(
    pairs.map((p) => ({
      queryId: p.baseline.queryId,
      cluster: p.baseline.cluster,
      baseline: meanReciprocalRank([asQueryRun(p.baseline)]),
      candidate: meanReciprocalRank([asQueryRun(p.candidate)]),
    })),
    opts,
  );
  const evidenceApplies = baseline.arm !== 'C' && candidate.arm !== 'C';
  const positives = pairs.filter((p) => p.baseline.expectedImageKeys.length > 0);
  const negatives = pairs.filter((p) => p.baseline.style === 'image-negative');
  return {
    baseline: baseline.arm,
    candidate: candidate.arm,
    recallAt,
    mrr,
    imageEvidenceRecallAt5: evidenceApplies ? binary((r) => (evidenceHitAtK(r, 5) ? 1 : 0), positives) : null,
    imageEvidenceGuardrailPower: evidenceApplies ? imageEvidenceGuardrailPower(positives.length) : null,
    leakageAt1: binary((r) => (r.evidence.some((e) => e.rank === 1) ? 1 : 0), negatives),
  };
}

/** Human-readable lines for one paired binary endpoint. */
export function formatPairedBinary(title: string, e: PairedBinaryEndpoint): string[] {
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  const sign = e.delta >= 0 ? '+' : '';
  return [
    `${title}: ${pct(e.baselineRate)} → ${pct(e.candidateRate)} (${sign}${(100 * e.delta).toFixed(1)} pp, n=${e.n}, ` +
      `${e.wins}W/${e.losses}L/${e.ties}T, McNemar exact p=${e.pValue.toFixed(4)})`,
    `  cluster-bootstrap 95% CI [${(100 * e.ci.lower).toFixed(1)}, ${(100 * e.ci.upper).toFixed(1)}] pp over ` +
      `${e.ci.clusters} pages; one-sided lower ${(100 * e.ci.oneSidedLower).toFixed(1)} pp, upper ${(100 * e.ci.oneSidedUpper).toFixed(1)} pp`,
  ];
}
