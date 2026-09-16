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
 * in `assertComparableArms` — the corpus and query-set hashes, the embedder,
 * the FTS configuration, the rerank and answer-model assignments, and every
 * retrieval knob the report records, key by key. What one arm carries and
 * another must not (A's VL endpoint and index identity, B's vision model and
 * output-token ceiling) is a per-arm rule of the schema itself
 * (`armProvenanceProblems`), so a B report without the ceiling or a C report
 * with one is not a report.
 *
 * The owner decisions O1–O7 are constants here (`ARM_MARGINS`,
 * `ARM_SAMPLE`), imported by the scorer and quoted by the runbook, so the
 * number the gate is decided against and the number the document states are
 * one definition.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { z } from 'zod';
import { query } from '../../../core/db/postgres.js';
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
 * The retrieval knobs ADR-027 "Held fixed across arms" names, read off the
 * run's own database by `readHeldFixedProvenance` and recorded by BOTH the
 * arm report and the answer run's provenance. They are REQUIRED here, not
 * merely admitted: a keyless `z.record` made the key-by-key comparison
 * exactly as strong as what two files happened to record, so two reports
 * that both omitted a knob compared nothing (review r2 finding 4).
 *
 * Extra keys are still accepted (`catchall`), because a report legitimately
 * carries knobs this list does not: the retrieval run records its own flags
 * (`topK`, `rerankRequested`, `mmr`, …), which the ask path has no
 * counterpart for, and a revision can define a knob another revision does
 * not. Two arms on ONE revision must still record the SAME key set — a
 * one-sided knob there is a drift (`assertComparableArms`). Across
 * revisions — every pair containing arm A, which runs on the legacy
 * revision by design — a knob that exists on one revision only cannot be
 * held fixed and no re-run could make it agree, so it is RECORDED as
 * revision-specific (`revisionSpecificKnobs`) instead of refused.
 */
export const HELD_FIXED_KNOBS = [
  'rag_ef_search',
  'rag_fetch_width',
  'rag_rerank_candidates',
  'rag_context_chars_per_page',
  'rag_pin_identifiers',
  'rag_confidence_threshold',
  'rag_confidence_threshold_rerank',
  'rag_ranking_prior_weight',
  'rag_mmr_enabled',
  'rag_mmr_lambda',
  'rag_answer_max_images',
] as const;

export const KnobValueSchema = z.union([z.number(), z.string(), z.boolean(), z.null()]);

export const RetrievalKnobsSchema = z
  .object(Object.fromEntries(HELD_FIXED_KNOBS.map((knob) => [knob, KnobValueSchema])) as Record<(typeof HELD_FIXED_KNOBS)[number], typeof KnobValueSchema>)
  .catchall(KnobValueSchema);
export type RetrievalKnobs = z.infer<typeof RetrievalKnobsSchema>;

/**
 * Everything the ADR's "Report provenance" and "Held fixed" lists name for a
 * retrieval run, plus the per-query rows. `judge-arms.ts` refuses a verdict
 * whose arm reports do not parse against this — "refused if absent", not
 * annotated.
 */
