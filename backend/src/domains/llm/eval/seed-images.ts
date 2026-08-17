/**
 * #1115 P5b — seed the German image corpus THROUGH THE REAL INTAKE.
 *
 * `seed.ts`'s whole argument, applied one leg over: the pages go through
 * `markdownToHtml` and `embedPage`, and their pictures go onto disk and then
 * through `embedPageImages` — the same enumerator, the same
 * `resolveAttachmentBytes`, the same sha-reuse, the same reconcile and the same
 * write transaction the product runs. A seeder that INSERTed vectors into
 * `page_image_embeddings` directly would measure its own fixture: the URL
 * shape, the directory key, the format sniff and the two ceilings are all
 * things the intake can get wrong, and every one of them fails SILENTLY —
 * `resolveAttachmentBytes` answers `null` for a mis-keyed directory exactly as
 * it does for a file that is not there.
 *
 * ── Three decisions that are not free choices ─────────────────────────────
 *
 * 1. **The `<img src>` is built by `buildPageImageUrl`, never spelled here.**
 *    That function is the exact inverse of `extractImageReferencesFromHtml`
 *    and shares `confluenceAttachmentDirKey` with `attachment-store.ts`, so
 *    the writer's directory rule and the reader's cannot drift. The eval pages
 *    are `source = 'standalone'`, which is what makes their Confluence-tree
 *    key the NUMERIC PK rather than a `confluence_id` — the layout the store
 *    resolves — and that is why the id has to exist before the body can be
 *    written (see `seedOnePage`).
 * 2. **The image phase is SEQUENTIAL and separately wall-clocked.** It is the
 *    axis's throughput figure, and a figure taken across five concurrent pages
 *    is not one a `processDirtyPageImages` backfill would ever reproduce —
 *    that worker walks the backlog one page at a time. The TEXT phase keeps
 *    `seedCorpus`'s `pLimit(5)`, because nothing is being timed there.
 * 3. **A skip is a bug in the rig, not a fact about the corpus.** Every one of
 *    the 187 vendored images is a raster inside both ceilings
 *    (`corpus-de-images.test.ts` pins that), so `missing`, `unsupported`,
 *    `oversized`, `tooLarge`, `capped` and `external` are all zero on a healthy
 *    run — and a run that quietly indexed 170 of 187 would report a leg
 *    measured against a corpus whose pictures are partly absent. The seeder
 *    therefore refuses rather than counting, and it does so against TWO counts:
 *    per page against the body it stored (which is what `embedPageImages` can
 *    fairly be judged against) and once at the end against the MANIFEST. The
 *    second is not redundant — the first is derived from this seeder's own
 *    output, so a picture lost on the way in shrinks the expectation in step
 *    with the result and every page passes at a smaller count.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pLimit from 'p-limit';

import { query } from '../../../core/db/postgres.js';
import { markdownToHtml, htmlToText } from '../../../core/services/content-converter.js';
import {
  attachmentCacheDir,
  type AttachmentStoreSource,
} from '../../../core/services/attachment-store.js';
import {
  buildPageImageUrl,
  confluenceAttachmentDirKey,
  extractImageReferencesFromHtml,
} from '../../../core/services/image-references.js';
import { IMAGE_EMBEDDING_TARGET_DIMENSIONS_KEY } from '../../../core/services/image-embedding-target-dimensions.js';
import type { VectorColumnTier } from '../../../core/db/vector-column-tier.js';
import { logger } from '../../../core/utils/logger.js';
import { embedPage } from '../services/embedding-service.js';
import { embedPageImages, type ImageEmbedOutcome } from '../services/image-embedding-service.js';
import {
  ensureImageEmbeddingColumn,
  imageIndexIdentityFor,
} from '../services/image-embedding-index.js';
import { probeImageEmbedding } from '../services/image-embedding-probe.js';
import { resolveImageEmbeddingUsecase } from '../services/llm-provider-resolver.js';
import type { ImageSkipCounts, PageSource } from '@compendiq/contracts';
import { IMAGE_CORPUS_DIR, loadImageCorpusManifest, type ImageCorpusPage } from './corpus-images.js';
import { EVAL_SPACE_KEY } from './seed.js';

/**
 * The store every eval page's images live in.
 *
 * `'confluence'` is the cache TREE (`<ATTACHMENTS_DIR>/<key>/<file>`), not a
 * statement about where the page came from — the local store's directory key is
 * always the numeric PK, so it would exercise strictly less of the resolver's
 * `pageSource` rule than the tree does.
 */
