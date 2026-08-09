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
 * Environment:
 *   EVAL_EMBEDDING_BASE_URL   OpenAI-compatible endpoint (Ollama's /v1 shim works)
 *   EVAL_EMBEDDING_MODEL      model name to embed with
 *   POSTGRES_URL              a database this script may TRUNCATE and RETYPE
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { markdownToHtml, htmlToText } from '../src/core/services/content-converter.js';
import { query, closePool, closeVectorPool, runMigrations } from '../src/core/db/postgres.js';
import { generateEmbedding } from '../src/domains/llm/services/openai-compatible-client.js';
import { loadCorpus, loadFixture, assertFixturePower } from '../src/domains/llm/eval/fixture.js';
import { seedCorpus, ensureVectorDimensions, configureEmbeddingProvider, resetEvalCorpus, assertModelReadsFullChunk } from '../src/domains/llm/eval/seed.js';
import { runEval } from '../src/domains/llm/eval/runner.js';
import { flushSearchAnalytics } from '../src/domains/llm/services/rag-service.js';
import { recallAtK, meanReciprocalRank, pairedBootstrapCi, pairedSignificance, winLoss, type QueryRun } from '../src/domains/llm/eval/metrics.js';

const TOP_K = [1, 3, 5, 10] as const;
const EVAL_USER = 'aaaaaaaa-1102-4000-8000-000000001102';

interface Report {
  model: string;
  corpusManifestSha: string;
  corpusPages: number;
  queries: number;
  vectorParticipatingQueries: number;
  recallAtK: Record<string, number>;
  mrr: number;
  runs: QueryRun[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * This script is DESTRUCTIVE: it truncates pages, page_embeddings,
 * page_relationships and search_analytics, retypes the vector columns and
 * rewrites admin_settings — against whatever POSTGRES_URL names. Prose in a
 * runbook is not a safeguard (review r3), so the database has to opt in by
 * name or by an explicit override.
 *
 * The allow-list is on the DATABASE name rather than the host: a colleague's
 * laptop, a staging box and production all differ in host but the fatal
 * mistake is pointing this at a database that holds real pages.
 */
// Substring, not token-delimited (review r4): the refusal tells the operator to
// use a name containing "eval" or "test", and the first version then refused
// `test`, `testdb` and `eval-db` with that very message — a loop whose only
// exit was the blanket override, which is the wrong habit to teach for a
// destructive script. Widening admits `production_eval`, so the production
// words are refused outright and win over the allow-list.
const DISPOSABLE_DB_PATTERN = /eval|test|scratch|sandbox/i;
const NEVER_DISPOSABLE_PATTERN = /prod|live|main|staging/i;

function assertDisposableDatabase(url: string): void {
  if (process.env.EVAL_ALLOW_DESTRUCTIVE === 'yes-wipe-this-database') return;

  let dbName: string;
  try {
    dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    throw new Error('POSTGRES_URL is not a valid URL — refusing to run a destructive eval against it');
  }

  if (!DISPOSABLE_DB_PATTERN.test(dbName) || NEVER_DISPOSABLE_PATTERN.test(dbName)) {
    throw new Error(
      `Refusing to run: this script TRUNCATES pages, page_embeddings, page_relationships and ` +
        `search_analytics and RETYPES the vector columns, and "${dbName}" does not look disposable. ` +
        `Its name must contain "eval", "test", "scratch" or "sandbox", and must not contain ` +
        `"prod", "live", "main" or "staging". Point POSTGRES_URL at a throwaway database, or set ` +
        `EVAL_ALLOW_DESTRUCTIVE=yes-wipe-this-database if you genuinely mean this one.`,
    );
  }
}

async function main(): Promise<void> {
  const baseUrl = process.env.EVAL_EMBEDDING_BASE_URL;
  const model = process.env.EVAL_EMBEDDING_MODEL;
  if (!baseUrl || !model) {
    throw new Error('EVAL_EMBEDDING_BASE_URL and EVAL_EMBEDDING_MODEL are required — the eval never mocks the embedder');
  }
  const outPath = arg('out') ?? 'retrieval-eval.json';

  assertDisposableDatabase(process.env.POSTGRES_URL ?? '');

  await runMigrations();
  await query(
    `INSERT INTO users (id, username, email, role, password_hash)
     VALUES ($1::uuid, 'eval-runner', 'eval@local', 'admin', 'x') ON CONFLICT (id) DO NOTHING`,
    [EVAL_USER],
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

  const corpus = loadCorpus();

  // Before anything is embedded: a model that truncates would produce a
  // confident score describing the prefix it happened to read. Probed with the
  // corpus's OWN text, whose token density is what a real chunk carries.
  const longestPage = corpus.reduce((a, b) => (b.markdown.length > a.markdown.length ? b : a));
  await assertModelReadsFullChunk(evalProviderConfig, model, htmlToText(await markdownToHtml(longestPage.markdown)));

  await ensureVectorDimensions(dims);
  const fixture = loadFixture(JSON.parse(readFileSync(new URL('../src/domains/llm/eval/fixture.json', import.meta.url), 'utf8')), corpus);
  assertFixturePower(fixture);

  // Before seeding, not after: a leftover corpus from a previous run would
  // double every page and halve recall.
  await resetEvalCorpus();

  console.log(`seeding ${corpus.length} pages…`);
  const seeded = await seedCorpus(EVAL_USER, {
    corpus,
    onProgress: (done, total) => {
      if (done % 25 === 0 || done === total) console.log(`  embedded ${done}/${total}`);
    },
  });
  if (seeded.skipped.length > 0) {
    throw new Error(`${seeded.skipped.length} corpus pages produced no chunks: ${seeded.skipped.slice(0, 5).join(', ')}`);
  }

  console.log(`running ${fixture.labels.length} queries…`);
  const { runs, vectorParticipatingQueries } = await runEval(fixture, {
    userId: EVAL_USER,
    pageIdByFile: seeded.pageIdByFile,
    topK: Math.max(...TOP_K),
  });

  const report: Report = {
    model,
    corpusManifestSha: fixture.corpusManifestSha,
    corpusPages: corpus.length,
    queries: runs.length,
    vectorParticipatingQueries,
    recallAtK: Object.fromEntries(TOP_K.map((k) => [`@${k}`, recallAtK(runs, k)])),
    mrr: meanReciprocalRank(runs),
    runs,
  };
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log('\n--- retrieval eval ---');
  for (const k of TOP_K) console.log(`Recall@${k}: ${report.recallAtK[`@${k}`]!.toFixed(4)}`);
  console.log(`MRR:       ${report.mrr.toFixed(4)}`);
  console.log(`vector leg participated in ${vectorParticipatingQueries}/${runs.length} queries`);

  const baselinePath = arg('baseline');
  if (baselinePath) {
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Report;
    if (baseline.corpusManifestSha !== report.corpusManifestSha) {
      throw new Error('Baseline was measured against a different corpus — the comparison would be meaningless');
    }
    if (baseline.model !== report.model) {
      throw new Error(`Baseline used model ${baseline.model}, this run used ${report.model} — this gate compares retrieval logic, not models (see #1113 for model comparisons)`);
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