const ArmRunReportObject = z.object({
  axis: z.literal('arm'),
  arm: z.enum(EVAL_ARMS),
  /**
   * A legacy-revision C (ADR-027: "a regression control for #1617's
   * authored-hit change, labelled as such, never substituted for C"). Set by
   * `--control legacy-revision-C`; a report carrying it is refused as the C
   * of any B−C or C−A pair. The ONE pairing it is read in is against the
   * candidate C through `--baseline` (`isRegressionControlPair`), descriptive
   * only — no verdict reads it.
   */
  control: z.literal('legacy-revision-C').optional(),
  /** `git rev-parse HEAD` of the checkout that ran (clean tree); prompts are pinned by it. */
  revisionSha: z.string().regex(/^[0-9a-f]{7,40}$/),
  /** The exact command line that produced this file (ADR-027 "Report provenance": commands). */
  command: z.string().min(1),
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
  /** Arm A: the VL embedding endpoint. Arm B: the `image_analysis` assignment the backfill ran under. C: null. */
  visionModel: ProviderIdentitySchema.nullable(),
  /** Arm A only: `imageIndexIdentityFor`'s `provider:model@baseUrl#dims`. */
  imageIndexIdentity: z.string().min(1).nullable(),
  /** Arm B only: `image_analysis_max_output_tokens` in force for the backfill (D8; recorded, not prescribed). */
  imageAnalysisMaxOutputTokens: z.number().int().positive().nullable(),
  /** Arm B only: the ONE (prompt, schema) version pair every analysed corpus row carries (D5). */
  imageAnalysisVersions: z.object({ prompt: z.number().int(), schema: z.number().int() }).nullable(),
  /**
   * Every retrieval knob the run was made under, recorded rather than
   * assumed: the ADR's held-fixed knobs are required, the run's own flags
   * ride along (`HELD_FIXED_KNOBS`).
   */
  retrieval: RetrievalKnobsSchema,
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
export type ArmRunReport = z.infer<typeof ArmRunReportObject>;

/**
 * The per-arm half of "Report provenance (refused if absent)": what A must
 * carry (its VL endpoint and index identity), what B must carry (the vision
 * model and the ceiling its backfill ran under, plus the version pair), and
 * what C must NOT carry (any of them — C has no image leg and no derived
 * rows, so a vision model or a ceiling on a C report says the database was
 * not in C's state).
 */
export function armProvenanceProblems(report: ArmRunReport): Array<{ field: keyof ArmRunReport; message: string }> {
  const problems: Array<{ field: keyof ArmRunReport; message: string }> = [];
  const want = (field: keyof ArmRunReport, present: boolean, why: string) => {
    const has = report[field] !== null;
    if (has !== present) problems.push({ field, message: `arm ${report.arm} ${present ? 'must record' : 'must not carry'} ${field}: ${why}` });
  };
  switch (report.arm) {
    case 'A':
      want('visionModel', true, 'the legacy leg embeds through a VL endpoint (ADR-027 O8/"Report provenance")');
      want('imageIndexIdentity', true, 'the index the leg searched is provenance');
      want('imageAnalysisMaxOutputTokens', false, 'no vision analysis runs on the legacy revision');
      want('imageAnalysisVersions', false, 'no vision analysis runs on the legacy revision');
      break;
    case 'B':
      want('visionModel', true, 'the image_analysis assignment the backfill ran under — refused if absent (O8)');
      want('imageAnalysisMaxOutputTokens', true, 'image_analysis_max_output_tokens in force for the backfill — refused if absent (D8)');
      want('imageAnalysisVersions', true, 'the prompt and schema versions the analysed rows carry (D5)');
      want('imageIndexIdentity', false, 'the candidate has no image leg');
      break;
    case 'C':
      want('visionModel', false, 'the ablation has image_analysis unassigned and no image leg');
      want('imageIndexIdentity', false, 'the ablation has no image leg');
      want('imageAnalysisMaxOutputTokens', false, 'the ablation ran no backfill');
      want('imageAnalysisVersions', false, 'the ablation ran no backfill');
      break;
  }
  return problems;
}

export const ArmRunReportSchema = ArmRunReportObject.superRefine((report, ctx) => {
  for (const problem of armProvenanceProblems(report)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [problem.field], message: problem.message });
  }
});

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

const SHA_RE = /^[0-9a-f]{7,40}$/;

/**
 * The revision a report records — `git rev-parse HEAD` of a CLEAN checkout.
 * Prompts, chunking and every stage are pinned by the sha, so a tree with
 * uncommitted changes to tracked files is refused: the sha would name code
 * the run did not execute. `EVAL_REVISION_SHA` is the escape hatch for a
 * tree without git history (an export or an image built at a commit) and
 * ONLY that: where git answers, the variable must agree with HEAD or is
 * refused, so it can never relabel a checkout.
 */
export function readRevisionSha(opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): string {
  const env = opts.env ?? process.env;
  const git = (args: string[]): string | null => {
    try {
      return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...(opts.cwd ? { cwd: opts.cwd } : {}) }).trim();
    } catch {
      return null;
    }
  };
  const override = env.EVAL_REVISION_SHA?.trim() || null;
  if (override !== null && !SHA_RE.test(override)) {
    throw new Error(`EVAL_REVISION_SHA="${override}" is not a commit sha`);
  }
  const head = git(['rev-parse', 'HEAD']);
  if (head === null) {
    if (override === null) {
      throw new Error(
        'Cannot record the revision: git cannot answer `rev-parse HEAD` here. Run from a git checkout, or set ' +
          'EVAL_REVISION_SHA to the commit the tree was exported at — the one escape hatch, for a tree without .git.',
      );
    }
    return override;
  }
  if (!SHA_RE.test(head)) throw new Error(`Cannot record the revision: "${head}" is not a commit sha`);
  const dirty = git(['status', '--porcelain', '--untracked-files=no']);
  if (dirty === null) throw new Error('Cannot record the revision: `git status` failed');
  if (dirty.length > 0) {
    throw new Error(
      `Refusing to record revision ${head}: the working tree has uncommitted changes to tracked files ` +
        `(${dirty.split('\n').slice(0, 3).join('; ')}${dirty.split('\n').length > 3 ? '; …' : ''}). The sha pins the prompts ` +
        'and every stage the run executed — commit or stash, then measure.',
    );
  }
  if (override !== null && override !== head && !head.startsWith(override)) {
    throw new Error(
      `EVAL_REVISION_SHA=${override} does not name this checkout's HEAD (${head}). The variable is only for a tree ` +
        'without git history; unset it here.',
    );
  }
  return head;
}