const EVAL_IMAGE_STORE: AttachmentStoreSource = 'confluence';

/** Every eval page is standalone, exactly as `seedCorpus` seeds them. */
const EVAL_PAGE_SOURCE: PageSource = 'standalone';

/** Refused intake, in the one class the caller must never continue past. */
export class ImageIntakeError extends Error {}

/**
 * The on-disk attachment key for a manifest image path.
 *
 * The manifest addresses images as `images/<slug>__N.<ext>` because that is how
 * the page body references them; the STORES address a file by its plain name
 * inside one page's directory (`isDirectChildKey` refuses anything else). One
 * function, used by the seeder to name the file it writes AND by the report to
 * map a fixture label's `expectedImages` onto what the leg answered with — two
 * spellings of this would silently score `imageHit@K` at zero.
 */
export function imageAttachmentKey(manifestPath: string): string {
  return path.posix.basename(manifestPath);
}

/**
 * A throwaway `ATTACHMENTS_DIR` for this run, exported to the environment.
 *
 * Setting the variable is what makes the store read it: `attachmentsRootNow()`
 * resolves the root at CALL time (#1123), precisely so a temp directory chosen
 * after the import graph is resolved still works. Every writer here goes
 * through `attachmentCacheDir`, which reads the same function, so the seeder
 * cannot write to a root the reader is not looking in.
 */
export async function stageEvalAttachmentsDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'compendiq-eval-images-'));
  process.env.ATTACHMENTS_DIR = dir;
  return dir;
}

/**
 * Point the `image_embedding` use case at the VL endpoint for this run.
 *
 * `configureEmbeddingProvider`'s shape, one use case over — and `is_default`
 * is FALSE for its reason too (`llm_providers_one_default` is a unique partial
 * index). The assignment PINS the model rather than leaving it to
 * `default_model`, which is what the product's own assignment route does and
 * what makes the recorded index identity stable.
 */
export async function configureImageEmbeddingProvider(opts: {
  baseUrl: string;
  model: string;
  name?: string;
}): Promise<string> {
  const name = opts.name ?? 'eval-image-embedding';
  await query(`DELETE FROM llm_usecase_assignments WHERE usecase = 'image_embedding'`);
  await query(`DELETE FROM llm_providers WHERE name = $1`, [name]);
  const provider = await query<{ id: string }>(
    `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, is_default, default_model)
     VALUES ($1, $2, 'none', true, false, $3)
     RETURNING id`,
    [name, opts.baseUrl, opts.model],
  );
  const providerId = provider.rows[0]!.id;
  await query(
    `INSERT INTO llm_usecase_assignments (usecase, provider_id, model, updated_at)
     VALUES ('image_embedding', $1, $2, NOW())
     ON CONFLICT (usecase) DO UPDATE SET provider_id = $1, model = $2, updated_at = NOW()`,
    [providerId, opts.model],
  );
  return providerId;
}

/**
 * Write (or clear) the MRL truncation width every image-side call will request.
 *
 * It has to land BEFORE the probe, exactly as the settings panel PUTs it before
 * re-sending the assignment: a probe run against the old width types the column
 * for a request the leg no longer makes.
 */
export async function configureImageEmbeddingTargetDimensions(dims: number | null): Promise<void> {
  if (dims === null) {
    await query(`DELETE FROM admin_settings WHERE setting_key = $1`, [IMAGE_EMBEDDING_TARGET_DIMENSIONS_KEY]);
    return;
  }
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW()`,
    [IMAGE_EMBEDDING_TARGET_DIMENSIONS_KEY, String(dims)],
  );
}

export interface PreparedImageIndex {
  providerId: string;
  /** The width the endpoint ANSWERED with, which is what the column is typed to. */
  dimensions: number;
  tier: VectorColumnTier;
  /** False above 4000 dimensions: pgvector has no HNSW opclass, so the leg scans. */
  indexed: boolean;
  /** `provider:model@baseUrl#dims`, as `ensureImageEmbeddingColumn` recorded it. */
  identity: string;
}

