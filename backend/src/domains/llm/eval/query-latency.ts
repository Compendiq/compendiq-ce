/**
 * #1114 — query-time latency, measured under concurrency.
 *
 * The quality eval cannot answer this and was never going to: its report
 * carries no timing field at all, `runner.ts` is strictly sequential by
 * design (its participation floors assume exactly one hit per query), and
 * `rag-service.ts` puts no timer around the embedding call. So "is 2560-dim
 * Qwen3 fast enough at query time when four people ask at once" had no
 * measurement behind it.
 *
 * This module is the pure half of `scripts/benchmark-query-latency.ts`:
 * argument parsing, deterministic sampling, the concurrency harness, the
 * percentile arithmetic and the refusal that stops a search arm from being run
 * against an index built for a different model. The script keeps the parts that
 * need a live database or a live provider.
 *
 * Two rules the numbers depend on:
 *
 * - **The embedding half formats the query exactly as production would**, via
 *   `formatQueryForEmbedding`. Qwen3 pays for its Instruct preamble on every
 *   query; a benchmark that skipped it would measure a request the product
 *   never sends and flatter the model this epic is deciding about.
 * - **Warm-up is issued and discarded.** The first call into a cold model
 *   server includes load time, which is a one-off startup cost and not what a
 *   per-query p95 means.
 */
import pLimit from 'p-limit';
import { formatQueryForEmbedding } from '../services/query-instruction.js';
import { assertKnownFlags, flagValue, wantsHelp } from './cli-flags.js';
import { IMAGE_AXIS_CORPUS_CLAIM } from './images-axis.js';
import { percentile, round } from './latency-stats.js';

// Re-exported so this module stays the benchmark's single import surface; the
// definitions themselves are shared with production-benchmark.ts, because two
// copies of one percentile rule is how two "p95" figures stop meaning the same
// thing (review r2).
export { percentile, wantsHelp };

/**
 * The two LM Studio model ids the #1114 comparison is between — the live
 * 1024-dim bge-m3 and the candidate 2560-dim Qwen3.
 */
export const DEFAULT_LATENCY_MODELS = [
  'text-embedding-bge-m3',
  'text-embedding-qwen3-embedding-4b',
] as const;

export type BenchmarkMode = 'embedding' | 'search' | 'both';
const MODES: readonly BenchmarkMode[] = ['embedding', 'search', 'both'];
const LANGS = ['en', 'de'] as const;

/**
 * Every flag this script understands. An unrecognised `--flag` is refused
 * rather than ignored: a typo'd `--concurency` would otherwise run the default
 * ladder and publish a report describing a run nobody asked for.
 */
export const KNOWN_FLAGS = [
  'base-url', 'models', 'concurrency', 'queries', 'lang', 'mode', 'out', 'help',
] as const;

/**
 * The switches: read as bare flags, never for a value, so `--help=1` must be
 * refused rather than accepted and dropped. Every other flag here carries one.
 */
export const VALUELESS_FLAGS = ['help'] as const;

/**
 * The flag reference, printed by `--help` and quoted into the unknown-flag
 * refusal. It lives here rather than in the script so a test can hold it to
 * naming every flag in `KNOWN_FLAGS` with its default — a flag added without a
 * line here is a flag only the source explains.
 */
export const BENCHMARK_USAGE = [
  'scripts/benchmark-query-latency.ts — query-time latency under concurrency (#1114)',
  '',
  `  --base-url <url>     embedding endpoint (default: $EVAL_EMBEDDING_BASE_URL; there is no built-in default).`,
  '                       Spelled exactly as the provider row is: the request goes to <base-url>/embeddings,',
  '                       which is what generateEmbedding does — nothing here guesses a /v1 for you.',
  `  --models a,b         model ids for the EMBEDDING half (default: ${DEFAULT_LATENCY_MODELS.join(',')}).`,
  '                       --mode search and --mode both take exactly ONE model: the search half reads its',
  '                       model from the seeded database, so a second id would be a label with no',
  '                       measurement behind it.',
  '  --concurrency 1,4,8  in-flight requests per rung (default: 1,4,8)',
  '  --queries N          questions sampled deterministically from the fixture (default: 40)',
  '  --lang en|de         which FIXTURE the questions come from (default: en). It does NOT choose the',
  '                       corpus — that is whatever run-retrieval-eval.ts last seeded here.',
  '  --mode <m>           embedding | search | both (default: both)',
  '  --out <file>         report path (default: query-latency.json)',
  '  --help               this text',
  '',
  'A value flag takes either spelling — "--out report.json" or "--out=report.json" — and is refused if',
  'given without a value, rather than falling back to a default nobody typed.',
  '',
  'The search half never seeds: point POSTGRES_URL at a database run-retrieval-eval.ts has already',
  'seeded for the model you want to time. Do not touch the model server during a run — loading a',
  'second model evicts the one being measured and every number after that is a cold start.',
].join('\n');

