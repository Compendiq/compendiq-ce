import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
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
const { runImageEval, runArmEval, ImageLegSilentError } = await import('./runner-images.js');
const { hybridSearch } = await import('../services/rag-service.js');
type SearchResult = import('../services/rag-service.js').SearchResult;
const { invalidateRagImageLegCache } = await import('../../../core/services/admin-settings-service.js');
const { flushSearchAnalytics } = await import('../services/rag-service.js');
const { imageHitAtK } = await import('./images-metrics.js');
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
    // The knob below is cached for 60s, and TRUNCATE does not reach a cache: a
    // `false` written by one case would otherwise stand for the rest of the file
    // and silently disable the leg in every test after it.
    invalidateRagImageLegCache();
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
    // Both stages really run on both arms, so both are counted rather than
    // published as a hardcoded zero — which on the text gate is the state
    // `runner.ts` REFUSES to publish (review r1).
    expect(result.assemblyParticipatingQueries.on).toBe(2);
    expect(result.assemblyParticipatingQueries.off).toBe(2);
    // Per arm, never summed: the report denominates these by the label count,
    // so an arm-query total would print participation above 100%.
    expect(result.expansionParticipatingQueries).toEqual({ off: 0, on: 0 });
    expect(result.expansionSkippedQueries).toEqual({ off: 0, on: 0 });
  }, 120_000);

  it('interleaves the two arms per query and alternates which one goes first', async () => {
    // Two properties, both invisible in the pairs alone and both load-bearing
    // for `queryCostMs` (review r1). A BLOCK design — every off arm, then every
    // on arm — passes every other assertion in this file, and a fixed off-first
    // order charges each query's first-touch cost to the off arm and publishes
    // the difference as the leg's cost. The text embedder is the observable:
    // each arm embeds its question once, so an interleaved run reads
    // q1,q1,q2,q2 and a block run q1,q2,q1,q2.
    const fixture = fixtureOf([
      label({ id: 'q1', query: STEERED_QUERY, expectedImages: [targetImage.file] }),
      label({ id: 'q2', query: 'Zweite Frage zum selben Korpus' }),
      label({ id: 'q3', query: 'Dritte Frage zum selben Korpus' }),
    ]);
    generateEmbeddingMock.mockClear();

    const result = await runImageEval(fixture, { userId: USER, pageIdByFile, topK: 10 });

    const embedded = generateEmbeddingMock.mock.calls.map((call) => String(call[2]));
    expect(embedded).toHaveLength(6);
    expect(embedded[0]).toBe(embedded[1]);
    expect(embedded[2]).toBe(embedded[3]);
    expect(embedded[4]).toBe(embedded[5]);
    expect(new Set(embedded).size).toBe(3);
    // …and the order inside each pair alternates deterministically on the
    // label index, so the warm-up cost lands on both arms rather than one.
    expect(result.pairs.map((p) => p.offFirst)).toEqual([true, false, true]);
    // Asserted against WHAT RAN, not against the recorded flag (review r3).
    // `offFirst` is `index % 2 === 0` and is pushed onto the pair from that same
    // expression, so the line above compares it with itself: replacing the
    // branch with an unconditional off-then-on left all 9 tests in this file
    // green. `startedAt` is stamped inside each arm, so this comparison reads
    // the branch that actually executed.
    for (const pair of result.pairs) {
      expect(pair.off.startedAt < pair.on.startedAt).toBe(pair.offFirst);
    }
  }, 120_000);

  it('records no search_analytics row: each question is asked twice and nobody asked either', async () => {
    // `recordAnalytics: false` on both arms. Without it every image-axis
    // question is filed twice, once as a leg-off variant nobody typed, in the
    // table the product's own search analytics are read out of.
    const fixture = fixtureOf([
      label({ id: 'q1', query: STEERED_QUERY, expectedImages: [targetImage.file] }),
      label({ id: 'q2', query: 'Zweite Frage zum selben Korpus' }),
    ]);

    await runImageEval(fixture, { userId: USER, pageIdByFile, topK: 10 });

    // The writes are fire-and-forget, so a count taken without draining them
    // passes whether or not they were requested.
    await flushSearchAnalytics();
    const rows = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM search_analytics`);
    expect(rows.rows[0]!.n).toBe(0);
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

  it('FORCES the leg in both directions, past whatever admin_settings says (review r2)', async () => {
    // Decision 2 has two halves and only the off one was pinned. The on arm
    // passing `imageLeg: true` — rather than leaving the flag off and inheriting
    // the global setting — is what makes the run reproducible on a database
    // whose `rag_image_leg_enabled` is false: a restored dump, or a knob an
    // operator flipped while debugging P3. Inheriting it there would run leg-off
    // against leg-off, which is the identical-arms state every other refusal in
    // this file exists to prevent.
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
       VALUES ('rag_image_leg_enabled', 'false', NOW())
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = 'false', updated_at = NOW()`,
    );
    invalidateRagImageLegCache();

    const fixture = fixtureOf([label({ id: 'q1', query: STEERED_QUERY, expectedImages: [targetImage.file] })]);

    const result = await runImageEval(fixture, { userId: USER, pageIdByFile, topK: 10 });

    expect(result.pairs[0]!.on.imageHits.length).toBeGreaterThan(0);
    expect(result.pairs[0]!.off.imageHits).toEqual([]);
    // …and exactly one VL query embed, from the on arm alone.
    expect(vl.textRequests()).toHaveLength(1);
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

  it('REFUSES a run whose off arm came back carrying image hits, on the FIRST such query', async () => {
    // `imageLeg: false` is the only thing making the pairing a comparison. If
    // it ever stopped forcing the leg off, both arms would measure the same
    // configuration and every verdict would be a coin flip reported as
    // "no credible change".
    //
    // Three labels rather than one, because WHEN it refuses is the property
    // (review r3): a flag that does not force is a fact about the code path and
    // is fully decided by the first query, so an operator on a real VL endpoint
    // must not pay all 309 labels × 2 arms to be told the rig was never a pair.
    // The participation floor beside it stays post-loop — a bypass really can
    // be intermittent.
    const fixture = fixtureOf([
      label({ id: 'q1', query: STEERED_QUERY, expectedImages: [targetImage.file] }),
      label({ id: 'q2', query: 'Zweite Frage zum selben Korpus' }),
      label({ id: 'q3', query: 'Dritte Frage zum selben Korpus' }),
    ]);

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
    // Two VL query embeds, not six: the first pair's two arms and then nothing.
    // Counted at the endpoint, which is the one place "it stopped" is visible.
    expect(vl.textRequests()).toHaveLength(2);
  }, 120_000);

  it('refuses a fixture label naming a page the seed never inserted', async () => {
    const fixture = fixtureOf([label({ id: 'q1', query: STEERED_QUERY, expectedFiles: ['nope.md'] })]);

    await expect(runImageEval(fixture, { userId: USER, pageIdByFile, topK: 10 }))
      .rejects.toThrow(/never seeded/i);
  }, 120_000);
});

