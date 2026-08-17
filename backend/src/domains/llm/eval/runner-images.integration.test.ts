import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';

/**
 * #1115 P5b — the paired image runner against real Postgres, the real intake
 * and the real image leg, with only the VL endpoint stubbed at its HTTP
 * boundary.
 *
 * The properties this file exists for are the ones no unit test can see:
 *
 *  - the two arms really are the SAME query against the SAME database, run in
 *    one process — that is what makes McNemar applicable at all;
 *  - `imageLeg: false` really does no VL work (0 requests), so the off arm is
 *    not paying for a leg it is meant to be measuring the absence of;
 *  - `imageLeg: true` embeds the question exactly ONCE, so the leg's query
 *    cost is one call and the paired latency delta means what it says.
 */

const TEXT_MODEL_DIMS = 384;
const VL_DIMS = 64;
const SEEDED_PAGES = 4;

/**
 * Text vectors hashed from the input, so a chunk and a query land on stable —
 * and different — axes. The image axis is what this file steers; the text legs
 * only need to be alive.
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

const { startVlStubServer } = await import('./vl-stub-server.js');
const { seedImageCorpus, prepareImageIndex, stageEvalAttachmentsDir, imageAttachmentKey } =
  await import('./seed-images.js');
const { ensureVectorDimensions, configureEmbeddingProvider, resetEvalCorpus } = await import('./seed.js');
const { loadImageCorpusManifest, IMAGE_CORPUS_DIR } = await import('./corpus-images.js');
const { runImageEval, ImageLegSilentError } = await import('./runner-images.js');
const { imageHitAtK } = await import('./images-metrics.js');
type ImageFixture = import('./fixture.js').ImageFixture;
type ImageFixtureLabel = import('./fixture.js').ImageFixtureLabel;

const dbAvailable = await isDbAvailable();
const USER = 'aaaaaaaa-1115-4000-8000-000000005116';

const manifest = loadImageCorpusManifest();
const pages = manifest.pages.slice(0, SEEDED_PAGES);
const target = pages[0]!;
const targetImage = target.images[0]!;
/**
 * The exact `data:` URI the client builds for the target image.
 *
 * Compared whole, never by prefix: two JPEGs off the same encoder share their
 * SOI/JFIF header, so a 96-character prefix match steered several images onto
 * the target's axis and the "best image" became a tie.
 */
const TARGET_DATA_URL = `data:image/${targetImage.format};base64,${
  readFileSync(join(IMAGE_CORPUS_DIR, targetImage.file)).toString('base64')}`;

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

type VlStub = Awaited<ReturnType<typeof startVlStubServer>>;

