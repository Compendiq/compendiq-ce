import type { PersistedSource } from '@compendiq/contracts';
import { logger } from '../../../core/utils/logger.js';

/** The union `llm-ask.ts` builds from search results, external docs, web hits and image hits. */
export interface WireSource {
  pageId?: number;
  pageTitle: string;
  spaceKey?: string | null;
  confluenceId?: string | null;
  url?: string;
  sectionTitle?: string;
  score?: number;
  similarity?: number | null;
  rerankScore?: number | null;
  /** #1115 P3 — the image-leg discriminator; see `toPersistedSources`. */
  kind?: 'image';
  attachmentUrl?: string;
}

/**
 * The persisted shape of a source (#1361): what a citation chip renders, and
 * nothing that only orders or thresholds. `pageId: 0` is the wire's
 * "not a knowledge-base page" sentinel and is OMITTED — the contract's
 * `SourceSchema.pageId` is positive-or-absent, and the read side annotates
 * only sources that carry a real page id.
 *
 * `kind`/`attachmentUrl` copy together, never singly — both or neither,
 * mirroring the frontend's `isImageSource` predicate (#1115 P3), so a
 * reopened conversation renders the same thumbnails as the live answer did.
 * A `kind` with no url or a url with no kind is not an image source by that
 * predicate, so copying just one would produce a shape the reader cannot
 * render as either a page or an image.
 *
 * The URL must be a NON-EMPTY string, not merely a string: `''` passes
 * `typeof === 'string'` on both this guard and the frontend's `isImageSource`
 * (review r1 #5), so an empty-string URL would take the image branch — and
 * its image `aria-label` — with no picture in it.
 *
 * An image source (`kind === 'image'`) whose URL fails that check is DROPPED
 * ENTIRELY (review r2 #1) — the whole entry, not merely its `kind` and
 * `attachmentUrl`. `llm-ask.ts` builds one page-shaped entry per search
 * result (from `searchResults`) and, separately, one image-shaped entry per
 * image hit on that same result (from `searchResults[].imageHits`), so a
 * stripped-but-kept image entry would carry the SAME `pageId` as the page
 * entry already sitting in the array and reopen as a second, identical page
 * chip — the "worst of both" the architect's decision names, reached through
 * an unusable URL instead of a missing one. Dropping it loses nothing: that
 * page is already represented by its own page-shaped entry. Unreachable
 * today (`buildPageImageUrl` never returns `''`), so a source that trips
 * this is a future regression, not a skip this deployment already relies on
 * — hence the warn.
 */
export function toPersistedSources(sources: WireSource[]): PersistedSource[] {
  return sources.flatMap((s) => {
    const isImage = s.kind === 'image' && typeof s.attachmentUrl === 'string' && s.attachmentUrl.length > 0;
    if (s.kind === 'image' && !isImage) {
      logger.warn(
        { pageId: s.pageId, pageTitle: s.pageTitle },
        'Dropping an image source with no usable attachmentUrl while persisting the conversation turn — its page, if any, is kept via the page-shaped entry for the same search result',
      );
      return [];
    }
    return [{
      pageTitle: s.pageTitle,
      ...(s.spaceKey !== undefined ? { spaceKey: s.spaceKey } : {}),
      ...(typeof s.pageId === 'number' && s.pageId > 0 ? { pageId: s.pageId } : {}),
      ...(s.confluenceId !== undefined ? { confluenceId: s.confluenceId } : {}),
      ...(s.url ? { url: s.url } : {}),
      ...(s.sectionTitle ? { sectionTitle: s.sectionTitle } : {}),
      ...(isImage ? { kind: 'image' as const, attachmentUrl: s.attachmentUrl! } : {}),
      similarity: s.similarity ?? null,
    }];
  });
}
