import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import type { AskFn } from './answers.js';
import type { ImageFixture, ImageFixtureLabel } from './fixture.js';

/**
 * #1823 — `run-arm-answers.ts` labels every answer with its `--arm`, so the
 * database the ask route reads must BE that arm when the first question is
 * asked, and `--report` must describe that database. Against real Postgres,
 * the real seeder, the real analysis worker and the real `embedPage`: a
 * wrong or incomplete arm state is refused before a single completion
 * request, and a correctly prepared state is still asked every question.
 *
 * The ask boundary is a spy — what is proven is WHETHER it is reached, never
 * an answer's quality (no real model is reachable from CI). The vision model
 * is a stub HTTP server and the text embedder is stubbed at the seam the
 * other eval suites use, exactly as `arm-b-backfill.integration.test.ts`.
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

// Dynamic, like every import in this block: the hoisted `vi.mock` above must be
// registered before the module graph is pulled in.
const { seedImageCorpus, stageEvalAttachmentsDir } = await import('./seed-images.js');
const { ensureVectorDimensions, configureEmbeddingProvider, resetEvalCorpus } = await import('./seed.js');
const { loadImageCorpusManifest } = await import('./corpus-images.js');
const { driveArmBBackfill } = await import('./arm-b-backfill.js');
const { armReport } = await import('./arm-report-fixtures.js');
const { generateLiveArmAnswers } = await import('./arm-live-state.js');
const { assertDisposableDatabase } = await import('./disposable-db.js');
const { resolveImageAnalysisIdentity, retainImageAnalysisIdentity } = await import('../services/image-analysis-identity.js');
const { bumpProviderCacheVersion } = await import('../services/cache-bus.js');
const { IMAGE_ANALYSIS_SCHEMA_VERSION } = await import('@compendiq/contracts');

const dbAvailable = await isDbAvailable();
const USER = 'aaaaaaaa-1823-4000-8000-000000001823';
const VISION_MODEL = 'stub-vision';
const VISION_PROVIDER = 'stub-vision-provider';
const MAX_PAGES = 1;
const TEXT_DIMS = 384;
const EMBED = { baseUrl: 'http://stub/v1', model: 'stub-embed' };
const FTS = 'german';

const expectedImages = loadImageCorpusManifest().pages.slice(0, MAX_PAGES).reduce((n, p) => n + p.images.length, 0);

function label(over: Partial<ImageFixtureLabel> & { id: string; query: string }): ImageFixtureLabel {
  return { lang: 'de', expectedFiles: ['page-1.md'], expectedImages: ['images/page-1__1.png'], style: 'image', rationale: '', ...over };
}

const fx: ImageFixture = {
  corpusManifestSha: 'test',
  labeledBy: 'test',
  notUsable: [],
  labels: [
    label({ id: 'img-01-a', query: 'Was zeigt das erste Bild?' }),
    label({ id: 'neg-01', query: 'Frage ohne Bild', expectedImages: [], style: 'image-negative' }),
  ],
};

/** The ask boundary: it answers like the route, and records whether it was ever reached. */
const askSpy = () => vi.fn<AskFn>(async (question) => ({ answer: `zu: ${question}`, refused: false, refusalReason: null, sources: [] }));

