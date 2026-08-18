import { ATTACHMENT_URL_PATTERN, type PersistedSource } from '@compendiq/contracts';
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
 * An image source (#1115 P3, `kind: 'image'`) keeps its `kind` AND its
 * `attachmentUrl` — the pair the frontend's `isImageSource` discriminates
 * on — so a reopened conversation renders the same thumbnails as the live
 * answer did. The URL must satisfy the contract's `ATTACHMENT_URL_PATTERN`
 * (one of the two authenticated attachment routes; `''` and absolute URLs
 * fail it). This is the ONE runtime gate for that rule: nothing re-parses a
 * persisted source on the read path, and `SourceThumbnail` hands the stored
 * URL to `useAuthenticatedSrc`, which sets any non-`/api/` src directly as
 * `<img src>`.
 *
 * An image source whose URL fails that check is DROPPED ENTIRELY — the whole
 * entry, never a stripped survivor. `llm-ask.ts` builds one page-shaped entry
 * per search result and, separately, one image-shaped entry per image hit on
 * that same result, so a kept-but-stripped image entry would carry the SAME
 * `pageId` as the page entry already in the array and reopen as a second,
 * identical page chip — the exact duplicate the identity fix exists to
 * remove. Dropping it loses nothing: the page is already represented by its
 * own entry. Unreachable today (`buildPageImageUrl` only ever emits the two
 * allowed prefixes), so a source that trips this is a regression upstream —
 * hence the warn. A url without a kind is not an image source and neither
 * field is copied.
 */
export function toPersistedSources(sources: WireSource[]): PersistedSource[] {
  return sources.flatMap((s) => {
    const isImage = s.kind === 'image' && typeof s.attachmentUrl === 'string' && ATTACHMENT_URL_PATTERN.test(s.attachmentUrl);
    if (s.kind === 'image' && !isImage) {
      logger.warn(
        { pageId: s.pageId, pageTitle: s.pageTitle },
        'Dropping an image source whose attachmentUrl is empty or outside the attachment routes while persisting the conversation turn — its page, if any, is kept via the page-shaped entry for the same search result',
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
