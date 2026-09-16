/**
 * #1102 — the eval entrypoint: seed the corpus, run the fixture, score it.
 *
 * Two modes, and the distinction matters:
 *
 *   --out report.json                 measure this checkout
 *   --out b.json --baseline a.json    compare against an earlier measurement
 *
 * A single run's absolute numbers are only meaningful against the same corpus
 * and the same model, so the comparison mode is the one that answers "did this
 * change help". It reports the paired bootstrap CI and the per-query win/loss
 * table, never a fixed threshold — Recall@K over N queries moves in 1/N steps,
 * so a "regressions > 0.01 fail" rule cannot represent what it claims to.
 *
 * Flags that change WHAT is measured, and so must match across a comparison:
 *   --lang en|de              which corpus and fixture (default en)
 *   --fts-language <cfg>      the Postgres text-search configuration BOTH legs
 *                             of the lexical half run under (default 'simple'
 *                             for every language — see fts-config.ts)
 *   --images                  #1115 P5b: the IMAGE axis instead of the text
 *                             gate (see below)
 *
 * `--help` prints the full list (EVAL_USAGE in eval/cli-flags.ts), and an
 * unrecognised flag is refused rather than ignored — a typo'd --fts-langauge
 * used to cost an hour of embedding under the default configuration.
 *
 * ── The image axis (#1115 P5b) ────────────────────────────────────────────
 *
 * `--images` measures a different question: not "did this checkout retrieve
 * better" but "what does the image leg add". So it is not a variant of the
 * gate above — it seeds a different corpus (`eval/corpus-de-images/`, through
 * the REAL intake: bytes on disk, `embedPageImages`, `page_image_embeddings`)
 * against a different fixture (`fixture-de-images.json`), and then runs every
 * query TWICE in one process — `imageLeg: false`, then `imageLeg: true` —
 * pairing the two arms per query. The verdict is the harness's own: McNemar
 * exact over the discordant pairs, overall and per `style` and per label
 * language. A `--baseline` from the other axis is refused — as is a same-axis
 * one measured through a different VL model, width or endpoint — and an
 * accepted pair compares leg-off against leg-off AND leg-on against leg-on.
 * `--deep-search` is refused on this axis: it reformulates per request, so the
 * two arms would be paraphrased separately and would not be a pair.
 *
 * ── The arm axis (#1614 PR2, ADR-027) ────────────────────────────────────
 *
 * `--images --arm A|B|C` runs ONE arm of the pre-registered A/B/C comparison
 * on the image corpus and writes an `ArmRunReport` (eval/arms.ts). The arms
 * live on different revisions and index states, so they cannot share a
 * process: pairing happens across files, here for the retrieval endpoints
 * (`--baseline` = another arm's report) and in scripts/judge-arms.ts for the
 * judged ones. A: the legacy leg, seeded through the real intake exactly as
 * the paired axis seeds it. C: text + attachment bytes only, and the run
 * asserts `page_image_embeddings` stayed empty. B: the same seed, then the
 * vision-analysis backfill must have run on this database (the product's
 * worker, on the post-#1617 revision) before the queries are made.
 *
 * Environment:
 *   EVAL_EMBEDDING_BASE_URL   OpenAI-compatible endpoint (Ollama's /v1 shim works)
 *   EVAL_EMBEDDING_MODEL      model name to embed with
 *   POSTGRES_URL              a database this script may TRUNCATE and RETYPE
 *   EVAL_HARDWARE             --arm only: free text naming the host, GPU and
 *                             server software (ADR-027 O9), recorded as provenance
 *   EVAL_REVISION_SHA         --arm only, and only for a tree WITHOUT git history
 *                             (an export or image built at a commit): the sha to
 *                             record. Where git answers, HEAD is recorded, the
 *                             tree must be clean, and the variable must agree
 *                             with HEAD or the run is refused (eval/arms.ts
 *                             `readRevisionSha`).
 *
 * With --images, additionally (see eval/images-axis.ts for why these are their
 * OWN variables and never fall back to the text pair):
 *   EVAL_IMAGE_EMBEDDING_BASE_URL   the vision-language endpoint, with its /v1
 *   EVAL_IMAGE_EMBEDDING_MODEL      the VL model id
 *   EVAL_IMAGE_EMBEDDING_DIMENSIONS optional MRL truncation width
 *   EVAL_IMAGE_EMBEDDING_BACKEND    optional provenance label for the report
 * (required on --arm A, REFUSED on --arm B and --arm C.)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { markdownToHtml, htmlToText } from '../src/core/services/content-converter.js';
import { query, closePool, closeVectorPool, runMigrations } from '../src/core/db/postgres.js';
import { generateEmbedding } from '../src/domains/llm/services/openai-compatible-client.js';
import { loadCorpus, loadFixture, loadImageFixture, assertFixturePower, corpusDirsForLanguage } from '../src/domains/llm/eval/fixture.js';
import { IMAGE_CORPUS_DIR, loadImageCorpusManifest } from '../src/domains/llm/eval/corpus-images.js';
import { seedCorpus, ensureVectorDimensions, configureEmbeddingProvider, resetEvalCorpus, assertModelReadsFullChunk, configureFtsLanguage, assertSeededFtsLanguage, recordCorpusLanguage, EVAL_USER_ID } from '../src/domains/llm/eval/seed.js';
import { seedImageCorpus, prepareImageIndex, stageEvalAttachmentsDir } from '../src/domains/llm/eval/seed-images.js';
import { assertDisposableDatabase } from '../src/domains/llm/eval/disposable-db.js';
import { assertKnownFlags, flagValue, wantsHelp, EVAL_KNOWN_FLAGS, EVAL_USAGE, EVAL_VALUELESS_FLAGS } from '../src/domains/llm/eval/cli-flags.js';
import { parseFtsLanguageArg, assertComparableFtsLanguage } from '../src/domains/llm/eval/fts-config.js';
import { ARM_AXIS, IMAGE_AXIS, IMAGE_AXIS_CORPUS_CLAIM, TEXT_AXIS, assertComparableAxis, assertComparableImageModel, assertImageAxisStagesPairable, parseImageAxisLanguage, readImageAxisEnv, wantsImageAxis, type EvalAxis, type ImageAxisEnv } from '../src/domains/llm/eval/images-axis.js';
import { runEval } from '../src/domains/llm/eval/runner.js';
import { runArmEval, runImageEval } from '../src/domains/llm/eval/runner-images.js';
import { armRuns } from '../src/domains/llm/eval/images-metrics.js';
import { buildImageAxisReport, formatImageAxisVerdict, type ImageAxisReport } from '../src/domains/llm/eval/images-report.js';
import { assertArmCState, commandLine, compareArmRetrieval, formatPairedBinary, imageEvidenceRecallAtK, imageNegativeLeakAt1, parseArmFlag, parseArmRunReport, querySetSha, readArmBState, readArmImageEnv, readHeldFixedProvenance, readRevisionSha, type ArmBState, type ArmRunReport, type EvalArm } from '../src/domains/llm/eval/arms.js';
import { driveArmBBackfill } from '../src/domains/llm/eval/arm-b-backfill.js';
import { percentile } from '../src/domains/llm/eval/latency-stats.js';
import { flushSearchAnalytics } from '../src/domains/llm/services/rag-service.js';
import { recallAtK, meanReciprocalRank, pairedBootstrapCi, pairedSignificance, winLoss, type QueryRun } from '../src/domains/llm/eval/metrics.js';

const TOP_K = [1, 3, 5, 10] as const;

interface Report {
  model: string;
  /**
   * #1114: which language corpus this run measured. Absent/'en' is the
   * English gate. A cross-language comparison is already refused by the
   * corpusManifestSha guard; this makes the refusal readable.
   */
  language: string;
  /**
   * #1114: the PostgreSQL text-search configuration the LEXICAL leg ran under
   * — both the seed-time `pages.tsv` build and the query-time
   * `keyword_search`. Independent of `language`: it defaults to 'simple' for
   * every corpus, because that is what every recorded baseline (CI included)
   * was measured under. A report without this field predates the flag and was
   * 'simple'.
   */
  ftsLanguage: string;
  corpusManifestSha: string;
  /**
   * #1619: the revision the run measured, where git could answer for a clean
   * tree. Absent on a dirty or history-less checkout — and a control without
   * it cannot serve as either side of `--control-legacy-c`'s cross-revision
   * pair (`scoreLegacyRevisionControls`).
   */
  revisionSha?: string;
  redundantSlots?: number;
  returnedSlots?: number;
  meanPairwiseSimilarity?: number;
  corpusPages: number;
  queries: number;
  vectorParticipatingQueries: number;
  /** #1104: whether this run measured the reranked pipeline (--rerank). */
  rerank: boolean;
  rerankParticipatingQueries: number;
  /** #1106 PR 2: whether sibling assembly ran (default true; --no-assemble). */
  assembleContext: boolean;
  assemblyParticipatingQueries: number;
  /** #1107: whether identifier pinning ran (default true; --no-pin). */
  pinIdentifiers: boolean;
  /** #1107: queries led by a verified identifier pin. */
  pinParticipatingQueries: number;
  /** #1112: whether this run measured multi-query expansion (--deep-search). */
  deepSearch: boolean;
  /** #1112: queries whose expansion actually produced paraphrase legs. */
  expansionParticipatingQueries: number;
  /** #1112: queries where expansion stood down by design (identifier, error-text). */
  expansionSkippedQueries: number;
  /**
   * #1115 P5b: which AXIS this run measured. Absent means `text` — every
   * report written before the image axis existed is a text-gate report, and
   * `assertComparableAxis` reads it that way.
   *
   * On an `images` run the fields above still describe what was measured (the
   * text embedder, the corpus language, the FTS configuration, the flags), and
   * the three below — `recallAtK`, `mrr`, `runs` — carry the **leg-on** arm:
   * that is the shipped configuration, since `rag_image_leg_enabled` defaults
   * true. Both arms are in `images.runsOff` / `images.runsOn`.
   */
  axis?: EvalAxis;
  recallAtK: Record<string, number>;
  mrr: number;
  runs: QueryRun[];
  /** #1115 P5b: everything the paired image measurement produced. */
  images?: ImageAxisReport;
}

