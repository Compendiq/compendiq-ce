/**
 * #1115 P5a — the image-bearing German corpus and the shape of its manifest.
 *
 * Kept beside `fixture.ts` rather than inside it, and deliberately: this
 * corpus is NOT part of `CORPUS_DIRS`. `computeCorpusManifestSha` hashes every
 * directory in that list, so joining it would invalidate every recorded
 * baseline the moment these bytes landed — the exact failure that hash exists
 * to make loud, and one there is no reason to spend in the PR that only
 * vendors the corpus. P5b adds the `--images` axis and wires it in on purpose;
 * `corpus-de-images.test.ts` fails if that happens by accident first.
 *
 * The manifest is a superset of `corpus/MANIFEST.json`'s page shape — `file`,
 * `title`, `titleSource`, `source` are the same four fields `loadCorpusDir`
 * reads, so P5b's seeder can consume this directory without a second loader.
 * Everything past them is what an image corpus needs and a text corpus does
 * not: the pinned revision, the licence obligations, and the caption the
 * builder stripped out of the page.
 *
 * The caption is the load-bearing one. The page body carries `![](images/…)`
 * with an EMPTY alt and no caption, because the corpus mimics a Confluence
 * page whose visual content is not restated in prose — a page that captions
 * its own figures is answerable from text alone, and an image leg measured on
 * it measures nothing. The caption still has to survive somewhere for the
 * independent labeller (P5c) to write `expectedImages[]` against, so it lives
 * here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const IMAGE_CORPUS_DIR = join(import.meta.dirname, 'corpus-de-images');

/** The four content shapes the design names, each measured as its own slice. */
export const IMAGE_CORPUS_CATEGORIES = ['technical', 'science', 'process', 'photo'] as const;
export type ImageCorpusCategory = (typeof IMAGE_CORPUS_CATEGORIES)[number];

/**
 * Longest edge. 512 is the design's ruling: small enough that ~150 images stay
 * a committable fixture, and comfortably above the ~64px floor a VL encoder
 * needs to see anything at all.
 */
export const MAX_IMAGE_EDGE_PX = 512;

/**
 * Per-image hard cap. The builder AIMS at 80 KB and drops any image it cannot
 * bring under 120 KB — two numbers on purpose: the target keeps the mean low,
 * the cap keeps one pathological diagram from eating the budget alone.
 */
export const MAX_IMAGE_FILE_BYTES = 120 * 1024;

/**
 * Whole-corpus ceiling, above the design's ~10 MB target so an ordinary
 * refresh does not have to be a budget negotiation, and low enough that a
 * runaway one is.
 */
export const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;

/** Below this a content shape is too thin to carry its own slice of the fixture. */
export const MIN_PAGES_PER_CATEGORY = 10;

/**
 * The licences this repository may carry inside an MIT tree, as canonical
 * labels the builder writes (it maps Commons' `extmetadata.License` ids onto
 * these, so the allow-list is a closed set of strings rather than a fuzzy
 * match over free text).
 *
 * Ported CC licences keep their jurisdiction suffix (`CC BY-SA 3.0 DE`)
 * because dropping it would misstate the licence in the attribution file.
 * GFDL-only, any NC or ND variant, fair use and "unknown" are rejected at
 * build time and have no spelling that passes here.
 */
const ALLOWED_LICENSE = /^(?:CC0 1\.0|Public domain|CC BY(?:-SA)? \d\.\d(?: [A-Z]{2})?)$/;

export function isAllowedImageLicense(license: string): boolean {
  return ALLOWED_LICENSE.test(license);
}

/**
 * SHAPE ONLY. Policy — the licence allow-list, a named author, the image
 * naming convention, the Commons link — is asserted in
 * `corpus-de-images.test.ts` and deliberately not here.
 *
 * That split is not stylistic. Every consumer resolves this manifest at module
 * load, so a `.refine()` on `license` throws before any test body runs: the
 * whole suite reports "no tests", and the readable assertion written to name
 * the offending file and licence is unreachable code that looks like a guard.
 * Verified by planting a `GFDL 1.2` licence — with the refine in place the run
 * said `Tests no tests`; without it, one named test fails and prints the file
 * and the value. It is also the arrangement `fixture.ts` already uses:
 * `loadCorpusDir` validates nothing and `fixture.test.ts` is the guard.
 */
export const ImageCorpusImageSchema = z.object({
  /** Relative to the corpus directory, exactly as the page body references it. */
  file: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().positive(),
  format: z.enum(['png', 'jpeg', 'webp']),
  /** `File:…` on Commons, in the canonical English namespace. */
  sourceTitle: z.string(),
  sourceUrl: z.string(),
  author: z.string(),
  license: z.string(),
  licenseUrl: z.string(),
  /** Stripped out of the page body; kept here for the independent labeller. */
  caption: z.string(),
});

export const ImageCorpusPageSchema = z.object({
  file: z.string().min(1),
  title: z.string().min(1),
  titleSource: z.literal('wikipedia'),
  source: z.literal('wikipedia-de'),
  url: z.string(),
  /** The revision the text and the figure list were taken from — a rebuild pins to it. */
  revid: z.number().int().positive(),
  license: z.literal('CC BY-SA 4.0'),
  category: z.enum(IMAGE_CORPUS_CATEGORIES),
  images: z.array(ImageCorpusImageSchema),
});

export const ImageCorpusManifestSchema = z.object({
  generatedBy: z.string().min(1),
  purpose: z.string().min(1),
  pages: z.array(ImageCorpusPageSchema).min(1),
});

export type ImageCorpusImage = z.infer<typeof ImageCorpusImageSchema>;
export type ImageCorpusPage = z.infer<typeof ImageCorpusPageSchema>;
export type ImageCorpusManifest = z.infer<typeof ImageCorpusManifestSchema>;

/** The image naming convention, asserted in the guard rather than the schema. */
export const IMAGE_FILE_NAME = /^images\/[a-z0-9-]+__\d+\.(?:png|jpg|webp)$/;

/**
 * Parses the manifest, or throws. Never filters: a loader that quietly drops
 * malformed entries changes the corpus size between runs, and corpus size is
 * what the fixture's manifest hash is meant to pin.
 */
export function loadImageCorpusManifest(dir: string = IMAGE_CORPUS_DIR): ImageCorpusManifest {
  return ImageCorpusManifestSchema.parse(
    JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8')),
  );
}
