import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createServer, type Server, type ServerResponse, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { invalidateRagImageIntakeCache } from '../../../core/services/admin-settings-service.js';
import { bumpProviderCacheVersion } from './cache-bus.js';
import { invalidateDispatcher } from './openai-compatible-client.js';
import { embedPage } from './embedding-service.js';
import { readPageImageAnalysisReadiness } from './image-analysis-readiness.js';
import { retryFailedImageAnalyses, runImageAnalysisBatch } from './image-analysis-worker.js';
import {
  computeIdentityHash,
  IMAGE_ANALYSIS_IDENTITY_KEY,
  IMAGE_ANALYSIS_PROMPT_VERSION,
  IMAGE_ANALYSIS_SCHEMA_VERSION,
  resolveImageAnalysisIdentity,
} from './image-analysis-provider.js';

/**
 * #1616's two INTEGRATED acceptance criteria (issue #1616, AC-3 and AC-4),
 * the ones the issue deliberately deferred until #1615 merged:
 *
 *   "converges after restart/retry **without duplicate vision calls**"
 *   "unchanged and **text-model-only reprocessing reuse cached analysis**"
 *
 * Everything below the criteria is REAL: real Postgres (migrations 115 and
 * 116), the real `analyzeImage` client through the real provider resolution,
 * identity, queue and breaker, the real intake reading real bytes off disk,
 * the real `embedPage`. There is no client double in this file — the previous
 * proof of these two criteria was one, which is exactly why they were
 * scheduled to be re-run here.
 *
 * The boundary is moved out to the WIRE instead: one local HTTP server
 * answering `POST /v1/chat/completions` (the vision leg) and
 * `POST /v1/embeddings` (the text leg), the pattern #1615's own route and
 * client suites use. Every request is counted per image and per model, so
 * "no duplicate vision call" and "the text model changed" are measurements
 * rather than assumptions.
 *
 * NOTE: no real vision model is reachable from CI or from the development
 * host (ADR-027 O8 records the instance as UNASSIGNED), so the analysed
 * CONTENT here is canned. What is being proven is not a model's quality but
 * the pipeline's call discipline, and that is a property of the request count.
 */
const dbAvailable = await isDbAvailable();

const USER = 'aaaaaaaa-1616-4000-8000-000000000002';
const MODEL_VISION = 'qwen3-vl';
const MODEL_TEXT = 'bge-m3';
const MODEL_TEXT_NEXT = 'bge-m3-next';

let server: Server;
let baseUrl: string;
let providerId: string;
let attachmentsDir: string;
let previousAttachmentsDir: string | undefined;

/** Vision calls keyed by the PNG width the request carried (one per image). */
let visionCalls: number[];
/** Widths the endpoint must answer 503 for, until the fault is cleared. */
let visionFaults: Set<number>;
/** Every model an embeddings request asked for, in order. */
let embeddingModels: string[];

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A minimal PNG whose IHDR width doubles as the image's identity on the wire. */
function png(width: number): Buffer {
  const ihdr = Buffer.alloc(8);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(4, 4);
  return Buffer.concat([PNG_SIG, Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), ihdr]);
}

/** The width in the data URL the client posted — which image this call is about. */
function widthOf(body: string): number {
  const parsed = JSON.parse(body) as {
    messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
  };
  const part = parsed.messages[0]!.content.find((c) => c.type === 'image_url');
  const url = part!.image_url!.url;
  const bytes = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  return bytes.readUInt32BE(16);
}

function analysisReply(width: number): string {
  return JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          schemaVersion: IMAGE_ANALYSIS_SCHEMA_VERSION,
          kind: 'screenshot',
          language: 'en',
          description: `A deployment dashboard for image ${width} with stage three marked failed.`,
          visibleText: `Build #48${width} FAILED at stage: integration-tests`,
          limitations: [],
        }),
      },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 910, completion_tokens: 64 },
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => resolve(raw));
  return promise;
}