// Both spellings, and a flag given with no value is refused rather than
// answered as "unset" — see flagValue in eval/cli-flags.ts. This used to be
// index arithmetic over `--${name}`, which could not see `--out=/tmp/x.json`
// at all while assertKnownFlags happily admitted it (review r3).
const arg = (name: string): string | undefined => flagValue(process.argv, name);

// The destructive-database guard now lives in
// src/domains/llm/eval/disposable-db.ts. It was private to this file, below
// the top-level main() call, so nothing could import it without running a
// destructive eval as a side effect — and #1114's latency benchmark needs the
// same protection against the same database.

async function main(): Promise<void> {
  if (wantsHelp(process.argv.slice(2))) {
    console.log(EVAL_USAGE);
    return;
  }
  // FIRST, before the endpoint check and long before anything is embedded: an
  // unrecognised flag used to be ignored here, so `--fts-langauge german` ran
  // the whole hour under 'simple' (review r2). The benchmark already refused
  // one; two entrypoints disagreeing about that is drift, not a policy.
  // EVAL_VALUELESS_FLAGS is the other half of the same guarantee: the switches
  // are read with `process.argv.includes`, so `--rerank=true` would otherwise
  // pass the name-half check and measure plain retrieval under a report that
  // says reranked.
  assertKnownFlags(process.argv.slice(2), EVAL_KNOWN_FLAGS, EVAL_USAGE, EVAL_VALUELESS_FLAGS);

  // #1115 P5b: the image axis is its own corpus, its own fixture, its own
  // seeder and its own paired runner. Read HERE, beside the flag guard,
  // because everything it decides has to be decided before the database is
  // touched.
  const imageAxis = wantsImageAxis(process.argv);
  // Here too, and for the same reason: `--deep-search` reformulates per REQUEST,
  // so the two arms of a pair would be asked different questions and the paired
  // verdict would attribute the difference to the image leg (review r2). Refused
  // before the environment is read, before a connection is opened and long
  // before anything is embedded.
  if (imageAxis) assertImageAxisStagesPairable(process.argv);
  // #1614 PR2: the arm axis is a mode OF the image corpus — one arm per run.
  // Parsed beside the other flags so `--arm C` without `--images`, or a
  // misspelt arm, costs a message and nothing else.
  const arm = parseArmFlag(process.argv);
  const control = arg('control');
  if (control !== undefined && (control !== 'legacy-revision-C' || arm !== 'C')) {
    throw new Error('--control takes exactly `legacy-revision-C`, and only on --arm C');
  }
  const backfillTimeoutSec = Number(arg('backfill-timeout') ?? '0');
  if (!Number.isFinite(backfillTimeoutSec) || backfillTimeoutSec < 0 || (arg('backfill-timeout') !== undefined && arm !== 'B')) {
    throw new Error('--backfill-timeout takes a non-negative number of seconds, and only on --arm B');
  }
  // A: the VL endpoint is required, read through the same reader the paired
  // axis uses. B and C: the same variables are REFUSED, before the database
  // is touched, because an index they would fill is one those arms must not
  // have. `readArmImageEnv` is that rule.
  const armImageEnv = arm ? readArmImageEnv(arm) : null;

  const baseUrl = process.env.EVAL_EMBEDDING_BASE_URL;
  const model = process.env.EVAL_EMBEDDING_MODEL;
  if (!baseUrl || !model) {
    throw new Error('EVAL_EMBEDDING_BASE_URL and EVAL_EMBEDDING_MODEL are required — the eval never mocks the embedder');
  }
  // In the same place and for the same reason as the pair above: a missing VL
  // endpoint must cost nothing. Read before `assertDisposableDatabase`, before
  // any connection and long before anything is embedded — the whole argument
  // the unknown-flag guard is written out of (review r2), applied to the axis's
  // own environment.
  const imageEnv = arm ? armImageEnv : imageAxis ? readImageAxisEnv() : null;
  // The default is PER AXIS. Both axes wrote `retrieval-eval.json`, so an
  // `--images` run started without `--out` overwrote the text gate's report in
  // place — the file the runbook tells operators to keep as their `--baseline`,
  // destroyed by a run that never mentions it. The two reports are not
  // interchangeable (`assertComparableAxis` refuses the pair outright), so
  // there is no reading under which sharing one path is useful.
  const outPath = arg('out') ?? (arm ? `retrieval-eval-arm-${arm}.json` : imageAxis ? 'retrieval-eval-images.json' : 'retrieval-eval.json');
  // Parsed before anything touches the database, so a typo costs nothing.
  // Default 'simple' for EVERY language — never derived from --lang; see
  // fts-config.ts for why the two are separate choices.
  const ftsLanguage = parseFtsLanguageArg(process.argv);
  // #1114: --lang de measures the translated corpus instead of the English
  // one. It is a separate measurement with its own fixture, never a variant
  // of the English gate — see corpusDirsForLanguage. On the image axis the
  // language is not a choice (the corpus is German Wikipedia), and any other
  // value is refused rather than silently resolved onto the English gate —
  // here, beside the other flag parsing, so `--images --lang en` costs an
  // error message rather than a connection and a migration run.
  const langArg = arg('lang');
  const language = imageAxis
    ? parseImageAxisLanguage(process.argv)
    : langArg && langArg !== 'en' ? langArg : 'en';

  assertDisposableDatabase(process.env.POSTGRES_URL ?? '');

  await runMigrations();
  // #1614 PR2 review r1: `--arm B` refuses AT ONCE — here, one row-less probe
  // after the migrations and before the FTS write, the corpus reset and the
  // 65-page seed. The candidate revision's table (#1616), the image_analysis
  // assignment (O8) and the output-token ceiling (D8) are what B needs
  // before anything is embedded; the backfill it waits for later cannot run
  // without them either.
  const armBState: ArmBState | null = arm === 'B' ? await readArmBState() : null;
  if (armBState) console.log(`arm B: image_analysis ${armBState.visionModel.identity} · image_analysis_max_output_tokens ${armBState.imageAnalysisMaxOutputTokens}`);
  // Before the seed, not after: migration 049 builds pages.tsv from a BEFORE
  // INSERT trigger that reads this row per row, so a value written later would
  // leave the corpus indexed under one configuration while keywordSearch
  // queried under another. Gated behind assertDisposableDatabase above — this
  // is an admin_settings write against whatever POSTGRES_URL names.
  await configureFtsLanguage(ftsLanguage);
  await query(
    `INSERT INTO users (id, username, email, role, password_hash)
     VALUES ($1::uuid, 'eval-runner', 'eval@local', 'admin', 'x') ON CONFLICT (id) DO NOTHING`,
    [EVAL_USER_ID],
  );

  const providerConfig = { baseUrl, model, name: 'eval-embedding' };
  await query(`DELETE FROM llm_usecase_assignments WHERE usecase = 'embedding'`);
  await query(`DELETE FROM llm_providers WHERE name = 'eval-embedding'`);
  await configureEmbeddingProvider(providerConfig);

  // Probe for the MEASURED dimension rather than trusting a constant: the
  // whole point of running a small model in CI is that it is not the 1024-dim
  // production one, and a hardcoded number would silently be wrong the first
  // time the model changes.
  const evalProviderConfig = {
    providerId: 'eval', id: 'eval', name: 'eval', baseUrl,
    apiKey: null, authType: 'none' as const, verifySsl: true, defaultModel: model,
  };
  const probe = await generateEmbedding(evalProviderConfig, model, 'dimension probe');
  const dims = probe[0]?.length ?? 0;
  console.log(`model ${model} → ${dims} dimensions`);

  console.log(`fts configuration: ${ftsLanguage}`);

  // Everything above this line is shared because it decides what the TEXT half
  // of retrieval does, and both axes have one.
  const shared: AxisContext = { language, ftsLanguage, model, dims, evalProviderConfig };
  // The arm axis writes its own report shape and pairs across files, so it
  // returns before the text/image report printing below.
  if (arm) {
    const report = await measureArmAxis(shared, {
      arm,
      imageEnv,
      armBState,
      control: control === 'legacy-revision-C' ? 'legacy-revision-C' : undefined,
      backfillTimeoutMs: backfillTimeoutSec * 1000,
    });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log('\n--- retrieval eval (arm axis) ---');
    console.log(
      `arm ${report.arm}${report.control ? ` (${report.control})` : ''} · revision ${report.revisionSha.slice(0, 12)} · ` +
        `corpus ${report.language} · fts ${report.ftsLanguage} · embedder ${report.embedder.model} (${report.embedder.dims}d) · ` +
        `rerank ${report.rerank} · answer model ${report.answerModel?.identity ?? 'none assigned'}`,
    );
    for (const k of TOP_K) console.log(`Recall@${k}: ${report.recallAtK[`@${k}`]!.toFixed(4)}`);
    console.log(`MRR:       ${report.mrr.toFixed(4)}`);
    console.log(
      `image-evidence R@5: ${report.imageEvidenceRecallAt5 === null ? 'none (arm C)' : report.imageEvidenceRecallAt5.toFixed(4)} · ` +
        `image-negative leakage@1: ${report.imageNegativeLeakAt1.toFixed(4)} · ` +
        `evidence in ${report.imageEvidenceParticipatingQueries}/${report.queries} queries`,
    );
    console.log(`vector leg participated in ${report.vectorParticipatingQueries}/${report.queries} queries`);
    console.log(`query cost p50 ${report.queryCostMs.p50.toFixed(0)} ms · p95 ${report.queryCostMs.p95.toFixed(0)} ms (reported, never gated — O11)`);
    const armBaselinePath = arg('baseline');
    if (armBaselinePath) {
      const json = JSON.parse(readFileSync(armBaselinePath, 'utf8')) as { axis?: string };
      assertComparableAxis(json.axis, ARM_AXIS);
      const baseline = parseArmRunReport(json, armBaselinePath);
      compareArmReports(baseline, report);
    }
    return;
  }
  // Branched on `imageEnv` rather than on `imageAxis` because they are the same
  // condition — the environment is read exactly when the flag is set, and is
  // refused rather than defaulted — and this spelling is the one that narrows
  // the argument's type instead of asserting it.
  const report = imageEnv
    ? await measureImageAxis(shared, imageEnv)
    : await measureTextAxis(shared);
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log('\n--- retrieval eval ---');
  // Named on the results header, not only at startup: this line is what gets
  // pasted into an issue, and a German score under a 'simple' stemmer is
  // exactly the number #1114 had to go back and re-measure.
  console.log(`axis ${report.axis} · corpus ${report.language} · fts ${report.ftsLanguage} · model ${report.model}`);
  for (const k of TOP_K) console.log(`Recall@${k}: ${report.recallAtK[`@${k}`]!.toFixed(4)}`);
  console.log(`MRR:       ${report.mrr.toFixed(4)}`);
  if (report.images) {
    for (const line of formatImageAxisVerdict(report.images)) console.log(line);
  } else {
    console.log(
      `redundant slots: ${report.redundantSlots}/${report.returnedSlots}` +
      ` (${((100 * (report.redundantSlots ?? 0)) / Math.max(1, report.returnedSlots ?? 1)).toFixed(2)}%)` +
      ` | mean pairwise similarity ${(report.meanPairwiseSimilarity ?? 0).toFixed(4)}`,
    );
  }
  console.log(`vector leg participated in ${report.vectorParticipatingQueries}/${report.queries} queries`);
  if (report.rerank) {
    console.log(`rerank stage participated in ${report.rerankParticipatingQueries}/${report.queries} queries`);
  }
  if (report.deepSearch) {
    console.log(
      `query expansion participated in ${report.expansionParticipatingQueries}/${report.queries} queries` +
      ` (${report.expansionSkippedQueries} skipped by design)`,
    );
  }

  const baselinePath = arg('baseline');
  if (baselinePath) {
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Report;
    // #1115 P5b: checked FIRST, and for the reason the language check below is
    // checked before the corpus sha. A cross-axis pair fails that check too
    // (the manifests differ), but "measured against a different corpus" sends
    // the reader looking for a corpus edit that never happened rather than at
    // the flag they forgot. Absent means the text gate.
    assertComparableAxis(baseline.axis, report.axis ?? TEXT_AXIS);
    // …and, on that axis, the VL model itself (review r2). `baseline.model`
    // below is the TEXT embedder and reads the same on both axes, so two runs
    // made with different checkpoints — the runbook's own 2B and 8B recipes,
    // both at 2048 dimensions — passed every check this block makes and had
    // their difference printed as `VERDICT: credible improvement` about
    // retrieval logic. Checked here, beside the axis, because it is the same
    // class of mistake: the pair is not a before/after at all.
    if ((report.axis ?? TEXT_AXIS) === IMAGE_AXIS) {
      assertComparableImageModel(baseline.images, report.images);
    }
    // #1114: checked BEFORE the corpus sha. A cross-language pair always fails
    // that check too (different manifests), but "different corpus" is a
    // confusing way to be told you compared a German run against an English
    // one — the reader goes looking for a corpus edit that never happened.
    // Old baselines predate the field; absent means English.
    if ((baseline.language ?? 'en') !== report.language) {
      throw new Error(
        `Baseline measured the ${baseline.language ?? 'en'} corpus, this run measured ${report.language} — ` +
        'these are separate measurements, not a before/after. Compare each language against its own baseline.',
      );
    }
    // #1114: beside the language check and for the same reason. The corpus sha
    // does NOT catch this one — two runs over the same corpus can differ only
    // in their text-search configuration, which changes the lexical index the
    // keyword leg scores against and nothing else. Absent means 'simple'.
    assertComparableFtsLanguage(baseline.ftsLanguage, report.ftsLanguage);
    if (baseline.corpusManifestSha !== report.corpusManifestSha) {
      throw new Error('Baseline was measured against a different corpus — the comparison would be meaningless');
    }
    if (baseline.model !== report.model) {
      throw new Error(`Baseline used model ${baseline.model}, this run used ${report.model} — this gate compares retrieval logic, not models (to compare models, run BOTH sides here yourself with the real candidates, or score them on your own corpus via #1260)`);
    }
    // #1104: a reranked and a plain run measure different pipelines — a
    // forgotten --rerank on one side would print a confident verdict about a
    // flag, not the checkout. Old baselines predate the field; treat absent
    // as false.
    if ((baseline.rerank ?? false) !== report.rerank) {
      throw new Error(
        `Baseline rerank=${baseline.rerank ?? false} but this run rerank=${report.rerank} — `
        + 'measure both sides with the same --rerank setting.',
      );
    }
    // #1112: deep search is the whole point of ITS comparison, so the two
    // sides differing on it is the one case where a mismatch is intended —
    // and exactly why it must be stated rather than inferred from a flag
    // someone forgot. Reported, never thrown on.
    if ((baseline.deepSearch ?? false) !== report.deepSearch) {
      console.log(
        `\nNOTE: baseline deepSearch=${baseline.deepSearch ?? false}, this run deepSearch=${report.deepSearch}` +
        ' — this comparison measures the FEATURE, not the checkout.',
      );
    }

    // #1115 P5b: an image-axis pair is compared ARM BY ARM. Reporting only the
    // leg-on arm would blame the image leg for a change that moved the text
    // legs — and reporting only the top-level `runs` (which IS the leg-on arm)
    // is exactly that mistake with no way to see it. Both are printed, and
    // either one regressing sets the exit code.
    if (report.images && baseline.images) {
      compareArm('leg OFF', baseline.images.runsOff, report.images.runsOff);
      compareArm('leg ON', baseline.images.runsOn, report.images.runsOn);
    } else {
      compareArm('Recall@5', baseline.runs, report.runs);
    }
  }
}

