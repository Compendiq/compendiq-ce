import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';

/**
 * #1614 PR2 — the single-arm runner against real Postgres and the real
 * intake, one arm per process over one seeded database.
 *
 * **#1115 P5b's PAIRED runner and its VL stub server are gone** (#1618
 * stage 2). `runImageEval` ran every query twice in one process, leg-off
 * against leg-on, because ADR-025's image leg was a request flag; with the leg
 * and `page_image_embeddings` retired there is no second arm to force, no
 * `imageHits` to record and no VL endpoint to stub. What survives is
 * `runArmEval`: arm B reads D11's `derived.attachmentKey` as its evidence and
 * arm C must carry none, and the per-arm participation floor is the same
 * argument one arm at a time.
 *
 * The properties this file exists for are the ones no unit test can see: the
 * arms are run over the SAME seeded database by the product's own
 * `hybridSearch`, and each arm's state precondition is read off that database
 * rather than asserted about a fixture.
 */

const TEXT_MODEL_DIMS = 384;
const SEEDED_PAGES = 4;

/**
 * Text vectors hashed from the input, so a chunk and a query land on stable —
 * and different — axes. The text legs only need to be alive.
 */
const { generateEmbeddingMock } = vi.hoisted(() => {
  const axisOf = (text: string): number =>
    parseInt(createHash('sha256').update(text).digest('hex').slice(0, 8), 16) % 384;
  return {
    generateEmbeddingMock: vi.fn(async (_cfg: unknown, _model: string, input: string | string[]) => {
      const texts = Array.isArray(input) ? input : [input];
      return texts.map((text) => {
        const v = Array.from({ length: 384 }, () => 0);
        v[axisOf(text)] = 1;
        return v;
      });
    }),
  };
});
vi.mock('../services/openai-compatible-client.js', async () => {
  const actual = await vi.importActual<typeof import('../services/openai-compatible-client.js')>(
    '../services/openai-compatible-client.js',
  );
  return { ...actual, generateEmbedding: generateEmbeddingMock };
});

const { seedImageCorpus, stageEvalAttachmentsDir, imageAttachmentKey } = await import('./seed-images.js');
const { ensureVectorDimensions, configureEmbeddingProvider, resetEvalCorpus } = await import('./seed.js');
const { loadImageCorpusManifest, IMAGE_CORPUS_DIR } = await import('./corpus-images.js');
const { runArmEval, ImageLegSilentError } = await import('./runner-images.js');
const { hybridSearch } = await import('../services/rag-service.js');
type SearchResult = import('../services/rag-service.js').SearchResult;
const { imageEvidenceRecallAtK, assertArmCState, readArmBState, readImageAnalysisAssignment } = await import('./arms.js');
const { bumpProviderCacheVersion } = await import('../services/cache-bus.js');
type ImageFixture = import('./fixture.js').ImageFixture;
type ImageFixtureLabel = import('./fixture.js').ImageFixtureLabel;

const dbAvailable = await isDbAvailable();
const USER = 'aaaaaaaa-1115-4000-8000-000000005116';

const manifest = loadImageCorpusManifest();
const pages = manifest.pages.slice(0, SEEDED_PAGES);
const target = pages[0]!;
const targetImage = target.images[0]!;

const STEERED_QUERY = 'Welches Bild zeigt das gesuchte Motiv?';

function label(over: Partial<ImageFixtureLabel> & { id: string; query: string }): ImageFixtureLabel {
  return {
    lang: 'de',
    expectedFiles: [target.file],
    expectedImages: [],
    style: 'image',
    rationale: 'test',
    ...over,
  };
}

function fixtureOf(labels: ImageFixtureLabel[]): ImageFixture {
  return { corpusManifestSha: 'test', labeledBy: 'test', notUsable: [], labels };
}

/** First file named `name` under `root`, or null — the attachment tree's layout is the store's business. */
function findFile(root: string, name: string): string | null {
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry === name) {
      return full;
    }
  }
  return null;
}

