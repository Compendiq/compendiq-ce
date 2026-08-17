import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';

/**
 * #1115 P5b — the image seeder against real Postgres, a real temp
 * `ATTACHMENTS_DIR` and the REAL intake (`embedPageImages`).
 *
 * The vision-language endpoint is the only thing mocked, and it is mocked at
 * its HTTP boundary (`vl-stub-server.ts`), so every image goes through
 * `vl-embedding-client.ts` for real. The text embedder is stubbed at the same
 * seam `seed.integration.test.ts` uses.
 *
 * What this file is FOR: the seeder's whole job is to put bytes somewhere
 * `resolveAttachmentBytes` will find them and a body somewhere
 * `extractImageReferencesFromHtml` will read them. Both sides are silent when
 * they disagree — the reader answers `null`, which is indistinguishable from
 * "no such attachment", and the run reports a leg that measured nothing.
 */

const TEXT_MODEL_DIMS = 384;
const VL_DIMS = 64;

const { generateEmbeddingMock } = vi.hoisted(() => ({
  generateEmbeddingMock: vi.fn(async (_cfg: unknown, _model: string, input: string | string[]) => {
    const texts = Array.isArray(input) ? input : [input];
    return texts.map((_, i) => Array.from({ length: 384 }, (_, j) => Math.sin((j + 1) * (i + 2)) * 0.01));
  }),
}));
vi.mock('../services/openai-compatible-client.js', async () => {
  const actual = await vi.importActual<typeof import('../services/openai-compatible-client.js')>(
    '../services/openai-compatible-client.js',
  );
  return { ...actual, generateEmbedding: generateEmbeddingMock };
});

const { startVlStubServer } = await import('./vl-stub-server.js');
const {
  seedImageCorpus,
  prepareImageIndex,
  stageEvalAttachmentsDir,
  imageAttachmentKey,
  ImageIntakeError,
} = await import('./seed-images.js');
const { ensureVectorDimensions, configureEmbeddingProvider, resetEvalCorpus, EVAL_SPACE_KEY } = await import('./seed.js');
const { loadImageCorpusManifest, IMAGE_CORPUS_DIR } = await import('./corpus-images.js');
const { resolveAttachmentBytes } = await import('../../../core/services/attachment-store.js');
const { buildPageImageUrl } = await import('../../../core/services/image-references.js');

const dbAvailable = await isDbAvailable();
const USER = 'aaaaaaaa-1115-4000-8000-000000005115';
const MAX_PAGES = 2;

type VlStub = Awaited<ReturnType<typeof startVlStubServer>>;

