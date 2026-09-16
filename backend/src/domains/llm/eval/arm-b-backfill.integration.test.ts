import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';

/**
 * #1619 — the two gaps that made `--arm B` un-runnable unattended, against
 * real Postgres, the real seeder, the real reconcile, the real analysis
 * worker and the real `embedPage`.
 *
 * GAP 1: nothing raised `pages.image_analysis_dirty`, which IS the analysis
 * queue (ADR-027 D6.2) — migration 116's initial-backlog UPDATE runs before
 * any corpus page exists — so the reconcile claimed nothing and no analysis
 * was ever written.
 *
 * GAP 2: nothing re-embedded after the analyses committed, and `embedPage`
 * is the only writer of derived `page_embeddings` rows — so the top-K carried
 * no derived chunk and `runArmEval` refused arm B at the 50 % evidence floor.
 *
 * The vision model is the ONE boundary moved out to the wire (no real vision
 * model is reachable from CI; ADR-027 O8), exactly as
 * `image-analysis-integrated.integration.test.ts` does it: what is proven
 * here is the pipeline's reachability, never a model's quality. The text
 * embedder is stubbed at the same seam the other eval suites use.
 */

const { generateEmbeddingMock } = vi.hoisted(() => ({
  generateEmbeddingMock: vi.fn(async (_cfg: unknown, _model: string, input: string | string[]) => {
    const texts = Array.isArray(input) ? input : [input];
    return texts.map((t, i) => Array.from({ length: 384 }, (_, j) => Math.sin((j + 1) * (i + 2) + t.length) * 0.01));
  }),
}));
vi.mock('../services/openai-compatible-client.js', async () => {
  const actual = await vi.importActual<typeof import('../services/openai-compatible-client.js')>(
    '../services/openai-compatible-client.js',
  );
  return { ...actual, generateEmbedding: generateEmbeddingMock };
});

const { seedImageCorpus, stageEvalAttachmentsDir } = await import('./seed-images.js');
const { ensureVectorDimensions, configureEmbeddingProvider, resetEvalCorpus } = await import('./seed.js');
const { loadImageCorpusManifest } = await import('./corpus-images.js');
const { driveArmBBackfill, countValidAnalyses } = await import('./arm-b-backfill.js');
const { imageAnalysisIdentityHash } = await import('./arms.js');
const { readImageAnalysisCorpusCounts } = await import('../services/image-analysis-readiness.js');
const { resolveImageAnalysisIdentity, retainImageAnalysisIdentity } = await import('../services/image-analysis-identity.js');
const { bumpProviderCacheVersion } = await import('../services/cache-bus.js');
const { IMAGE_ANALYSIS_SCHEMA_VERSION } = await import('@compendiq/contracts');

const dbAvailable = await isDbAvailable();
const USER = 'aaaaaaaa-1619-4000-8000-000000001619';
const MODEL = 'stub-vision';
const MAX_PAGES = 2;
const TEXT_DIMS = 384;

function readBody(req: IncomingMessage): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => resolve(raw));
  return promise;
}