/**
 * Assign, probe and type the image index for this run — the product's own
 * sequence, in the product's own order.
 *
 * The probe is not a formality here. It is the gate that makes the assignment
 * legitimate in production (`probeImageEmbedding` blocks the PUT and a failure
 * is a 422), and running the eval past a failed one would type no column and
 * then fail every single image with an error the report has no field for. The
 * refusal quotes the probe's own CATEGORY, so an operator reads the same word
 * the Settings panel would have shown them.
 */
export async function prepareImageIndex(opts: {
  baseUrl: string;
  model: string;
  targetDimensions: number | null;
  name?: string;
}): Promise<PreparedImageIndex> {
  await configureImageEmbeddingTargetDimensions(opts.targetDimensions);
  const providerId = await configureImageEmbeddingProvider(opts);

  // Resolved through the product's own non-inheriting resolver rather than a
  // hand-built ProviderConfig: that resolution IS the ADR-021 rule under test,
  // and a config assembled here would measure a leg no deployment can reproduce.
  const resolved = await resolveImageEmbeddingUsecase();
  if (!resolved) {
    throw new ImageIntakeError(
      'The image_embedding assignment did not resolve immediately after being written — ' +
        'check that the provider row and the assignment both landed.',
    );
  }

  const probe = await probeImageEmbedding(resolved.config, resolved.model, opts.targetDimensions);
  if (probe.dimensions === null) {
    throw new ImageIntakeError(
      `The image-embedding probe failed (${probe.reason}): ${probe.error ?? 'no detail'}. ` +
        'This is the same gate that refuses the assignment in Settings → AI Models with a 422, and ' +
        'past it every image in the corpus would fail against an untyped column.',
    );
  }

  const pair = {
    providerId: resolved.config.providerId,
    model: resolved.model,
    baseUrl: resolved.config.baseUrl,
    targetDimensions: opts.targetDimensions,
  };
  const ensured = await ensureImageEmbeddingColumn(probe.dimensions, pair);
  if (!ensured.indexed) {
    logger.warn(
      { dimensions: probe.dimensions },
      'Image index has no HNSW index at this width — the leg will run a sequential scan, and its ' +
        'query-cost figures describe that. Set EVAL_IMAGE_EMBEDDING_DIMENSIONS to 4000 or less to measure the indexed tier.',
    );
  }
  return {
    providerId,
    dimensions: probe.dimensions,
    tier: ensured.tier,
    indexed: ensured.indexed,
    identity: imageIndexIdentityFor(pair),
  };
}

export interface ImageSeedResult {
  /** Corpus filename → page id, the map the fixture is resolved through. */
  pageIdByFile: Map<string, number>;
  pages: number;
  imagesEmbedded: number;
  imagesReused: number;
  /** Wall clock of the sequential image phase alone — the throughput denominator. */
  imageEmbedWallClockMs: number;
  throughputImagesPerSec: number;
  /** All zero on a healthy run; the seeder refuses before returning otherwise. */
  skipped: ImageSkipCounts;
  /** Corpus pages that produced no text chunk. Empty for this corpus. */
  textSkipped: string[];
}

export interface SeedImageCorpusOptions {
  corpusDir?: string;
  /**
   * TEST SEAM ONLY. The measurement seeds the whole corpus — a subset changes
   * the page population every metric is computed over, so a report produced
   * with this set is not comparable to one produced without it. The runner's
   * own fixture would also reference pages that were never seeded.
   */
  maxPages?: number;
  onProgress?: (done: number, total: number) => void;
}

function emptySkips(): ImageSkipCounts {
  return { missing: 0, unsupported: 0, oversized: 0, tooLarge: 0, capped: 0, external: 0 };
}

/**
 * Point the page body at the bytes the seeder is about to write.
 *
 * Every manifest image is replaced by name, and the result is then checked for
 * a surviving `src="images/` — a body that still carries one references a
 * picture the manifest does not list, which would be enumerated, resolved to
 * nothing and counted as a `missing` skip. Explicit replacement plus that
 * assertion is what turns "the corpus changed shape" into a refusal instead of
 * a quietly smaller measurement.
 */
