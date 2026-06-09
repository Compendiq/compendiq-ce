/**
 * Pure helpers for validating the OIDC Redirect URI against the origin the
 * admin is actually using.
 *
 * Background (issue #710): OIDC login uses a two-hop callback. The configured
 * Redirect URI governs hop 1 (IdP → backend). Hop 3 (backend → SPA) is built
 * from the backend's `FRONTEND_URL` env var, which defaults to a localhost
 * value. When those two origins diverge — typically behind a reverse proxy —
 * a correctly-set Redirect URI still bounces the browser to `localhost`,
 * dead-ending login. `FRONTEND_URL` is invisible in the admin UI, so the
 * footgun is silent.
 *
 * These helpers let the settings page warn when the Redirect URI's origin does
 * not match the origin the admin loaded the app from (`window.location.origin`),
 * and surface the exact `FRONTEND_URL` value the backend must be set to.
 */

/** Extract the origin (`scheme://host[:port]`) from a URL string, or null if unparseable. */
export function originOf(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

export interface RedirectUriCheck {
  /** True when the Redirect URI origin diverges from the app origin. */
  mismatch: boolean;
  /** Origin parsed from the Redirect URI, or null if it isn't a valid URL yet. */
  redirectOrigin: string | null;
  /** The origin the admin is currently using (typically window.location.origin). */
  appOrigin: string;
}

/**
 * Compare the Redirect URI's origin against the app origin.
 *
 * Returns `mismatch: false` while the Redirect URI is empty or not yet a valid
 * URL (nothing to warn about until the admin has typed a complete origin), so
 * the warning only fires on a genuine, confident divergence.
 */
export function checkRedirectUriOrigin(redirectUri: string, appOrigin: string): RedirectUriCheck {
  const redirectOrigin = originOf(redirectUri);
  return {
    redirectOrigin,
    appOrigin,
    mismatch: redirectOrigin !== null && redirectOrigin !== appOrigin,
  };
}
