import type { PersistedSource } from '@compendiq/contracts';

/** The union `llm-ask.ts` builds from search results, external docs and web hits. */
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
}

/**
 * The persisted shape of a source (#1361): what a citation chip renders, and
 * nothing that only orders or thresholds. `pageId: 0` is the wire's
 * "not a knowledge-base page" sentinel and is OMITTED — the contract's
 * `SourceSchema.pageId` is positive-or-absent, and the read side annotates
 * only sources that carry a real page id.
 */
export function toPersistedSources(sources: WireSource[]): PersistedSource[] {
  return sources.map((s) => ({
    pageTitle: s.pageTitle,
    ...(s.spaceKey !== undefined ? { spaceKey: s.spaceKey } : {}),
    ...(typeof s.pageId === 'number' && s.pageId > 0 ? { pageId: s.pageId } : {}),
    ...(s.confluenceId !== undefined ? { confluenceId: s.confluenceId } : {}),
    ...(s.url ? { url: s.url } : {}),
    ...(s.sectionTitle ? { sectionTitle: s.sectionTitle } : {}),
    similarity: s.similarity ?? null,
  }));
}
