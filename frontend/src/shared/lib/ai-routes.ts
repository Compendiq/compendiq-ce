/**
 * The `/ai` route family (#1361).
 *
 * `AiProvider` sits ABOVE `<Routes>` (`AppLayout.tsx`), so it cannot use
 * `useParams`: it reads the conversation id out of `location.pathname`, exactly
 * as `resolveAiPageId` reads the article id. `AppLayout` lives in `shared/` and
 * `AiContext` in `features/`, and both need these predicates, so they belong in
 * `shared/lib` beside `article-route.ts` — the same shape of module, extracted
 * for the same reason.
 */

/** The bare assistant route: a new, unsaved chat. */
export const AI_HOME_PATH = '/ai';

/**
 * `/ai` and `/ai/c/<id>`, and nothing else.
 *
 * A trailing slash is deliberately not matched: react-router normalises `/ai/`
 * to `/ai` before anything reads `location.pathname`, so accepting it would
 * only add a second spelling of the same route for hand-built strings. Neither
 * is an empty id (`/ai/c/`) — the segment is `[^/]+`, so it falls through to
 * `App.tsx`'s `*` route and gets the real 404.
 */
const AI_ROUTE = /^\/ai(?:\/c\/([^/]+))?$/;

export function isAiRoute(pathname: string): boolean {
  return AI_ROUTE.test(pathname);
}

/**
 * The conversation id on `/ai/c/:id`; `null` on `/ai` and off the family.
 *
 * The segment is decoded because `conversationPath` encodes it. A malformed
 * escape makes `decodeURIComponent` throw, and this runs on every render of the
 * provider, so the raw segment is returned instead: a hand-typed URL yields a
 * lookup that 404s rather than an exception out of `AiProvider`.
 */
export function conversationIdFromPath(pathname: string): string | null {
  const raw = AI_ROUTE.exec(pathname)?.[1];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** The URL of one conversation. */
export function conversationPath(id: string): string {
  return `/ai/c/${encodeURIComponent(id)}`;
}