export interface BenchmarkConfig {
  baseUrl: string;
  models: string[];
  concurrency: number[];
  queries: number;
  lang: string;
  mode: BenchmarkMode;
  outPath: string;
}

export interface LatencySummary {
  n: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
}

export interface BenchmarkRow {
  model: string;
  concurrency: number;
  embedding?: LatencySummary;
  search?: LatencySummary;
  /**
   * Search arms only. `hybridSearch` swallows an embedding failure into a
   * warning and returns keyword-only results, so a dead vector leg reads as a
   * *fast* search rather than a broken one — the timing-side form of the lie
   * `runner.ts`'s participation guard exists for. Recorded per arm so a report
   * can be read without re-running it.
   */
  searchVectorParticipatingQueries?: number;
}

export interface BenchmarkMetadata {
  baseUrl: string;
  lang: string;
  /**
   * Read from `admin_settings` and printed, never chosen here: a search-half
   * number is only interpretable beside the lexical configuration its keyword
   * leg ran under — which is the whole reason #1114's German numbers had to be
   * re-measured.
   */
  ftsLanguage: string;
  columnType: string;
  dims: number;
  queries: number;
  mode: BenchmarkMode;
  generatedAt: string;
  /**
   * Search arms only, and the reason they exist: `hybridSearch` takes no model
   * and no endpoint — `rag-service` resolves both from the database's
   * `embedding` use-case assignment. `--models` and `--base-url` describe the
   * EMBEDDING half. Recording what the database resolved is what stops a
   * search row claiming a model it did not run; the script also refuses an arm
   * whose flags disagree with these.
   */
  searchModel?: string;
  searchBaseUrl?: string;
  /**
   * The corpus `run-retrieval-eval.ts` last seeded here, recorded at seed time.
   * `--lang` chooses the question set only, so this is the field that says
   * which corpus the questions were asked of. `null` means the database was
   * seeded before that was recorded.
   */
  corpusLanguage?: string | null;
  /**
   * The two ceilings that dominate the search half above ~4 in flight, so a
   * report from one box can be compared with a report from another.
   * `llmConcurrency` is the shared LLM queue's width (`LLM_CONCURRENCY`,
   * default 4) — every search call's embedding goes through it, so a rung
   * above it measures the product's own serialisation, not N-way parallelism.
   * `vectorPoolMax` is `PG_VECTOR_POOL_MAX` (default 5), the vector leg's
   * connection ceiling.
   */
  llmConcurrency?: number;
  vectorPoolMax?: number;
  /**
   * Search arms only — the HNSW scan depth the vector leg ran at, and where it
   * came from.
   *
   * Before #1285 the floor was `process.env.RAG_EF_SEARCH`, read once at module
   * load: visible in the shell that launched this script, constant for the life
   * of the process, and defaulting to 100. It is now
   * `admin_settings.rag_ef_search` in whatever database `POSTGRES_URL` points
   * at, so two runs of this script labelled identically can measure different
   * scan depths over the same corpus — and the panel's own copy puts that swing
   * at 0.39 ms per probe at 100 against 1.74 ms at 1000, on exactly the
   * quantity published here. `ragEfSearchSource` distinguishes a saved row from
   * the deprecated variable and from the unconfigured default, because "100"
   * arrived at three different ways is three different claims about the
   * instance.
   *
   * This is the same rule `assertSeededFtsLanguage` serves and one read-only
   * `SELECT`, so it keeps the script non-destructive.
   */
  ragEfSearch?: number;
  ragEfSearchSource?: 'row' | 'env' | 'default';
  /**
   * Always true when the embedding half ran, and stated rather than implied:
   * the embedding half POSTs directly, bypassing that same queue, so the two
   * halves of one row at concurrency 8 are NOT under the same in-flight load.
   */
  embeddingQueueBypassed?: boolean;
}

export interface BenchmarkReport {
  metadata: BenchmarkMetadata;
  results: BenchmarkRow[];
}