describe.skipIf(!dbAvailable)('live arm certification before answers (#1823)', () => {
  let server: Server;
  let visionBaseUrl: string;
  let attachmentsDir: string | undefined;
  const previousAttachmentsDir = process.env.ATTACHMENTS_DIR;

  /** The embedder and FTS half both arms share, as `run-retrieval-eval.ts` leaves it. */
  const embedder = () => ({ identity: `eval-embedding:${EMBED.model}@${EMBED.baseUrl}`, model: EMBED.model, endpoint: EMBED.baseUrl, dims: TEXT_DIMS });
  const visionModel = () => ({ identity: `${VISION_PROVIDER}:${VISION_MODEL}@${visionBaseUrl}`, model: VISION_MODEL, endpoint: visionBaseUrl });
  const cReport = () => armReport('C', { embedder: embedder(), ftsLanguage: FTS });
  const bReport = (versions: { prompt: number; schema: number }) =>
    armReport('B', { embedder: embedder(), ftsLanguage: FTS, visionModel: visionModel(), imageAnalysisMaxOutputTokens: 8192, imageAnalysisVersions: versions });

  /** A fresh disposable database with the shared text half; arm B also gets its vision assignment. */
  async function prepare(arm: 'B' | 'C'): Promise<void> {
    await truncateAllTables();
    await query(
      `INSERT INTO users (id, username, email, role, password_hash)
       VALUES ($1::uuid, $1::text, $1::text || '@t', 'admin', 'x') ON CONFLICT (id) DO NOTHING`,
      [USER],
    );
    if (attachmentsDir) await rm(attachmentsDir, { recursive: true, force: true });
    attachmentsDir = await stageEvalAttachmentsDir();
    await ensureVectorDimensions(TEXT_DIMS);
    await configureEmbeddingProvider(EMBED);
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value, updated_at) VALUES ('fts_language', $1, NOW())
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
      [FTS],
    );
    if (arm === 'B') {
      const provider = await query<{ id: string }>(
        `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, is_default, default_model)
         VALUES ($1, $2, 'none', true, false, $3) RETURNING id`,
        [VISION_PROVIDER, visionBaseUrl, VISION_MODEL],
      );
      const providerId = provider.rows[0]!.id;
      await query(
        `INSERT INTO llm_usecase_assignments (usecase, provider_id, model, updated_at)
         VALUES ('image_analysis', $1, $2, NOW())
         ON CONFLICT (usecase) DO UPDATE SET provider_id = $1, model = $2, updated_at = NOW()`,
        [providerId, VISION_MODEL],
      );
      await query(
        `INSERT INTO llm_model_capabilities (provider_id, model, vision, probed_at)
         VALUES ($1, $2, TRUE, NOW())
         ON CONFLICT (provider_id, model) DO UPDATE SET vision = TRUE, probed_at = NOW()`,
        [providerId, VISION_MODEL],
      );
      await query(
        `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
         VALUES ('image_analysis_max_output_tokens', '8192', NOW())
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
      );
    }
    await bumpProviderCacheVersion();
    if (arm === 'B') {
      const resolved = await resolveImageAnalysisIdentity();
      if (!resolved) throw new Error('the test fixture did not assign image_analysis');
      await retainImageAnalysisIdentity(resolved);
    }
    await resetEvalCorpus();
    await seedImageCorpus(USER, { maxPages: MAX_PAGES, imageIndex: false });
  }

  beforeAll(async () => {
    await setupTestDb();
    // Arm state is written and wiped below: only ever on a disposable database.
    assertDisposableDatabase(process.env.POSTGRES_URL!);
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
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
    const listening = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', () => listening.resolve());
    await listening.promise;
    visionBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  }, 60_000);

  afterAll(async () => {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
    if (attachmentsDir) await rm(attachmentsDir, { recursive: true, force: true });
    if (previousAttachmentsDir === undefined) delete process.env.ATTACHMENTS_DIR;
    else process.env.ATTACHMENTS_DIR = previousAttachmentsDir;
    await ensureVectorDimensions(1024);
    await teardownTestDb();
  });

  describe('a database driven to arm B', () => {
    let versions: { prompt: number; schema: number };

    beforeAll(async () => {
      await prepare('B');
      ({ versions } = await driveArmBBackfill(
        { visionModel: visionModel(), imageAnalysisMaxOutputTokens: 8192, identityHash: (await resolveImageAnalysisIdentity())!.identityHash },
        expectedImages,
        { userId: USER, timeoutMs: 120_000 },
      ));
      expect(versions.schema).toBe(IMAGE_ANALYSIS_SCHEMA_VERSION);
    }, 300_000);

    it('refuses --arm C with a valid C report on a database driven to B — no ask', async () => {
      const ask = askSpy();
      await expect(generateLiveArmAnswers(ask, fx, { arm: 'C', report: cReport(), userId: USER, expectedImages }))
        .rejects.toThrow(/arm C: this database is not in the ablation's state/);
      expect(ask).not.toHaveBeenCalled();
    });

    it('refuses a B report whose vision model / version pair differs from the live state — no ask', async () => {
      const ask = askSpy();
      const stale = bReport({ prompt: versions.prompt + 1, schema: versions.schema });
      stale.visionModel = { identity: `${VISION_PROVIDER}:other-vl@${visionBaseUrl}`, model: 'other-vl', endpoint: visionBaseUrl };
      await expect(generateLiveArmAnswers(ask, fx, { arm: 'B', report: stale, userId: USER, expectedImages }))
        .rejects.toThrow(/^--report does not describe this database: visionModel: .*other-vl.*; imageAnalysisVersions: /);
      expect(ask).not.toHaveBeenCalled();
    });

    it('refuses a B report written under another embedder or FTS configuration — no ask', async () => {
      const ask = askSpy();
      const other = bReport(versions);
      other.embedder = { ...other.embedder, model: 'bge-m3', dims: 1024 };
      other.ftsLanguage = 'simple';
      await expect(generateLiveArmAnswers(ask, fx, { arm: 'B', report: other, userId: USER, expectedImages }))
        .rejects.toThrow(/embedder\.model: .*embedder\.dims: .*ftsLanguage: /);
      expect(ask).not.toHaveBeenCalled();
    });

    it('accepts a correctly prepared B with its report', async () => {
      const ask = askSpy();
      const generated = await generateLiveArmAnswers(ask, fx, { arm: 'B', report: bReport(versions), userId: USER, expectedImages });
      expect(ask).toHaveBeenCalledTimes(fx.labels.length);
      expect(generated.answers).toHaveLength(fx.labels.length);
      expect(Object.values(generated.mapping).every((m) => m.arm === 'B')).toBe(true);
    });
  });

  it('refuses --arm B before the backfill completed — no ask', async () => {
    await prepare('B');
    const ask = askSpy();
    await expect(generateLiveArmAnswers(ask, fx, { arm: 'B', report: null, userId: USER, expectedImages }))
      .rejects.toThrow(/--arm B: 0\/\d+ corpus images carry a valid analysis/);
    expect(ask).not.toHaveBeenCalled();
  }, 300_000);

  it('accepts a correctly prepared C (image_analysis unassigned) with its report', async () => {
    await prepare('C');
    const ask = askSpy();
    const generated = await generateLiveArmAnswers(ask, fx, { arm: 'C', report: cReport(), userId: USER, expectedImages });
    expect(ask).toHaveBeenCalledTimes(fx.labels.length);
    expect(Object.values(generated.mapping).every((m) => m.arm === 'C')).toBe(true);
  }, 300_000);
});