describe.skipIf(!dbAvailable)('paired image runner (#1115 P5b)', () => {
  let vl: VlStub;
  let attachmentsDir: string;
  let pageIdByFile: Map<string, number>;
  const previousAttachmentsDir = process.env.ATTACHMENTS_DIR;

  beforeAll(async () => {
    await setupTestDb();
    vl = await startVlStubServer({ dimensions: VL_DIMS });
  }, 60_000);

  afterAll(async () => {
    await vl.close();
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
    vl.reset();
    // One axis for the target image and the steered query, another for
    // everything else — so the leg has something to be right about without a
    // model, exactly as the text runner's topic vectors do.
    vl.axisFor((req) => {
      if (req.isImage) return req.imageDataUrl === TARGET_DATA_URL ? 1 : 2;
      return req.text === STEERED_QUERY ? 1 : 3;
    });
    attachmentsDir = await stageEvalAttachmentsDir();
    await ensureVectorDimensions(TEXT_MODEL_DIMS);
    await configureEmbeddingProvider({ baseUrl: 'http://stub/v1', model: 'stub-embed' });
    await prepareImageIndex({ baseUrl: vl.baseUrl, model: 'stub-vl', targetDimensions: null });
    await resetEvalCorpus();
    ({ pageIdByFile } = await seedImageCorpus(USER, { maxPages: SEEDED_PAGES }));
    // The request LOG only: a full reset would drop the axis steering armed
    // above, and every query would then be embedded by the default hash.
    vl.clearRequests();
  }, 120_000);

  it('runs both arms of every query and pairs them by label id', async () => {
    const fixture = fixtureOf([
      label({ id: 'q1', query: STEERED_QUERY, expectedImages: [targetImage.file] }),
      label({ id: 'q2', query: 'Eine ganz andere Frage über den Text', lang: 'en' }),
    ]);

    const result = await runImageEval(fixture, { userId: USER, pageIdByFile, topK: 10 });

    expect(result.pairs.map((p) => p.queryId)).toEqual(['q1', 'q2']);
    expect(result.totalQueries).toBe(2);
    for (const pair of result.pairs) {
      expect(pair.expected).toEqual([pageIdByFile.get(target.file)]);
      expect(pair.off.retrieved.length).toBeGreaterThan(0);
      expect(pair.on.retrieved.length).toBeGreaterThan(0);
      expect(pair.off.ms).toBeGreaterThan(0);
      expect(pair.on.ms).toBeGreaterThan(0);
    }
    // The fixture's own fields travel onto the pair, or the per-style and
    // per-lang slices are computed over a partition nobody set.
    expect(result.pairs[1]!.lang).toBe('en');
    expect(result.pairs[0]!.expectedImageKeys).toEqual([imageAttachmentKey(targetImage.file)]);
  }, 120_000);

  it('embeds the question exactly ONCE on the leg-on arm and not at all on the leg-off arm', async () => {
    // The whole cost claim rests on this. `imageLeg: false` must do no
    // retrieval work at all — no query embed, no kNN — or the "off" arm is
    // paying for the leg it exists to measure the absence of, and the paired
    // latency delta is not the leg's cost.
    const fixture = fixtureOf([
      label({ id: 'q1', query: STEERED_QUERY, expectedImages: [targetImage.file] }),
      label({ id: 'q2', query: 'Zweite Frage zum selben Korpus' }),
    ]);

    const result = await runImageEval(fixture, { userId: USER, pageIdByFile, topK: 10 });

    // Two queries, two arms each, and exactly two requests reached the
    // endpoint — so the off arms made none and each on arm made one. Counted
    // at the HTTP boundary, because that is the only place "the leg ran" and
    // "the leg contributed a hit" can be told apart.
    expect(vl.requests).toHaveLength(2);
    expect(vl.textRequests()).toHaveLength(2);
    expect(vl.imageRequests()).toHaveLength(0);
    // …and the off arm carries no image evidence, which is the observable
    // consequence a report reader can check.
    for (const pair of result.pairs) expect(pair.off.imageHits).toEqual([]);
  }, 120_000);

  it('records the image hits the leg answered with, keyed the way the fixture names them', async () => {
    const fixture = fixtureOf([label({ id: 'q1', query: STEERED_QUERY, expectedImages: [targetImage.file] })]);

    const result = await runImageEval(fixture, { userId: USER, pageIdByFile, topK: 10 });

    const pair = result.pairs[0]!;
    expect(pair.on.imageHits.length).toBeGreaterThan(0);
    expect(pair.on.imageHits.map((h) => h.key)).toContain(imageAttachmentKey(targetImage.file));
    expect(pair.on.imageHits.every((h) => h.source === 'confluence')).toBe(true);
    // End to end: corpus file → seeded attachment key → leg → runner → metric.
    expect(imageHitAtK(result.pairs, 1)).toBe(1);
    expect(result.imageLegParticipatingQueries).toBe(1);
  }, 120_000);

  it('REFUSES a run in which the image leg never participated, instead of publishing a paired zero', async () => {
    // Every failure mode of the leg is a silent bypass by design: an
    // unassigned model, an empty index, a dead endpoint. Each produces two
    // IDENTICAL arms and a delta of exactly zero — which reads as "the leg
    // does not help" rather than "the leg never ran".
    await query(`TRUNCATE page_image_embeddings`);

    const fixture = fixtureOf([label({ id: 'q1', query: STEERED_QUERY, expectedImages: [targetImage.file] })]);

    const boom = runImageEval(fixture, { userId: USER, pageIdByFile, topK: 10 });
    await expect(boom).rejects.toBeInstanceOf(ImageLegSilentError);
    await expect(boom).rejects.toThrow(/0\/1/);
  }, 120_000);

  it('REFUSES a run whose off arm came back carrying image hits', async () => {
    // `imageLeg: false` is the only thing making the pairing a comparison. If
    // it ever stopped forcing the leg off, both arms would measure the same
    // configuration and every verdict would be a coin flip reported as
    // "no credible change".
    const fixture = fixtureOf([label({ id: 'q1', query: STEERED_QUERY, expectedImages: [targetImage.file] })]);

    const boom = runImageEval(fixture, {
      userId: USER,
      pageIdByFile,
      topK: 10,
      // The seam that makes the invariant testable: the arm the runner sends
      // as "off" is forced back on.
      _forceOffArmLegOn: true,
    });
    await expect(boom).rejects.toBeInstanceOf(ImageLegSilentError);
    await expect(boom).rejects.toThrow(/leg-off arm/i);
  }, 120_000);

  it('refuses a fixture label naming a page the seed never inserted', async () => {
    const fixture = fixtureOf([label({ id: 'q1', query: STEERED_QUERY, expectedFiles: ['nope.md'] })]);

    await expect(runImageEval(fixture, { userId: USER, pageIdByFile, topK: 10 }))
      .rejects.toThrow(/never seeded/i);
  }, 120_000);
});
