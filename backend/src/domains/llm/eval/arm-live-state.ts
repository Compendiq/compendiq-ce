/**
 * #1823 — certify the LIVE arm state immediately before labelled answers.
 *
 * `run-arm-answers.ts` labels every answer it writes with `--arm B|C`, but
 * until #1823 it compared `--report` only with local facts (arm flag,
 * revision, corpus and query-set hashes) and never looked at the database
 * the ask route would read. A C database re-seeded or backfilled into B's
 * state answered as "C"; a B database whose backfill never finished answered
 * as "B"; a report written under another vision model, ceiling, version pair,
 * embedder or FTS configuration was accepted because nothing compared it with
 * what the index now is.
 *
 * Nothing here is a second predicate. Arm C's state is `assertArmCState`,
 * arm B's readiness is `readArmBState` + `driveArmBBackfill` at
 * `timeoutMs: 0` ("refuse unless already complete" — it never runs a batch),
 * exactly what the retrieval run certified before it wrote the report. The
 * report is then bound to the configuration those reads return, and only a
 * database that passes both is asked a single question.
 */
import { getFtsLanguage } from '../../../core/services/fts-language.js';
import { resolveUsecase } from '../services/llm-provider-resolver.js';
import { generateArmAnswers, type AskFn, type GenerateArmAnswersOptions, type GeneratedAnswers } from './answers.js';
import { driveArmBBackfill } from './arm-b-backfill.js';
import { assertArmCState, readArmBState, type ArmRunReport, type EvalArm, type ProviderIdentity } from './arms.js';
import { loadImageCorpusManifest } from './corpus-images.js';
import type { ImageFixture } from './fixture.js';
import { currentVectorDimensions } from './seed.js';

/** What the database the ask route reads is, field for field with `ArmRunReport`. */
export interface LiveArmState {
  arm: EvalArm;
  visionModel: ProviderIdentity | null;
  imageAnalysisMaxOutputTokens: number | null;
  imageAnalysisVersions: { prompt: number; schema: number } | null;
  /** The `embedding` assignment the route embeds questions with, and the index's vector width. */
  embedder: { model: string; endpoint: string; dims: number | null };
  ftsLanguage: string;
}

export interface ReadLiveArmStateOptions {
  /** The eval user — `driveArmBBackfill` takes it for the embedding lock it never reaches at timeout 0. */
  userId: string;
  /** Corpus images arm B must carry a valid analysis for; defaults to the image corpus manifest's count. */
  expectedImages?: number;
}

/**
 * Certify the arm's index state on the database and read the configuration
 * the report must match. Throws the guard's own refusal when the database is
 * not in that arm's state.
 */
export async function readLiveArmState(arm: EvalArm, opts: ReadLiveArmStateOptions): Promise<LiveArmState> {
  let visionModel: ProviderIdentity | null = null;
  let imageAnalysisMaxOutputTokens: number | null = null;
  let imageAnalysisVersions: { prompt: number; schema: number } | null = null;
  if (arm === 'C') {
    await assertArmCState();
  } else {
    const state = await readArmBState();
    const expectedImages = opts.expectedImages
      ?? loadImageCorpusManifest().pages.reduce((n, page) => n + page.images.length, 0);
    const { versions } = await driveArmBBackfill(state, expectedImages, { userId: opts.userId, timeoutMs: 0 });
    visionModel = state.visionModel;
    imageAnalysisMaxOutputTokens = state.imageAnalysisMaxOutputTokens;
    imageAnalysisVersions = versions;
  }
  const embedding = await resolveUsecase('embedding');
  return {
    arm,
    visionModel,
    imageAnalysisMaxOutputTokens,
    imageAnalysisVersions,
    embedder: { model: embedding.model, endpoint: embedding.config.baseUrl, dims: await currentVectorDimensions() },
    ftsLanguage: await getFtsLanguage(),
  };
}

/** Every field of the report that the live index configuration contradicts, named. */
export function liveArmReportProblems(report: ArmRunReport, live: LiveArmState): string[] {
  const problems: string[] = [];
  const show = (v: unknown): string => JSON.stringify(v ?? null);
  if (report.arm !== live.arm) problems.push(`arm: report ${report.arm}, live ${live.arm}`);
  if ((report.visionModel?.identity ?? null) !== (live.visionModel?.identity ?? null)) {
    problems.push(`visionModel: report ${show(report.visionModel?.identity)}, live ${show(live.visionModel?.identity)}`);
  }
  if (report.imageAnalysisMaxOutputTokens !== live.imageAnalysisMaxOutputTokens) {
    problems.push(`imageAnalysisMaxOutputTokens: report ${show(report.imageAnalysisMaxOutputTokens)}, live ${show(live.imageAnalysisMaxOutputTokens)}`);
  }
  const rv = report.imageAnalysisVersions;
  const lv = live.imageAnalysisVersions;
  if ((rv === null) !== (lv === null) || (rv && lv && (rv.prompt !== lv.prompt || rv.schema !== lv.schema))) {
    problems.push(`imageAnalysisVersions: report ${show(rv)}, live ${show(lv)}`);
  }
  if (report.embedder.model !== live.embedder.model) {
    problems.push(`embedder.model: report ${show(report.embedder.model)}, live ${show(live.embedder.model)}`);
  }
  // A trailing `/` on an endpoint is the same endpoint.
  if (report.embedder.endpoint.replace(/\/+$/, '') !== live.embedder.endpoint.replace(/\/+$/, '')) {
    problems.push(`embedder.endpoint: report ${show(report.embedder.endpoint)}, live ${show(live.embedder.endpoint)}`);
  }
  if (report.embedder.dims !== live.embedder.dims) {
    problems.push(`embedder.dims: report ${report.embedder.dims}, live ${show(live.embedder.dims)}`);
  }
  if (report.ftsLanguage !== live.ftsLanguage) {
    problems.push(`ftsLanguage: report ${show(report.ftsLanguage)}, live ${show(live.ftsLanguage)}`);
  }
  return problems;
}

export interface GenerateLiveArmAnswersOptions extends GenerateArmAnswersOptions {
  /** The retrieval report of the same arm on the same database (`--report`), or null when none was given. */
  report: ArmRunReport | null;
  userId: string;
  expectedImages?: number;
}

/**
 * `generateArmAnswers`, behind the live certification: the arm's state is
 * asserted on the database and `--report` is bound to it BEFORE the first
 * question — a refusal here means no completion request was ever made.
 */
export async function generateLiveArmAnswers(
  ask: AskFn,
  fixture: ImageFixture,
  opts: GenerateLiveArmAnswersOptions,
): Promise<GeneratedAnswers> {
  const { report, userId, expectedImages, ...generateOpts } = opts;
  const live = await readLiveArmState(generateOpts.arm, { userId, expectedImages });
  if (report) {
    const problems = liveArmReportProblems(report, live);
    if (problems.length > 0) throw new Error(`--report does not describe this database: ${problems.join('; ')}`);
  }
  return generateArmAnswers(ask, fixture, generateOpts);
}
