import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LATENCY_MODELS,
  summarizeLatencies,
  parseBenchmarkArgs,
  sampleQueries,
  embeddingsUrl,
  assertProbeMatchesColumn,
  probeEmbeddingDimensions,
  timeConcurrently,
  timeEmbeddingCalls,
  formatBenchmarkTable,
} from './query-latency.js';

// #1114 — the open item was "query-time latency at 2560 under concurrency",
// and nothing that exists could measure it: the eval report carries no timing
// field, runner.ts is strictly sequential, and rag-service.ts has no timer
// around the embedding call. These are the pure halves of the benchmark that
// answers it; the HTTP half is exercised against a mocked fetch, per the
// project's mock-at-the-boundary rule.

describe('summarizeLatencies', () => {
  it('reports n, mean, p50 and p95 over real samples', () => {
    // 1..20 — p50 lands on the 10th of 20 sorted values, p95 on the 19th.
    const samples = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(summarizeLatencies(samples)).toEqual({ n: 20, meanMs: 10.5, p50Ms: 10, p95Ms: 19 });
  });

  it('is order-independent — samples arrive in completion order, not issue order', () => {
    expect(summarizeLatencies([9, 1, 5, 3, 7])).toEqual(summarizeLatencies([1, 3, 5, 7, 9]));
  });

  it('rounds to two decimals so a report is diffable', () => {
    expect(summarizeLatencies([1.005, 2.004, 3.0]).meanMs).toBe(2);
    expect(summarizeLatencies([1.239]).p95Ms).toBe(1.24);
  });

  it('answers n=0 for an empty run rather than NaN', () => {
    expect(summarizeLatencies([])).toEqual({ n: 0, meanMs: 0, p50Ms: 0, p95Ms: 0 });
  });

  it('does not interpolate past the end for a single sample', () => {
    expect(summarizeLatencies([42])).toEqual({ n: 1, meanMs: 42, p50Ms: 42, p95Ms: 42 });
  });
});

describe('parseBenchmarkArgs', () => {
  const ENV = { EVAL_EMBEDDING_BASE_URL: 'http://localhost:1234/v1' };

  it('defaults everything the runbook does not make the operator type', () => {
    expect(parseBenchmarkArgs([], ENV)).toEqual({
      baseUrl: 'http://localhost:1234/v1',
      models: DEFAULT_LATENCY_MODELS,
      concurrency: [1, 4, 8],
      queries: 40,
      lang: 'en',
      mode: 'both',
      outPath: 'query-latency.json',
    });
  });

  it('reads both --flag value and --flag=value', () => {
    const a = parseBenchmarkArgs(['--models', 'a,b', '--concurrency', '2,16', '--queries', '5'], ENV);
    const b = parseBenchmarkArgs(['--models=a,b', '--concurrency=2,16', '--queries=5'], ENV);
    expect(a.models).toEqual(['a', 'b']);
    expect(a).toEqual(b);
    expect(a.concurrency).toEqual([2, 16]);
    expect(a.queries).toBe(5);
  });

  it('sorts and de-duplicates the concurrency ladder so the table reads low to high', () => {
    expect(parseBenchmarkArgs(['--concurrency', '8,1,4,4'], ENV).concurrency).toEqual([1, 4, 8]);
  });

  it('requires a base URL, since there is no sensible default endpoint', () => {
    expect(() => parseBenchmarkArgs([], {})).toThrow(/--base-url|EVAL_EMBEDDING_BASE_URL/);
    expect(parseBenchmarkArgs(['--base-url', 'http://h/v1'], {}).baseUrl).toBe('http://h/v1');
  });

  it('refuses a mode, language or ladder it cannot honour instead of silently picking one', () => {
    expect(() => parseBenchmarkArgs(['--mode', 'quality'], ENV)).toThrow(/quality/);
    expect(() => parseBenchmarkArgs(['--lang', 'fr'], ENV)).toThrow(/fr/);
    expect(() => parseBenchmarkArgs(['--concurrency', '0'], ENV)).toThrow(/concurrency/i);
    expect(() => parseBenchmarkArgs(['--concurrency', '4,x'], ENV)).toThrow(/concurrency/i);
    expect(() => parseBenchmarkArgs(['--queries', '0'], ENV)).toThrow(/queries/i);
    expect(() => parseBenchmarkArgs(['--queries', '1.5'], ENV)).toThrow(/queries/i);
    expect(() => parseBenchmarkArgs(['--models', ' , '], ENV)).toThrow(/models/i);
  });
});

