import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ADR-027 D9 — `embedPage` composing derived chunks, against real Postgres.
 * Only the external text-embedding provider is mocked (each text gets a
 * distinct deterministic vector); chunking, the composition read, every
 * transaction and both page averages run for real. No vision client exists in
 * this file at all: composition must never need one (D9.8).
 */
const cap = vi.hoisted(() => ({
  texts: [] as string[],
  counter: 0,
  /** Runs before one statement is sent — the seam for a race that has no other hook (the settle path). */
  beforeQuery: undefined as ((text: string) => Promise<void>) | undefined,
}));

vi.mock('../../../core/db/postgres.js', async () => {
  const actual = await vi.importActual<typeof import('../../../core/db/postgres.js')>('../../../core/db/postgres.js');
  return {
    ...actual,
    query: async (text: string, params?: unknown[]) => {
      if (cap.beforeQuery) await cap.beforeQuery(text);
      return actual.query(text, params);
    },
  };
});

vi.mock('./openai-compatible-client.js', async () => {
  const actual = await vi.importActual<typeof import('./openai-compatible-client.js')>('./openai-compatible-client.js');
  return {
    ...actual,
    generateEmbedding: vi.fn(async (_cfg: unknown, _model: string, texts: string[] | string) => {
      const arr = Array.isArray(texts) ? texts : [texts];
      return arr.map((t) => {
        cap.texts.push(t);
        const seed = ++cap.counter;
        return Array.from({ length: 1024 }, (_, i) => Math.sin((i + 1) * seed) * 0.01);
      });
    }),
  };
});

vi.mock('./llm-provider-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('./llm-provider-resolver.js')>('./llm-provider-resolver.js');
  return {
    ...actual,
    resolveUsecase: vi.fn(async () => ({
      config: {
        providerId: 'test-provider',
        id: 'test-provider',
        name: 'Test',
        baseUrl: 'http://localhost:0/v1',
        apiKey: null,
        authType: 'none' as const,
        verifySsl: false,
        defaultModel: 'bge-m3',
      },
      model: 'bge-m3',
    })),
  };
});

import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { ensureImageAnalysisStore, dropImageAnalysisStoreIfProvisioned } from './__fixtures__/image-analysis-store.js';
import { query } from '../../../core/db/postgres.js';
import { embedPage } from './embedding-service.js';
import { getEmbeddingCoverage } from './rag-service.js';
import { readPageImageAnalysisReadiness } from './image-analysis-readiness.js';
import {
  computeIdentityHash,
  IMAGE_ANALYSIS_IDENTITY_KEY,
  IMAGE_ANALYSIS_PROMPT_VERSION,
  IMAGE_ANALYSIS_SCHEMA_VERSION,
  type ImageAnalysisPayload,
} from './image-analysis-provider.js';

const dbAvailable = await isDbAvailable();
const USER = 'aaaaaaaa-1616-4000-8000-000000000001';
let providerId: string;

const RETAINED_TRIPLE = { model: 'qwen3-vl', baseUrl: 'http://vision/v1' };
async function retainIdentity(): Promise<string> {
  const triple = { providerId, ...RETAINED_TRIPLE };
  const identityHash = computeIdentityHash(triple);
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value) VALUES ($1, $2)
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`,
    [IMAGE_ANALYSIS_IDENTITY_KEY, JSON.stringify({ ...triple, identityHash, assignedAt: '2026-09-15T00:00:00.000Z' })],
  );
  return identityHash;
}

const PAYLOAD: ImageAnalysisPayload = {
  schemaVersion: 1,
  kind: 'screenshot',
  language: 'en',
  description: 'The release pipeline dashboard with stage three marked failed.',
  visibleText: 'Build #4821 FAILED at stage: integration-tests',
  limitations: [],
};

async function seedPage(bodyHtml: string, title = 'Page'): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html, visibility, embedding_dirty)
     VALUES (NULL, 'standalone', 'DEV', $1, 'body', '', $2, 'shared', TRUE) RETURNING id`,
    [title, bodyHtml],
  );
  return res.rows[0]!.id;
}

