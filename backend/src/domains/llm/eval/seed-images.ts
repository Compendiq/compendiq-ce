/**
 * #1115 P5b — seed the German image corpus THROUGH THE REAL INTAKE.
 *
 * `seed.ts`'s whole argument, applied to a corpus with pictures: the pages go
 * through `markdownToHtml` and `embedPage`, and their images go onto disk under
 * the store's own directory key and are referenced by `buildPageImageUrl`, the
 * exact inverse of the enumerator the analysis worker reads them with. A seeder
 * that wrote rows directly would measure its own fixture: the URL shape, the
 * directory key and the format sniff are all things the intake can get wrong,
 * and every one of them fails SILENTLY — `resolveAttachmentBytes` answers
 * `null` for a mis-keyed directory exactly as it does for a file that is not
 * there.
 *
 * **#1618 stage 2 removed the image-EMBEDDING phase.** The seeder used to
 * assign a VL endpoint, probe it, type `page_image_embeddings` and run
 * `embedPageImages` per page for ADR-025's arm A. That arm and its index are
 * retired, so what remains is the text seed plus the attachment bytes — the
 * state ADR-027's arms B and C both start from — with `image_analysis_dirty`
 * raised per page, which is the analysis backfill's whole queue (D6.2).
 *
 * ── Two decisions that are not free choices ───────────────────────────────
 *
 * 1. **The `<img src>` is built by `buildPageImageUrl`, never spelled here.**
 *    That function is the exact inverse of `extractImageReferencesFromHtml`
 *    and shares `confluenceAttachmentDirKey` with `attachment-store.ts`, so
 *    the writer's directory rule and the reader's cannot drift. The eval pages
 *    are `source = 'standalone'`, which is what makes their Confluence-tree
 *    key the NUMERIC PK rather than a `confluence_id` — the layout the store
 *    resolves — and that is why the id has to exist before the body can be
 *    written (see `seedOnePage`).
 * 2. **Every manifest image must survive into the stored body.** The bodies
 *    are checked for a surviving `src="images/` after the rewrite, because an
 *    `<img>` the Markdown conversion or the sanitiser dropped outright leaves
 *    nothing behind to find and would silently shrink the corpus the arms are
 *    measured over. `corpus-de-images.test.ts` pins that all 187 vendored
 *    images are rasters inside both ceilings, so a page the intake cannot read
 *    is a fault in the rig, not a fact about the corpus.
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
import { markPageImagesDirty } from '../../../core/services/image-analysis-dirty.js';
import { embedPage } from '../services/embedding-service.js';
import type { PageSource } from '@compendiq/contracts';
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

export interface ImageSeedResult {
  /** Corpus filename → page id, the map the fixture is resolved through. */
  pageIdByFile: Map<string, number>;
  pages: number;
  /** Images the manifest lists for the seeded pages, all written to disk. */
  imagesStaged: number;
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

/**
 * `<ATTACHMENTS_DIR>/<dir key>/<file>` for every image the page carries.
 *
 * `confluenceId` is threaded in rather than passed as a literal `null`, even
 * though `EVAL_PAGE_SOURCE` is `'standalone'` and `confluenceAttachmentDirKey`
 * therefore ignores it today. The WRITER here and the URL builder in
 * `rewriteImageSources` have to compute the same directory key or the intake
 * resolves to a silent `null`, and they can only be checked against each other
 * if they are handed the same inputs — a hardcoded argument on one side means
 * the two agree by way of a constant declared eighty lines away rather than by
 * construction. The row really does carry a non-null `confluence_id` (the
 * INSERT generates one), so the literal was not even the row's value.
 */
async function writePageAttachments(
  page: ImageCorpusPage,
  pageId: number,
  confluenceId: string | null,
  corpusDir: string,
): Promise<void> {
  const dir = attachmentCacheDir(confluenceAttachmentDirKey(EVAL_PAGE_SOURCE, pageId, confluenceId));
  await mkdir(dir, { recursive: true });
  for (const image of page.images) {
    await writeFile(
      path.join(dir, imageAttachmentKey(image.file)),
      readFileSync(path.join(corpusDir, image.file)),
    );
  }
}

