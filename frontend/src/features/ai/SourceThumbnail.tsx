import { useEffect, useRef, useState } from 'react';
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
 * How far ahead of the viewport a thumbnail starts fetching. The gate exists to
 * bound the UNBOUNDED case — a whole reopened history fetched in one gesture —
 * not to refuse the next screenful, so it is generous.
 */
const PREFETCH_MARGIN = '200px';

/**
 * The picture beside an image source (#1115 P3).
 *
 * Four decisions are load-bearing.
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
 * **It is VIEWPORT-GATED (#1361, owner's decision 2026-08-18).** `CitationChips`
 * renders on every answer and each image source pulls the FULL attachment —
 * ADR-025 deliberately adds no server-side resize — so an N-turn thread costs
 * `N × MAX_IMAGE_SOURCES` (4) full-size requests, and reopening a conversation
 * reaches that state in ONE gesture rather than over a session. So the fetch
 * waits for a zero-footprint sentinel to intersect once, and the gate lives
 * here rather than behind a per-surface flag: the 14px chip and the 32px card,
 * live and reopened, all get it from one place. The sentinel has no layout, so
 * the "loading and failure render nothing" rule above is kept exactly — no
 * placeholder box, no layout shift.
 *
 * Neutral by ADR-010: an image source is a CATEGORY, not a state, so the frame
 * is `--color-border` and nothing here is Steel or violet.
 */
export function SourceThumbnail({ url, size, className }: SourceThumbnailProps) {
  const sentinelRef = useRef<HTMLSpanElement>(null);
  // No `IntersectionObserver` at all (an old browser, a non-DOM renderer) means
  // the gate cannot be evaluated — fetch, rather than silently render no
  // thumbnail anywhere for the rest of the session.
  const [inView, setInView] = useState(() => typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    if (inView) return;
    const node = sentinelRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        // Once is enough: the blob URL is held by `useAuthenticatedSrc` until
        // unmount, so scrolling away has nothing to release and scrolling back
        // has nothing to re-fetch.
        setInView(true);
        observer.disconnect();
      },
      { rootMargin: PREFETCH_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [inView]);

  const { blobSrc, error } = useAuthenticatedSrc(inView ? url : null);

  if (!inView || error || !blobSrc) {
    return (
      <span
        ref={sentinelRef}
        aria-hidden
        data-testid="source-thumbnail-sentinel"
        style={{ display: 'inline-block', width: 0, height: 0 }}
      />
    );
  }

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