/**
 * The command line a report records, verbatim: the script relative to the
 * working directory and every argument (quoted where it carries whitespace).
 * Environment is recorded by the fields that read it, never here.
 */
export function commandLine(argv: readonly string[] = process.argv, cwd: string = process.cwd()): string {
  const [, script, ...args] = argv;
  const parts = [...(script ? [relative(cwd, script) || script] : []), ...args];
  return parts.map((p) => (/[\s"']/.test(p) ? JSON.stringify(p) : p)).join(' ');
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
  /** Exactly `HELD_FIXED_KNOBS`, so the schema's required set is checked at compile time too. */
  retrieval: RetrievalKnobs;
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
// Arm B's and arm C's index state, asserted on the database itself.
// ---------------------------------------------------------------------------

/** D5's retained identity: `sha256(providerId + '\n' + model + '\n' + baseUrl)`. */
export function imageAnalysisIdentityHash(providerId: string, model: string, baseUrl: string): string {
  return createHash('sha256').update(`${providerId}\n${model}\n${baseUrl}`).digest('hex');
}

/** What one poll of arm B's backfill counted (`awaitArmBBackfill`'s D5 query). */
export interface AnalysisVersionCount {
  /** Rows that are `status = 'analyzed'` UNDER the assignment's retained identity. */
  analyzed: number;
  /** `COUNT(DISTINCT (prompt_version, schema_version))` over those rows. */
  versions: number;
  prompt: number | null;
  schema: number | null;
}

/**
 * D5's other half, once the count is complete: the valid rows must carry ONE
 * (prompt, schema) version pair. A backfill that straddled a version bump is
 * a corpus the product would not compose from, so the run refuses rather
 * than recording one of the two pairs as "the" version.
 *
 * This is the script's decision, extracted so it is testable: the entrypoint
 * calls `main()` at import, so `awaitArmBBackfill` can only be pinned as
 * source text, and a query whose result is ignored passes such a pin (review
 * r2 finding 6).
 */
export function assertSingleAnalysisVersionPair(count: AnalysisVersionCount): { prompt: number; schema: number } {
  if (count.versions !== 1) {
    throw new Error(
      `--arm B: the ${count.analyzed} valid analyses carry ${count.versions} distinct (prompt_version, schema_version) pairs — ` +
        'the backfill straddled a version bump. Let the sweep re-analyse under one pair, then re-run.',
    );
  }
  if (count.prompt === null || count.schema === null) {
    throw new Error(
      '--arm B: the backfill reports one (prompt_version, schema_version) pair but no row carries it — the report ' +
        'records the pair the analysed rows were written under (ADR-027 D5) and is refused without it.',
    );
  }
  return { prompt: count.prompt, schema: count.schema };
}

export interface ArmBState {
  visionModel: ProviderIdentity;
  imageAnalysisMaxOutputTokens: number;
  /** The hash every valid analysed row must carry (D5) — computed from the assignment read here. */
  identityHash: string;
}

/**
 * Arm B's preconditions, read BEFORE the database is seeded: the candidate
 * revision (its `page_image_analyses` table, #1616), the `image_analysis`
 * assignment (O8: the vision model on the instance under test, refused if
 * absent) and the output-token ceiling in force (D8, recorded not
 * prescribed). The assignment is read off `llm_usecase_assignments` directly:
 * this revision has no `resolveImageAnalysisUsecase`, and the row's shape is
 * the same as every non-inheriting use case's.
 */
export async function readArmBState(): Promise<ArmBState> {
  const table = await query<{ exists: string | null }>(`SELECT to_regclass('public.page_image_analyses') AS exists`);
  if (!table.rows[0]?.exists) {
    throw new Error(
      '--arm B needs the candidate revision: this checkout has no page_image_analyses table (#1616), so nothing ' +
        'here can be arm B. Run it on the post-#1617 revision with image_analysis assigned. (D11\'s derived ' +
        'provenance is checked by the runner: an arm B whose top-K never carries a derived row is refused.)',
    );
  }
  const assignment = await query<{ provider_id: string; name: string; base_url: string; model: string | null; default_model: string | null }>(
    `SELECT p.id AS provider_id, p.name, p.base_url, a.model, p.default_model
       FROM llm_usecase_assignments a JOIN llm_providers p ON p.id = a.provider_id
      WHERE a.usecase = 'image_analysis'`,
  );
  const row = assignment.rows[0];
  const model = row?.model || row?.default_model || '';
  if (!row || !model) {
    throw new Error(
      '--arm B needs image_analysis assigned to a vision model on this database (ADR-027 O8: the model assigned ' +
        'in Settings → AI Models on the instance under test, recorded as provider:model@endpoint — refused if absent).',
    );
  }
  const setting = await query<{ v: string }>(`SELECT setting_value AS v FROM admin_settings WHERE setting_key = 'image_analysis_max_output_tokens'`);
  const ceiling = Number(setting.rows[0]?.v);
  if (!Number.isInteger(ceiling) || ceiling <= 0) {
    throw new Error(
      `--arm B: admin_settings.image_analysis_max_output_tokens reads ${JSON.stringify(setting.rows[0]?.v ?? null)} — the ` +
        'report records the ceiling the backfill ran under (ADR-027 D8, "Report provenance") and is refused without it.',
    );
  }
  return {
    visionModel: providerIdentity({ config: { name: row.name, baseUrl: row.base_url }, model }),
    imageAnalysisMaxOutputTokens: ceiling,
    identityHash: imageAnalysisIdentityHash(row.provider_id, model, row.base_url),
  };
}

/**
 * Arm C's index state, on the database rather than on the returned top-K:
 * `image_analysis` unassigned, no derived `page_embeddings` row
 * (`metadata.source = 'image_analysis'`, the one provenance D11 allows), and
 * `page_image_analyses` absent or empty. A derived row that exists but ranks
 * outside every query's window is invisible to the runner's per-query check;
 * it is not invisible here.
 */
export async function assertArmCState(): Promise<void> {
  const problems: string[] = [];
  const assigned = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM llm_usecase_assignments WHERE usecase = 'image_analysis'`);
  if ((assigned.rows[0]?.n ?? 0) > 0) problems.push('image_analysis is assigned');
  const derived = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM page_embeddings WHERE metadata->>'source' = 'image_analysis'`);
  if ((derived.rows[0]?.n ?? 0) > 0) problems.push(`page_embeddings carries ${derived.rows[0]!.n} derived row(s) (metadata.source = 'image_analysis')`);
  const table = await query<{ exists: string | null }>(`SELECT to_regclass('public.page_image_analyses') AS exists`);
  if (table.rows[0]?.exists) {
    const analyses = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM page_image_analyses`);
    if ((analyses.rows[0]?.n ?? 0) > 0) problems.push(`page_image_analyses carries ${analyses.rows[0]!.n} row(s)`);
  }
  if (problems.length > 0) {
    throw new Error(
      `arm C: this database is not in the ablation's state (ADR-027 "Arms and revisions": image_analysis unassigned, ` +
        `no derived chunks, page_image_embeddings empty) — ${problems.join('; ')}. Unassign it and re-seed; the run ` +
        'refuses rather than deleting what it did not write.',
    );
  }
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
 * The one pairing a `legacy-revision-C` report is read in: against the
 * candidate C, on a different revision by construction. It is the regression
 * control for #1617's authored-hit change (ADR-027 "Arms and revisions"),
 * DESCRIPTIVE only — `--baseline` prints its retrieval endpoints under that
 * label and no verdict condition reads it; `--unblind` never accepts it.
 */
export function isRegressionControlPair(baseline: ArmRunReport, candidate: ArmRunReport): boolean {
  return baseline.arm === 'C' && candidate.arm === 'C' && (baseline.control !== undefined) !== (candidate.control !== undefined);
}

/**
 * The knobs only ONE of two reports records, when the two ran on different
 * revisions. Every pair containing arm A is such a pair by design (A is the
 * legacy revision), and a knob a revision does not define cannot be held
 * fixed: there is no re-run that could make it agree, so the comparison
 * RECORDS it (`ArmRetrievalComparison.revisionSpecificKnobs`) instead of
 * refusing the pair (review r2 finding 4).
 *
 * Two arms on the SAME revision (B vs C) record the same knob set or one of
 * them drifted, so this is empty there and `assertComparableArms` refuses a
 * one-sided knob — round-1 finding 1's rule, unchanged. The ADR's named
 * knobs are required of every report by `RetrievalKnobsSchema`, so they can
 * never be revision-specific.
 */
export function revisionSpecificKnobs(baseline: ArmRunReport, candidate: ArmRunReport): string[] {
  if (baseline.revisionSha === candidate.revisionSha) return [];
  const named = HELD_FIXED_KNOBS as readonly string[];
  const oneSided: string[] = [];
  for (const [a, b] of [[baseline, candidate], [candidate, baseline]] as const) {
    for (const knob of Object.keys(a.retrieval)) {
      if (!named.includes(knob) && !(knob in b.retrieval)) oneSided.push(knob);
    }
  }
  return [...new Set(oneSided)].sort();
}

/**
 * Refuse a pair of arm reports the ADR says is not a comparison.
 *
 * "The report refuses a pair whose arm, revision, corpus hash, query-set
 * hash, embedder, FTS language, rerank assignment or answer model differ."
 * Read as the design intends it: the two files must be two DIFFERENT arms
 * (two runs of one arm are a before/after on that arm, which the text gate
 * already does), each must be the arm the operator says it is, each must
 * carry its own arm's provenance (`armProvenanceProblems`), B and C must
 * share the candidate revision (that is what makes B − C the enrichment
 * alone), and everything in the "Held fixed" list must match — including
 * every retrieval knob the reports record, key by key, so a `rag_fetch_width`
 * that drifted between arms is a refusal and not a footnote. The ADR's named
 * knobs are required of every report, so "neither side recorded it" is not a
 * way past that; the one exception is a knob that exists on one REVISION
 * only, which is recorded rather than refused (`revisionSpecificKnobs` — it
 * is empty for a same-revision pair, so B vs C is unchanged). A
 * legacy-revision C control is refused as C of any pair; the one pairing it
 * is admitted in is `isRegressionControlPair`, and never under `expected`
 * (the un-blind step's pairs).
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
  for (const report of [baseline, candidate]) {
    const problems = armProvenanceProblems(report);
    if (problems.length > 0) {
      throw new Error(`Arm ${report.arm}'s report does not carry its arm's provenance: ${problems.map((p) => p.message).join('; ')}`);
    }
  }
  const regressionControl = expected === undefined && isRegressionControlPair(baseline, candidate);
  if (!regressionControl) {
    for (const report of [baseline, candidate]) {
      if (report.control !== undefined) {
        throw new Error(
          `A ${report.control} report is a regression control for #1617's authored-hit change and is never ` +
            'substituted for arm C (ADR-027 "Arms and revisions"). Read it beside the pair, not inside it — the one ' +
            'comparison it is read in is --baseline against the candidate C, descriptive only.',
        );
      }
    }
    if (baseline.arm === candidate.arm) {
      throw new Error(
        `Both reports are arm ${baseline.arm} — two runs of one arm are a before/after on that arm, not an ` +
          'arm comparison. Pair A, B and C against each other.',
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
  const revisionOnly = revisionSpecificKnobs(baseline, candidate);
  for (const knob of [...new Set([...Object.keys(baseline.retrieval), ...Object.keys(candidate.retrieval)])].sort()) {
    if (revisionOnly.includes(knob)) continue;
    check(`retrieval.${knob}`, baseline.retrieval[knob], candidate.retrieval[knob]);
  }
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
  /**
   * True for the legacy-C vs candidate-C pairing (`isRegressionControlPair`):
   * the regression control for #1617's authored-hit change, descriptive only.
   */
  regressionControl: boolean;
  /**
   * Knobs only one side's revision defines (`revisionSpecificKnobs`): empty
   * for a same-revision pair, and the reason a cross-revision pair is not
   * refused for them. Recorded so the verdict document says which knobs
   * were NOT compared.
   */
  revisionSpecificKnobs: string[];
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
    regressionControl: isRegressionControlPair(baseline, candidate),
    revisionSpecificKnobs: revisionSpecificKnobs(baseline, candidate),
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