/**
 * One paired comparison, printed. Shared by the text gate and by each arm of
 * an image-axis pair, so the two cannot end up with different verdict rules.
 */
function compareArm(title: string, baselineRuns: QueryRun[], candidateRuns: QueryRun[]): void {
  const scoreOne = (r: QueryRun) => recallAtK([r], 5);
  const ci = pairedBootstrapCi(baselineRuns, candidateRuns, scoreOne, { seed: 1102 });
  const table = winLoss(baselineRuns, candidateRuns, scoreOne);
  const verdict = pairedSignificance(baselineRuns, candidateRuns, scoreOne);

  console.log(`\n--- vs baseline (${title}) ---`);
  console.log(`delta ${ci.observedDelta >= 0 ? '+' : ''}${ci.observedDelta.toFixed(4)}  (bootstrap interval [${ci.lower.toFixed(4)}, ${ci.upper.toFixed(4)}], descriptive)`);
  console.log(`${table.wins.length} wins · ${table.losses.length} losses · ${table.ties} unchanged`);
  for (const loss of table.losses.slice(0, 10)) {
    console.log(`  LOSS ${loss.queryId}: ${loss.baseline.toFixed(2)} → ${loss.candidate.toFixed(2)}`);
  }

  // The DECISION is McNemar's exact test over the discordant pairs — the
  // interval above only describes effect size. Per-query Recall@5 is binary
  // here, and in that regime the percentile bootstrap fired at 4 flipped
  // queries for any fixture size, at a true p of 0.125 (review r1).
  if (verdict.method === 'mcnemar-exact') {
    console.log(`\nMcNemar exact over ${verdict.wins + verdict.losses} discordant pairs: p = ${verdict.pValue!.toFixed(4)}`);
    console.log(
      verdict.significant
        ? `VERDICT: credible ${verdict.direction === 'improvement' ? 'improvement' : 'REGRESSION'} (p < 0.05).`
        : 'VERDICT: no credible change — too few queries moved, or they moved both ways. The win/loss table above is still worth reading.',
    );
    if (verdict.direction === 'regression') process.exitCode = 1;
  } else {
    // Graded scores: no exact paired test applies, so report and do not gate.
    console.log('\nVERDICT: graded scores — reporting only, no automated verdict. Read the win/loss table.');
  }
}