export function summarizeLatencies(samples: readonly number[]): LatencySummary {
  if (samples.length === 0) return { n: 0, meanMs: 0, p50Ms: 0, p95Ms: 0 };
  const total = samples.reduce((sum, value) => sum + value, 0);
  return {
    n: samples.length,
    meanMs: round(total / samples.length),
    p50Ms: round(percentile(samples, 0.5)),
    p95Ms: round(percentile(samples, 0.95)),
  };
}

export function parseBenchmarkArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): BenchmarkConfig {
  assertKnownFlags(argv, KNOWN_FLAGS, BENCHMARK_USAGE, VALUELESS_FLAGS);

  // `??`, not `||` (review r3): flagValue now refuses a valueless flag rather
  // than answering '', so the environment is a fallback for an ABSENT
  // --base-url only. It used to also absorb a `--base-url` whose value went
  // missing, which points a run at one endpoint under a command line naming
  // another — and --out did the same over the report path.
  const baseUrl = flagValue(argv, 'base-url') ?? env.EVAL_EMBEDDING_BASE_URL;
  if (!baseUrl) {
    throw new Error(
      'No embedding endpoint: pass --base-url or set EVAL_EMBEDDING_BASE_URL (e.g. http://localhost:1234/v1). '
      + 'There is no sensible default — the whole point is to measure the server you actually serve from.',
    );
  }

  const modelsRaw = flagValue(argv, 'models');
  const models = modelsRaw === undefined
    ? [...DEFAULT_LATENCY_MODELS]
    : modelsRaw.split(',').map((m) => m.trim()).filter(Boolean);
  if (models.length === 0) {
    throw new Error('--models needs at least one model id, comma-separated');
  }

  const concurrencyRaw = flagValue(argv, 'concurrency');
  const concurrency = concurrencyRaw === undefined
    ? [1, 4, 8]
    : [...new Set(concurrencyRaw.split(',').map((c) => c.trim()).filter(Boolean).map((c) => {
      const n = Number(c);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`--concurrency takes positive integers, comma-separated; got "${c}"`);
      }
      return n;
    }))].sort((a, b) => a - b);
  if (concurrency.length === 0) {
    throw new Error('--concurrency needs at least one positive integer, comma-separated');
  }

  const queriesRaw = flagValue(argv, 'queries');
  const queries = queriesRaw === undefined ? 40 : Number(queriesRaw);
  if (!Number.isInteger(queries) || queries < 1) {
    throw new Error(`--queries takes a positive integer; got "${queriesRaw}"`);
  }

  const lang = flagValue(argv, 'lang') ?? 'en';
  if (!(LANGS as readonly string[]).includes(lang)) {
    throw new Error(`--lang must be one of ${LANGS.join(', ')}; got "${lang}"`);
  }

  const mode = (flagValue(argv, 'mode') ?? 'both') as BenchmarkMode;
  if (!MODES.includes(mode)) {
    throw new Error(`--mode must be one of ${MODES.join(', ')}; got "${mode}"`);
  }

  // The search half is not parameterised by --models at all: `hybridSearch`
  // takes no model, and `rag-service` resolves one from the database's
  // `embedding` assignment. Two ids under a search mode therefore produce two
  // differently-labelled rows measuring the same thing — and the default pair
  // (1024-dim bge-m3, 2560-dim Qwen3) cannot even both match one seeded index.
  // One arm per seeding, said here rather than discovered from a table.
  if (mode !== 'embedding' && models.length !== 1) {
    throw new Error(
      `--mode ${mode} runs the search half, which reads its embedding model from the seeded database's `
      + `'embedding' use-case assignment — never from --models. `
      + (modelsRaw === undefined
        ? `Name the one model this database was seeded for: --models <id>`
        : `Got ${models.length} (${models.join(', ')}); name exactly one — one arm per seeding`)
      + '. Use --mode embedding to sweep several models against the endpoint directly.',
    );
  }

  return {
    baseUrl,
    models,
    concurrency,
    queries,
    lang,
    mode,
    outPath: flagValue(argv, 'out') ?? 'query-latency.json',
  };
}

/**
 * A deterministic, evenly-spaced sample of the fixture.
 *
 * Evenly spaced rather than a head slice or a seeded shuffle: the fixture is
 * grouped by query style, so the first 40 labels are one shape and would
 * benchmark one kind of question. Deterministic so two arms of a comparison
 * time the same questions — a latency difference must come from the model, not
 * from one arm drawing shorter queries.
 */