function json(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

async function seedPage(bodyHtml: string, bodyText: string, title = 'Release notes'): Promise<number> {
  const r = await query<{ id: number }>(
    `INSERT INTO pages (title, space_key, source, visibility, body_html, body_text, body_storage,
                        image_analysis_dirty, embedding_dirty)
     VALUES ($1, 'DEV', 'standalone', 'shared', $2, $3, '', TRUE, TRUE) RETURNING id`,
    [title, bodyHtml, bodyText],
  );
  return r.rows[0]!.id;
}

async function writeAttachment(pageId: number, name: string, bytes: Buffer): Promise<void> {
  const dir = path.join(attachmentsDir, String(pageId));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), bytes);
}

interface Row {
  attachment_key: string;
  status: string;
  error: string | null;
  attempts: number;
  next_attempt_at: Date | null;
  analysis_version: number;
  analyzed_at: Date | null;
  identity_hash: string | null;
  model: string | null;
  base_url: string | null;
  payload: { description?: string } | null;
}
async function rowsFor(pageId: number): Promise<Row[]> {
  return (await query<Row>(
    `SELECT attachment_key, status, error, attempts, next_attempt_at, analysis_version, analyzed_at,
            identity_hash, model, base_url, payload
       FROM page_image_analyses WHERE page_id = $1 ORDER BY attachment_key`,
    [pageId],
  )).rows;
}

async function assignUsecase(usecase: string, model: string): Promise<void> {
  await query(
    `INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ($1, $2, $3)
     ON CONFLICT (usecase) DO UPDATE SET provider_id = EXCLUDED.provider_id, model = EXCLUDED.model`,
    [usecase, providerId, model],
  );
  await bumpProviderCacheVersion();
}

/**
 * The retained identity (D7) exactly as the assignment PUT writes it: the
 * identity the LIVE assignment resolves to, through #1615's own resolver.
 */