/**
 * Everything both axes share, decided in `main` before either one seeds.
 *
 * They really do share it: an image-axis run still has a TEXT half — the same
 * embedder, the same chunking, the same lexical configuration — because the
 * whole measurement is what the image leg adds to that.
 */
interface AxisContext {
  language: string;
  ftsLanguage: string;
  /** The TEXT embedding model, resolved from EVAL_EMBEDDING_MODEL. */
  model: string;
  /** Its measured width. */
  dims: number;
  evalProviderConfig: {
    providerId: string; id: string; name: string; baseUrl: string;
    apiKey: string | null; authType: 'none'; verifySsl: boolean; defaultModel: string;
  };
}

/** The stage flags both axes read, in one place so they cannot diverge. */
function stageFlags() {
  return {
    // --rerank requests the #1104 stage; it runs only when this eval DB
    // carries a rerank use-case assignment (a provider serving /v1/rerank —
    // e.g. a local llama-server --rerank). Never enabled in CI: the CI DB
    // has no assignment, so the gate stays a plain-retrieval comparison.
    rerank: process.argv.includes('--rerank'),
    // Assembly mirrors the shipped chat configuration by default;
    // --no-assemble exposes the identity-A/B axis from committed code
    // (#1270 review F10). Provably metric-invisible either way — the
    // runner scores pageIds only — and participation-guarded in runEval.
    assembleContext: !process.argv.includes('--no-assemble'),
    pinIdentifiers: !process.argv.includes('--no-pin'),
    // #1112: --deep-search runs every query through multi-query expansion.
    // The reformulation call is REAL, like the embedder — this eval DB needs
    // a `chat` use-case assignment, and the runner refuses the run rather than
    // reporting plain retrieval under a deep label if it never fires.
    deepSearch: process.argv.includes('--deep-search'),
    ...(process.argv.includes('--mmr')
      ? { mmr: { enabled: true, lambda: Number(arg('mmr-lambda') ?? '0.5') } }
      : {}),
  };
}