describe('sampleQueries', () => {
  const labels = Array.from({ length: 100 }, (_, i) => ({ id: `q${i}` }));

  it('is deterministic — two runs measure the same questions', () => {
    expect(sampleQueries(labels, 7)).toEqual(sampleQueries(labels, 7));
  });

  it('spreads across the fixture rather than taking the first N', () => {
    // The fixture is grouped by style; the first 40 labels are one style, so a
    // head slice would benchmark one query shape and call it the corpus.
    const picked = sampleQueries(labels, 4).map((l) => l.id);
    expect(picked).toEqual(['q0', 'q25', 'q50', 'q75']);
  });

  it('never repeats a label and returns everything when asked for more than exists', () => {
    const all = sampleQueries(labels, 500);
    expect(all).toHaveLength(100);
    expect(new Set(all.map((l) => l.id)).size).toBe(100);
  });
});

describe('embeddingsUrl', () => {
  it('mirrors the product: a base URL already ending in /v1 gets /embeddings', () => {
    // generateEmbedding posts to `${cfg.baseUrl}/embeddings`, and
    // EVAL_EMBEDDING_BASE_URL is written with the /v1 on it in every recipe.
    expect(embeddingsUrl('http://localhost:1234/v1')).toBe('http://localhost:1234/v1/embeddings');
    expect(embeddingsUrl('http://localhost:1234/v1/')).toBe('http://localhost:1234/v1/embeddings');
  });

  it('accepts a bare host and a fully-qualified endpoint too', () => {
    expect(embeddingsUrl('http://localhost:1234')).toBe('http://localhost:1234/v1/embeddings');
    expect(embeddingsUrl('http://localhost:1234/v1/embeddings')).toBe('http://localhost:1234/v1/embeddings');
  });
});

describe('assertProbeMatchesColumn', () => {
  it('passes when the live column is the width the model produces', () => {
    expect(() =>
      assertProbeMatchesColumn({ model: 'bge-m3', probeDims: 1024, columnDims: 1024, columnType: 'vector(1024)' }),
    ).not.toThrow();
  });

  it('refuses a model the database was not seeded for, naming both widths', () => {
    // The hazard is silent: hybridSearch swallows an embedding failure into
    // keyword-only, so a mismatched arm would publish a "search latency" that
    // is really Postgres FTS with no vector leg at all.
    const boom = () =>
      assertProbeMatchesColumn({
        model: 'text-embedding-qwen3-embedding-4b',
        probeDims: 2560,
        columnDims: 1024,
        columnType: 'vector(1024)',
      });
    expect(boom).toThrow(/2560/);
    expect(boom).toThrow(/1024/);
    expect(boom).toThrow(/text-embedding-qwen3-embedding-4b/);
    // …and it must say how to fix it, not merely that it is broken.
    expect(boom).toThrow(/run-retrieval-eval/);
    expect(boom).toThrow(/--mode embedding/);
  });
});

describe('timeConcurrently', () => {
  it('excludes the warm-up from the samples it returns', async () => {
    const calls: string[] = [];
    const samples = await timeConcurrently(
      Array.from({ length: 6 }, (_, i) => async () => { calls.push(`timed${i}`); }),
      2,
      Array.from({ length: 3 }, (_, i) => async () => { calls.push(`warm${i}`); }),
    );
    expect(samples).toHaveLength(6);
    expect(calls.filter((c) => c.startsWith('warm'))).toHaveLength(3);
    expect(calls.filter((c) => c.startsWith('timed'))).toHaveLength(6);
  });

  it('never runs more than `concurrency` tasks at once — the whole point of the ladder', async () => {
    let inFlight = 0;
    let peak = 0;
    const task = () => async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    };
    await timeConcurrently(Array.from({ length: 12 }, task), 3);
    expect(peak).toBe(3);
  });

  it('measures each task individually, not the wall clock of the batch', async () => {
    const samples = await timeConcurrently(
      [
        async () => { await new Promise((r) => setTimeout(r, 60)); },
        async () => { await new Promise((r) => setTimeout(r, 0)); },
      ],
      2,
    );
    const sorted = [...samples].sort((a, b) => a - b);
    expect(sorted[0]).toBeLessThan(40);
    expect(sorted[1]).toBeGreaterThanOrEqual(50);
  });
});

