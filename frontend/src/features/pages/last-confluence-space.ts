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
 * between visits.
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
