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

/**
 * The picture's own name, for the surfaces that have to tell two of them
 * apart (#1115 P3, review r1).
 *
 * One page contributes up to `MAX_IMAGE_HITS_PER_PAGE` (3) image sources to
 * one answer, and they arrive carrying the same `pageTitle`, the same
 * `spaceKey` and the same destination — so a citation named `${pageTitle} —
 * image` names three different pictures identically, and the thumbnails, which
 * are deliberately decorative, are the only thing distinguishing them. On a
 * surface whose subject IS the pictures that is the tree's own
 * twenty-identical-"Expand"-buttons problem, so the filename — already on the
 * wire, as the last segment of `attachmentUrl` — is added to the accessible
 * name and shown beside the `Image` label.
 *
 * `null` rather than a placeholder when there is nothing usable to show: the
 * caller then keeps its unqualified label, which is the correct name for a
 * page contributing exactly one image and would otherwise gain a meaningless
 * suffix.
 *
 * The segment is percent-encoded by `buildPageImageUrl`
 * (`encodeURIComponent`), and `decodeURIComponent` throws on a lone `%` — a
 * character a real filename may contain (`100%.png`). The raw segment is then
 * the honest fallback, exactly as the backend's own decoder does it.
 */
export function imageSourceFileName(source: Source): string | null {
  if (!isImageSource(source)) return null;
  const raw = source.attachmentUrl!.split('/').pop();
  if (!raw) return null;
  try {
    return decodeURIComponent(raw) || null;
  } catch {
    return raw;
  }
}