/** The #1102 text gate: one corpus, one fixture, one pipeline. */
async function measureTextAxis(ctx: AxisContext): Promise<Report> {
  const { language, ftsLanguage, model, dims, evalProviderConfig } = ctx;
  const corpusDirs = corpusDirsForLanguage(language);
  const fixtureFile = language === 'en' ? 'fixture.json' : `fixture-${language}.json`;
  if (language !== 'en') console.log(`language: ${language} (corpus ${corpusDirs.join(', ')}, fixture ${fixtureFile})`);

  const corpus = loadCorpus(corpusDirs);

  // Before anything is embedded: a model that truncates would produce a
  // confident score describing the prefix it happened to read. Probed with the
  // corpus's OWN text, whose token density is what a real chunk carries.
  const longestPage = corpus.reduce((a, b) => (b.markdown.length > a.markdown.length ? b : a));
  await assertModelReadsFullChunk(evalProviderConfig, model, htmlToText(await markdownToHtml(longestPage.markdown)));

  await ensureVectorDimensions(dims);
  const fixture = loadFixture(
    JSON.parse(readFileSync(new URL(`../src/domains/llm/eval/${fixtureFile}`, import.meta.url), 'utf8')),
    corpus,
  );
  assertFixturePower(fixture);

  // Before seeding, not after: a leftover corpus from a previous run would
  // double every page and halve recall.
  await resetEvalCorpus();

  console.log(`seeding ${corpus.length} pages…`);
  const seeded = await seedCorpus(EVAL_USER_ID, {
    corpus,
    onProgress: (done, total) => {
      if (done % 25 === 0 || done === total) console.log(`  embedded ${done}/${total}`);
    },
  });
  if (seeded.skipped.length > 0) {
    throw new Error(`${seeded.skipped.length} corpus pages produced no chunks: ${seeded.skipped.slice(0, 5).join(', ')}`);
  }
  // The trigger is what actually built pages.tsv, and it is not this script's
  // code. Certify the result rather than trusting that an INSERT ordering held.
  await assertSeededFtsLanguage(ftsLanguage);
  // AFTER the seed, because the row states what is in the database. Nothing
  // about the seeded rows says which corpus they are, and #1114's latency
  // benchmark needs to refuse a German question set aimed at an English one.
  await recordCorpusLanguage(language);

  console.log(`running ${fixture.labels.length} queries…`);
  const flags = stageFlags();
  const { runs, vectorParticipatingQueries, rerankParticipatingQueries, assemblyParticipatingQueries, pinParticipatingQueries, expansionParticipatingQueries, expansionSkippedQueries, redundantSlots, returnedSlots, meanPairwiseSimilarity } = await runEval(fixture, {
    userId: EVAL_USER_ID,
    pageIdByFile: seeded.pageIdByFile,
    topK: Math.max(...TOP_K),
    ...flags,
  });

  return {
    model,
    language,
    ftsLanguage,
    axis: TEXT_AXIS,
    corpusManifestSha: fixture.corpusManifestSha,
    // #1619 (ADR-027 amendment A-3): the revision this control was measured
    // on, so `--control-legacy-c` can CERTIFY that its pair really spans two
    // revisions instead of labelling whatever it was handed. Recorded only
    // where `readRevisionSha` can answer for the tree — a dirty or
    // history-less checkout records none and is refused as either side of
    // the legacy pair, rather than silently passing as one revision or the
    // other. The text gate itself is not gated on it: a developer iterating
    // on a dirty tree still gets a report, it just cannot serve as a
    // cross-revision control.
    ...(() => {
      try {
        return { revisionSha: readRevisionSha() };
      } catch {
        return {};
      }
    })(),
    redundantSlots,
    returnedSlots,
    meanPairwiseSimilarity,
    corpusPages: corpus.length,
    assembleContext: flags.assembleContext,
    assemblyParticipatingQueries,
    pinIdentifiers: flags.pinIdentifiers,
    pinParticipatingQueries,
    deepSearch: flags.deepSearch,
    expansionParticipatingQueries,
    expansionSkippedQueries,
    queries: runs.length,
    vectorParticipatingQueries,
    rerank: flags.rerank,
    rerankParticipatingQueries,
    recallAtK: Object.fromEntries(TOP_K.map((k) => [`@${k}`, recallAtK(runs, k)])),
    mrr: meanReciprocalRank(runs),
    runs,
  };
}

