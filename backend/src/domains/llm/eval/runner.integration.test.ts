import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import pgvector from 'pgvector';

// #1102 — the runner against real Postgres + pgvector. The embedding provider
// is mocked at its HTTP boundary (the same seam rag-service.integration.test.ts
// uses); everything below it — pgvector search, FTS, RRF — is real.

const DIMS = 1024;

/**
 * Deterministic "semantic" vectors: each topic gets an axis, so a query about
 * topic N is nearest the page about topic N. That gives the vector leg
 * something real to be right or wrong about without a model.
 */
function topicVec(topic: number, jitter = 0): number[] {
  const v = Array.from({ length: DIMS }, () => 0);
  v[topic % DIMS] = 1;
  v[(topic + 1) % DIMS] = 0.1 + jitter;
  return v;
}

const embeddingState = vi.hoisted(() => ({ topicForQuery: 0, fail: false }));
vi.mock('../services/openai-compatible-client.js', async () => {
  const actual = await vi.importActual<typeof import('../services/openai-compatible-client.js')>(
    '../services/openai-compatible-client.js',
  );
  return {
    ...actual,
    generateEmbedding: vi.fn(async () => {
      if (embeddingState.fail) throw new Error('embedding provider is down');
      return [topicVec(embeddingState.topicForQuery)];
    }),
    // #1112: the reformulation completion. Default is a provider that answers
    // with nothing usable, so every pre-existing test keeps measuring the
    // single-query pipeline.
    chat: vi.fn(async () => ''),
  };
});
// Inlined rather than hoisted into a shared const: `vi.mock` factories are
// lifted above every module-level declaration, so a reference here would be a
// TDZ error at load time.
vi.mock('../services/llm-provider-resolver.js', () => ({
  resolveUsecase: vi.fn(async () => ({
    config: { providerId: 'stub', id: 'stub', name: 'stub', baseUrl: '', apiKey: null, authType: 'none', verifySsl: true, defaultModel: 'stub' },
    model: 'stub',
  })),
  // The rerank stage's own resolver. Default REJECTS, so every test that does
  // not opt in keeps measuring the un-reranked pipeline exactly as before
  // (rag-service catches this and disables the stage for the request).
  resolveRerankUsecase: vi.fn(async () => {
    throw new Error('no rerank assignment in this eval DB');
  }),
}));
// rag-service imports this as `rerank as rerankDocuments` — the MOCK must
// carry the module's own export name.
vi.mock('../services/rerank-client.js', () => ({ rerank: vi.fn(async () => []) }));

const { runEval, VectorLegSilentError } = await import('./runner.js');

const dbAvailable = await isDbAvailable();
const USER = 'aaaaaaaa-1102-4000-8000-000000000001';

async function seedPage(title: string, body: string, topic: number): Promise<number> {
  const page = await query<{ id: number }>(
    `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html, page_type, visibility, embedding_status, embedding_dirty)
     VALUES (gen_random_uuid()::text, 'standalone', NULL, $1, $2, '', '<p>' || $2 || '</p>', 'page', 'shared', 'embedded', FALSE)
     RETURNING id`,
    [title, body],
  );
  const pageId = page.rows[0]!.id;
  await query(
    `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
     VALUES ($1, 0, $2, $3, $4::jsonb)`,
    [pageId, body, pgvector.toSql(topicVec(topic)), JSON.stringify({ page_title: title, section_title: title, space_key: null })],
  );
  return pageId;
}

function fixtureOf(labels: Array<{ id: string; query: string; expectedFiles: string[] }>) {
  return {
    corpusManifestSha: 'test',
    labeledBy: 'test',
    labels: labels.map((l) => ({ ...l, style: 'question' as const, rationale: '' })),
  };
}