async function seedAnalysis(
  pageId: number,
  key: string,
  opts: { identityHash: string; status?: string; payload?: ImageAnalysisPayload; prompt?: number; contentHash?: string },
): Promise<number> {
  const r = await query<{ id: number }>(
    `INSERT INTO page_image_analyses
       (page_id, source, attachment_key, content_hash, format, status, payload, identity_hash, prompt_version, schema_version,
        analysis_version, provider_id, model, base_url)
     VALUES ($1, 'confluence', $2, $3, 'png', $4, $5::jsonb, $6, $7, $8, 1, $9, $10, $11) RETURNING id`,
    [
      pageId,
      key,
      opts.contentHash ?? `hash-${key}`,
      opts.status ?? 'analyzed',
      JSON.stringify(opts.payload ?? PAYLOAD),
      opts.identityHash,
      opts.prompt ?? IMAGE_ANALYSIS_PROMPT_VERSION,
      IMAGE_ANALYSIS_SCHEMA_VERSION,
      providerId,
      RETAINED_TRIPLE.model,
      RETAINED_TRIPLE.baseUrl,
    ],
  );
  return r.rows[0]!.id;
}

interface ChunkRow {
  chunk_index: number;
  chunk_text: string;
  metadata: Record<string, unknown>;
  tsv_hit: boolean;
}
async function chunksFor(pageId: number, term = 'integration-tests'): Promise<ChunkRow[]> {
  const r = await query<ChunkRow>(
    `SELECT chunk_index, chunk_text, metadata, (chunk_tsv @@ plainto_tsquery('simple', $2)) AS tsv_hit
       FROM page_embeddings WHERE page_id = $1 ORDER BY chunk_index`,
    [pageId, term],
  );
  return r.rows;
}

async function pageRow(pageId: number): Promise<{ status: string; dirty: boolean; avg: number[] | null }> {
  const r = await query<{ embedding_status: string; embedding_dirty: boolean; avg: string | null }>(
    `SELECT embedding_status, embedding_dirty, page_avg_embedding::text AS avg FROM pages WHERE id = $1`,
    [pageId],
  );
  const row = r.rows[0]!;
  return { status: row.embedding_status, dirty: row.embedding_dirty, avg: row.avg ? (JSON.parse(row.avg) as number[]) : null };
}

const PROSE = '<p>' + 'Compendiq release notes describe the pipeline stages in detail. '.repeat(40) + '</p>';

