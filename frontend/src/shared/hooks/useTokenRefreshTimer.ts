import { useEffect } from 'react';
import { useAuthStore } from '../../stores/auth-store';
import { refreshAccessTokenOnce } from '../lib/api';

/**
 * Decode the payload of a JWT without verifying the signature.
 * The frontend only needs the `exp` claim to schedule proactive refreshes —
 * no cryptographic verification is required (the backend validates tokens).
 */
function decodeJwtPayload(token: string): { exp?: number; [key: string]: unknown } {
  const parts = token.split('.');
  const payload = parts[1];
  if (!payload) return {};
  try {
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return {};
  }
}

/**
 * Proactively refreshes the access token at 75% of its remaining lifetime,
 * rather than waiting for a reactive 401. This eliminates the observable
 * latency spike users see when a token expires mid-session: the timer fires
 * before expiry, silently exchanges the refresh cookie for a new token, and
 * updates the store — which re-triggers this hook to schedule the next cycle.
 *
 * If the proactive refresh fails (e.g. no network), the reactive interceptor
 * in apiFetch will still catch the eventual 401 on the next API call.
 */
export function useTokenRefreshTimer() {
  const accessToken = useAuthStore((s) => s.accessToken);

  useEffect(() => {
    if (!accessToken) return;

    let exp: number | undefined;
    try {
      const claims = decodeJwtPayload(accessToken);
      exp = claims.exp;
    } catch {
      return; // malformed token — let reactive refresh handle it
    }
    if (!exp) return;

    const now = Math.floor(Date.now() / 1000);
    const remaining = exp - now;
    if (remaining <= 0) return; // already expired — reactive refresh will handle it

    // Refresh at 75% of remaining lifetime (minimum 10 seconds from now)
    const refreshInMs = Math.max(remaining * 0.75, 10) * 1000;

    const timer = setTimeout(() => {
      refreshAccessTokenOnce().catch(() => {
        // Proactive refresh failed — reactive refresh will catch it on next API call
      });
    }, refreshInMs);

    return () => clearTimeout(timer);
  }, [accessToken]);
}
