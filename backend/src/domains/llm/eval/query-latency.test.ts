import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LATENCY_MODELS,
  KNOWN_FLAGS,
  BENCHMARK_USAGE,
  wantsHelp,
  summarizeLatencies,
  parseBenchmarkArgs,
  sampleQueries,
  embeddingsUrl,
  assertProbeMatchesColumn,
  assertSearchArmMatchesAssignment,
  checkCorpusLanguage,
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
    // --mode embedding, because the default model list is a two-model sweep
    // and a search mode takes exactly one; see the test below.
    expect(parseBenchmarkArgs(['--mode', 'embedding'], ENV)).toEqual({
      baseUrl: 'http://localhost:1234/v1',
      models: DEFAULT_LATENCY_MODELS,
      concurrency: [1, 4, 8],
      queries: 40,
      lang: 'en',
      mode: 'embedding',
      outPath: 'query-latency.json',
    });
    expect(parseBenchmarkArgs(['--models', 'm'], ENV).mode).toBe('both');
  });

  it('refuses a search mode carrying more than one model — the search half has no model flag', () => {
    // hybridSearch takes no model: rag-service resolves it from the database's
    // `embedding` assignment. Two ids under `both` therefore produce two
    // differently-labelled rows measuring the same thing, and the default pair
    // (1024-dim, 2560-dim) cannot both match one seeded index anyway.
    for (const mode of ['both', 'search']) {
      const boom = () => parseBenchmarkArgs(['--mode', mode, '--models', 'a,b'], ENV);
      expect(boom).toThrow(/exactly one/i);
      expect(boom).toThrow(/assignment/i);
      // The bare default is the two-model sweep, so it hits the same rule and
      // must say what to type instead rather than failing at the probe later.
      expect(() => parseBenchmarkArgs(['--mode', mode], ENV)).toThrow(/--models <id>/);
    }
    expect(() => parseBenchmarkArgs(['--mode', 'both', '--models', 'a'], ENV)).not.toThrow();
    expect(() => parseBenchmarkArgs(['--mode', 'embedding', '--models', 'a,b'], ENV)).not.toThrow();
  });

  it('refuses an unknown flag instead of running the defaults under it', () => {
    // A typo'd --concurency would otherwise publish a 1,4,8 ladder the
    // operator did not ask for, and --help would silently run a benchmark.
    const boom = () => parseBenchmarkArgs(['--concurency', '4', '--models', 'm'], ENV);
    expect(boom).toThrow(/--concurency/);
    expect(boom).toThrow(/--concurrency/);
  });

  it('reads both --flag value and --flag=value', () => {
    const a = parseBenchmarkArgs(['--mode', 'embedding', '--models', 'a,b', '--concurrency', '2,16', '--queries', '5'], ENV);
    const b = parseBenchmarkArgs(['--mode=embedding', '--models=a,b', '--concurrency=2,16', '--queries=5'], ENV);
    expect(a.models).toEqual(['a', 'b']);
    expect(a).toEqual(b);
    expect(a.concurrency).toEqual([2, 16]);
    expect(a.queries).toBe(5);
  });

  it('sorts and de-duplicates the concurrency ladder so the table reads low to high', () => {
    expect(parseBenchmarkArgs(['--mode', 'embedding', '--concurrency', '8,1,4,4'], ENV).concurrency).toEqual([1, 4, 8]);
  });

  it('requires a base URL, since there is no sensible default endpoint', () => {
    expect(() => parseBenchmarkArgs([], {})).toThrow(/--base-url|EVAL_EMBEDDING_BASE_URL/);
    expect(parseBenchmarkArgs(['--mode', 'embedding', '--base-url', 'http://h/v1'], {}).baseUrl).toBe('http://h/v1');
  });

  it('refuses a valueless --base-url or --out rather than quietly substituting a default', () => {
    // #1114 review r3. These two were the only flags whose empty form was
    // read as "unset" (`flagValue(...) || fallback`), and they are exactly the
    // two that decide where a run POINTS and where its report LANDS: an
    // operator who typed `--base-url` and lost the value measured the
    // environment's endpoint under a command line that names another, and
    // `--out` wrote over query-latency.json. Every other flag already refused.
    expect(() => parseBenchmarkArgs(['--mode', 'embedding', '--base-url'], ENV)).toThrow(/--base-url needs a value/);
    expect(() => parseBenchmarkArgs(['--mode', 'embedding', '--out'], ENV)).toThrow(/--out needs a value/);
    expect(() => parseBenchmarkArgs(['--mode', 'embedding', '--out='], ENV)).toThrow(/--out needs a value/);
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

describe('BENCHMARK_USAGE (#1114)', () => {
  it('documents every flag the parser accepts, with its default', () => {
    // The runbook's flag list drifted from the parser once already. This is
    // the copy that ships with the binary, so it is the one held to the parser.
    for (const flag of KNOWN_FLAGS) expect(BENCHMARK_USAGE).toContain(`--${flag}`);
    expect(BENCHMARK_USAGE).toMatch(/default: 1,4,8/);
    expect(BENCHMARK_USAGE).toMatch(/default: 40/);
    expect(BENCHMARK_USAGE).toMatch(/default: en/);
    expect(BENCHMARK_USAGE).toMatch(/default: both/);
    expect(BENCHMARK_USAGE).toMatch(/default: query-latency\.json/);
    expect(BENCHMARK_USAGE).toContain(DEFAULT_LATENCY_MODELS.join(','));
  });

  it('says the two things a wrong run cannot recover from', () => {
    // The search half's model comes from the database, and a second model
    // loaded mid-run evicts the one being measured.
    expect(BENCHMARK_USAGE).toMatch(/search half reads its\s+model from the seeded database/);
    expect(BENCHMARK_USAGE).toMatch(/Do not touch the model server/);
  });

  it('is reachable, so the warnings above are not source-only', () => {
    expect(wantsHelp(['--help'])).toBe(true);
    expect(wantsHelp(['-h'])).toBe(true);
    expect(wantsHelp(['--models', 'm'])).toBe(false);
  });
});

describe('assertSearchArmMatchesAssignment (#1114)', () => {
  const assignment = { assignedModel: 'bge-m3', assignedBaseUrl: 'http://localhost:1234/v1' };

  it('passes when the arm names what the database will actually use', () => {
    expect(() =>
      assertSearchArmMatchesAssignment({ model: 'bge-m3', baseUrl: 'http://localhost:1234/v1', ...assignment }),
    ).not.toThrow();
  });

  it('tolerates the trailing-slash spelling, which is not a mismatch', () => {
    expect(() =>
      assertSearchArmMatchesAssignment({ model: 'bge-m3', baseUrl: 'http://localhost:1234/v1/', ...assignment }),
    ).not.toThrow();
  });

  it('refuses a same-width model the database was not assigned — the probe cannot see it', () => {
    // Two 1024-dim models pass assertProbeMatchesColumn, and hybridSearch
    // resolves its model from llm_usecase_assignments regardless of --models.
    // The row would carry one model's name over another model's numbers.
    const boom = () =>
      assertSearchArmMatchesAssignment({ model: 'mxbai-embed-large', baseUrl: 'http://localhost:1234/v1', ...assignment });
    expect(boom).toThrow(/mxbai-embed-large/);
    expect(boom).toThrow(/bge-m3/);
    expect(boom).toThrow(/--mode embedding/);
  });

  it('refuses an endpoint the assignment does not point at', () => {
    const boom = () =>
      assertSearchArmMatchesAssignment({ model: 'bge-m3', baseUrl: 'http://other-host:1234/v1', ...assignment });
    expect(boom).toThrow(/other-host/);
    expect(boom).toThrow(/localhost:1234/);
  });

  it('refuses a path difference too — /v1 and a bare host are different endpoints', () => {
    // #1114 review r3. The comparison ran through embeddingsUrl, which guessed
    // a `/v1` onto a bare host, so these two matched. They are not the same
    // endpoint to the product: generateEmbedding posts `${base_url}/embeddings`
    // verbatim, so an assignment of `http://localhost:1234` embeds at
    // `/embeddings` while this arm's own calls went to `/v1/embeddings`.
    const boom = () => assertSearchArmMatchesAssignment({
      model: 'bge-m3',
      baseUrl: 'http://localhost:1234/v1',
      assignedModel: 'bge-m3',
      assignedBaseUrl: 'http://localhost:1234',
    });
    expect(boom).toThrow(/http:\/\/localhost:1234\b/);
    expect(boom).toThrow(/--mode embedding/);
  });
});

describe('checkCorpusLanguage (#1114)', () => {
  it('passes silently when the question set matches the seeded corpus', () => {
    expect(checkCorpusLanguage('de', 'de')).toBeNull();
    expect(checkCorpusLanguage('en', 'en')).toBeNull();
  });

  it('refuses German questions aimed at an English corpus', () => {
    // --lang picks the fixture, never the corpus. The dead-vector-leg guard
    // cannot catch this: it fires only at exactly zero participation, and a
    // mismatched corpus still returns vector hits — just wrong ones.
    const boom = () => checkCorpusLanguage('en', 'de');
    expect(boom).toThrow(/seeded with the "en" corpus/);
    expect(boom).toThrow(/--lang de/);
    expect(boom).toThrow(/run-retrieval-eval\.ts --lang de/);
  });

  it('warns rather than refuses when the seeding predates the record', () => {
    // Refusing would make the benchmark unusable against every existing
    // seeding until an hour of re-embedding had run.
    const warning = checkCorpusLanguage(null, 'en');
    expect(warning).toMatch(/records no corpus language/);
    expect(warning).toMatch(/QUESTION SET only/);
    expect(checkCorpusLanguage(undefined, 'de')).toMatch(/records no corpus language/);
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

  it('never guesses a /v1 the product would not add', () => {
    // #1114 review r3. This used to rewrite a bare host to `/v1/embeddings`,
    // which is NOT what generateEmbedding does with such a provider row — it
    // posts `${base_url}/embeddings` verbatim. Two costs: the embedding half
    // timed an endpoint the product never calls, and
    // assertSearchArmMatchesAssignment compared the two sides THROUGH this
    // function, so a `/v1` arm passed against a bare-host assignment that
    // resolves somewhere else entirely. `run-retrieval-eval.ts` writes the
    // provider row from EVAL_EMBEDDING_BASE_URL verbatim, so the spelling that
    // works there is the spelling that must work here.
    expect(embeddingsUrl('http://localhost:1234')).toBe('http://localhost:1234/embeddings');
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
        corpusLanguage: 'de',
        searchModel: 'text-embedding-qwen3-embedding-4b',
        searchBaseUrl: 'http://localhost:1234/v1',
        llmConcurrency: 4,
        vectorPoolMax: 5,
        embeddingQueueBypassed: true,
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

  it('names what the search half actually ran and the ceilings it ran under', () => {
    // The `model` column is the --models label; the search half's model comes
    // from the database. And above concurrency 4 a search rung is mostly
    // waiting on the shared LLM queue, so a report that omits its width is not
    // comparable across boxes — while the embedding half bypasses that queue
    // entirely, which is why one row's two halves are not the same load.
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
        corpusLanguage: 'de',
        searchModel: 'text-embedding-qwen3-embedding-4b',
        searchBaseUrl: 'http://localhost:1234/v1',
        llmConcurrency: 4,
        vectorPoolMax: 5,
        embeddingQueueBypassed: true,
      },
      results: [],
    });
    expect(table).toMatch(/search half: text-embedding-qwen3-embedding-4b @ http:\/\/localhost:1234\/v1/);
    expect(table).toMatch(/llm queue 4/);
    expect(table).toMatch(/vector pool 5/);
    expect(table).toMatch(/queue is bypassed/);
    expect(table).toMatch(/corpus de/);
  });

  it('says "unrecorded" rather than inventing a corpus language it never read', () => {
    const table = formatBenchmarkTable({
      metadata: {
        baseUrl: 'http://h/v1',
        lang: 'en',
        ftsLanguage: 'n/a (no database read)',
        columnType: 'n/a (no database read)',
        dims: 0,
        queries: 5,
        mode: 'embedding',
        generatedAt: '2026-08-16T00:00:00.000Z',
        embeddingQueueBypassed: true,
      },
      results: [],
    });
    expect(table).toContain('corpus unrecorded');
    expect(table).not.toMatch(/search half:/);
  });
});
