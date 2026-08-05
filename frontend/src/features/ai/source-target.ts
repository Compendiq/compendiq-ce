import type { Source } from './SourceCitations';

/**
 * Where a citation actually points.
 *
 * `none` is a real outcome, not an error: a source can arrive with no usable
 * target (an old persisted conversation whose row predates `pageId`, or a
 * standalone page whose `confluenceId` is NULL). Rendering it as a dead link
 * into `/pages/` is what produced #1125 — the "page cannot be found" report.
 */
export type SourceTarget =
  | { kind: 'internal'; path: string }
  | { kind: 'external'; url: string }
  | { kind: 'none' };

/** Parses `value` as an absolute URL, or null if it isn't one. */
function parseAbsolute(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Resolves the navigation target for an AI source citation.
 *
 * Precedence, and why:
 *  1. An absolute URL (explicit `url`, or one the backend stuffed into
 *     `confluenceId` before this fix) is a **web/external** source. It must be
 *     opened as a link — `navigate('/pages/https://…')` is multi-segment, never
 *     matches `/pages/:id`, and lands on NotFoundPage.
 *  2. The internal integer `pages.id`. This is what every other navigation in
 *     the app uses, and it is the only id a locally-created page has.
 *  3. `confluenceId`, for conversations persisted before the backend started
 *     emitting `pageId` on every source.
 *
 * Discrimination is deliberately **not** on `spaceKey === 'Web'`: that is a
 * display label rendered verbatim, and a real Confluence space could be keyed
 * `Web`.
 */
export function resolveSourceTarget(source: Source): SourceTarget {
  const absolute = parseAbsolute(source.url) ?? parseAbsolute(source.confluenceId);
  if (absolute) {
    // Only http(s) is ever opened. A `javascript:` / `data:` / `file:` source
    // gets no target at all rather than falling through to be treated as a
    // page id — it is not one, and it must not become an href either.
    return absolute.protocol === 'http:' || absolute.protocol === 'https:'
      ? { kind: 'external', url: absolute.toString() }
      : { kind: 'none' };
  }

  if (typeof source.pageId === 'number' && Number.isInteger(source.pageId) && source.pageId > 0) {
    return { kind: 'internal', path: `/pages/${source.pageId}` };
  }

  const legacyId = source.confluenceId?.trim();
  if (legacyId) return { kind: 'internal', path: `/pages/${encodeURIComponent(legacyId)}` };

  return { kind: 'none' };
}