describe('timeEmbeddingCalls (HTTP boundary mocked)', () => {
  function fetchMock() {
    return vi.fn(async () => new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  }

  it('formats the query EXACTLY as production does, so Qwen3 pays for its Instruct prefix', async () => {
    const fetchImpl = fetchMock();
    await timeEmbeddingCalls({
      baseUrl: 'http://localhost:1234/v1',
      model: 'text-embedding-qwen3-embedding-4b',
      queries: ['how do i configure retention'],
      concurrency: 1,
      warmup: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:1234/v1/embeddings');
    const body = JSON.parse(String(init.body)) as { model: string; input: string[] };
    expect(body.model).toBe('text-embedding-qwen3-embedding-4b');
    expect(body.input[0]).toBe(
      'Instruct: Given a search query, retrieve relevant passages from the knowledge base that answer the query\n'
      + 'Query:how do i configure retention',
    );
  });

  it('leaves a non-instruction model unprefixed — measuring a cost it does not pay is a lie too', async () => {
    const fetchImpl = fetchMock();
    await timeEmbeddingCalls({
      baseUrl: 'http://localhost:1234/v1',
      model: 'text-embedding-bge-m3',
      queries: ['how do i configure retention'],
      concurrency: 1,
      warmup: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).input[0]).toBe('how do i configure retention');
  });

  it('issues warm-up calls that are not measured', async () => {
    const fetchImpl = fetchMock();
    const samples = await timeEmbeddingCalls({
      baseUrl: 'http://localhost:1234/v1',
      model: 'text-embedding-bge-m3',
      queries: ['a', 'b', 'c', 'd'],
      concurrency: 2,
      warmup: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(samples).toHaveLength(4);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('surfaces a provider error instead of recording it as a fast call', async () => {
    const fetchImpl = vi.fn(async () => new Response('model not loaded', { status: 503 }));
    await expect(
      timeEmbeddingCalls({
        baseUrl: 'http://localhost:1234/v1',
        model: 'text-embedding-bge-m3',
        queries: ['a'],
        concurrency: 1,
        warmup: 0,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/503/);
  });
});

describe('probeEmbeddingDimensions (HTTP boundary mocked)', () => {
  it('reports the width the model actually returns, not one a config claims', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ data: [{ embedding: Array.from({ length: 2560 }, () => 0) }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    await expect(probeEmbeddingDimensions({
      baseUrl: 'http://localhost:1234/v1',
      model: 'text-embedding-qwen3-embedding-4b',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).resolves.toBe(2560);
  });

  it('fails loudly on an empty reply rather than reporting 0 dimensions', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    await expect(probeEmbeddingDimensions({
      baseUrl: 'http://h/v1',
      model: 'm',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/no embedding/);
  });
});

describe('formatBenchmarkTable', () => {
  it('prints one row per (model, concurrency) and names the configuration it measured', () => {
    const table = formatBenchmarkTable({
      metadata: {
        baseUrl: 'http://localhost:1234/v1',
        lang: 'de',
        ftsLanguage: 'german',
        columnType: 'halfvec(2560)',
        dims: 2560,
        queries: 40,
        mode: 'both',
        generatedAt: '2026-08-16T00:00:00.000Z',
      },
      results: [
        { model: 'm', concurrency: 1, embedding: { n: 40, meanMs: 12.3, p50Ms: 12, p95Ms: 20 } },
        { model: 'm', concurrency: 8, embedding: { n: 40, meanMs: 40.1, p50Ms: 39, p95Ms: 80 }, search: { n: 40, meanMs: 90, p50Ms: 88, p95Ms: 150 } },
      ],
    });
    expect(table).toContain('halfvec(2560)');
    expect(table).toContain('german');
    expect(table).toMatch(/\bm\b.*\b1\b/);
    expect(table).toContain('40.1');
    expect(table).toContain('150');
  });
});
