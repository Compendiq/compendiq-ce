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
  /**
   * ADR-027 D12 — the derived-provenance discriminator; see
   * `toPersistedSources`. Introduced as the image leg's discriminator
   * (#1115 P3); the leg was retired in #1618 stage 2 and the `image_analysis`
   * chunks inherited the shape.
   */
  kind?: 'image';
  attachmentUrl?: string;
  /** ADR-027 D12 (#1617) — copied together with `kind`/`attachmentUrl`. */
  attachmentStore?: 'confluence' | 'local';
  attachmentKey?: string;
  contentHash?: string;
  analysisVersion?: number;
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
 * fail it). Nothing re-parses a persisted source on the read path, so this
 * is the write-side gate; the frontend's `isImageSource` imports the same
 * pattern as the last check before `<img>` (`SourceThumbnail` hands the URL
 * to `useAuthenticatedSrc`, which sets any non-`/api/` src directly).
 *
 * ADR-027 D12 adds four provenance fields — `attachmentStore`,
 * `attachmentKey`, `contentHash`, `analysisVersion` — and they are copied as
 * ONE UNIT with `kind`/`attachmentUrl`, never singly: the contract's
 * `superRefine` rejects a subset, and a lone `contentHash` on a replayed turn
 * would be provenance with nothing to attribute it to. An image source that
 * carries none of them is a pre-#1617 shape and stays valid. A dropped image
 * entry takes its provenance with it, for the same reason it takes its URL.
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
    // All four or none (D12). A partially-populated wire source is an upstream
    // regression, and persisting the half of it that exists would write a row
    // the contract refuses to parse.
    const hasProvenance =
      s.attachmentStore !== undefined
      && s.attachmentKey !== undefined
      && s.contentHash !== undefined
      && s.analysisVersion !== undefined;
    if (s.kind === 'image' && !isImage) {
      logger.warn(
        { pageId: s.pageId, pageTitle: s.pageTitle, attachmentUrl: s.attachmentUrl ?? null },
        'Dropping an image source whose attachmentUrl is missing, empty or outside the attachment routes while persisting the conversation turn — its page, if any, is kept via the page-shaped entry for the same search result',
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
      ...(isImage && hasProvenance
        ? {
            attachmentStore: s.attachmentStore!,
            attachmentKey: s.attachmentKey!,
            contentHash: s.contentHash!,
            analysisVersion: s.analysisVersion!,
          }
        : {}),
      similarity: s.similarity ?? null,
    }];
  });
}
