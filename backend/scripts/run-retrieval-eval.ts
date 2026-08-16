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
 *
 * `--help` prints the full list (EVAL_USAGE in eval/cli-flags.ts), and an
 * unrecognised flag is refused rather than ignored — a typo'd --fts-langauge
 * used to cost an hour of embedding under the default configuration.
 *
 * Environment:
 *   EVAL_EMBEDDING_BASE_URL   OpenAI-compatible endpoint (Ollama's /v1 shim works)
 *   EVAL_EMBEDDING_MODEL      model name to embed with
 *   POSTGRES_URL              a database this script may TRUNCATE and RETYPE
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { markdownToHtml, htmlToText } from '../src/core/services/content-converter.js';
import { query, closePool, closeVectorPool, runMigrations } from '../src/core/db/postgres.js';
import { generateEmbedding } from '../src/domains/llm/services/openai-compatible-client.js';
import { loadCorpus, loadFixture, assertFixturePower, corpusDirsForLanguage } from '../src/domains/llm/eval/fixture.js';
import { seedCorpus, ensureVectorDimensions, configureEmbeddingProvider, resetEvalCorpus, assertModelReadsFullChunk, configureFtsLanguage, assertSeededFtsLanguage, recordCorpusLanguage, EVAL_USER_ID } from '../src/domains/llm/eval/seed.js';
import { assertDisposableDatabase } from '../src/domains/llm/eval/disposable-db.js';
import { assertKnownFlags, flagValue, wantsHelp, EVAL_KNOWN_FLAGS, EVAL_USAGE, EVAL_VALUELESS_FLAGS } from '../src/domains/llm/eval/cli-flags.js';
import { parseFtsLanguageArg, assertComparableFtsLanguage } from '../src/domains/llm/eval/fts-config.js';
import { runEval } from '../src/domains/llm/eval/runner.js';
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
  recallAtK: Record<string, number>;
  mrr: number;
  runs: QueryRun[];
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

  const baseUrl = process.env.EVAL_EMBEDDING_BASE_URL;
  const model = process.env.EVAL_EMBEDDING_MODEL;
  if (!baseUrl || !model) {
    throw new Error('EVAL_EMBEDDING_BASE_URL and EVAL_EMBEDDING_MODEL are required — the eval never mocks the embedder');
  }
  const outPath = arg('out') ?? 'retrieval-eval.json';
  // Parsed before anything touches the database, so a typo costs nothing.
  // Default 'simple' for EVERY language — never derived from --lang; see
  // fts-config.ts for why the two are separate choices.
  const ftsLanguage = parseFtsLanguageArg(process.argv);

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

  // #1114: --lang de measures the translated corpus instead of the English
  // one. It is a separate measurement with its own fixture, never a variant
  // of the English gate — see corpusDirsForLanguage.
  const langArg = arg('lang');
  const language = langArg && langArg !== 'en' ? langArg : 'en';
  const corpusDirs = corpusDirsForLanguage(language);
  const fixtureFile = language === 'en' ? 'fixture.json' : `fixture-${language}.json`;
  if (language !== 'en') console.log(`language: ${language} (corpus ${corpusDirs.join(', ')}, fixture ${fixtureFile})`);
  console.log(`fts configuration: ${ftsLanguage}`);

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
  const { runs, vectorParticipatingQueries, rerankParticipatingQueries, assemblyParticipatingQueries, pinParticipatingQueries, expansionParticipatingQueries, expansionSkippedQueries, redundantSlots, returnedSlots, meanPairwiseSimilarity } = await runEval(fixture, {
    userId: EVAL_USER_ID,
    pageIdByFile: seeded.pageIdByFile,
    topK: Math.max(...TOP_K),
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
    // a `chat` use-case assignment, and runEval refuses the run rather than
    // reporting plain retrieval under a deep label if it never fires.
    deepSearch: process.argv.includes('--deep-search'),
    ...(process.argv.includes('--mmr')
      ? { mmr: { enabled: true, lambda: Number(arg('mmr-lambda') ?? '0.5') } }
      : {}),
  });

  const rerankRequested = process.argv.includes('--rerank');
  const deepRequested = process.argv.includes('--deep-search');
  const report: Report = {
    model,
    language,
    ftsLanguage,
    corpusManifestSha: fixture.corpusManifestSha,
    redundantSlots,
    returnedSlots,
    meanPairwiseSimilarity,
    corpusPages: corpus.length,
    assembleContext: !process.argv.includes('--no-assemble'),
    assemblyParticipatingQueries,
    pinIdentifiers: !process.argv.includes('--no-pin'),
    pinParticipatingQueries,
    deepSearch: deepRequested,
    expansionParticipatingQueries,
    expansionSkippedQueries,
    queries: runs.length,
    vectorParticipatingQueries,
    rerank: rerankRequested,
    rerankParticipatingQueries,
    recallAtK: Object.fromEntries(TOP_K.map((k) => [`@${k}`, recallAtK(runs, k)])),
    mrr: meanReciprocalRank(runs),
    runs,
  };
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log('\n--- retrieval eval ---');
  // Named on the results header, not only at startup: this line is what gets
  // pasted into an issue, and a German score under a 'simple' stemmer is
  // exactly the number #1114 had to go back and re-measure.
  console.log(`corpus ${report.language} · fts ${report.ftsLanguage} · model ${report.model}`);
  for (const k of TOP_K) console.log(`Recall@${k}: ${report.recallAtK[`@${k}`]!.toFixed(4)}`);
  console.log(`MRR:       ${report.mrr.toFixed(4)}`);
  console.log(
    `redundant slots: ${report.redundantSlots}/${report.returnedSlots}` +
    ` (${((100 * (report.redundantSlots ?? 0)) / Math.max(1, report.returnedSlots ?? 1)).toFixed(2)}%)` +
    ` | mean pairwise similarity ${(report.meanPairwiseSimilarity ?? 0).toFixed(4)}`,
  );
  console.log(`vector leg participated in ${vectorParticipatingQueries}/${runs.length} queries`);
  if (rerankRequested) {
    console.log(`rerank stage participated in ${rerankParticipatingQueries}/${runs.length} queries`);
  }
  if (deepRequested) {
    console.log(
      `query expansion participated in ${expansionParticipatingQueries}/${runs.length} queries` +
      ` (${expansionSkippedQueries} skipped by design)`,
    );
  }

  const baselinePath = arg('baseline');
  if (baselinePath) {
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Report;
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

    const scoreOne = (r: QueryRun) => recallAtK([r], 5);
    const ci = pairedBootstrapCi(baseline.runs, runs, scoreOne, { seed: 1102 });
    const table = winLoss(baseline.runs, runs, scoreOne);
    const verdict = pairedSignificance(baseline.runs, runs, scoreOne);

    console.log('\n--- vs baseline (Recall@5) ---');
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