function rewriteImageSources(html: string, page: ImageCorpusPage, pageId: number, confluenceId: string | null): string {
  let out = html;
  for (const image of page.images) {
    const url = buildPageImageUrl({
      source: EVAL_IMAGE_STORE,
      key: imageAttachmentKey(image.file),
      pageId,
      pageSource: EVAL_PAGE_SOURCE,
      confluenceId,
    });
    out = out.split(`src="${image.file}"`).join(`src="${url}"`);
  }
  if (out.includes('src="images/')) {
    throw new ImageIntakeError(
      `${page.file} references an image its manifest entry does not list — the intake would enumerate ` +
        'it, resolve it to nothing and count it as a missing skip. Re-run the corpus builder.',
    );
  }
  return out;
}

/** `<ATTACHMENTS_DIR>/<dir key>/<file>` for every image the page carries. */
async function writePageAttachments(page: ImageCorpusPage, pageId: number, corpusDir: string): Promise<void> {
  const dir = attachmentCacheDir(confluenceAttachmentDirKey(EVAL_PAGE_SOURCE, pageId, null));
  await mkdir(dir, { recursive: true });
  for (const image of page.images) {
    await writeFile(
      path.join(dir, imageAttachmentKey(image.file)),
      readFileSync(path.join(corpusDir, image.file)),
    );
  }
}

/**
 * Refuse anything that is not a clean, complete intake.
 *
 * `embedPageImages` never throws for something the corpus can contain, which is
 * right for a worker walking a backlog and wrong for a measurement: `failed`
 * means the endpoint is down, `unassigned` means there is no leg, `stale` means
 * a rebuild landed mid-run, and `skipped` means the page is not one this index
 * covers. Each leaves images out of the index, and the run would still print a
 * paired verdict computed against a corpus whose pictures are partly absent.
 *
 * EVERY skip reason lands here, including `unsupported`, and that is why there
 * is no warn path beside this refusal (review r2). `embedded + reused` is
 * `allRefs` minus the failures and minus every skip, so the count check below
 * fires on any non-zero counter — a `logger.warn` for `unsupported` was
 * unreachable by construction. The message names the page's own image keys
 * rather than the counters alone, because "1 of 3" plus a bag of reasons still
 * leaves the operator grepping the corpus for which picture went missing.
 */
function assertCleanIntake(page: ImageCorpusPage, outcome: ImageEmbedOutcome, referenced: readonly string[]): void {
  if (outcome.status !== 'ok') {
    throw new ImageIntakeError(
      `Image intake for ${page.file} answered "${outcome.status}"` +
        `${outcome.error ? ` (${outcome.error})` : ''}. The corpus is curated, so this is a fault in the ` +
        'rig or the endpoint, not a fact about the page — measuring past it would score the image leg ' +
        'against an index that is missing pictures.',
    );
  }
  const written = outcome.embedded + outcome.reused;
  if (written !== referenced.length) {
    throw new ImageIntakeError(
      `Image intake for ${page.file} indexed ${written} of ${referenced.length} images ` +
        `(skips: ${JSON.stringify(outcome.skipped)}; referenced: ${referenced.join(', ')}). Every ` +
        'vendored image is a raster inside both ceilings, so a skip here means the seeder and the ' +
        'reader disagree about where the bytes are, or about what they are.',
    );
  }
}

/**
 * Seed every corpus page, then embed every page's images.
 *
 * Two phases on purpose. The text phase mirrors `seedCorpus` — same insert,
 * same `markdownToHtml`, same `pLimit(5)` — and the image phase runs
 * SEQUENTIALLY under one wall clock, because that number is published as
 * images/s and a concurrent figure is not one the production worker can
 * reproduce.
 */
