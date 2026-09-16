/**
 * ADR-027 — the raster-image intake both image pipelines share: resolve one
 * referenced image's bytes, sniff its format, bound it, hash it.
 *
 * Moved out of `image-embedding-service.ts` (ADR-025 P2) under #1616's
 * ownership, because the analysis reconcile applies EXACTLY the same rules
 * ("reuse existing HTML image discovery, attachment-store prefix resolution,
 * raster validation, size/dimension bounds", issue #1616) and #1618 deletes
 * the legacy module after the #1619 gate. The legacy service imports this;
 * its behaviour is unchanged.
 *
 * Three rules, restated from the legacy header:
 *
 *  - Source follows the URL PREFIX (`extractImageReferencesFromHtml`), never
 *    `pages.confluence_id IS NULL` — `resolveAttachmentBytes` owns the store
 *    and directory derivation.
 *  - Skip and COUNT; never resize (ADR-025 D10). SVG and draw.io's XML behind
 *    a `.png` sniff as no raster format; the byte and dimension ceilings are
 *    `image-validator.ts`'s; the backend has no pixel decoder.
 *  - A header we cannot read is not a header we can clear the ceiling with,
 *    so it joins `unsupported` rather than being accepted on trust.
 */
import { createHash } from 'crypto';
import type { ImageFormat, PageSource } from '@compendiq/contracts';
import type { PageImageReference } from '../../../core/services/image-references.js';
import { resolveAttachmentBytes } from '../../../core/services/attachment-store.js';
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  readImageDimensions,
} from '../../../core/services/image-validator.js';

/** The `skip_reason` values intake can produce (policy skips are the caller's). */
export type ImageIntakeSkipReason = 'missing' | 'unsupported' | 'too_large' | 'oversized';

export interface ImageIntakePage {
  id: number;
  confluence_id: string | null;
  source: PageSource;
}

export type ImageIntakeResult =
  | {
      kind: 'ok';
      bytes: Buffer;
      format: ImageFormat;
      width: number;
      height: number;
      /** sha256 hex of `bytes` — the reference revision (ADR-027 D6). */
      sha256: string;
    }
  | {
      kind: 'skipped';
      reason: ImageIntakeSkipReason;
      /** Present when bytes were read (everything but `missing`). */
      sha256?: string;
    }
  | {
      /**
       * The file could not be read for a reason other than its absence
       * (`EACCES`, `EIO`, `ESTALE`, …): a fact about the disk right now, not
       * about the corpus, so no skip reason fits and nothing durable should
       * be recorded from it — the caller retries or leaves the page dirty.
       */
      kind: 'unavailable';
      error: unknown;
    };

const MIME_BY_FORMAT: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** The `data:` URL / content-part MIME type for a sniffed format. */
export function mimeTypeForImageFormat(format: ImageFormat): string {
  return MIME_BY_FORMAT[format];
}

/**
 * Read, sniff and bound one referenced image. Never throws: a missing file,
 * a format nothing can read, a header over a ceiling are all `skipped`
 * outcomes, and a read failure that is not an absence is `unavailable` —
 * distinguished because the first three are verdicts about the corpus and
 * the last is a transient of the disk (#1626 review r2).
 */
export async function intakePageImage(
  page: ImageIntakePage,
  ref: PageImageReference,
): Promise<ImageIntakeResult> {
  let bytes;
  try {
    bytes = await resolveAttachmentBytes({
      pageId: page.id,
      confluenceId: page.confluence_id,
      pageSource: page.source,
      source: ref.source,
      key: ref.key,
    });
  } catch (error) {
    return { kind: 'unavailable', error };
  }
  if (!bytes) return { kind: 'skipped', reason: 'missing' };

  const sha256 = createHash('sha256').update(bytes.bytes).digest('hex');
  if (bytes.sniffedFormat === null) {
    // SVG, draw.io XML behind a `.png`, a PDF, a truncated download. All the
    // same verdict: this is not something a vision model can read.
    return { kind: 'skipped', reason: 'unsupported', sha256 };
  }
  if (bytes.bytes.length > MAX_IMAGE_BYTES) return { kind: 'skipped', reason: 'too_large', sha256 };
  const dims = readImageDimensions(bytes.bytes, bytes.sniffedFormat);
  if (!dims || dims.width <= 0 || dims.height <= 0) {
    return { kind: 'skipped', reason: 'unsupported', sha256 };
  }
  if (dims.width > MAX_IMAGE_DIMENSION || dims.height > MAX_IMAGE_DIMENSION) {
    return { kind: 'skipped', reason: 'oversized', sha256 };
  }
  return {
    kind: 'ok',
    bytes: bytes.bytes,
    format: bytes.sniffedFormat,
    width: dims.width,
    height: dims.height,
    sha256,
  };
}
