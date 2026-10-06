import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';

/**
 * #1115 P5b — the image seeder against real Postgres and a real temp
 * `ATTACHMENTS_DIR`. The text embedder is stubbed at the same seam
 * `seed.integration.test.ts` uses; nothing else is.
 *
 * **#1618 stage 2 retired the image-EMBEDDING phase**, and with it this file's
 * VL stub server, the `prepareImageIndex` probe and every throughput figure
 * the per-page embed loop produced. What the seeder still owes the arms is the
 * start state ADR-027's B and C share: a page body pointing at bytes on disk,
 * text chunks, and `image_analysis_dirty` raised — the analysis backfill's
 * whole queue (D6.2).
 *
 * What this file is FOR: the seeder's job is to put bytes somewhere
 * `resolveAttachmentBytes` will find them and a body somewhere
 * `extractImageReferencesFromHtml` will read them. Both sides are silent when
 * they disagree — the reader answers `null`, which is indistinguishable from
 * "no such attachment", and the run reports an arm that measured nothing.
 */

const TEXT_MODEL_DIMS = 384;

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

const {
  seedImageCorpus,
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

describe.skipIf(!dbAvailable)('image corpus seeder (#1115 P5b)', () => {
  let attachmentsDir: string;
  const previousAttachmentsDir = process.env.ATTACHMENTS_DIR;

  beforeAll(async () => {
    await setupTestDb();
  }, 60_000);

  afterAll(async () => {
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
    attachmentsDir = await stageEvalAttachmentsDir();
    await ensureVectorDimensions(TEXT_MODEL_DIMS);
    await configureEmbeddingProvider({ baseUrl: 'http://stub/v1', model: 'stub-embed' });
    await resetEvalCorpus();
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

  it('stages every corpus image and leaves each page on the analysis queue (D6.2)', async () => {
    // What replaced the embedding phase. `image_analysis_dirty` IS the
    // backfill's queue and nothing else is walked, so a corpus seeded without
    // it hands `--arm B` a backfill that never starts — #1619 lost a run to
    // exactly that, reporting 0/187 valid analyses at its deadline.
    const seeded = await seedImageCorpus(USER, { maxPages: MAX_PAGES });

    expect(seeded.pages).toBe(seededPages.length);
    expect(seeded.imagesStaged).toBe(seededImages.length);

    const dirty = await query<{ page_id: number; image_analysis_dirty: boolean }>(
      `SELECT id AS page_id, image_analysis_dirty FROM pages ORDER BY id`,
    );
    expect(dirty.rows).toHaveLength(seededPages.length);
    expect(dirty.rows.every((r) => r.image_analysis_dirty)).toBe(true);
    // And the retired leg leaves no trace: no column, no table, nothing for a
    // stale writer to have raised.
    const legacy = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'pages' AND column_name = 'image_embedding_dirty'`,
    );
    expect(legacy.rows[0]!.n).toBe(0);
  }, 120_000);

  it('seeds the pages the way the text corpus is seeded, so both arms measure the same rows', async () => {
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

  it('REFUSES a corpus whose stored bodies carry fewer images than the manifest lists', async () => {
    // The corpus-level check compares the manifest against the bodies THIS
    // SEEDER wrote, and `rewriteImageSources` cannot see the loss either,
    // because an element dropped outright leaves no `src="images/` behind to
    // find. Latent against the committed corpus (markdownToHtml emits all 187
    // srcs today); this builds the state that makes it live, which is the only
    // way to test a guard whose subject is a disagreement between two
    // producers.
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
        new RegExp(`reference ${page.images.length - 1} of the ${page.images.length} images`),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