/**
 * Seed every corpus page: body, attachment bytes, text chunks, dirty flag.
 *
 * The text phase mirrors `seedCorpus` — same insert, same `markdownToHtml`,
 * same `pLimit(5)`. The images are written to disk beside it and left for the
 * analysis backfill (`arm-b-backfill.ts`) to read, which is their only
 * consumer since #1618 stage 2 retired the embedding phase.
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
    const confluenceId = inserted.rows[0]!.confluence_id;
    const bodyHtml = rewriteImageSources(html, page, pageId, confluenceId);
    await query(`UPDATE pages SET body_html = $2 WHERE id = $1`, [pageId, bodyHtml]);

    // The same three inputs the URL builder just got, so the directory the
    // bytes land in and the directory the intake looks in are computed from one
    // set of values rather than two that happen to agree.
    await writePageAttachments(page, pageId, confluenceId, corpusDir);
    // ADR-027 D4: every product writer that stores a body carrying attachment
    // images raises `image_analysis_dirty` beside `image_embedding_dirty`
    // through ONE writer (`markPageImagesDirty`). The seeder writes exactly
    // such a body, so it raises the flag the same way rather than leaving the
    // corpus in a state no product path produces. **The flag IS the analysis
    // queue** (D6.2): `reconcileDirtyPages` walks nothing else, migration
    // 116's initial-backlog UPDATE ran before any of these pages existed, and
    // a corpus seeded without it gave `--arm B` a backfill that never started
    // — the run then died at its `--backfill-timeout` deadline reporting
    // 0/187 valid analyses (#1619). Raised AFTER the bytes are on disk, so a
    // reconcile that claims the page can read every picture it enumerates.
    if (!(await markPageImagesDirty(pageId))) {
      throw new ImageIntakeError(
        `Could not raise image_analysis_dirty for ${page.file} (page ${pageId}): the analysis backfill walks that ` +
          'flag and nothing else, so the run would measure an un-analysed corpus under arm B\'s name.',
      );
    }
    const chunks = await embedPage(userId, pageId, page.title, EVAL_SPACE_KEY, bodyHtml);
    if (chunks === 0) textSkipped.push(page.file);

    pageIdByFile.set(page.file, pageId);
    referencedByFile.set(page.file, extractImageReferencesFromHtml(bodyHtml).map((ref) => ref.key));
    completed++;
    opts.onProgress?.(completed, pages.length);
  })));

  // The MANIFEST is the independent count, and this is the assertion the
  // module header claims: a corpus seeded with 170 of 187 pictures reachable is
  // an arm measured against a corpus whose images are partly absent, and it
  // must be a refusal rather than a smaller measurement. Checked against what
  // the STORED BODY references, because that is the set the analysis worker's
  // enumerator can reach — and `rewriteImageSources` cannot see an element
  // dropped outright, which leaves no `src="images/` behind to find.
  const expectedTotal = pages.reduce((n, page) => n + page.images.length, 0);
  const referencedTotal = [...referencedByFile.values()].reduce((n, keys) => n + keys.length, 0);
  if (referencedTotal !== expectedTotal) {
    throw new ImageIntakeError(
      `The stored bodies reference ${referencedTotal} of the ${expectedTotal} images the manifest lists ` +
        `for these ${pages.length} pages, so the loss is between the manifest and the stored body — an ` +
        '`<img>` the Markdown conversion or the sanitiser dropped is never enumerated and never read. ' +
        'Re-run the corpus builder, or check markdownToHtml against the manifest srcs.',
    );
  }

  return {
    pageIdByFile,
    pages: pages.length,
    imagesStaged: referencedTotal,
    textSkipped,
  };
}
