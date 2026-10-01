import { useAuthStore } from '../../stores/auth-store';

/**
 * The command palette's recent search terms, kept in localStorage per ACCOUNT.
 *
 * localStorage is shared by every account that signs in to the same browser
 * profile, so the terms are stored under the signed-in user's id
 * (`compendiq-recent-searches:u:<userId>`) and only ever read back for that
 * same id. With no signed-in user nothing is read or written. This module is
 * the only place that builds a recent-searches storage key.
 *
 * Lifecycle (the editor-drafts rules, see `editor-drafts.ts`):
 * - An explicit sign-out (`discardRecentSearchesOnSignOut`, called by
 *   `logoutApi`) deletes the signing-out user's terms and the legacy key.
 * - Any other session loss (refresh failure, expiry → `clearAuth`) keeps them
 *   for the same user's next sign-in; no other account can read them.
 * - The legacy unscoped `kb-recent-searches` list has no owner: it is never
 *   read, and `purgeLegacyRecentSearches` deletes it at app start.
 *
 * Terms are written synchronously by the signed-in user's own action, so
 * there is no pending write to fence on sign-out. A tab that has not yet
 * processed another tab's sign-out still writes under the signed-in user's
 * scope only.
 */

const LEGACY_KEY = 'kb-recent-searches';
const SCOPED_PREFIX = 'compendiq-recent-searches:u:';
const MAX_RECENT = 5;

function storageKey(userId: string): string {
  return `${SCOPED_PREFIX}${encodeURIComponent(userId)}`;
}

function signedInUserId(): string | null {
  const { isAuthenticated, user } = useAuthStore.getState();
  return isAuthenticated && user?.id ? user.id : null;
}

function readTerms(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((term): term is string => typeof term === 'string').slice(0, MAX_RECENT)
      : [];
  } catch {
    return [];
  }
}

function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch { /* storage unavailable — nothing to remove */ }
}

/** The signed-in user's recent search terms, newest first. */
export function readRecentSearches(): string[] {
  const userId = signedInUserId();
  return userId ? readTerms(storageKey(userId)) : [];
}

/** Record `term` as the signed-in user's most recent search. */
export function rememberRecentSearch(term: string): void {
  const userId = signedInUserId();
  if (!userId) return;
  const key = storageKey(userId);
  const next = [term, ...readTerms(key).filter((s) => s !== term)].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch { /* quota exceeded — recent searches are a convenience */ }
}

/** Explicit sign-out completed: delete `userId`'s terms and the legacy list. */
export function discardRecentSearchesOnSignOut(userId: string | null): void {
  if (userId) removeKey(storageKey(userId));
  removeKey(LEGACY_KEY);
}

/** Delete the list written before recent searches were scoped to an account. */
export function purgeLegacyRecentSearches(): void {
  removeKey(LEGACY_KEY);
}
