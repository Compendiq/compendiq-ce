import type { Source } from './SourceCitations';

/**
 * Whether a citation is an image the retrieval leg matched (#1115 P3).
 *
 * Its own module, beside `source-target.ts`, for the same reason that one is:
 * a predicate over `Source` shared by three render surfaces is not a
 * component, and exporting it from `SourceCitations.tsx` costs that file its
 * fast-refresh boundary.
 *
 * It requires the URL as well as the discriminator. `kind` alone would let a
 * malformed frame render an empty `<img>` and, worse, take the image branch's
 * `aria-label` on a chip with no picture in it — the check and the thing it
 * unlocks have to be the same fact.
 *
 * **`similarity` on an image source is always `null`**, deliberately: the
 * image leg's own score is a CROSS-MODAL cosine sitting in a different band
 * from the text cosines beside it in the same array (ADR-025 §8), so
 * `averageSourceSimilarity` must never see one. That is enforced at the
 * backend, and pinned in `source-confidence.test.ts`.
 */
export function isImageSource(source: Source): boolean {
  return source.kind === 'image' && typeof source.attachmentUrl === 'string';
}