describe.skipIf(!dbAvailable)('single-arm runner (#1614 PR2, ADR-027 arms)', () => {
  let attachmentsDir: string;
  const previousAttachmentsDir = process.env.ATTACHMENTS_DIR;

  beforeAll(async () => {
    await setupTestDb();
  }, 60_000);

  afterAll(async () => {
    if (attachmentsDir) await rm(attachmentsDir, { recursive: true, force: true });
    if (previousAttachmentsDir === undefined) delete process.env.ATTACHMENTS_DIR;
    else process.env.ATTACHMENTS_DIR = previousAttachmentsDir;
    await ensureVectorDimensions(1024);
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    await query(
      `INSERT INTO users (id, username, email, role, password_hash)
       VALUES ($1::uuid, $1::text, $1::text || '@t', 'admin', 'x') ON CONFLICT (id) DO NOTHING`,
      [USER],
    );
    attachmentsDir = await stageEvalAttachmentsDir();
    await ensureVectorDimensions(TEXT_MODEL_DIMS);
    await configureEmbeddingProvider({ baseUrl: 'http://stub/v1', model: 'stub-embed' });
    await resetEvalCorpus();
  }, 120_000);

  it('refuses a fixture label naming a page the seed never inserted', async () => {
    const { pageIdByFile } = await seedImageCorpus(USER, { maxPages: SEEDED_PAGES });
    const fixture = fixtureOf([label({ id: 'q1', query: STEERED_QUERY, expectedFiles: ['nope.md'] })]);

    await expect(runArmEval(fixture, { arm: 'C', userId: USER, pageIdByFile, topK: 10 }))
      .rejects.toThrow(/never seeded/i);
  }, 120_000);

  it('arm C: seeds text and attachment bytes only and carries no evidence', async () => {
    const seeded = await seedImageCorpus(USER, { maxPages: SEEDED_PAGES });
    expect(seeded.imagesStaged).toBeGreaterThan(0);
    // The bytes are on disk exactly as arm B has them: the arms differ in what
    // the database does with them, not in what they are given.
    const stored = findFile(attachmentsDir, imageAttachmentKey(targetImage.file));
    expect(stored, 'the attachment bytes were written').not.toBeNull();
    expect(readFileSync(stored!).equals(readFileSync(join(IMAGE_CORPUS_DIR, targetImage.file)))).toBe(true);

    const fixture = fixtureOf([label({ id: 'q1', query: STEERED_QUERY, expectedImages: [targetImage.file] })]);
    const result = await runArmEval(fixture, { arm: 'C', userId: USER, pageIdByFile: seeded.pageIdByFile, topK: 10 });

    expect(result.runs[0]!.evidence).toEqual([]);
    expect(result.imageEvidenceParticipatingQueries).toBe(0);
    expect(result.assemblyParticipatingQueries).toBe(1);
    // The evidence scorer reports arm C as none, never as a zero.
    expect(imageEvidenceRecallAtK('C', result.runs, 5)).toBeNull();
  }, 120_000);

  it('arm B: attributes evidence to a row\'s derived.attachmentKey (D11), and to nothing when the key mismatches', async () => {
    const seeded = await seedImageCorpus(USER, { maxPages: SEEDED_PAGES });
    const fixture = fixtureOf([label({ id: 'q1', query: STEERED_QUERY, expectedImages: [targetImage.file] })]);
    // No row on this revision carries `derived` (#1617), so the seam
    // decorates the REAL search's rows with the D11 shape. It decorates
    // WHATEVER the search returned first, not the target page's row: keying
    // the decoration on the target page made the assertion depend on that
    // page reaching the top-10 through the one-hot text legs, so any DB-state
    // shift that moved ranking turned this test into an ImageLegSilentError
    // (it failed in 2 of 3 full-suite runs; review r2 finding 11).
    let decoratedPageId = -1;
    const decorated = (key: string): typeof hybridSearch => async (...args) => {
      const rows = await hybridSearch(...args);
      expect(rows.length, 'the text legs returned something to attribute evidence to').toBeGreaterThan(0);
      decoratedPageId = rows[0]!.pageId;
      return rows.map((r, i): SearchResult => (i === 0 ? { ...r, derived: { attachmentKey: key } } as SearchResult : r));
    };

    const hit = await runArmEval(fixture, { arm: 'B', userId: USER, pageIdByFile: seeded.pageIdByFile, topK: 10, _search: decorated(imageAttachmentKey(targetImage.file)) });
    expect(hit.runs[0]!.evidence.map((e) => e.key)).toEqual([imageAttachmentKey(targetImage.file)]);
    // The rank is the rank of the PAGE that carried it — rank 1 here, because
    // the decorated row is the one the search ranked first.
    expect(hit.runs[0]!.evidence.map((e) => e.rank)).toEqual([1]);
    expect(hit.runs[0]!.retrieved[0]).toBe(decoratedPageId);
    expect(hit.imageEvidenceParticipatingQueries).toBe(1);
    expect(imageEvidenceRecallAtK('B', hit.runs, 10)).toBe(1);

    const miss = await runArmEval(fixture, { arm: 'B', userId: USER, pageIdByFile: seeded.pageIdByFile, topK: 10, _search: decorated('some-other-image.png'), minEvidenceParticipation: 0 });
    expect(imageEvidenceRecallAtK('B', miss.runs, 10)).toBe(0);
  }, 120_000);

  it('readArmBState refuses a database with image_analysis unassigned (O8), on the revision that has the table', async () => {
    // Which of `readArmBState`'s three refusals is reachable depends on the
    // revision. Since #1615's migration 115 `page_image_analyses` EXISTS
    // here, so the table branch is unreachable and the ASSIGNMENT refusal
    // (O8) is the live one — and until now only the call POSITION was pinned
    // (review r2 finding 5). The accepting path needs a real vision
    // assignment, which is #1615's surface and its own tests.
    expect((await query<{ exists: string | null }>(`SELECT to_regclass('public.page_image_analyses') AS exists`)).rows[0]!.exists).not.toBeNull();
    // The assignment row is migration 115's seed, which `truncateAllTables`
    // does not restore, so this test neither depends on what another file
    // left in it nor leaves anything behind — the order-dependence class of
    // review r2 finding 11.
    const previous = await query<{ provider_id: string | null; model: string | null }>(
      `SELECT provider_id, model FROM llm_usecase_assignments WHERE usecase = 'image_analysis'`,
    );
    try {
      await query(`UPDATE llm_usecase_assignments SET provider_id = NULL, model = NULL, updated_at = NOW() WHERE usecase = 'image_analysis'`);
      await expect(readArmBState()).rejects.toThrow(/--arm B needs image_analysis assigned to a vision model on this database/);
    } finally {
      if (previous.rows.length > 0) {
        await query(
          `UPDATE llm_usecase_assignments SET provider_id = $1, model = $2, updated_at = NOW() WHERE usecase = 'image_analysis'`,
          [previous.rows[0]!.provider_id, previous.rows[0]!.model],
        );
      }
    }
  }, 60_000);

  it('arm B REFUSES a run in which no derived evidence ever surfaced, instead of publishing text retrieval as the candidate', async () => {
    const seeded = await seedImageCorpus(USER, { maxPages: SEEDED_PAGES });
    const fixture = fixtureOf([label({ id: 'q1', query: STEERED_QUERY, expectedImages: [targetImage.file] })]);
    const boom = runArmEval(fixture, { arm: 'B', userId: USER, pageIdByFile: seeded.pageIdByFile, topK: 10 });
    await expect(boom).rejects.toBeInstanceOf(ImageLegSilentError);
    await expect(boom).rejects.toThrow(/backfill/);
  }, 120_000);

  it('refuses a row returned under arm C that carries image evidence at all', async () => {
    const { pageIdByFile } = await seedImageCorpus(USER, { maxPages: SEEDED_PAGES });
    const fixture = fixtureOf([label({ id: 'q1', query: STEERED_QUERY, expectedImages: [targetImage.file] })]);
    // Catching the STATE is the entrypoint's job (`assertArmCState`, below);
    // this is the per-query check, and it is the one that sees a derived row
    // that reached a top-K.
    const leaking: typeof hybridSearch = async (...args) => (await hybridSearch(...args)).map((r): SearchResult => ({ ...r, derived: { attachmentKey: 'x.png' } } as SearchResult));
    await expect(runArmEval(fixture, { arm: 'C', userId: USER, pageIdByFile, topK: 10, _search: leaking })).rejects.toThrow(/arm C carrying image evidence/);
  }, 120_000);

  it('assertArmCState passes the ablation and refuses a derived chunk that never reaches a top-K', async () => {
    await seedImageCorpus(USER, { maxPages: SEEDED_PAGES });
    await expect(assertArmCState()).resolves.toBeUndefined();
    // One derived row, ranked nowhere: the runner's per-query check reads
    // the returned window and cannot see it, so the state assertion is the
    // only thing that can (review r1 finding 5).
    const updated = await query(
      `UPDATE page_embeddings SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"source":"image_analysis"}'::jsonb
        WHERE id = (SELECT id FROM page_embeddings ORDER BY id LIMIT 1)`,
    );
    expect(updated.rowCount).toBe(1);
    await expect(assertArmCState()).rejects.toThrow(/derived row\(s\)/);
  }, 120_000);

  // Review r3 finding 1: `assertArmCState` counted rows for
  // `usecase = 'image_analysis'` and called `> 0` assigned, while #1615's
  // migration 115 seeds `('image_analysis', NULL, NULL)` on EVERY database —
  // so `--arm C` aborted on every database it will ever run on. The test
  // above cannot see it because `truncateAllTables` removes that seed; this
  // one puts back exactly what the migration writes, and pins the two arms'
  // predicates against each other, since one shared reader is what stops
  // them drifting again.
  it('reads a MIGRATED database (migration 115\'s seeded row) as unassigned, and arm B refuses exactly where arm C passes', async () => {
    await query(
      `INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('image_analysis', NULL, NULL)
         ON CONFLICT (usecase) DO UPDATE SET provider_id = NULL, model = NULL, updated_at = NOW()`,
    );
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value, updated_at) VALUES ('image_analysis_max_output_tokens', '8192', NOW())
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = '8192'`,
    );
    // The row migration 115 leaves behind is present and is NOT an assignment.
    expect((await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM llm_usecase_assignments WHERE usecase = 'image_analysis'`)).rows[0]!.n).toBe(1);
    expect(await readImageAnalysisAssignment()).toBeNull();
    await expect(assertArmCState()).resolves.toBeUndefined();
    await expect(readArmBState()).rejects.toThrow(/--arm B needs image_analysis assigned to a vision model/);

    // A resolvable provider + model is what "assigned" means, for both arms.
    const provider = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, is_default, default_model)
       VALUES ('arm-c-vision', 'http://vl.invalid/v1', 'none', true, false, 'qwen2.5-vl-7b') RETURNING id`,
    );
    await query(`UPDATE llm_usecase_assignments SET provider_id = $1, model = 'qwen2.5-vl-7b', updated_at = NOW() WHERE usecase = 'image_analysis'`, [provider.rows[0]!.id]);
    await expect(assertArmCState()).rejects.toThrow(/image_analysis is assigned to arm-c-vision:qwen2\.5-vl-7b/);
    expect((await readArmBState()).visionModel.identity).toContain('qwen2.5-vl-7b');

    // Neither arm calls a row that resolves to no model an assignment: the
    // one reader decides it once. The provider's own columns are cached by
    // `resolveImageAnalysisUsecase`, so clearing `default_model` bumps the
    // cache exactly as editing a provider in Settings does.
    await query(`UPDATE llm_usecase_assignments SET model = NULL, updated_at = NOW() WHERE usecase = 'image_analysis'`);
    await query(`UPDATE llm_providers SET default_model = NULL WHERE id = $1`, [provider.rows[0]!.id]);
    await bumpProviderCacheVersion();
    expect(await readImageAnalysisAssignment()).toBeNull();
    await expect(assertArmCState()).resolves.toBeUndefined();
    await expect(readArmBState()).rejects.toThrow(/--arm B needs image_analysis assigned to a vision model/);
  }, 60_000);
});