/**
 * #1115 P5b — the image axis: the German image corpus seeded through the real
 * intake, then every fixture query run twice, leg off and leg on, paired.
 *
 * The order below is the product's own and none of it is arbitrary. The
 * truncation width lands before the probe, the probe before the column DDL,
 * the column before any image is embedded, and the whole image index is
 * prepared before `resetEvalCorpus` clears the corpus it will be filled from.
 */
async function measureImageAxis(ctx: AxisContext, imageEnv: ImageAxisEnv): Promise<Report> {
  const { language, ftsLanguage, model, dims, evalProviderConfig } = ctx;
  // Before ANY attachment is written or read: `attachment-store` resolves its
  // root at call time, and this is the call that decides it.
  const attachmentsDir = await stageEvalAttachmentsDir();
  // Named, and deliberately NOT cleaned up: it holds the exact bytes the
  // intake read, which is the first thing to look at when a run reports
  // skipped or missing images. It is ~6 MB and yours to delete.
  console.log(`image axis: corpus ${IMAGE_CORPUS_DIR}, attachments ${attachmentsDir} (left in place)`);

  const manifest = loadImageCorpusManifest();
  const longestPage = manifest.pages
    .map((page) => readFileSync(join(IMAGE_CORPUS_DIR, page.file), 'utf8'))
    .reduce((a, b) => (b.length > a.length ? b : a));
  await assertModelReadsFullChunk(evalProviderConfig, model, htmlToText(await markdownToHtml(longestPage)));

  await ensureVectorDimensions(dims);
  const prepared = await prepareImageIndex(imageEnv);
  console.log(
    `image model ${imageEnv.model} → ${prepared.dimensions} dimensions (${prepared.tier}, ` +
    `${prepared.indexed ? 'HNSW' : 'no index at this width'})`,
  );

  const fixture = loadImageFixture();
  assertFixturePower(fixture);

  await resetEvalCorpus();

  console.log(`seeding ${manifest.pages.length} image pages…`);
  const seeded = await seedImageCorpus(EVAL_USER_ID, {
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) console.log(`  embedded ${done}/${total}`);
    },
  });
  if (seeded.textSkipped.length > 0) {
    throw new Error(`${seeded.textSkipped.length} corpus pages produced no chunks: ${seeded.textSkipped.slice(0, 5).join(', ')}`);
  }
  console.log(
    `indexed ${seeded.imagesEmbedded} images in ${(seeded.imageEmbedWallClockMs / 1000).toFixed(1)}s ` +
    `(${seeded.throughputImagesPerSec.toFixed(2)} images/s sequential; ` +
    `${seeded.backfillThroughputImagesPerSec.toFixed(2)} images/s once the worker's ` +
    `${seeded.interPageDelayMs}ms per-page valve is added)`,
  );
  await assertSeededFtsLanguage(ftsLanguage);
  // NOT `language` (review r1). That row is what #1114's latency benchmark
  // refuses a mismatched question set against, and this corpus is a different
  // corpus from the German TEXT one — writing plain 'de' here made the two
  // indistinguishable and switched the refusal off for the very state it
  // exists to catch. `checkCorpusLanguage` knows this claim by name.
  await recordCorpusLanguage(IMAGE_AXIS_CORPUS_CLAIM);

  console.log(`running ${fixture.labels.length} queries, twice each (leg off, leg on)…`);
  const flags = stageFlags();
  const run = await runImageEval(fixture, {
    userId: EVAL_USER_ID,
    pageIdByFile: seeded.pageIdByFile,
    topK: Math.max(...TOP_K),
    ...flags,
    onProgress: (done, total) => {
      if (done % 25 === 0 || done === total) console.log(`  paired ${done}/${total}`);
    },
  });

  const images = buildImageAxisReport({
    imageModel: imageEnv.model,
    imageDims: prepared.dimensions,
    backend: imageEnv.backend,
    identity: prepared.identity,
    indexed: prepared.indexed,
    imagesEmbedded: seeded.imagesEmbedded,
    imagesReused: seeded.imagesReused,
    imageEmbedWallClockMs: seeded.imageEmbedWallClockMs,
    throughputImagesPerSec: seeded.throughputImagesPerSec,
    backfillThroughputImagesPerSec: seeded.backfillThroughputImagesPerSec,
    interPageDelayMs: seeded.interPageDelayMs,
    run,
  });
  // The top-level scores are the LEG-ON arm — the shipped configuration, since
  // `rag_image_leg_enabled` defaults true. Both arms are in `images`.
  const runsOn = armRuns(run.pairs, 'on');

  return {
    model,
    language,
    ftsLanguage,
    axis: IMAGE_AXIS,
    corpusManifestSha: fixture.corpusManifestSha,
    corpusPages: seeded.pages,
    assembleContext: flags.assembleContext,
    // Every participation figure below is the LEG-ON arm's, matching the
    // top-level scores and matching `queries` — one label, one query. A count
    // summed over both arms would be a count of ARM-queries reported against N
    // labels, which prints participation above 100% (review r1). Both stages
    // really run on this axis, so these are measured, never a hardcoded 0: a
    // zero here is a refusal condition on the text gate, and writing one by
    // hand asserts the broken state the harness refuses to publish.
    assemblyParticipatingQueries: run.assemblyParticipatingQueries.on,
    pinIdentifiers: flags.pinIdentifiers,
    pinParticipatingQueries: run.pinParticipatingQueries.on,
    deepSearch: flags.deepSearch,
    expansionParticipatingQueries: run.expansionParticipatingQueries.on,
    expansionSkippedQueries: run.expansionSkippedQueries.on,
    queries: run.totalQueries,
    vectorParticipatingQueries: run.vectorParticipatingQueries.on,
    rerank: flags.rerank,
    rerankParticipatingQueries: run.rerankParticipatingQueries.on,
    recallAtK: images.legOn.recallAtK,
    mrr: images.legOn.mrr,
    runs: runsOn,
    images,
  };
}

