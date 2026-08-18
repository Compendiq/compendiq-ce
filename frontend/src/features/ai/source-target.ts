import type { Source } from './SourceCitations';

/**
 * Where a citation actually points.
 *
 * `none` is a real outcome, not an error: a source can arrive carrying neither
 * a `pageId` nor a URL, and rendering that as a link into `/pages/` is what
 * produced #1125 — the "page cannot be found" report.
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
 *  3. Nothing. **`confluenceId` is never a navigation target.** It is kept on
 *     the type because it still arrives on the wire and case 1 reads a URL out
 *     of it, but it must not be routed: `GET /pages/:id` resolves a
 *     `/^\d+$/` id against the integer PK (`pages-crud.ts`), and Confluence
 *     content ids *are* numeric — so `/pages/<confluenceId>` does not 404, it
 *     silently opens whichever unrelated page happens to hold that PK. A
 *     non-link is the safe outcome; a wrong page is worse than #1125's
 *     not-found. Nothing is lost by refusing: `/llm/ask` has always emitted
 *     `pageId` on knowledge-base hits, the other three routes only ever emit
 *     web sources (which carry the URL), and persisted sources (#1361) carry
 *     the same `pageId`, so the stored back-catalogue has no `pageId`-less KB
 *     source either.
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

  return { kind: 'none' };
}
