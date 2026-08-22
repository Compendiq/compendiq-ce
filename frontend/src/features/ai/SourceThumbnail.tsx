import { cn } from '../../shared/lib/cn';
import { useAuthenticatedSrc } from '../../shared/hooks/use-authenticated-src';

interface SourceThumbnailProps {
  /** `/api/attachments/…` or `/api/local-attachments/…` — an authenticated route. */
  url: string;
  /** Rendered edge length in px. */
  size: number;
  className?: string;
}

/**
 * The picture beside an image source (#1115 P3).
 *
 * Three decisions are load-bearing.
 *
 * **It fetches through `useAuthenticatedSrc`**, the mechanism `ArticleViewer`
 * already uses for every `<img>` in a page body: the attachment routes are
 * behind `fastify.authenticate`, and a browser `<img src>` cannot carry a
 * bearer token, so a plain `src` would 401 on every thumbnail. The hook
 * fetches with the token, hands back a blob URL and revokes it on unmount.
 *
 * **It is DECORATIVE — `alt=""` plus `aria-hidden`** — on every surface that
 * uses it, and every one of them puts the page title on the *control* instead
 * (visible text in the source card, an `aria-label` on the citation chip). A
 * thumbnail with `alt="Page — image"` beside a visible "Page" says the same
 * thing twice to a screen reader while the link, which is the thing you
 * operate, is still the one that has to be named. One rule across all three
 * surfaces beats a per-surface judgement call.
 *
 * **Loading and failure both render NOTHING.** The caller degrades to its
 * title-only shape, which is a complete, operable source citation — an image
 * that will not load must not leave a broken-image glyph or a grey box
 * standing in for a source. It also means an attachment whose ACL has changed
 * since retrieval simply shows as a page link.
 *
 * Neutral by ADR-010: an image source is a CATEGORY, not a state, so the frame
 * is `--color-border` and nothing here is Steel or violet.
 */
export function SourceThumbnail({ url, size, className }: SourceThumbnailProps) {
  const { blobSrc, error } = useAuthenticatedSrc(url);
  if (error || !blobSrc) return null;
  return (
    <img
      src={blobSrc}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className={cn('shrink-0 rounded border border-border object-cover', className)}
      data-testid="source-thumbnail"
    />
  );
}