/**
 * Arm B's index state is "backfill complete on the corpus", and the backfill
 * is the PRODUCT's vision-analysis worker (#1616) running against this
 * database on the candidate revision — never a copy inside the harness. The
 * run now DRIVES that worker (`eval/arm-b-backfill.ts`) instead of waiting
 * for a human to drive a second process: the analyses and the re-embed the
 * derived chunks need are both the product's own entrypoints, and they run
 * inside the process that owns this run's `ATTACHMENTS_DIR`.
 *
 * What "complete" means is unchanged — D5's validity predicate, not
 * `status = 'analyzed'` alone: the row's `identity_hash` must be the retained
 * identity of the assignment this run read (`readArmBState`, before the
 * seed), and every valid row must carry ONE (prompt, schema) version pair,
 * which the report records.
 */
async function runArmBBackfill(state: ArmBState, expectedImages: number, timeoutMs: number): Promise<{ prompt: number; schema: number }> {
  const backfill = await driveArmBBackfill(state, expectedImages, {
    userId: EVAL_USER_ID,
    timeoutMs,
    onProgress: (line) => console.log(`arm B: ${line}`),
  });
  console.log(
    `arm B: ${backfill.analyses}/${expectedImages} corpus images analysed under ${state.visionModel.identity} ` +
      `(prompt v${backfill.versions.prompt}, schema v${backfill.versions.schema}) in ${backfill.batches} batch(es) ` +
      `over ${(backfill.wallMs / 60000).toFixed(1)} min, ${backfill.pagesReEmbedded} page(s) re-embedded in ` +
      `${backfill.embedPasses} pass(es) — backfill complete (O11: reported, never gated)`,
  );
  return backfill.versions;
}

/**
 * #1614 PR2 — ONE arm of ADR-027's comparison on the image corpus.
 *
 * A seeds exactly as the paired axis does (real intake, VL endpoint,
 * `page_image_embeddings` filled). B and C seed the text and the attachment
 * bytes with `imageIndex: false` and never assign `image_embedding`; C then
 * asserts its state on the database (`assertArmCState`: image_analysis
 * unassigned, no derived rows, no analyses) beside the empty image index, B
 * waits for the backfill. Every arm records the same provenance, and the
 * report is the arm's alone — pairing is `--baseline` here (retrieval
 * endpoints) and judge-arms.ts (judged ones).
 */
async function measureArmAxis(
  ctx: AxisContext,
  opts: { arm: EvalArm; imageEnv: ImageAxisEnv | null; armBState: ArmBState | null; control: 'legacy-revision-C' | undefined; backfillTimeoutMs: number },
): Promise<ArmRunReport> {
  const { language, ftsLanguage, model, dims, evalProviderConfig } = ctx;
  const { arm } = opts;
  const sha = readRevisionSha();
  const hardware = process.env.EVAL_HARDWARE?.trim() || null;
  if (!hardware) console.log('NOTE: EVAL_HARDWARE is unset — the report records hardware: null and the un-blind step of judge-arms.ts will refuse it (O9).');

  const attachmentsDir = await stageEvalAttachmentsDir();
  console.log(`arm ${arm}: corpus ${IMAGE_CORPUS_DIR}, attachments ${attachmentsDir} (left in place), revision ${sha}`);

  const manifest = loadImageCorpusManifest();
  const longestPage = manifest.pages
    .map((page) => readFileSync(join(IMAGE_CORPUS_DIR, page.file), 'utf8'))
    .reduce((a, b) => (b.length > a.length ? b : a));
  await assertModelReadsFullChunk(evalProviderConfig, model, htmlToText(await markdownToHtml(longestPage)));
  await ensureVectorDimensions(dims);

  let imageIndexIdentity: string | null = null;
  let visionModel: ArmRunReport['visionModel'] = opts.armBState?.visionModel ?? null;
  if (arm === 'A') {
    const prepared = await prepareImageIndex(opts.imageEnv!);
    imageIndexIdentity = prepared.identity;
    visionModel = { identity: `eval-image-embedding:${opts.imageEnv!.model}@${opts.imageEnv!.baseUrl}`, model: opts.imageEnv!.model, endpoint: opts.imageEnv!.baseUrl };
    console.log(`image model ${opts.imageEnv!.model} → ${prepared.dimensions} dimensions (${prepared.tier}, ${prepared.indexed ? 'HNSW' : 'no index at this width'})`);
  } else {
    // No image leg on B or C: the assignment is removed so the leg's gate
    // cannot open, whatever a restored database carried.
    await query(`DELETE FROM llm_usecase_assignments WHERE usecase = 'image_embedding'`);
  }

  const fixture = loadImageFixture();
  assertFixturePower(fixture);
  await resetEvalCorpus();

  console.log(`seeding ${manifest.pages.length} image pages (${arm === 'A' ? 'text + image index' : 'text + attachment bytes, no image index'})…`);
  const seeded = await seedImageCorpus(EVAL_USER_ID, {
    imageIndex: arm === 'A',
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) console.log(`  embedded ${done}/${total}`);
    },
  });
  if (seeded.textSkipped.length > 0) {
    throw new Error(`${seeded.textSkipped.length} corpus pages produced no chunks: ${seeded.textSkipped.slice(0, 5).join(', ')}`);
  }
  await assertSeededFtsLanguage(ftsLanguage);
  await recordCorpusLanguage(IMAGE_AXIS_CORPUS_CLAIM);

  const expectedImages = manifest.pages.reduce((n, page) => n + page.images.length, 0);
  let imageAnalysisVersions: ArmRunReport['imageAnalysisVersions'] = null;
  if (arm === 'A') {
    console.log(`indexed ${seeded.imagesEmbedded} images in ${(seeded.imageEmbedWallClockMs / 1000).toFixed(1)}s`);
  } else {
    const rows = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM page_image_embeddings`);
    if ((rows.rows[0]?.n ?? 0) !== 0) {
      throw new Error(`arm ${arm}: page_image_embeddings carries ${rows.rows[0]!.n} rows after a no-image-index seed — this database is not in arm ${arm}'s state`);
    }
    if (arm === 'B') imageAnalysisVersions = await runArmBBackfill(opts.armBState!, expectedImages, opts.backfillTimeoutMs);
    // C's state on the database itself, not only on the top-K each query
    // returns: a derived row outside every window is invisible to the runner.
    if (arm === 'C') await assertArmCState();
  }

  const held = await readHeldFixedProvenance();
  console.log(`rerank ${held.rerank} · answer model ${held.answerModel?.identity ?? 'none assigned'} · knobs ${JSON.stringify(held.retrieval)}`);

  console.log(`running ${fixture.labels.length} queries on arm ${arm}…`);
  const flags = stageFlags();
  const run = await runArmEval(fixture, {
    arm,
    userId: EVAL_USER_ID,
    pageIdByFile: seeded.pageIdByFile,
    topK: Math.max(...TOP_K),
    rerank: flags.rerank,
    assembleContext: flags.assembleContext,
    pinIdentifiers: flags.pinIdentifiers,
    ...(flags.mmr ? { mmr: flags.mmr } : {}),
    onProgress: (done, total) => {
      if (done % 25 === 0 || done === total) console.log(`  queried ${done}/${total}`);
    },
  });
  const queryRuns: QueryRun[] = run.runs.map((r) => ({ queryId: r.queryId, retrieved: r.retrieved, expected: r.expected }));
  const costs = run.runs.map((r) => r.ms);

  return {
    axis: ARM_AXIS,
    arm,
    ...(opts.control ? { control: opts.control } : {}),
    revisionSha: sha,
    command: commandLine(),
    capturedAt: new Date().toISOString(),
    hardware,
    corpusManifestSha: fixture.corpusManifestSha,
    querySetSha: querySetSha(),
    language,
    ftsLanguage,
    embedder: { identity: `eval-embedding:${model}@${evalProviderConfig.baseUrl}`, model, endpoint: evalProviderConfig.baseUrl, dims },
    rerank: held.rerank,
    answerModel: held.answerModel,
    visionModel,
    imageIndexIdentity,
    imageAnalysisMaxOutputTokens: opts.armBState?.imageAnalysisMaxOutputTokens ?? null,
    imageAnalysisVersions,
    retrieval: {
      ...held.retrieval,
      topK: Math.max(...TOP_K),
      rerankRequested: flags.rerank,
      assembleContext: flags.assembleContext,
      pinIdentifiers: flags.pinIdentifiers,
      deepSearch: false,
      mmr: flags.mmr ? `on:${flags.mmr.lambda}` : 'off',
    },
    queries: run.totalQueries,
    vectorParticipatingQueries: run.vectorParticipatingQueries,
    rerankParticipatingQueries: run.rerankParticipatingQueries,
    assemblyParticipatingQueries: run.assemblyParticipatingQueries,
    pinParticipatingQueries: run.pinParticipatingQueries,
    imageEvidenceParticipatingQueries: run.imageEvidenceParticipatingQueries,
    recallAtK: Object.fromEntries(TOP_K.map((k) => [`@${k}`, recallAtK(queryRuns, k)])),
    mrr: meanReciprocalRank(queryRuns),
    imageEvidenceRecallAt5: imageEvidenceRecallAtK(arm, run.runs, 5),
    imageNegativeLeakAt1: imageNegativeLeakAt1(run.runs),
    // `percentile` takes a FRACTION, not a percent (every other caller passes
    // 0.5 / 0.95): `Math.ceil(n * 50) - 1` clamps to the last index, so BOTH
    // fields carried the MAXIMUM query cost and the arm reports captured
    // before this fix record the max twice (#1619).
    queryCostMs: { p50: percentile(costs, 0.5), p95: percentile(costs, 0.95) },
    runs: run.runs,
  };
}

