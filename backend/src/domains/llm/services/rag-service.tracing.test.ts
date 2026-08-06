import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import pgvector from 'pgvector';

// #1117 stage 2: OTel spans + the retrieval-stage latency histogram.
//
// `withSpan`/`recordHistogram` read their tracer/meter from the globalThis
// seams (`__otelTracer`/`__otelMeter`) and pass straight through when absent.
// These tests install minimal fakes at those seams and drive the REAL
// retrieval pipeline against the REAL test database — only the embedding
// provider HTTP boundary is mocked, per CLAUDE.md.

function fakeVec(seed: number): number[] {
  return Array.from({ length: 1024 }, (_, i) => Math.sin((i + 1) * seed) * 0.01);
}

const generateEmbeddingMock = vi.hoisted(() => vi.fn(async () => [fakeVec(7)]));
vi.mock('./openai-compatible-client.js', async () => {
  const actual = await vi.importActual<typeof import('./openai-compatible-client.js')>(
    './openai-compatible-client.js',
  );
  return {
    ...actual,
    generateEmbedding: generateEmbeddingMock,
  };
});
vi.mock('./llm-provider-resolver.js', () => ({
  resolveUsecase: vi.fn(async () => ({
    config: {
      providerId: 'stub',
      id: 'stub',
      name: 'stub',
      baseUrl: '',
      apiKey: null,
      authType: 'none',
      verifySsl: true,
      defaultModel: 'stub',
    },
    model: 'stub',
  })),
}));

const { hybridSearch, flushSearchAnalytics, RETRIEVAL_STAGE_DURATION_METRIC } = await import(
  './rag-service.js'
);

interface RecordedSpan {
  name: string;
  attributes: Record<string, unknown>;
  status: { code: number; message?: string } | null;
  ended: boolean;
}

let recordedSpans: RecordedSpan[];

function installFakeTracer(): void {
  recordedSpans = [];
  (globalThis as Record<string, unknown>).__otelTracer = {
    startActiveSpan<T>(name: string, fn: (span: unknown) => T): T {
      const rec: RecordedSpan = { name, attributes: {}, status: null, ended: false };
      recordedSpans.push(rec);
      return fn({
        setAttribute(key: string, value: unknown) {
          rec.attributes[key] = value;
        },
        setStatus(s: { code: number; message?: string }) {
          rec.status = s;
        },
        recordException() {},
        end() {
          rec.ended = true;
        },
      });
    },
  };
}

let recordedMetrics: Array<{ name: string; value: number; attributes: Record<string, unknown> }>;

function installFakeMeter(): void {
  recordedMetrics = [];
  (globalThis as Record<string, unknown>).__otelMeter = {
    createHistogram(name: string) {
      return {
        record(value: number, attributes: Record<string, unknown>) {
          recordedMetrics.push({ name, value, attributes });
        },
      };
    },
  };
}

function spanByName(name: string): RecordedSpan | undefined {
  return recordedSpans.find((s) => s.name === name);
}

function stagesRecorded(): string[] {
  return recordedMetrics
    .filter((m) => m.name === RETRIEVAL_STAGE_DURATION_METRIC)
    .map((m) => m.attributes.stage as string);
}

const dbAvailable = await isDbAvailable();

const USER = 'dddddddd-1117-4000-8000-000000000099';
const SPACE = 'TRC';

