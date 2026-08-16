/**
 * #1114 — query-time latency under concurrency, for the Qwen3-Embedding-4B
 * decision.
 *
 * The epic's open item was "what does 2560 cost at query time when several
 * people ask at once", and nothing that existed could answer it: the retrieval
 * eval's report carries no timing field, `runner.ts` is strictly sequential
 * (its participation floors assume exactly one hit per query, which is why this
 * script lives OUTSIDE `eval/` rather than growing a concurrency flag there),
 * and `rag-service.ts` puts no timer around the embedding call.
 *
 * Two halves, either or both:
 *
 *   --mode embedding   POST {base-url}/v1/embeddings per query, at each
 *                      concurrency level. The query text is formatted exactly
 *                      as production formats it, so Qwen3 pays for its Instruct
 *                      preamble. Touches no database.
 *   --mode search      hybridSearch() end to end, the way runner.ts calls it
 *                      (rerank off, sibling assembly on, identifier pinning
 *                      on), timed per call. NEVER writes: no reseed, no
 *                      analytics rows (recordAnalytics: false).
 *
 * The search half REQUIRES the database to be seeded for the model already —
 * seeding is an hour of embedding and destroys the corpus you may have just
 * measured. It refuses instead: it probes the model's vector width, reads
 * page_embeddings' live width from the catalog, and stops if they differ.
 *
 * Non-destructive by construction, but it still runs `assertDisposableDatabase`
 * — the only database that carries an eval corpus is the disposable one, and a
 * pointer at production here means the URL is wrong, not that the run is safe.
 *
 *   cd backend
 *   export POSTGRES_URL=postgresql://kb_user:pw@localhost:5433/kb_eval
 *   export EVAL_EMBEDDING_BASE_URL=http://localhost:1234/v1
 *   npx tsx scripts/benchmark-query-latency.ts \
 *     --models text-embedding-bge-m3 --concurrency 1,4,8 --out /tmp/bge.json
 *
 * Do not touch the model server during a run: loading a second model evicts the
 * one being measured and every number after that point is a cold start.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { query, closePool, closeVectorPool } from '../src/core/db/postgres.js';
import { hybridSearch, flushSearchAnalytics } from '../src/domains/llm/services/rag-service.js';
import { getFtsLanguage } from '../src/core/services/fts-language.js';
import { assertDisposableDatabase } from '../src/domains/llm/eval/disposable-db.js';
import { EVAL_USER_ID } from '../src/domains/llm/eval/seed.js';
import { FixtureSchema } from '../src/domains/llm/eval/fixture.js';
import {
  parseBenchmarkArgs,
  sampleQueries,
  summarizeLatencies,
  timeConcurrently,
  timeEmbeddingCalls,
  probeEmbeddingDimensions,
  assertProbeMatchesColumn,
  formatBenchmarkTable,
  type BenchmarkReport,
  type BenchmarkRow,
} from '../src/domains/llm/eval/query-latency.js';

/** The width the chat path retrieves at; matched so the number means something. */
const TOP_K = 5;

interface ColumnShape {
  columnType: string;
  dims: number;
}

async function readEmbeddingColumn(): Promise<ColumnShape> {
  const r = await query<{ column_type: string; atttypmod: number }>(
    `SELECT format_type(atttypid, atttypmod) AS column_type, atttypmod
       FROM pg_attribute
      WHERE attrelid = 'page_embeddings'::regclass AND attname = 'embedding'`,
  );
  const row = r.rows[0];
  if (!row) throw new Error('page_embeddings.embedding does not exist — is this database migrated?');
  return { columnType: row.column_type, dims: row.atttypmod < 0 ? 0 : row.atttypmod };
}

/**
 * The search half measures a seeded corpus through the product's own ACL
 * predicates, so both the corpus and the user it was seeded under have to be
 * there. Empty means "run-retrieval-eval.ts has not run here", which would
 * otherwise show up as a suspiciously fast search over nothing.
 */
