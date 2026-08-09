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
import { query, closePool, runMigrations } from '../src/core/db/postgres.js';
import { generateEmbedding } from '../src/domains/llm/services/openai-compatible-client.js';
import { loadCorpus, loadFixture, assertFixturePower } from '../src/domains/llm/eval/fixture.js';
import { seedCorpus, ensureVectorDimensions, configureEmbeddingProvider, resetEvalCorpus } from '../src/domains/llm/eval/seed.js';
import { runEval } from '../src/domains/llm/eval/runner.js';
import { flushSearchAnalytics } from '../src/domains/llm/services/rag-service.js';
import { recallAtK, meanReciprocalRank, pairedBootstrapCi, winLoss, type QueryRun } from '../src/domains/llm/eval/metrics.js';

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

async function main(): Promise<void> {
  const baseUrl = process.env.EVAL_EMBEDDING_BASE_URL;
  const model = process.env.EVAL_EMBEDDING_MODEL;
  if (!baseUrl || !model) {
    throw new Error('EVAL_EMBEDDING_BASE_URL and EVAL_EMBEDDING_MODEL are required — the eval never mocks the embedder');
  }
  const outPath = arg('out') ?? 'retrieval-eval.json';

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
  const probe = await generateEmbedding(
    { providerId: 'eval', id: 'eval', name: 'eval', baseUrl, apiKey: null, authType: 'none', verifySsl: true, defaultModel: model },
    model,
    'dimension probe',
  );
  const dims = probe[0]?.length ?? 0;
  console.log(`model ${model} → ${dims} dimensions`);
  await ensureVectorDimensions(dims);

  const corpus = loadCorpus();
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

    console.log('\n--- vs baseline (Recall@5) ---');
    console.log(`delta ${ci.observedDelta >= 0 ? '+' : ''}${ci.observedDelta.toFixed(4)}  95% CI [${ci.lower.toFixed(4)}, ${ci.upper.toFixed(4)}]`);
    console.log(`${table.wins.length} wins · ${table.losses.length} losses · ${table.ties} unchanged`);
    for (const loss of table.losses.slice(0, 10)) {
      console.log(`  LOSS ${loss.queryId}: ${loss.baseline.toFixed(2)} → ${loss.candidate.toFixed(2)}`);
    }
    console.log(
      ci.excludesZero
        ? `\nVERDICT: credible ${ci.observedDelta > 0 ? 'improvement' : 'REGRESSION'} — the interval excludes zero.`
        : '\nVERDICT: no credible change — the interval straddles zero. Per-query movement above is still worth reading.',
    );
    // A credible regression is the only failing verdict: an improvement and a
    // wash both pass, because this gate exists to catch retrieval getting
    // worse, not to demand that every PR make it better.
    if (ci.excludesZero && ci.observedDelta < 0) process.exitCode = 1;
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
    await closePool();
  });