describe.skipIf(!dbAvailable)('eval runner (#1102)', () => {
  beforeAll(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await truncateAllTables();
    await query(
      `INSERT INTO users (id, username, email, role, password_hash)
       VALUES ($1::uuid, $1::text, $1::text || '@t', 'admin', 'x') ON CONFLICT (id) DO NOTHING`,
      [USER],
    );
    embeddingState.fail = false;
    embeddingState.topicForQuery = 0;
  });

  it('records retrieved page ids per query and reports vector participation', async () => {
    const alpha = await seedPage('Alpha topic', 'alpha content about hooks and plugins', 5);
    await seedPage('Beta topic', 'beta content about bundling and rollup', 400);
    const pageIdByFile = new Map([['alpha.md', alpha]]);
    embeddingState.topicForQuery = 5; // the query embeds near Alpha

    const result = await runEval(fixtureOf([{ id: 'q1', query: 'how do hooks work', expectedFiles: ['alpha.md'] }]), {
      userId: USER,
      pageIdByFile,
      topK: 5,
    });

    expect(result.runs[0]!.expected).toEqual([alpha]);
    expect(result.runs[0]!.retrieved[0]).toBe(alpha);
    expect(result.vectorParticipatingQueries).toBe(1);
  });

  it('FAILS when the vector leg is silently dead, instead of scoring keyword-only results', async () => {
    // The hazard the issue names: hybridSearch swallows the embedding failure,
    // returns FTS hits, and every metric downstream looks healthy.
    const alpha = await seedPage('Alpha topic', 'alpha content about hooks and plugins', 5);
    embeddingState.fail = true;

    const promise = runEval(fixtureOf([{ id: 'q1', query: 'hooks plugins', expectedFiles: ['alpha.md'] }]), {
      userId: USER,
      pageIdByFile: new Map([['alpha.md', alpha]]),
      topK: 5,
    });

    await expect(promise).rejects.toBeInstanceOf(VectorLegSilentError);
    await expect(promise).rejects.toThrow(/keyword-only/i);
  });

  it('proves the dead leg still RETURNS results — which is why the guard cannot just check for hits', async () => {
    const alpha = await seedPage('Alpha topic', 'alpha hooks plugins content', 5);
    embeddingState.fail = true;

    const { hybridSearch } = await import('../services/rag-service.js');
    const results = await hybridSearch(USER, 'hooks plugins', 5);

    expect(results.length).toBeGreaterThan(0);
    expect(results.map((r) => r.pageId)).toContain(alpha);
    // …and every one of them came from FTS alone.
    expect(results.every((r) => r.vectorScore === null)).toBe(true);
  });

  it('refuses to measure a partially embedded corpus', async () => {
    const alpha = await seedPage('Alpha topic', 'alpha content', 5);
    // A page the embedding worker has not reached yet. Its body must clear
    // MIN_EMBEDDABLE_TEXT_CHARS or coverage rightly excludes it as unembeddable
    // and the corpus reads as complete.
    await query(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html, page_type, visibility, embedding_status, embedding_dirty)
       VALUES (gen_random_uuid()::text, 'standalone', NULL, 'Unembedded', $1, '', '<p>' || $1 || '</p>', 'page', 'shared', 'not_embedded', TRUE)`,
      ['a page the embedding worker has not reached yet, long enough to count'],
    );

    const promise = runEval(fixtureOf([{ id: 'q1', query: 'alpha', expectedFiles: ['alpha.md'] }]), {
      userId: USER,
      pageIdByFile: new Map([['alpha.md', alpha]]),
      topK: 5,
    });

    await expect(promise).rejects.toThrow(/only .* embedded/i);
  });

  it('#1112: a --deep-search run measures the fused three-leg pipeline', async () => {
    const alpha = await seedPage('Alpha topic', 'alpha content about hooks and plugins', 5);
    await seedPage('Beta topic', 'beta content about bundling and rollup', 400);
    embeddingState.topicForQuery = 5;
    const client = await import('../services/openai-compatible-client.js');
    vi.mocked(client.chat).mockResolvedValue('how are hooks registered\nplugin hook lifecycle');

    const result = await runEval(fixtureOf([{ id: 'q1', query: 'how do hooks work', expectedFiles: ['alpha.md'] }]), {
      userId: USER,
      pageIdByFile: new Map([['alpha.md', alpha]]),
      topK: 5,
      deepSearch: true,
    });

    expect(result.expansionParticipatingQueries).toBe(1);
    expect(result.runs[0]!.retrieved[0]).toBe(alpha);
  });

  it('#1112: FAILS a --deep-search run in which expansion never fired, instead of labelling plain retrieval "deep"', async () => {
    // Expansion is soft-fail by design, so an eval DB with no `chat`
    // assignment produces perfectly ordinary numbers under a deep label —
    // the same silent lie the vector-participation guard exists for.
    const alpha = await seedPage('Alpha topic', 'alpha content about hooks and plugins', 5);
    embeddingState.topicForQuery = 5;
    const client = await import('../services/openai-compatible-client.js');
    vi.mocked(client.chat).mockRejectedValue(new Error('no chat provider'));

    const promise = runEval(fixtureOf([{ id: 'q1', query: 'how do hooks work', expectedFiles: ['alpha.md'] }]), {
      userId: USER,
      pageIdByFile: new Map([['alpha.md', alpha]]),
      topK: 5,
      deepSearch: true,
    });

    await expect(promise).rejects.toBeInstanceOf(VectorLegSilentError);
    await expect(promise).rejects.toThrow(/expansion participated in 0 queries/i);
  });

  it('#1112: does NOT fail when every query legitimately skipped expansion', async () => {
    // Identifier and error-text queries are excluded by design. A fixture
    // made only of those expands nothing and is still a valid measurement —
    // "skipped by design" and "the provider is down" are different facts.
    const alpha = await seedPage('FST_ERR_DEC_UNDECLARED', 'decorator error content for hooks', 5);
    embeddingState.topicForQuery = 5;
    const client = await import('../services/openai-compatible-client.js');
    // The stub is module-level, so earlier tests' calls are still recorded on
    // it — clear before asserting this test's own call count.
    vi.mocked(client.chat).mockClear();
    vi.mocked(client.chat).mockRejectedValue(new Error('never called'));

    const result = await runEval(
      fixtureOf([{ id: 'q1', query: 'FST_ERR_DEC_UNDECLARED', expectedFiles: ['alpha.md'] }]),
      { userId: USER, pageIdByFile: new Map([['alpha.md', alpha]]), topK: 5, deepSearch: true },
    );

    expect(result.expansionParticipatingQueries).toBe(0);
    expect(result.expansionSkippedQueries).toBe(1);
    expect(client.chat).not.toHaveBeenCalled();
  });

  it('fails when the vector leg works for only a token minority of queries', async () => {
    // One lucky hit across many queries is evidence of a broken leg, not a
    // working one — the reason the floor is a fraction rather than "> 0".
    const alpha = await seedPage('Alpha topic', 'alpha content about hooks', 5);
    const pageIdByFile = new Map([['alpha.md', alpha]]);
    const labels = Array.from({ length: 4 }, (_, i) => ({
      id: `q${i}`,
      query: `query ${i} about hooks`,
      expectedFiles: ['alpha.md'],
    }));

    let call = 0;
    const client = await import('../services/openai-compatible-client.js');
    vi.mocked(client.generateEmbedding).mockImplementation(async () => {
      // Only the first query gets a usable vector; the rest fail.
      if (call++ > 0) throw new Error('embedding provider is down');
      return [topicVec(5)];
    });

    await expect(runEval(fixtureOf(labels), { userId: USER, pageIdByFile, topK: 5 })).rejects.toThrow(
      /1\/4 queries/,
    );
  });

  it('fails a --rerank run in which the stage worked for only a token minority of queries', async () => {
    // The defect this test exists for: the guard used to fire only at EXACTLY
    // zero. The first #1112 deep+rerank measurement sent three concurrent
    // 60-document rerank calls into one 5s budget, every call aborted, the
    // aborts tripped the breaker — and the stage still scored 7 of 197
    // queries in the gaps between cool-downs, which the zero-only guard read
    // as a healthy stage and published.
    const alpha = await seedPage('Alpha topic', 'alpha content about hooks', 5);
    await seedPage('Beta topic', 'beta content about hooks and bundling', 6);
    const pageIdByFile = new Map([['alpha.md', alpha]]);
    const labels = Array.from({ length: 4 }, (_, i) => ({
      id: `q${i}`,
      query: `query ${i} about hooks`,
      expectedFiles: ['alpha.md'],
    }));

    // The vector-minority test above replaces the embedding implementation
    // with a counting one, and `beforeEach` only resets the flags it reads —
    // without this the vector guard fires first and the assertion below would
    // pass on the wrong error.
    const client = await import('../services/openai-compatible-client.js');
    vi.mocked(client.generateEmbedding).mockImplementation(async () => [topicVec(5)]);

    const resolver = await import('../services/llm-provider-resolver.js');
    vi.mocked(resolver.resolveRerankUsecase).mockResolvedValue({ config: {
      providerId: 'stub', id: 'stub', name: 'stub', baseUrl: '', apiKey: null,
      authType: 'none', verifySsl: true, defaultModel: 'rr',
    }, model: 'rr' } as never);
    const rerankClient = await import('../services/rerank-client.js');
    let call = 0;
    vi.mocked(rerankClient.rerank).mockImplementation(async (_c, _m, _q, docs) => {
      // Only the first query is scored; the rest time out the way an
      // over-sized pool does against RERANK_TIMEOUT_MS.
      if (call++ > 0) throw new Error('The operation was aborted due to timeout');
      return docs.map((_d: string, i: number) => ({ index: i, relevanceScore: 1 - i / 100 }));
    });

    try {
      await expect(
        runEval(fixtureOf(labels), { userId: USER, pageIdByFile, topK: 5, rerank: true }),
      ).rejects.toThrow(/participated in only 1\/4 queries/);

    } finally {
      vi.mocked(resolver.resolveRerankUsecase).mockRejectedValue(new Error('no rerank assignment'));
      vi.mocked(rerankClient.rerank).mockResolvedValue([]);
    }
  });
});