/**
 * #1614 PR2 — the single-arm runner on the same rig: arm A is the leg-on
 * arm above, one arm per process; arm C seeds WITHOUT the image phase and
 * must leave `page_image_embeddings` empty; arm B's attribution reads D11's
 * `derived.attachmentKey`, which no row on this revision carries, so the
 * test decorates the real search's rows through the `_search` seam.
 */
describe.skipIf(!dbAvailable)('single-arm runner (#1614 PR2, ADR-027 arms)', () => {
  let vl: VlStub;
  let attachmentsDir: string;
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
    invalidateRagImageLegCache();
    await query(
      `INSERT INTO users (id, username, email, role, password_hash)
       VALUES ($1::uuid, $1::text, $1::text || '@t', 'admin', 'x') ON CONFLICT (id) DO NOTHING`,
      [USER],
    );
    vl.reset();
    vl.axisFor((req) => {
      if (req.isImage) return req.imageDataUrl === TARGET_DATA_URL ? 1 : 2;
      return req.text === STEERED_QUERY ? 1 : 3;
    });
    attachmentsDir = await stageEvalAttachmentsDir();
    await ensureVectorDimensions(TEXT_MODEL_DIMS);
    await configureEmbeddingProvider({ baseUrl: 'http://stub/v1', model: 'stub-embed' });
    await resetEvalCorpus();
  }, 120_000);

  const imageRows = async (): Promise<number> =>
    (await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM page_image_embeddings`)).rows[0]!.n;

  it('arm A: one search per label, leg forced on, evidence keyed like the fixture and ranked by page', async () => {
    await prepareImageIndex({ baseUrl: vl.baseUrl, model: 'stub-vl', targetDimensions: null });
    const { pageIdByFile } = await seedImageCorpus(USER, { maxPages: SEEDED_PAGES });
    vl.clearRequests();
    const fixture = fixtureOf([
      label({ id: 'q1', query: STEERED_QUERY, expectedImages: [targetImage.file] }),
      label({ id: 'n1', query: 'Eine Frage ohne passendes Bild', style: 'image-negative' }),
    ]);

    const result = await runArmEval(fixture, { arm: 'A', userId: USER, pageIdByFile, topK: 10 });

    expect(result.runs.map((r) => r.queryId)).toEqual(['q1', 'n1']);
    expect(result.runs[0]!.cluster).toBe(target.file);
    expect(result.runs[0]!.expectedImageKeys).toEqual([imageAttachmentKey(targetImage.file)]);
    // `rank` is the 1-based rank of the PAGE that carried the evidence —
    // the invariant image-evidence R@5 and leakage@1 both read. Pinned
    // against the run's own ranked page list, not against `>= 1` (which
    // `rankedEvidence` cannot violate; review r1 finding 17).
    const targetPageRank = result.runs[0]!.retrieved.indexOf(pageIdByFile.get(target.file)!) + 1;
    expect(targetPageRank).toBeGreaterThan(0);
    expect(result.runs[0]!.evidence.filter((e) => e.key === imageAttachmentKey(targetImage.file)).map((e) => e.rank)).toEqual([targetPageRank]);
    expect(result.imageEvidenceParticipatingQueries).toBeGreaterThanOrEqual(1);
    // One VL query embed per label — one arm, one search.
    expect(vl.textRequests()).toHaveLength(2);
    expect(result.assemblyParticipatingQueries).toBe(2);
  }, 120_000);

  it('arm C: seeds text and attachment bytes only, leaves page_image_embeddings empty and carries no evidence', async () => {
    const seeded = await seedImageCorpus(USER, { maxPages: SEEDED_PAGES, imageIndex: false });
    expect(seeded.imagesEmbedded).toBe(0);
    expect(seeded.imageEmbedWallClockMs).toBe(0);
    expect(await imageRows()).toBe(0);
    // The bytes are on disk exactly as arm A has them: the arms differ in
    // what the revision does with them, not in what they are given.
    const stored = findFile(attachmentsDir, imageAttachmentKey(targetImage.file));
    expect(stored, 'the attachment bytes were written').not.toBeNull();
    expect(readFileSync(stored!).equals(readFileSync(join(IMAGE_CORPUS_DIR, targetImage.file)))).toBe(true);

    const fixture = fixtureOf([label({ id: 'q1', query: STEERED_QUERY, expectedImages: [targetImage.file] })]);
    const result = await runArmEval(fixture, { arm: 'C', userId: USER, pageIdByFile: seeded.pageIdByFile, topK: 10 });

    expect(result.runs[0]!.evidence).toEqual([]);
    expect(result.imageEvidenceParticipatingQueries).toBe(0);
    expect(vl.requests).toHaveLength(0);
    // The evidence scorer reports arm C as none, never as a zero.
    expect(imageEvidenceRecallAtK('C', result.runs, 5)).toBeNull();
  }, 120_000);

  it('arm B: attributes evidence to a row\'s derived.attachmentKey (D11), and to nothing when the key mismatches', async () => {
    const seeded = await seedImageCorpus(USER, { maxPages: SEEDED_PAGES, imageIndex: false });
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
    expect(vl.requests).toHaveLength(0);
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
    const seeded = await seedImageCorpus(USER, { maxPages: SEEDED_PAGES, imageIndex: false });
    const fixture = fixtureOf([label({ id: 'q1', query: STEERED_QUERY, expectedImages: [targetImage.file] })]);
    const boom = runArmEval(fixture, { arm: 'B', userId: USER, pageIdByFile: seeded.pageIdByFile, topK: 10 });
    await expect(boom).rejects.toBeInstanceOf(ImageLegSilentError);
    await expect(boom).rejects.toThrow(/backfill/);
  }, 120_000);

  it('arm C on a filled image index: the runner does no VL work, surfaces no evidence, and refuses a row that carries any', async () => {
    await prepareImageIndex({ baseUrl: vl.baseUrl, model: 'stub-vl', targetDimensions: null });
    const { pageIdByFile } = await seedImageCorpus(USER, { maxPages: SEEDED_PAGES });
    expect(await imageRows()).toBeGreaterThan(0);
    vl.clearRequests();
    const fixture = fixtureOf([label({ id: 'q1', query: STEERED_QUERY, expectedImages: [targetImage.file] })]);
    // The runner forces the leg OFF on C, so the filled index yields no leg
    // hits and no evidence. Catching the STATE is the entrypoint's job
    // (`assertArmCState`, below) — this title used to claim the refusal the
    // body never exercised (review r1 finding 17).
    const result = await runArmEval(fixture, { arm: 'C', userId: USER, pageIdByFile, topK: 10 });
    expect(result.runs[0]!.evidence).toEqual([]);
    expect(vl.textRequests()).toHaveLength(0);
    // …and a C row that somehow carried evidence is refused on that query.
    const leaking: typeof hybridSearch = async (...args) => (await hybridSearch(...args)).map((r): SearchResult => ({ ...r, derived: { attachmentKey: 'x.png' } } as SearchResult));
    await expect(runArmEval(fixture, { arm: 'C', userId: USER, pageIdByFile, topK: 10, _search: leaking })).rejects.toThrow(/arm C carrying image evidence/);
  }, 120_000);

  it('assertArmCState passes the ablation and refuses a derived chunk that never reaches a top-K', async () => {
    await seedImageCorpus(USER, { maxPages: SEEDED_PAGES, imageIndex: false });
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