describe.skipIf(!dbAvailable)('embedPage composes derived chunks (ADR-027 D9, #1616)', () => {
  beforeAll(async () => {
    await setupTestDb();
    await ensureImageAnalysisStore();
  }, 30_000);
  afterAll(async () => {
    await dropImageAnalysisStoreIfProvisioned();
    await teardownTestDb();
  });
  beforeEach(async () => {
    await truncateAllTables();
    cap.texts = [];
    cap.counter = 0;
    cap.beforeQuery = undefined;
    await query(
      `INSERT INTO users (id, username, email, role, password_hash)
       VALUES ($1::uuid, 'u', 'u@t', 'admin', 'x') ON CONFLICT (id) DO NOTHING`,
      [USER],
    );
    const prov = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, default_model)
       VALUES ('vision-box', 'http://vision/v1', 'none', TRUE, 'qwen3-vl') RETURNING id`,
    );
    providerId = prov.rows[0]!.id;
  });

  it('appends valid derived chunks after every authored index, with provenance in metadata.source, and they survive a re-embed', async () => {
    const hash = await retainIdentity();
    const body = `<h2>Overview</h2>${PROSE}<h2>Status</h2><img src="/api/attachments/1/dash.png" alt="Pipeline dashboard">`;
    const pageId = await seedPage(body, 'Release 4.2');
    const analysisId = await seedAnalysis(pageId, 'dash.png', { identityHash: hash });

    const written = await embedPage(USER, pageId, 'Release 4.2', 'DEV', body);

    const chunks = await chunksFor(pageId);
    expect(written).toBe(chunks.length);
    const derived = chunks.filter((c) => c.metadata.source === 'image_analysis');
    const authored = chunks.filter((c) => c.metadata.source !== 'image_analysis');
    expect(authored.length).toBeGreaterThan(0);
    expect(derived).toHaveLength(1);
    expect(derived[0]!.chunk_index).toBe(authored.length);
    expect(Math.max(...authored.map((c) => c.chunk_index))).toBeLessThan(derived[0]!.chunk_index);
    expect(derived[0]!.metadata).toEqual({
      page_title: 'Release 4.2',
      section_title: '[Image: dash.png — screenshot]',
      space_key: 'DEV',
      confluence_id: String(pageId),
      source: 'image_analysis',
      attachment_source: 'confluence',
      attachment_key: 'dash.png',
      content_hash: 'hash-dash.png',
      analysis_id: Number(analysisId),
      analysis_version: 1,
      part: 1,
      parts: 1,
    });
    expect(derived[0]!.chunk_text).toContain('[Image: dash.png — screenshot]\nPage: Release 4.2\nCaption (author-supplied): Pipeline dashboard\nSection: Status\n');
    expect(derived[0]!.chunk_text).toContain('Visible text:\nBuild #4821 FAILED at stage: integration-tests');
    // The derived text is in the lexical index too (D10): the trigger filled chunk_tsv.
    expect(derived[0]!.tsv_hit).toBe(true);
    for (const c of authored) expect(c.metadata).not.toHaveProperty('source');

    // Re-embed: same order and metadata, no duplicate, no leftover.
    const again = await embedPage(USER, pageId, 'Release 4.2', 'DEV', body);
    const after = await chunksFor(pageId);
    expect(again).toBe(written);
    expect(after.map((c) => [c.chunk_index, c.metadata.source ?? 'authored'])).toEqual(
      chunks.map((c) => [c.chunk_index, c.metadata.source ?? 'authored']),
    );
    expect(await pageRow(pageId)).toMatchObject({ status: 'embedded', dirty: false });
  });

  it('excludes derived rows from the page average, so a page with screenshots does not drift', async () => {
    const hash = await retainIdentity();
    const body = `${PROSE}<img src="/api/attachments/1/a.png"><img src="/api/attachments/1/b.png">`;
    const pageId = await seedPage(body);
    await seedAnalysis(pageId, 'a.png', { identityHash: hash });
    await seedAnalysis(pageId, 'b.png', { identityHash: hash });

    await embedPage(USER, pageId, 'Page', 'DEV', body);

    const chunks = await chunksFor(pageId);
    const authoredCount = chunks.filter((c) => c.metadata.source !== 'image_analysis').length;
    expect(chunks.length - authoredCount).toBe(2);
    // The provider was asked in composition order: authored texts first.
    const authoredVectors = await query<{ v: string }>(
      `SELECT embedding::text AS v FROM page_embeddings
        WHERE page_id = $1 AND (metadata->>'source') IS DISTINCT FROM 'image_analysis' ORDER BY chunk_index`,
      [pageId],
    );
    const vectors = authoredVectors.rows.map((r) => JSON.parse(r.v) as number[]);
    const expected = Array.from({ length: 1024 }, (_, i) => vectors.reduce((s, v) => s + v[i]!, 0) / vectors.length);
    const { avg } = await pageRow(pageId);
    expect(avg).not.toBeNull();
    for (let i = 0; i < 1024; i += 97) expect(avg![i]).toBeCloseTo(expected[i]!, 6);
  });

  it('makes an image-only page embeddable through one substantive analysis, counted by coverage; not without one', async () => {
    const hash = await retainIdentity();
    const body = '<img src="/api/attachments/1/only.png">';
    const pageId = await seedPage(body, 'Screenshot only');
    await query(`UPDATE pages SET body_text = '' WHERE id = $1`, [pageId]);

    const before = await getEmbeddingCoverage(USER);
    await seedAnalysis(pageId, 'only.png', { identityHash: hash });

    const written = await embedPage(USER, pageId, 'Screenshot only', 'DEV', body);

    expect(written).toBe(1);
    const chunks = await chunksFor(pageId);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.chunk_index).toBe(0);
    expect(chunks[0]!.metadata.source).toBe('image_analysis');
    expect(await pageRow(pageId)).toMatchObject({ status: 'embedded', dirty: false, avg: null });
    const coverage = await getEmbeddingCoverage(USER);
    expect(before.totalPages).toBe(0);
    expect(coverage).toEqual({ embeddedPages: 1, totalPages: 1, coverage: 1 });
    expect(await readPageImageAnalysisReadiness(pageId)).toEqual({ readiness: 'complete', embeddingReady: true });

    // URLs and boilerplate never count as substance.
    const urlOnly = await seedPage('<img src="/api/attachments/1/x.png">', 'URL only');
    await query(`UPDATE pages SET body_text = '' WHERE id = $1`, [urlOnly]);
    await seedAnalysis(urlOnly, 'x.png', {
      identityHash: hash,
      payload: { ...PAYLOAD, description: 'https://example.com/a/b/c.png', visibleText: '' },
    });
    expect(await embedPage(USER, urlOnly, 'URL only', 'DEV', '<img src="/api/attachments/1/x.png">')).toBe(0);
    expect(await pageRow(urlOnly)).toMatchObject({ status: 'not_embedded', dirty: false });
  });

  it('composes only currently valid rows: stale identity, bumped version, pending or failed rows are never composed', async () => {
    const hash = await retainIdentity();
    const body = `${PROSE}<img src="/api/attachments/1/valid.png"><img src="/api/attachments/1/stale.png"><img src="/api/attachments/1/old.png"><img src="/api/attachments/1/pend.png">`;
    const pageId = await seedPage(body);
    await seedAnalysis(pageId, 'valid.png', { identityHash: hash });
    await seedAnalysis(pageId, 'stale.png', { identityHash: 'another-identity' });
    await seedAnalysis(pageId, 'old.png', { identityHash: hash, prompt: IMAGE_ANALYSIS_PROMPT_VERSION + 1 });
    await seedAnalysis(pageId, 'pend.png', { identityHash: hash, status: 'pending' });

    await embedPage(USER, pageId, 'Page', 'DEV', body);

    const derived = (await chunksFor(pageId)).filter((c) => c.metadata.source === 'image_analysis');
    expect(derived.map((c) => c.metadata.attachment_key)).toEqual(['valid.png']);
    expect(await readPageImageAnalysisReadiness(pageId)).toMatchObject({ readiness: 'partial' });
  });

  it('composes nothing while no identity is retained, even with analyzed rows on disk', async () => {
    const body = `${PROSE}<img src="/api/attachments/1/a.png">`;
    const pageId = await seedPage(body);
    await seedAnalysis(pageId, 'a.png', { identityHash: 'whatever' });

    await embedPage(USER, pageId, 'Page', 'DEV', body);

    expect((await chunksFor(pageId)).some((c) => c.metadata.source === 'image_analysis')).toBe(false);
  });

  it('never calls anything but the text embedder, and a text-model re-embed sends the cached description again', async () => {
    const hash = await retainIdentity();
    const body = `${PROSE}<img src="/api/attachments/1/a.png">`;
    const pageId = await seedPage(body);
    await seedAnalysis(pageId, 'a.png', { identityHash: hash });

    await embedPage(USER, pageId, 'Page', 'DEV', body);
    const first = cap.texts.filter((t) => t.startsWith('[Image: a.png'));
    cap.texts = [];
    await embedPage(USER, pageId, 'Page', 'DEV', body);
    const second = cap.texts.filter((t) => t.startsWith('[Image: a.png'));

    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    const row = await query<{ analysis_version: number; updated_at: Date }>(
      `SELECT analysis_version FROM page_image_analyses WHERE page_id = $1`,
      [pageId],
    );
    expect(row.rows[0]!.analysis_version).toBe(1);
  });

  it('leaves the page dirty when the analysis revision moved during the embed (D6.3), and clears it on the recompose', async () => {
    const hash = await retainIdentity();
    const body = `${PROSE}<img src="/api/attachments/1/a.png">`;
    const pageId = await seedPage(body);
    await seedAnalysis(pageId, 'a.png', { identityHash: hash });
    const { generateEmbedding } = await import('./openai-compatible-client.js');
    let raced = false;
    vi.mocked(generateEmbedding).mockImplementationOnce(async (_cfg, _model, texts) => {
      const arr = Array.isArray(texts) ? texts : [texts];
      if (!raced) {
        raced = true;
        // A reconcile or an analysis completion lands mid-generate.
        await query(`UPDATE pages SET image_analysis_revision = image_analysis_revision + 1, embedding_dirty = TRUE WHERE id = $1`, [pageId]);
      }
      return arr.map(() => Array.from({ length: 1024 }, (_, i) => Math.sin(i + 1) * 0.01));
    });

    const written = await embedPage(USER, pageId, 'Page', 'DEV', body);

    expect(written).toBeGreaterThan(0);
    expect(await pageRow(pageId)).toMatchObject({ status: 'embedded', dirty: true });

    await embedPage(USER, pageId, 'Page', 'DEV', body);
    expect(await pageRow(pageId)).toMatchObject({ status: 'embedded', dirty: false });
  });

  it('settles a short page without clearing a raise that landed after the composition read (D6.3 on the settle path)', async () => {
    await retainIdentity();
    // Image-only, nothing analyzed yet: the page settles as `not_embedded`.
    const body = '<img src="/api/attachments/1/a.png">';
    const pageId = await seedPage(body);
    let raced = false;
    cap.beforeQuery = async (text) => {
      if (raced || !text.includes("embedding_status = 'not_embedded'")) return;
      raced = true;
      // The first analysis commits between `planDerivedChunks` and the settle
      // write: revision + 1, `embedding_dirty` re-raised.
      await query(`UPDATE pages SET image_analysis_revision = image_analysis_revision + 1, embedding_dirty = TRUE WHERE id = $1`, [pageId]);
    };

    expect(await embedPage(USER, pageId, 'Page', 'DEV', body)).toBe(0);

    expect(raced).toBe(true);
    // The raise survives the settle: the page is picked up by the next pass.
    expect(await pageRow(pageId)).toMatchObject({ status: 'not_embedded', dirty: true });
    cap.beforeQuery = undefined;
    expect(await embedPage(USER, pageId, 'Page', 'DEV', body)).toBe(0);
    expect(await pageRow(pageId)).toMatchObject({ status: 'not_embedded', dirty: false });
  });

  it('a title or caption edit recomposes the context lines from the current page and touches no analysis row', async () => {
    const hash = await retainIdentity();
    const body = '<img src="/api/attachments/1/a.png" alt="Old caption"><p>Some prose on this page to embed.</p>';
    const pageId = await seedPage(body, 'Old title');
    await seedAnalysis(pageId, 'a.png', { identityHash: hash });
    await embedPage(USER, pageId, 'Old title', 'DEV', body);
    const before = await query<{ updated_at: Date; analysis_version: number }>(`SELECT updated_at, analysis_version FROM page_image_analyses WHERE page_id = $1`, [pageId]);

    const edited = '<img src="/api/attachments/1/a.png" alt="New caption"><p>Some prose on this page to embed.</p>';
    await embedPage(USER, pageId, 'New title', 'DEV', edited);

    const derived = (await chunksFor(pageId)).find((c) => c.metadata.source === 'image_analysis')!;
    expect(derived.chunk_text).toContain('Page: New title');
    expect(derived.chunk_text).toContain('Caption (author-supplied): New caption');
    expect(derived.chunk_text).not.toContain('Old');
    const after = await query<{ updated_at: Date; analysis_version: number }>(`SELECT updated_at, analysis_version FROM page_image_analyses WHERE page_id = $1`, [pageId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});