describe.skipIf(!dbAvailable)('#1117 retrieval spans + stage histogram', () => {
  beforeAll(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await flushSearchAnalytics();
    await truncateAllTables();
    await query(
      `INSERT INTO roles (name, display_name, is_system, permissions) VALUES
         ('viewer', 'Viewer', TRUE, ARRAY['read'])
       ON CONFLICT (name) DO NOTHING`,
    );
    await query(
      `INSERT INTO users (id, username, email, role, password_hash)
       VALUES ($1::uuid, $1::text, $1::text || '@t', 'user', 'x')
       ON CONFLICT (id) DO NOTHING`,
      [USER],
    );
    await query(
      `INSERT INTO spaces (space_key, space_name) VALUES ($1, $1)
       ON CONFLICT (space_key) DO NOTHING`,
      [SPACE],
    );
    const role = await query<{ id: number }>(`SELECT id FROM roles WHERE name = 'viewer'`);
    await query(
      `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
       VALUES ($1, 'user', $2, $3)
       ON CONFLICT DO NOTHING`,
      [SPACE, USER, role.rows[0]!.id],
    );
    const page = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html)
       VALUES (gen_random_uuid()::text, 'confluence', $1, 'Runbook', 'restart the queue', '', '<p>x</p>')
       RETURNING id`,
      [SPACE],
    );
    await query(
      `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
       VALUES ($1, 0, 'restart the queue', $2, $3::jsonb)`,
      [
        page.rows[0]!.id,
        pgvector.toSql(fakeVec(7)),
        JSON.stringify({ page_title: 'Runbook', section_title: 'Runbook', space_key: SPACE }),
      ],
    );
    generateEmbeddingMock.mockClear();
    generateEmbeddingMock.mockImplementation(async () => [fakeVec(7)]);
    installFakeTracer();
    installFakeMeter();
  });
  afterEach(async () => {
    await flushSearchAnalytics();
    delete (globalThis as Record<string, unknown>).__otelTracer;
    delete (globalThis as Record<string, unknown>).__otelMeter;
  });

  it('emits rag.hybrid_search with leg spans and result-derived attributes', async () => {
    await hybridSearch(USER, 'restart the queue');

    const hybrid = spanByName('rag.hybrid_search');
    expect(hybrid).toBeDefined();
    expect(hybrid!.ended).toBe(true);
    expect(hybrid!.attributes['rag.top_k']).toBe(5);
    expect(hybrid!.attributes['rag.vector_hits']).toBe(1);
    expect(hybrid!.attributes['rag.keyword_hits']).toBe(1);
    expect(hybrid!.attributes['rag.search_type']).toBe('hybrid');
    expect(hybrid!.attributes['rag.embedding_coverage']).toBe(1);
    // Healthy retrieval carries NO degraded attribute — absence is the signal.
    expect('rag.degraded_reason' in hybrid!.attributes).toBe(false);

    const vector = spanByName('rag.vector_search');
    expect(vector).toBeDefined();
    expect(vector!.attributes['rag.hits']).toBe(1);
    expect(vector!.ended).toBe(true);

    const keyword = spanByName('rag.keyword_search');
    expect(keyword).toBeDefined();
    expect(keyword!.attributes['rag.hits']).toBe(1);
    expect(keyword!.ended).toBe(true);
  });

  it('records stage durations for vector, keyword and total', async () => {
    await hybridSearch(USER, 'restart the queue');

    const stages = stagesRecorded();
    expect(stages).toContain('vector_search');
    expect(stages).toContain('keyword_search');
    expect(stages).toContain('total');
    for (const m of recordedMetrics) {
      expect(Number.isFinite(m.value)).toBe(true);
      expect(m.value).toBeGreaterThanOrEqual(0);
    }
  });

  it('marks the hybrid span degraded and skips the vector stage when the provider fails', async () => {
    generateEmbeddingMock.mockImplementationOnce(async () => {
      throw new Error('provider exploded');
    });

    await hybridSearch(USER, 'restart the queue');

    const hybrid = spanByName('rag.hybrid_search');
    expect(hybrid).toBeDefined();
    expect(hybrid!.attributes['rag.degraded_reason']).toBe('embedding_failed');
    expect(hybrid!.attributes['rag.search_type']).toBe('keyword_fallback');

    // The vector leg never ran — no span, no duration sample for it.
    expect(spanByName('rag.vector_search')).toBeUndefined();
    const stages = stagesRecorded();
    expect(stages).not.toContain('vector_search');
    expect(stages).toContain('keyword_search');
    expect(stages).toContain('total');
  });
});