/**
 * The retrieval rows of the ADR endpoint table for a pair of arm reports —
 * McNemar exact on the discordant pairs and the page-cluster bootstrap on
 * every interval. Printed, never gated here: the gate is judge-arms.ts's,
 * where the judged endpoints join these. The legacy-C control paired with
 * the candidate C is printed under its own label: the regression control
 * for #1617's authored-hit change, descriptive only.
 */
function compareArmReports(baseline: ArmRunReport, candidate: ArmRunReport): void {
  const cmp = compareArmRetrieval(baseline, candidate, { seed: 1614 });
  const label = (r: ArmRunReport) => `arm ${r.arm}${r.control ? ` (${r.control})` : ''}`;
  console.log(`\n--- ${label(candidate)} vs ${label(baseline)} (retrieval endpoints, ADR-027) ---`);
  if (cmp.regressionControl) {
    console.log('REGRESSION CONTROL for #1617\'s authored-hit change (ADR-027 "Arms and revisions"): descriptive only — no verdict condition reads this pair, and the control is never substituted for arm C.');
  }
  for (const [k, endpoint] of Object.entries(cmp.recallAt)) {
    for (const line of formatPairedBinary(`Recall${k}`, endpoint)) console.log(line);
  }
  console.log(
    `MRR: ${cmp.mrr.baselineMean.toFixed(4)} → ${cmp.mrr.candidateMean.toFixed(4)} (${cmp.mrr.delta >= 0 ? '+' : ''}${cmp.mrr.delta.toFixed(4)}, ` +
      `cluster-bootstrap 95% CI [${cmp.mrr.ci.lower.toFixed(4)}, ${cmp.mrr.ci.upper.toFixed(4)}] over ${cmp.mrr.ci.clusters} pages)`,
  );
  if (cmp.imageEvidenceRecallAt5) {
    for (const line of formatPairedBinary('image-evidence R@5', cmp.imageEvidenceRecallAt5)) console.log(line);
    console.log(`  guardrail power ≈ ${cmp.imageEvidenceGuardrailPower!.toFixed(2)} at δ = 0 (O5: a pass reads "no collapse", never parity)`);
  } else {
    console.log('image-evidence R@5: none — one side is arm C');
  }
  for (const line of formatPairedBinary('image-negative leakage@1', cmp.leakageAt1)) console.log(line);
  console.log('Verdict: none here — the gate is decided by the un-blind step of judge-arms.ts with the judged endpoints.');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  // Every query the eval runs is recorded through the same analytics path the
  // product uses, and those writes are batched. Closing the pool first makes
  // them fail with a connection timeout AFTER the report has printed — noise
  // that reads like a harness fault.
  .finally(async () => {
    await flushSearchAnalytics().catch(() => {});
    // BOTH pools (review r4): the vector leg runs on its own via
    // getVectorPool, and leaving it open made the process sit for pg's 30s
    // idle timeout after printing the verdict — indistinguishable from a hang
    // at the exact moment the operator is reading the result, and a Ctrl-C
    // there replaces the exit code that carries the regression signal.
    await closeVectorPool().catch(() => {});
    await closePool();
  });
