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
 * Environment:
 *   EVAL_EMBEDDING_BASE_URL   OpenAI-compatible endpoint (Ollama's /v1 shim works)
 *   EVAL_EMBEDDING_MODEL      model name to embed with
 *   POSTGRES_URL              a database this script may TRUNCATE and RETYPE
 *
 * With --images, additionally (see eval/images-axis.ts for why these are their
 * OWN variables and never fall back to the text pair):
 *   EVAL_IMAGE_EMBEDDING_BASE_URL   the vision-language endpoint, with its /v1
 *   EVAL_IMAGE_EMBEDDING_MODEL      the VL model id
 *   EVAL_IMAGE_EMBEDDING_DIMENSIONS optional MRL truncation width
 *   EVAL_IMAGE_EMBEDDING_BACKEND    optional provenance label for the report
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
import { IMAGE_AXIS, IMAGE_AXIS_CORPUS_CLAIM, TEXT_AXIS, assertComparableAxis, assertComparableImageModel, assertImageAxisStagesPairable, parseImageAxisLanguage, readImageAxisEnv, wantsImageAxis, type EvalAxis, type ImageAxisEnv } from '../src/domains/llm/eval/images-axis.js';
import { runEval } from '../src/domains/llm/eval/runner.js';
import { runImageEval } from '../src/domains/llm/eval/runner-images.js';
import { armRuns } from '../src/domains/llm/eval/images-metrics.js';
import { buildImageAxisReport, formatImageAxisVerdict, type ImageAxisReport } from '../src/domains/llm/eval/images-report.js';
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
  const imageEnv = imageAxis ? readImageAxisEnv() : null;
  const outPath = arg('out') ?? 'retrieval-eval.json';
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
    `(${seeded.throughputImagesPerSec.toFixed(2)} images/s)`,
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