export async function seedImageCorpus(
  userId: string,
  opts: SeedImageCorpusOptions = {},
): Promise<ImageSeedResult> {
  const corpusDir = opts.corpusDir ?? IMAGE_CORPUS_DIR;
  const manifest = loadImageCorpusManifest(corpusDir);
  const pages = opts.maxPages === undefined ? manifest.pages : manifest.pages.slice(0, opts.maxPages);

  const pageIdByFile = new Map<string, number>();
  // WHICH distinct images the stored body ends up referencing — read off
  // `body_html` with the intake's own enumerator rather than off the manifest,
  // because that is the set `embedPageImages` can possibly write (it dedupes
  // by `(source, key)` and is bounded by `rag_images_per_page_max`). The keys
  // rather than their count, so a refusal can name the pictures (review r2);
  // kept here so the page bodies do not have to be held for the second phase.
  const referencedByFile = new Map<string, string[]>();
  const textSkipped: string[] = [];
  let completed = 0;

  const limit = pLimit(5);
  await Promise.all(pages.map((page) => limit(async () => {
    const html = await markdownToHtml(readFileSync(path.join(corpusDir, page.file), 'utf8'));
    // `body_text` is what the migration-049 trigger indexes and what the
    // coverage probe counts, so it is the EXTRACTED text — the same rule
    // `seedCorpus` documents. Images contribute none of it, which is the whole
    // point of a corpus whose figures carry no caption and an empty alt.
    const text = htmlToText(html);
    const inserted = await query<{ id: number; confluence_id: string | null }>(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html, page_type, visibility, embedding_dirty, embedding_status)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, '', $5, 'page', 'shared', TRUE, 'not_embedded')
       RETURNING id, confluence_id`,
      [EVAL_PAGE_SOURCE, EVAL_SPACE_KEY, page.title, text, html],
    );
    const pageId = inserted.rows[0]!.id;
    // The id has to exist before the body can name it: the Confluence-tree key
    // for a standalone page IS the numeric PK (`confluenceAttachmentDirKey`),
    // so the `<img src>` cannot be written until the row is in. `body_text` is
    // untouched by the rewrite, so the tsvector the INSERT built stays correct
    // and the trigger — which fires on `title`/`body_text` only — is not
    // re-run under a different configuration.
    const bodyHtml = rewriteImageSources(html, page, pageId, inserted.rows[0]!.confluence_id);
    await query(`UPDATE pages SET body_html = $2 WHERE id = $1`, [pageId, bodyHtml]);

    await writePageAttachments(page, pageId, corpusDir);
    const chunks = await embedPage(userId, pageId, page.title, EVAL_SPACE_KEY, bodyHtml);
    if (chunks === 0) textSkipped.push(page.file);

    pageIdByFile.set(page.file, pageId);
    referencedByFile.set(page.file, extractImageReferencesFromHtml(bodyHtml).map((ref) => ref.key));
    completed++;
    opts.onProgress?.(completed, pages.length);
  })));

  const skipped = emptySkips();
  let imagesEmbedded = 0;
  let imagesReused = 0;
  const started = performance.now();
  for (const page of pages) {
    const pageId = pageIdByFile.get(page.file)!;
    const outcome = await embedPageImages(pageId);
    assertCleanIntake(page, outcome, referencedByFile.get(page.file)!);
    imagesEmbedded += outcome.embedded;
    imagesReused += outcome.reused;
    for (const reason of Object.keys(skipped) as Array<keyof ImageSkipCounts>) {
      skipped[reason] += outcome.skipped[reason];
    }
  }
  const imageEmbedWallClockMs = performance.now() - started;

  // The per-page expectation is read off the STORED BODY, because that is the
  // only number `embedPageImages` can fairly be judged against — but it is a
  // number this seeder produced, so an `<img>` lost between the manifest and
  // the body shrinks the expectation in step with the result and every page
  // passes its own check at a smaller count (review r1). `rewriteImageSources`
  // does not see that either: an element dropped outright leaves no
  // `src="images/` behind to find. The MANIFEST is the independent count, and
  // this is the assertion the module header has always claimed — 170 of 187
  // indexed is a leg measured against a corpus whose pictures are partly
  // absent, and it must be a refusal rather than a smaller measurement.
  const expectedTotal = pages.reduce((n, page) => n + page.images.length, 0);
  if (imagesEmbedded + imagesReused !== expectedTotal) {
    throw new ImageIntakeError(
      `Indexed ${imagesEmbedded + imagesReused} of the ${expectedTotal} images the manifest lists for ` +
        `these ${pages.length} pages. Every page's own intake was clean, so the loss is between the ` +
        'manifest and the stored body — an `<img>` the Markdown conversion or the sanitiser dropped is ' +
        'never enumerated, never resolved and never counted as a skip. Re-run the corpus builder, or ' +
        'check markdownToHtml against the manifest srcs.',
    );
  }

  return {
    pageIdByFile,
    pages: pages.length,
    imagesEmbedded,
    imagesReused,
    imageEmbedWallClockMs,
    throughputImagesPerSec:
      imageEmbedWallClockMs > 0 ? imagesEmbedded / (imageEmbedWallClockMs / 1000) : 0,
    skipped,
    textSkipped,
  };
}