export function sampleQueries<T>(labels: readonly T[], n: number): T[] {
  if (n >= labels.length) return [...labels];
  return Array.from({ length: n }, (_, i) => labels[Math.floor((i * labels.length) / n)]!);
}

/**
 * The embeddings endpoint for a base URL: exactly what `generateEmbedding`
 * does with a provider row, which is `${cfg.baseUrl}/embeddings` and no
 * normalisation at all.
 *
 * It used to guess: a base URL without `/v1` was rewritten to
 * `${host}/v1/embeddings`. That guess is not the product's behaviour, and it
 * cost twice (review r3). The embedding half timed a URL the product would
 * never call for such a row — so the number described a different request —
 * and `assertSearchArmMatchesAssignment` compared its two endpoints *through*
 * this function, so a `/v1` arm passed against an assignment pointing at the
 * bare host, whose search half then embedded somewhere else. `--base-url` is
 * the spelling that goes into `llm_providers.base_url` verbatim when
 * `run-retrieval-eval.ts` seeds; the spelling that works there is the one that
 * has to work here.
 *
 * Trailing slashes are trimmed, and only that: `http://h/v1/` and `http://h/v1`
 * are the same endpoint to every server, and the assignment check needs the two
 * spellings not to read as a mismatch.
 */
export function embeddingsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/embeddings`;
}

/**
 * Refuse a search arm whose model does not match the seeded index.
 *
 * The failure is silent otherwise: `hybridSearch` swallows any embedding
 * failure into `logger.warn` and returns keyword-only results, so an arm run
 * against the wrong index publishes a confident "search latency" that is
 * Postgres FTS with a dead vector leg — the same class of lie `runner.ts`'s
 * participation guards exist for, arriving through the timing door instead of
 * the quality one.
 */
export function assertProbeMatchesColumn(opts: {
  model: string;
  probeDims: number;
  columnDims: number;
  columnType: string;
}): void {
  if (opts.probeDims === opts.columnDims) return;
  throw new Error(
    `Model "${opts.model}" returns ${opts.probeDims}-dimensional vectors but page_embeddings.embedding is `
    + `${opts.columnType} (${opts.columnDims}) — this database was seeded for a different model. `
    + 'The search half deliberately does NOT reseed (that would take an hour and destroy the corpus you '
    + 'just measured), and hybridSearch degrades to keyword-only on an embedding failure rather than '
    + 'erroring, so this arm would report FTS latency as retrieval latency. Seed this model first with '
    + 'scripts/run-retrieval-eval.ts, or pass --mode embedding to skip the search half.',
  );
}

/**
 * Refuse a search arm whose flags describe a different model or endpoint from
 * the one the database will actually use.
 *
 * `hybridSearch(userId, question, …)` takes neither a model nor a base URL:
 * `rag-service` calls `resolveUsecase('embedding')` and embeds at whatever
 * provider row that resolves to — the row `run-retrieval-eval.ts` wrote when it
 * last seeded. So `--models` and `--base-url` describe the EMBEDDING half only,
 * and a row labelled with them can silently attribute one model's latency to
 * another. The width probe cannot catch it: two 1024-dim models pass it, and it
 * says nothing about the endpoint at all.
 *
 * This is the same failure class as #1114's own: a published number whose
 * configuration nobody recorded. The report records the resolved pair; this
 * refuses the case where recording it would contradict the label.
 */
export function assertSearchArmMatchesAssignment(opts: {
  model: string;
  baseUrl: string;
  assignedModel: string;
  assignedBaseUrl: string;
}): void {
  const sameModel = opts.model === opts.assignedModel;
  // Through the same spelling rule the requests use — which is now the
  // product's own, so the only difference it forgives is a trailing slash. It
  // forgave a missing `/v1` while that was guessed, which admitted a pair
  // pointing at two genuinely different endpoints (review r3).
  const sameEndpoint = embeddingsUrl(opts.baseUrl) === embeddingsUrl(opts.assignedBaseUrl);
  if (sameModel && sameEndpoint) return;

  throw new Error(
    `The search half would time "${opts.assignedModel}" at ${opts.assignedBaseUrl} — that is what this `
    + `database's 'embedding' use-case assignment resolves to, and hybridSearch takes no model or endpoint `
    + `from the command line — but this arm is labelled "${opts.model}" at ${opts.baseUrl}. `
    + 'Publishing it would attribute one model\'s latency to another. Seed this database for the model you '
    + 'mean (scripts/run-retrieval-eval.ts), pass --models/--base-url matching the assignment, or use '
    + '--mode embedding, which reads no database.',
  );
}