async function retainResolvedIdentity(): Promise<string> {
  const resolved = await resolveImageAnalysisIdentity();
  expect(resolved).not.toBeNull();
  expect(resolved!.identityHash).toBe(computeIdentityHash({
    providerId: resolved!.providerId, model: resolved!.model, baseUrl: resolved!.baseUrl,
  }));
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value) VALUES ($1, $2)
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`,
    [IMAGE_ANALYSIS_IDENTITY_KEY, JSON.stringify({
      providerId: resolved!.providerId,
      model: resolved!.model,
      baseUrl: resolved!.baseUrl,
      identityHash: resolved!.identityHash,
      assignedAt: '2026-09-16T00:00:00.000Z',
    })],
  );
  return resolved!.identityHash;
}

/** The cached `true` vision verdict a probe-gated assignment leaves behind (#1615 D3). */
async function seedVisionVerdict(): Promise<void> {
  await query(
    `INSERT INTO llm_model_capabilities (provider_id, model, vision, probed_at)
     VALUES ($1, $2, TRUE, NOW())
     ON CONFLICT (provider_id, model) DO UPDATE SET vision = TRUE, probed_at = NOW()`,
    [providerId, MODEL_VISION],
  );
}

describe.skipIf(!dbAvailable)('image analysis, integrated with #1615 (issue #1616 AC-3 / AC-4)', () => {
  beforeAll(async () => {
    await setupTestDb();
    server = createServer(async (req, res) => {
      const body = await readBody(req);
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const width = widthOf(body);
        visionCalls.push(width);
        if (visionFaults.has(width)) {
          json(res, 503, JSON.stringify({ error: 'PRIVATE_BODY: the vision model is still loading' }));
          return;
        }
        json(res, 200, analysisReply(width));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/embeddings') {
        const parsed = JSON.parse(body) as { model: string; input: string[] };
        embeddingModels.push(parsed.model);
        json(res, 200, JSON.stringify({
          data: parsed.input.map((text, i) => ({
            embedding: Array.from({ length: 1024 }, (_, d) => Math.sin((d + 1) * (i + 1 + text.length)) * 0.01),
          })),
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', () => listening.resolve());
    await listening.promise;
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    previousAttachmentsDir = process.env.ATTACHMENTS_DIR;
    attachmentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cq-image-analysis-integrated-'));
    process.env.ATTACHMENTS_DIR = attachmentsDir;
  }, 30_000);

  afterAll(async () => {
    if (previousAttachmentsDir === undefined) delete process.env.ATTACHMENTS_DIR;
    else process.env.ATTACHMENTS_DIR = previousAttachmentsDir;
    await fs.rm(attachmentsDir, { recursive: true, force: true });
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    invalidateRagImageIntakeCache();
    visionCalls = [];
    visionFaults = new Set();
    embeddingModels = [];
    const prov = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, is_default, default_model)
       VALUES ('integrated-box', $1, 'none', TRUE, TRUE, $2) RETURNING id`,
      [baseUrl, MODEL_TEXT],
    );
    providerId = prov.rows[0]!.id;
    invalidateDispatcher(providerId);
    await assignUsecase('image_analysis', MODEL_VISION);
    await assignUsecase('embedding', MODEL_TEXT);
    await seedVisionVerdict();
  });

  it('converges after a transient provider failure and a retry without a duplicate vision call (AC-3)', async () => {
    const identityHash = await retainResolvedIdentity();
    const pageId = await seedPage(
      '<p>The release pipeline is documented below.</p>'
        + '<img src="/api/attachments/1/a.png"><img src="/api/attachments/1/b.png">',
      'The release pipeline is documented below.',
    );
    await writeAttachment(pageId, 'a.png', png(11));
    await writeAttachment(pageId, 'b.png', png(22));

    // b.png's endpoint is sick for this batch: a 503 is D8's transient
    // `unavailable`, so the batch keeps going and indexes what it got.
    visionFaults.add(22);
    const first = await runImageAnalysisBatch();

    expect(first).toMatchObject({ processed: 1, failed: 1, terminal: 0, reconciledPages: 1, pagesFailed: 0 });
    expect(visionCalls).toEqual([11, 22]);
    const afterFirst = await rowsFor(pageId);
    expect(afterFirst.map((r) => [r.attachment_key, r.status, r.error])).toEqual([
      ['a.png', 'analyzed', null],
      ['b.png', 'failed', 'unavailable:503'],
    ]);
    // The successful half is real evidence written by the real client.
    expect(afterFirst[0]!.payload?.description).toContain('image 11');
    expect(afterFirst[0]!.identity_hash).toBe(identityHash);
    expect(afterFirst[0]!.model).toBe(MODEL_VISION);
    expect(afterFirst[0]!.base_url).toBe(baseUrl);
    expect(afterFirst[1]!.attempts).toBe(1);
    expect(afterFirst[1]!.next_attempt_at!.getTime()).toBeGreaterThan(Date.now());
    expect((await readPageImageAnalysisReadiness(pageId))!.readiness).toBe('partial');
    const analyzedAt = afterFirst[0]!.analyzed_at!.getTime();

    // A cadence before the backoff is due — the shape a worker restart hits
    // first — spends no call at all: not for the analysed row, not for the
    // failed one.
    visionFaults.clear();
    const notDue = await runImageAnalysisBatch();
    expect(notDue).toMatchObject({ processed: 0, failed: 0, reused: 0, repended: 0 });
    expect(visionCalls).toEqual([11, 22]);

    // Retry failed (the operator's restart-equivalent) makes it due, and the
    // fault is gone: the batch converges.
    expect(await retryFailedImageAnalyses()).toBe(1);
    const second = await runImageAnalysisBatch();

    expect(second).toMatchObject({ processed: 1, failed: 0, terminal: 0 });
    // THE CRITERION: b.png was called once more, a.png was never called again.
    expect(visionCalls).toEqual([11, 22, 22]);
    const afterSecond = await rowsFor(pageId);
    expect(afterSecond.map((r) => r.status)).toEqual(['analyzed', 'analyzed']);
    expect(afterSecond[1]!.attempts).toBe(0);
    expect(afterSecond[1]!.error).toBeNull();
    // a.png's committed analysis was not rewritten on the way through.
    expect(afterSecond[0]!.analysis_version).toBe(1);
    expect(afterSecond[0]!.analyzed_at!.getTime()).toBe(analyzedAt);
    expect((await readPageImageAnalysisReadiness(pageId))!.readiness).toBe('complete');

    // And a converged corpus costs nothing per cadence.
    const third = await runImageAnalysisBatch();
    expect(third).toMatchObject({ processed: 0, failed: 0, reused: 0 });
    expect(visionCalls).toEqual([11, 22, 22]);
  }, 30_000);

  it('re-embedding after a text-model change reuses the cached analysis and spends no vision call (AC-4)', async () => {
    await retainResolvedIdentity();
    const body = '<p>The deployment runbook lives here and is long enough to embed on its own.</p>'
      + '<img src="/api/attachments/1/dash.png">';
    const pageId = await seedPage(body, 'The deployment runbook lives here and is long enough to embed on its own.');
    await writeAttachment(pageId, 'dash.png', png(33));

    const batch = await runImageAnalysisBatch();
    expect(batch).toMatchObject({ processed: 1, failed: 0 });
    expect(visionCalls).toEqual([33]);
    const analyzed = (await rowsFor(pageId))[0]!;
    expect(analyzed.status).toBe('analyzed');

    // First embed: the derived chunk is composed from that analysis.
    const written = await embedPage(USER, pageId, 'Runbook', 'DEV', body);
    expect(written).toBeGreaterThan(1);
    const derived = await query<{ chunk_text: string; metadata: { source?: string } }>(
      `SELECT chunk_text, metadata FROM page_embeddings
        WHERE page_id = $1 AND metadata->>'source' = 'image_analysis' ORDER BY chunk_index`,
      [pageId],
    );
    expect(derived.rows).toHaveLength(1);
    expect(derived.rows[0]!.chunk_text).toContain('image 33');
    expect(embeddingModels.every((m) => m === MODEL_TEXT)).toBe(true);
    const embedCallsAfterFirst = embeddingModels.length;

    // ── The text model changes, and NOTHING about the vision identity does.
    await assignUsecase('embedding', MODEL_TEXT_NEXT);
    await query(`UPDATE pages SET embedding_dirty = TRUE WHERE id = $1`, [pageId]);

    const rewritten = await embedPage(USER, pageId, 'Runbook', 'DEV', body);

    expect(rewritten).toBe(written);
    // The text leg really ran again, under the NEW model...
    expect(embeddingModels.length).toBeGreaterThan(embedCallsAfterFirst);
    expect(embeddingModels.slice(embedCallsAfterFirst).every((m) => m === MODEL_TEXT_NEXT)).toBe(true);
    // ...and THE CRITERION: not one further vision call, and the row that
    // holds the analysis was neither re-pended nor re-written.
    expect(visionCalls).toEqual([33]);
    const after = (await rowsFor(pageId))[0]!;
    expect(after.status).toBe('analyzed');
    expect(after.analysis_version).toBe(analyzed.analysis_version);
    expect(after.analyzed_at!.getTime()).toBe(analyzed.analyzed_at!.getTime());
    expect(after.payload).toEqual(analyzed.payload);
    const derivedAfter = await query<{ chunk_text: string }>(
      `SELECT chunk_text FROM page_embeddings
        WHERE page_id = $1 AND metadata->>'source' = 'image_analysis' ORDER BY chunk_index`,
      [pageId],
    );
    expect(derivedAfter.rows.map((r) => r.chunk_text)).toEqual(derived.rows.map((r) => r.chunk_text));

    // A cadence after the text-model change does not re-analyze either: the
    // text embedder is deliberately outside D5's identity and cache key.
    const afterBatch = await runImageAnalysisBatch();
    expect(afterBatch).toMatchObject({ processed: 0, failed: 0, reused: 0, repended: 0 });
    expect(visionCalls).toEqual([33]);
    expect(analyzed.prompt_version ?? IMAGE_ANALYSIS_PROMPT_VERSION).toBe(IMAGE_ANALYSIS_PROMPT_VERSION);
  }, 30_000);
});
