/**
 * Remembers the Confluence space the user last created a page in, so the New
 * Page form can preselect it (#1122).
 *
 * Alphabetical-first would be the obvious default, but people author into one
 * space at a time: with ten spaces it would be the wrong guess nine times out
 * of ten, and a wrong preselection is worse than none because the user has to
 * notice it before they can correct it.
 *
 * A remembered key is only ever a *hint*. The caller must check it against the
 * spaces the current user can actually reach before using it — the value is
 * per-browser, not per-user, and a space can be unsynced or a role revoked
 * between visits. It is also cleared on logout, so the next user in the same
 * tab is not shown a space key belonging to the previous one.
 */

const STORAGE_KEY = 'compendiq:last-confluence-space';

/** The last remembered Confluence space key, or null. Never trust it blindly. */
export function readLastConfluenceSpace(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    // localStorage unavailable (private browsing quota, SSR) — no memory, no harm.
    return null;
  }
}

/** Record the Confluence space a page was just created in. */
export function rememberConfluenceSpace(spaceKey: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, spaceKey);
  } catch {
    // Ignore: the preselection is a convenience, never a correctness concern.
  }
}

/**
 * Forget the remembered space. Called from the logout choke point: the key is
 * per-browser, and while it can never grant access — the caller re-checks it
 * against the current user's spaces — the key *name* is still the previous
 * user's business.
 */
export function forgetLastConfluenceSpace(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored, nothing to forget.
  }
}
