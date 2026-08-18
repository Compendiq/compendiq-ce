import type { PersistedSource } from '@compendiq/contracts';

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
 */
export function toPersistedSources(sources: WireSource[]): PersistedSource[] {
  return sources.map((s) => {
    const isImage = s.kind === 'image' && typeof s.attachmentUrl === 'string';
    return {
      pageTitle: s.pageTitle,
      ...(s.spaceKey !== undefined ? { spaceKey: s.spaceKey } : {}),
      ...(typeof s.pageId === 'number' && s.pageId > 0 ? { pageId: s.pageId } : {}),
      ...(s.confluenceId !== undefined ? { confluenceId: s.confluenceId } : {}),
      ...(s.url ? { url: s.url } : {}),
      ...(s.sectionTitle ? { sectionTitle: s.sectionTitle } : {}),
      ...(isImage ? { kind: 'image' as const, attachmentUrl: s.attachmentUrl! } : {}),
      similarity: s.similarity ?? null,
    };
  });
}