/**
 * Check the `--lang` question set against the corpus this database was seeded
 * with — recorded at seed time, because nothing about the corpus itself says
 * which language it is.
 *
 * A mismatch is a refusal: `--lang` chooses the QUESTION SET, never the corpus,
 * so German questions over an English corpus produce a perfectly plausible
 * report of a retrieval path that mostly missed. The dead-vector-leg guard does
 * not see it — it fires at exactly zero participation, and a mismatched corpus
 * still returns vector hits.
 *
 * A database seeded before this was recorded returns a WARNING rather than a
 * refusal: the corpus may well be the right one, and refusing every
 * pre-existing seeding would make the benchmark unusable until an hour of
 * re-embedding had run.
 */
export function checkCorpusLanguage(
  recorded: string | null | undefined,
  requested: string,
): string | null {
  if (!recorded) {
    return `This database records no corpus language — it was seeded before that was recorded. `
      + `--lang ${requested} selects the QUESTION SET only; the corpus is whatever was seeded here. `
      + `Re-seed with scripts/run-retrieval-eval.ts --lang ${requested} to have it certified.`;
  }
  // #1115 P5b: a claim that is not a language at all. `--images` seeds the
  // image corpus, whose 65 pages are not the corpus any --lang question set is
  // written against — and the generic refusal below would offer
  // `--lang de-images` as the remedy, which `corpusDirsForLanguage` throws on.
  if (recorded === IMAGE_AXIS_CORPUS_CLAIM) {
    throw new Error(
      `This database holds the #1115 image corpus ("${IMAGE_AXIS_CORPUS_CLAIM}": 65 German Wikipedia `
      + `articles seeded by run-retrieval-eval.ts --images), not the ${requested} text corpus. --lang `
      + `chooses the question set and never the corpus, so this arm would time ${requested} questions `
      + `against pages they were never written for and publish the result as a ${requested} `
      + `measurement. Re-seed the text corpus first (scripts/run-retrieval-eval.ts --lang ${requested}); `
      + `"${IMAGE_AXIS_CORPUS_CLAIM}" is not a --lang value.`,
    );
  }
  if (recorded !== requested) {
    throw new Error(
      `This database was seeded with the "${recorded}" corpus, but --lang says "${requested}". --lang `
      + 'chooses the question set and never the corpus, so this arm would time '
      + `${requested} questions against a ${recorded} corpus and publish the result as a ${requested} `
      + `measurement. Seed the ${requested} corpus first (scripts/run-retrieval-eval.ts --lang ${requested}), `
      + `or run this arm with --lang ${recorded}.`,
    );
  }
  return null;
}

/**
 * Run `tasks` at a fixed concurrency and return each task's own wall-clock
 * duration in milliseconds.
 *
 * Per task, not per batch: the batch clock answers throughput, and the question
 * here is what one person waits when four others are asking at the same time.
 * `warmup` tasks run first at the same concurrency and are discarded.
 */
export async function timeConcurrently<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  concurrency: number,
  warmup: ReadonlyArray<() => Promise<T>> = [],
): Promise<number[]> {
  const limit = pLimit(concurrency);
  await Promise.all(warmup.map((task) => limit(task)));

  const samples: number[] = [];
  await Promise.all(
    tasks.map((task) => limit(async () => {
      const started = performance.now();
      await task();
      samples.push(performance.now() - started);
    })),
  );
  return samples;
}

/**
 * Time one embedding request per query against a live OpenAI-compatible
 * endpoint, bypassing `openai-compatible-client.ts` on purpose: its shared
 * queue and per-provider circuit breaker are exactly the serialisation this
 * measurement is trying to look underneath.
 */