async function assertSeededCorpus(): Promise<number> {
  const user = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM users WHERE id = $1::uuid`, [EVAL_USER_ID]);
  const pages = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pages WHERE deleted_at IS NULL`);
  const chunks = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM page_embeddings`);
  if (user.rows[0]!.n === 0 || pages.rows[0]!.n === 0 || chunks.rows[0]!.n === 0) {
    throw new Error(
      `This database is not seeded for a search run (eval user: ${user.rows[0]!.n}, pages: ${pages.rows[0]!.n}, `
      + `chunks: ${chunks.rows[0]!.n}). The search half deliberately does not seed — run `
      + 'scripts/run-retrieval-eval.ts for the model you want to time, then run this against the result.',
    );
  }
  return pages.rows[0]!.n;
}

function loadQueries(lang: string, count: number): string[] {
  const file = lang === 'en' ? 'fixture.json' : `fixture-${lang}.json`;
  const raw = JSON.parse(readFileSync(new URL(`../src/domains/llm/eval/${file}`, import.meta.url), 'utf8'));
  // Parsed, not trusted: a fixture edit that breaks the shape should fail here
  // rather than produce a benchmark over `undefined`.
  const fixture = FixtureSchema.parse(raw);
  return sampleQueries(fixture.labels, count).map((label) => label.query);
}

async function main(): Promise<void> {
  const config = parseBenchmarkArgs(process.argv.slice(2), process.env);
  const needsDb = config.mode !== 'embedding';

  const queries = loadQueries(config.lang, config.queries);
  console.log(
    `benchmarking ${config.models.length} model(s) × concurrency ${config.concurrency.join(',')} `
    + `over ${queries.length} ${config.lang} queries · mode ${config.mode}`,
  );

  // An embedding-only run reads no database, and says so rather than printing
  // a plausible-looking default it never checked.
  let ftsLanguage = 'n/a (no database read)';
  let column: ColumnShape = { columnType: 'n/a (no database read)', dims: 0 };

  if (needsDb) {
    assertDisposableDatabase(process.env.POSTGRES_URL ?? '');
    const pages = await assertSeededCorpus();
    column = await readEmbeddingColumn();
    ftsLanguage = await getFtsLanguage();
    console.log(
      `corpus ${pages} pages · index ${column.columnType} · fts ${ftsLanguage} `
      + '· pipeline: hybrid, rerank off, assembly on, identifier pinning on',
    );

    // Fail fast, before an hour of embedding: every model has to match the one
    // index this database carries.
    for (const model of config.models) {
      const probeDims = await probeEmbeddingDimensions({ baseUrl: config.baseUrl, model });
      assertProbeMatchesColumn({ model, probeDims, columnDims: column.dims, columnType: column.columnType });
    }
  }

  const results: BenchmarkRow[] = [];
  let deadVectorLeg = false;

  for (const model of config.models) {
    for (const concurrency of config.concurrency) {
      const row: BenchmarkRow = { model, concurrency };

      if (config.mode !== 'search') {
        const samples = await timeEmbeddingCalls({ baseUrl: config.baseUrl, model, queries, concurrency });
        row.embedding = summarizeLatencies(samples);
      }

      if (config.mode !== 'embedding') {
        let vectorParticipating = 0;
        // `counted` is false for the warm-up: a participation count that
        // included discarded calls would read as more queries than the arm
        // measured, which is a confusing way to state a health check.
        const call = (q: string, counted: boolean) => async (): Promise<void> => {
          const hits = await hybridSearch(EVAL_USER_ID, q, TOP_K, undefined, {
            rerank: false,
            assembleContext: true,
            pinIdentifiers: true,
            // Never write: this is a measurement, and a replayed fixture query
            // is not a question anybody asked.
            recordAnalytics: false,
          });
          if (counted && hits.some((hit) => hit.vectorScore !== null)) vectorParticipating += 1;
        };
        const samples = await timeConcurrently(
          queries.map((q) => call(q, true)),
          concurrency,
          queries.slice(0, Math.min(concurrency, 3)).map((q) => call(q, false)),
        );
        row.search = summarizeLatencies(samples);
        row.searchVectorParticipatingQueries = vectorParticipating;
        // hybridSearch swallows an embedding failure into keyword-only and
        // still returns results, so a dead vector leg looks like a fast search
        // rather than a broken one — runner.ts's lesson, arriving through the
        // timing door.
        if (vectorParticipating === 0) deadVectorLeg = true;
      }

      results.push(row);
      console.log(`  ${model} @${concurrency}: ${JSON.stringify({ embedding: row.embedding, search: row.search })}`);
    }
  }

  const report: BenchmarkReport = {
    metadata: {
      baseUrl: config.baseUrl,
      lang: config.lang,
      ftsLanguage,
      columnType: column.columnType,
      dims: column.dims,
      queries: queries.length,
      mode: config.mode,
      generatedAt: new Date().toISOString(),
    },
    results,
  };
  writeFileSync(config.outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`\n${formatBenchmarkTable(report)}`);
  console.log(`\nwrote ${config.outPath}`);

  if (deadVectorLeg) {
    console.error(
      '\nREFUSING to publish this search timing: the vector leg participated in 0 queries, so what was '
      + 'measured is Postgres FTS with a dead vector leg. Check the embedding use-case assignment in this '
      + 'database and that the provider endpoint is reachable.',
    );
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // recordAnalytics is off for every call above, so there should be nothing
    // to flush — draining anyway keeps the shutdown identical to the eval's,
    // whose comment explains why the order matters.
    await flushSearchAnalytics().catch(() => {});
    await closeVectorPool().catch(() => {});
    await closePool().catch(() => {});
  });