describe.skipIf(!dbAvailable)('arm B backfill driver (#1619)', () => {
  let server: Server;
  let baseUrl: string;
  let providerId: string;
  let identityHash: string;
  let attachmentsDir: string;
  let visionCalls = 0;
  const previousAttachmentsDir = process.env.ATTACHMENTS_DIR;

  beforeAll(async () => {
    await setupTestDb();
    server = createServer((req, res) => {
      void readBody(req).then(() => {
        visionCalls++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                schemaVersion: IMAGE_ANALYSIS_SCHEMA_VERSION,
                kind: 'diagram',
                language: 'de',
                description: 'Ein Schaubild mit drei beschrifteten Ebenen und einem Pfeil nach rechts.',
                visibleText: 'Ebene 1 Ebene 2 Ebene 3',
                limitations: [],
              }),
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 900, completion_tokens: 120 },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (attachmentsDir) await rm(attachmentsDir, { recursive: true, force: true });
    if (previousAttachmentsDir === undefined) delete process.env.ATTACHMENTS_DIR;
    else process.env.ATTACHMENTS_DIR = previousAttachmentsDir;
    await ensureVectorDimensions(1024);
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    visionCalls = 0;
    await query(
      `INSERT INTO users (id, username, email, role, password_hash)
       VALUES ($1::uuid, $1::text, $1::text || '@t', 'admin', 'x') ON CONFLICT (id) DO NOTHING`,
      [USER],
    );
    attachmentsDir = await stageEvalAttachmentsDir();
    await ensureVectorDimensions(TEXT_DIMS);
    await configureEmbeddingProvider({ baseUrl: 'http://stub/v1', model: 'stub-embed' });
    const provider = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, is_default, default_model)
       VALUES ('stub-vision-provider', $1, 'none', true, false, $2) RETURNING id`,
      [baseUrl, MODEL],
    );
    providerId = provider.rows[0]!.id;
    await query(
      `INSERT INTO llm_usecase_assignments (usecase, provider_id, model, updated_at)
       VALUES ('image_analysis', $1, $2, NOW())
       ON CONFLICT (usecase) DO UPDATE SET provider_id = $1, model = $2, updated_at = NOW()`,
      [providerId, MODEL],
    );
    // The capability gate is a probed row (migration 087); the probe itself is
    // #1615's subject and is not what this file is about.
    await query(
      `INSERT INTO llm_model_capabilities (provider_id, model, vision, probed_at)
       VALUES ($1, $2, TRUE, NOW())
       ON CONFLICT (provider_id, model) DO UPDATE SET vision = TRUE, probed_at = NOW()`,
      [providerId, MODEL],
    );
    identityHash = imageAnalysisIdentityHash(providerId, MODEL, baseUrl);
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
       VALUES ('image_analysis_max_output_tokens', '8192', NOW())
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
    );
    bumpProviderCacheVersion();
    // D7's retained identity, written by its ONE writer rather than by hand:
    // a row the worker cannot parse reads as none and shuts the gate
    // (`identity_drift`).
    const resolved = await resolveImageAnalysisIdentity();
    if (!resolved) throw new Error('the test fixture did not assign image_analysis');
    await retainImageAnalysisIdentity(resolved);
    expect(resolved.identityHash).toBe(identityHash);
    await resetEvalCorpus();
  }, 60_000);

  const manifest = loadImageCorpusManifest();
  const seededPages = manifest.pages.slice(0, MAX_PAGES);
  const expectedImages = seededPages.reduce((n, p) => n + p.images.length, 0);

  const state = () => ({
    visionModel: { identity: `stub:${MODEL}@${baseUrl}`, model: MODEL, endpoint: baseUrl },
    imageAnalysisMaxOutputTokens: 8192,
    identityHash,
  });

  it('GAP 1: the seed leaves every corpus page claimable by the reconcile', async () => {
    await seedImageCorpus(USER, { maxPages: MAX_PAGES, imageIndex: false });

    // The flag IS the queue: without it `reconcileDirtyPages` claims nothing,
    // no `page_image_analyses` row is ever written and the run dies at its
    // `--backfill-timeout` with 0 valid analyses.
    const dirty = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages
        WHERE image_analysis_dirty AND deleted_at IS NULL AND COALESCE(page_type, 'page') <> 'folder'`,
    );
    expect(dirty.rows[0]!.n).toBe(MAX_PAGES);
    expect((await readImageAnalysisCorpusCounts()).dirtyPages).toBe(MAX_PAGES);
  }, 180_000);

  it('GAP 2: driving the product\'s worker analyses every image AND re-embeds, so derived chunks exist', async () => {
    await seedImageCorpus(USER, { maxPages: MAX_PAGES, imageIndex: false });
    // The seed embedded the authored text once; nothing has analysed anything.
    expect(await countValidAnalyses(identityHash)).toMatchObject({ analyzed: 0 });

    const result = await driveArmBBackfill(state(), expectedImages, { userId: USER, timeoutMs: 120_000 });

    expect(result.analyses).toBe(expectedImages);
    expect(result.versions.schema).toBe(IMAGE_ANALYSIS_SCHEMA_VERSION);
    expect(result.batches).toBeGreaterThan(0);
    expect(visionCalls).toBe(expectedImages);
    // One vision call per image, and nothing left for the next cadence.
    const counts = await readImageAnalysisCorpusCounts();
    expect(counts.rows).toMatchObject({ analyzed: expectedImages, pending: 0, failed: 0, terminal: 0, skipped: 0 });
    expect(counts.dirtyPages).toBe(0);
    // THE point of gap 2: `embedPage` is the only writer of derived chunks, so
    // without the re-embed pass the top-K carries none and arm B is refused at
    // the evidence floor.
    expect(counts.pagesAwaitingEmbed).toBe(0);
    expect(result.embedPasses).toBeGreaterThan(0);
    const derived = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM page_embeddings WHERE metadata->>'source' = 'image_analysis'`,
    );
    expect(derived.rows[0]!.n).toBeGreaterThan(0);
  }, 300_000);

  it('refuses a terminal row rather than spending the whole timeout on a backfill that cannot complete', async () => {
    await seedImageCorpus(USER, { maxPages: MAX_PAGES, imageIndex: false });
    await driveArmBBackfill(state(), expectedImages, { userId: USER, timeoutMs: 120_000 });
    // A deterministic failure five attempts deep (D13) is re-opened only by
    // raising the ceiling, so the valid count can never reach the corpus.
    await query(
      `UPDATE page_image_analyses SET status = 'failed_terminal', error = 'truncated:8192', payload = NULL
        WHERE attachment_key = (SELECT MIN(attachment_key) FROM page_image_analyses)`,
    );

    await expect(driveArmBBackfill(state(), expectedImages, { userId: USER, timeoutMs: 1000 }))
      .rejects.toThrow(/failed_terminal.*8192 output tokens.*no further attempt re-opens/s);
  }, 300_000);
});
