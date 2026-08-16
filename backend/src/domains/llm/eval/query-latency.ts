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
}

export interface BenchmarkReport {
  metadata: BenchmarkMetadata;
  results: BenchmarkRow[];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Nearest-rank percentile, the same definition `production-benchmark.ts` uses,
 * so two latency figures in this repo mean the same thing.
 */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
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

function flagValue(argv: readonly string[], name: string): string | undefined {
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = argv[i + 1];
  return next === undefined || next.startsWith('--') ? '' : next;
}

export function parseBenchmarkArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): BenchmarkConfig {
  const baseUrl = flagValue(argv, 'base-url') || env.EVAL_EMBEDDING_BASE_URL;
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

  return {
    baseUrl,
    models,
    concurrency,
    queries,
    lang,
    mode,
    outPath: flagValue(argv, 'out') || 'query-latency.json',
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
 * The embeddings endpoint for a base URL, mirroring what
 * `generateEmbedding` does (`${cfg.baseUrl}/embeddings`) while tolerating the
 * two other spellings that appear in this repo's recipes: a bare host, and a
 * fully-qualified endpoint.
 */
export function embeddingsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/embeddings')) return trimmed;
  if (trimmed.endsWith('/v1')) return `${trimmed}/embeddings`;
  return `${trimmed}/v1/embeddings`;
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
      throw new Error(`${opts.model}: embeddings request failed with ${res.status} ${await res.text()}`);
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
  const res = await doFetch(embeddingsUrl(opts.baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: opts.model, input: ['dimension probe'] }),
  });
  if (!res.ok) {
    throw new Error(`${opts.model}: dimension probe failed with ${res.status} ${await res.text()}`);
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
    `endpoint ${metadata.baseUrl} · corpus ${metadata.lang} · fts ${metadata.ftsLanguage}`,
    `index ${metadata.columnType} (${metadata.dims} dims) · ${metadata.queries} queries · mode ${metadata.mode}`,
    '',
    `${'model'.padEnd(38)}${cell('conc', 6)}${cell('n', 5)}${cell('emb mean', 10)}${cell('emb p50', 9)}${cell('emb p95', 9)}${cell('search mean', 13)}${cell('search p50', 12)}${cell('search p95', 12)}`,
  ];
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