export async function timeEmbeddingCalls(opts: {
  baseUrl: string;
  model: string;
  queries: readonly string[];
  concurrency: number;
  /** Discarded calls issued first; the first request into a cold server carries model-load time. */
  warmup?: number;
  fetchImpl?: typeof fetch;
}): Promise<number[]> {
  const url = embeddingsUrl(opts.baseUrl);
  const doFetch = opts.fetchImpl ?? fetch;

  const call = (query: string) => async (): Promise<void> => {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The PRODUCT's query text, not the raw label: Qwen3 is trained with a
      // query-side instruction preamble and pays for those tokens on every
      // request the app makes.
      body: JSON.stringify({ model: opts.model, input: [formatQueryForEmbedding(opts.model, query)] }),
    });
    if (!res.ok) {
      // Naming the URL, because it is derived from --base-url the way the
      // product derives it — a 404 here usually means the base URL is missing
      // the path segment the provider row carries (e.g. /v1).
      throw new Error(`${opts.model}: embeddings request to ${url} failed with ${res.status} ${await res.text()}`);
    }
    // Drain the body inside the timed window — a latency that stops at the
    // response headers is not the latency the caller experiences.
    await res.json();
  };

  const warmupCount = Math.min(opts.warmup ?? Math.min(opts.concurrency, 3), opts.queries.length);
  return timeConcurrently(
    opts.queries.map(call),
    opts.concurrency,
    opts.queries.slice(0, warmupCount).map(call),
  );
}

/**
 * One un-timed embedding call, used to learn the model's vector width before
 * the search half is allowed to run. Deliberately the same direct HTTP path the
 * timed calls take, so a model that cannot be reached fails here rather than
 * inside the measurement.
 */
export async function probeEmbeddingDimensions(opts: {
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
}): Promise<number> {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = embeddingsUrl(opts.baseUrl);
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: opts.model, input: ['dimension probe'] }),
  });
  if (!res.ok) {
    throw new Error(`${opts.model}: dimension probe to ${url} failed with ${res.status} ${await res.text()}`);
  }
  const body = await res.json() as { data?: Array<{ embedding?: number[] }> };
  const dims = body.data?.[0]?.embedding?.length ?? 0;
  if (dims === 0) {
    throw new Error(`${opts.model}: dimension probe returned no embedding`);
  }
  return dims;
}

function cell(value: string | number, width: number): string {
  return String(value).padStart(width);
}

/** The same report the JSON carries, rendered for a terminal. */
export function formatBenchmarkTable(report: BenchmarkReport): string {
  const { metadata } = report;
  const lines = [
    `--- query latency (#1114) ---`,
    `endpoint ${metadata.baseUrl} · questions ${metadata.lang} · corpus ${metadata.corpusLanguage ?? 'unrecorded'}`
    + ` · fts ${metadata.ftsLanguage}`,
    `index ${metadata.columnType} (${metadata.dims} dims) · ${metadata.queries} queries · mode ${metadata.mode}`,
  ];
  if (metadata.embeddingQueueBypassed) {
    lines.push('embedding half: direct POST — the shared LLM queue is bypassed, so a rung really runs N-wide');
  }
  if (metadata.searchModel !== undefined) {
    // The search half's model is the database's, not the flag's, and the two
    // ceilings below are what a rung above 4 is really measuring.
    lines.push(
      `search half: ${metadata.searchModel} @ ${metadata.searchBaseUrl} (resolved from the database)`
      + ` · llm queue ${metadata.llmConcurrency ?? '?'} · vector pool ${metadata.vectorPoolMax ?? '?'}`
      // #1285 turned the scan depth from a process-env constant into a live
      // row, so it belongs beside the other two ceilings rather than being
      // assumed to be 100.
      + ` · ef_search floor ${metadata.ragEfSearch ?? '?'}`
      + ` (${metadata.ragEfSearchSource ?? 'unrecorded'})`,
    );
  }
  lines.push(
    '',
    `${'model'.padEnd(38)}${cell('conc', 6)}${cell('n', 5)}${cell('emb mean', 10)}${cell('emb p50', 9)}${cell('emb p95', 9)}${cell('search mean', 13)}${cell('search p50', 12)}${cell('search p95', 12)}`,
  );
  for (const row of report.results) {
    const e = row.embedding;
    const s = row.search;
    lines.push(
      row.model.padEnd(38)
      + cell(row.concurrency, 6)
      + cell(e?.n ?? s?.n ?? 0, 5)
      + cell(e ? e.meanMs.toFixed(1) : '–', 10)
      + cell(e ? e.p50Ms.toFixed(1) : '–', 9)
      + cell(e ? e.p95Ms.toFixed(1) : '–', 9)
      + cell(s ? s.meanMs.toFixed(1) : '–', 13)
      + cell(s ? s.p50Ms.toFixed(1) : '–', 12)
      + cell(s ? s.p95Ms.toFixed(1) : '–', 12),
    );
  }
  return lines.join('\n');
}