describe.skipIf(!dbAvailable)('image corpus seeder (#1115 P5b)', () => {
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
    // Leave the shared schema at the canonical width for every other suite.
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
    attachmentsDir = await stageEvalAttachmentsDir();
    await ensureVectorDimensions(TEXT_MODEL_DIMS);
    await configureEmbeddingProvider({ baseUrl: 'http://stub/v1', model: 'stub-embed' });
    await prepareImageIndex({ baseUrl: vl.baseUrl, model: 'stub-vl', targetDimensions: null });
    await resetEvalCorpus();
    // AFTER the probe: `prepareImageIndex` embeds a known image and a known
    // text to establish the width, so a request count taken from here would
    // otherwise carry the gate's two calls into the seeder's own totals.
    vl.reset();
  }, 60_000);

  afterEach(async () => {
    if (attachmentsDir) await rm(attachmentsDir, { recursive: true, force: true });
  });

  const manifest = loadImageCorpusManifest();
  const seededPages = manifest.pages.slice(0, MAX_PAGES);
  const seededImages = seededPages.flatMap((p) => p.images);

  it('maps a manifest image path onto the key the attachment stores are addressed by', () => {
    expect(imageAttachmentKey('images/airbus-a380__1.jpg')).toBe('airbus-a380__1.jpg');
  });

  it('writes every image where resolveAttachmentBytes finds it, under the layout the store computes', async () => {
    const seeded = await seedImageCorpus(USER, { maxPages: MAX_PAGES });

    for (const page of seededPages) {
      const pageId = seeded.pageIdByFile.get(page.file)!;
      expect(pageId).toBeGreaterThan(0);
      const row = await query<{ confluence_id: string | null; source: 'confluence' | 'standalone' }>(
        `SELECT confluence_id, source FROM pages WHERE id = $1`,
        [pageId],
      );
      for (const image of page.images) {
        const key = imageAttachmentKey(image.file);
        const bytes = await resolveAttachmentBytes({
          pageId,
          confluenceId: row.rows[0]!.confluence_id,
          pageSource: row.rows[0]!.source,
          source: 'confluence',
          key,
        });
        expect(bytes, `${page.file} → ${key}`).not.toBeNull();
        expect(bytes!.sniffedFormat).not.toBeNull();
        expect(bytes!.bytes.equals(readFileSync(join(IMAGE_CORPUS_DIR, image.file)))).toBe(true);
      }
    }
  }, 120_000);

  it('rewrites the stored body through the product\'s own URL builder, leaving no corpus-relative src', async () => {
    // The reader derives the directory from the page row and the WRITER has to
    // agree; `buildPageImageUrl` is the exact inverse of the enumerator, which
    // is why the seeder must not spell the URL itself.
    const seeded = await seedImageCorpus(USER, { maxPages: MAX_PAGES });

    const page = seededPages[0]!;
    const pageId = seeded.pageIdByFile.get(page.file)!;
    const row = await query<{ body_html: string; confluence_id: string | null; source: 'confluence' | 'standalone' }>(
      `SELECT body_html, confluence_id, source FROM pages WHERE id = $1`,
      [pageId],
    );
    const bodyHtml = row.rows[0]!.body_html;
    expect(bodyHtml).not.toContain('src="images/');
    for (const image of page.images) {
      expect(bodyHtml).toContain(buildPageImageUrl({
        source: 'confluence',
        key: imageAttachmentKey(image.file),
        pageId,
        pageSource: row.rows[0]!.source,
        confluenceId: row.rows[0]!.confluence_id,
      }));
    }
  }, 120_000);

  it('embeds every corpus image through the real intake, and skips none', async () => {
    const seeded = await seedImageCorpus(USER, { maxPages: MAX_PAGES });

    expect(seeded.imagesEmbedded).toBe(seededImages.length);
    expect(seeded.imagesReused).toBe(0);
    // The corpus is curated — every image is a raster under both ceilings — so
    // any skip at all is a bug in the rig rather than a fact about the corpus.
    expect(seeded.skipped).toEqual({
      missing: 0, unsupported: 0, oversized: 0, tooLarge: 0, capped: 0, external: 0,
    });

    const rows = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM page_image_embeddings`);
    expect(rows.rows[0]!.n).toBe(seededImages.length);
    // …and the vectors really came off the wire, one request per image.
    expect(vl.imageRequests()).toHaveLength(seededImages.length);
  }, 120_000);

  it('seeds the pages the way the text corpus is seeded, so both legs measure the same rows', async () => {
    const seeded = await seedImageCorpus(USER, { maxPages: MAX_PAGES });

    const page = seededPages[0]!;
    const pageId = seeded.pageIdByFile.get(page.file)!;
    const row = await query<{ title: string; space_key: string; body_text: string }>(
      `SELECT title, space_key, body_text FROM pages WHERE id = $1`,
      [pageId],
    );
    expect(row.rows[0]!.title).toBe(page.title);
    expect(row.rows[0]!.space_key).toBe(EVAL_SPACE_KEY);
    expect(row.rows[0]!.body_text.length).toBeGreaterThan(100);

    const chunks = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM page_embeddings WHERE page_id = $1`,
      [pageId],
    );
    expect(chunks.rows[0]!.n).toBeGreaterThan(0);
    expect(seeded.textSkipped).toEqual([]);
  }, 120_000);

  it('records image-embed throughput, which is the axis\'s own cost figure', async () => {
    const seeded = await seedImageCorpus(USER, { maxPages: MAX_PAGES });

    expect(seeded.imageEmbedWallClockMs).toBeGreaterThan(0);
    expect(seeded.throughputImagesPerSec).toBeGreaterThan(0);
    expect(seeded.throughputImagesPerSec).toBeCloseTo(
      seeded.imagesEmbedded / (seeded.imageEmbedWallClockMs / 1000),
      6,
    );
  }, 120_000);

  it('REFUSES the run when a page\'s intake fails, instead of measuring a half-filled index', async () => {
    // A VL outage mid-seed leaves the affected pages dirty and their images
    // absent from the index. The run would still complete and would still
    // print a paired verdict — computed against a corpus whose pictures are
    // partly missing, which is a number about the outage.
    vl.failWith(502);

    await expect(seedImageCorpus(USER, { maxPages: 1 })).rejects.toBeInstanceOf(ImageIntakeError);
    vl.failWith(null);
  }, 120_000);

  it('REFUSES a corpus whose stored bodies carry fewer images than the manifest lists', async () => {
    // The per-page check compares the intake against the body THIS SEEDER
    // wrote, so a picture lost on the way in shrinks the expectation in step
    // with the result and each page passes its own check at a smaller count —
    // and `rewriteImageSources` cannot see it either, because an element
    // dropped outright leaves no `src="images/` behind to find. Latent against
    // the committed corpus (markdownToHtml emits all 187 srcs today); this
    // builds the state that makes it live, which is the only way to test a
    // guard whose subject is a disagreement between two producers.
    const page = seededPages.find((p) => p.images.length >= 2)!;
    const dir = await mkdtemp(join(tmpdir(), 'compendiq-eval-corpus-'));
    try {
      await mkdir(join(dir, 'images'), { recursive: true });
      for (const image of page.images) {
        await writeFile(join(dir, image.file), readFileSync(join(IMAGE_CORPUS_DIR, image.file)));
      }
      const markdown = readFileSync(join(IMAGE_CORPUS_DIR, page.file), 'utf8');
      // Removed from the BODY only — the manifest entry is copied verbatim, so
      // the corpus still claims every one of its images.
      const dropped = page.images[0]!.file;
      await writeFile(join(dir, page.file), markdown.split(`![](${dropped})`).join(''));
      await writeFile(
        join(dir, 'MANIFEST.json'),
        JSON.stringify({ generatedBy: 'test', purpose: 'test', pages: [page] }),
      );

      const boom = seedImageCorpus(USER, { corpusDir: dir });
      await expect(boom).rejects.toBeInstanceOf(ImageIntakeError);
      await expect(boom).rejects.toThrow(/manifest lists/i);
      await expect(boom).rejects.toThrow(
        new RegExp(`Indexed ${page.images.length - 1} of the ${page.images.length} images`),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('REFUSES the run when the image use case is unassigned, rather than seeding an empty index', async () => {
    // `embedPageImages` answers `unassigned` and KEEPS the flag by design — the
    // queue is the flag. For the eval that is not a queue, it is a leg-on arm
    // with nothing to search.
    await query(`DELETE FROM llm_usecase_assignments WHERE usecase = 'image_embedding'`);

    const boom = seedImageCorpus(USER, { maxPages: 1 });
    await expect(boom).rejects.toBeInstanceOf(ImageIntakeError);
    await expect(boom).rejects.toThrow(/unassigned/i);
  }, 120_000);
});

describe.skipIf(!dbAvailable)('prepareImageIndex (#1115 P5b)', () => {
  let vl: VlStub;
  const previousAttachmentsDir = process.env.ATTACHMENTS_DIR;

  beforeAll(async () => {
    await setupTestDb();
    vl = await startVlStubServer({ dimensions: VL_DIMS });
  }, 60_000);

  afterAll(async () => {
    await vl.close();
    if (previousAttachmentsDir === undefined) delete process.env.ATTACHMENTS_DIR;
    else process.env.ATTACHMENTS_DIR = previousAttachmentsDir;
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    vl.reset();
  });

  it('probes the assigned pair and types the column to the width it measured', async () => {
    const prepared = await prepareImageIndex({ baseUrl: vl.baseUrl, model: 'stub-vl', targetDimensions: null });

    expect(prepared.dimensions).toBe(VL_DIMS);
    const col = await query<{ dims: number }>(
      `SELECT atttypmod AS dims FROM pg_attribute
        WHERE attrelid = 'page_image_embeddings'::regclass AND attname = 'embedding'`,
    );
    expect(col.rows[0]!.dims).toBe(VL_DIMS);
    // Assigned through the product's own non-inheriting resolver, not a
    // hand-built config: an eval that skipped the assignment would measure a
    // leg the deployment cannot reproduce.
    const assignment = await query<{ model: string }>(
      `SELECT model FROM llm_usecase_assignments WHERE usecase = 'image_embedding'`,
    );
    expect(assignment.rows[0]!.model).toBe('stub-vl');
  }, 60_000);

  it('sends the MRL width and records it in the index identity', async () => {
    const prepared = await prepareImageIndex({ baseUrl: vl.baseUrl, model: 'stub-vl', targetDimensions: 32 });

    expect(prepared.dimensions).toBe(32);
    expect(prepared.identity).toContain('#32');
    expect(vl.requests.every((r) => r.body.dimensions === 32)).toBe(true);
  }, 60_000);

  it('REFUSES a probe the endpoint cannot serve, naming the category', async () => {
    // The 422 a plain text-embedding server answers the `messages` body with.
    // Left to run, the eval would type no column and every image would fail.
    vl.failWith(422);

    const boom = prepareImageIndex({ baseUrl: vl.baseUrl, model: 'stub-vl', targetDimensions: null });
    await expect(boom).rejects.toThrow(/shape_rejected/);
    vl.failWith(null);
  }, 60_000);
});
