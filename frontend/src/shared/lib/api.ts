import { useAuthStore } from '../../stores/auth-store';

const API_BASE = '/api';

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
    public remoteVersion?: number,
    public localVersion?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function refreshAccessToken(): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) return null;
    const data = await res.json();
    useAuthStore.getState().setAuth(data.accessToken, data.user);
    return data.accessToken;
  } catch {
    return null;
  }
}

/**
 * Deduplicates concurrent refresh calls. When multiple requests get 401
 * simultaneously (e.g. page load with expired token), only the first
 * triggers an actual refresh; all others await the same promise.
 * Without this, concurrent refreshes race to rotate the token, and the
 * backend's reuse detection revokes the entire token family.
 */
let pendingRefresh: Promise<string | null> | null = null;

export function refreshAccessTokenOnce(): Promise<string | null> {
  if (!pendingRefresh) {
    pendingRefresh = refreshAccessToken().finally(() => {
      pendingRefresh = null;
    });
  }
  return pendingRefresh;
}

/**
 * Decode a JWT's `exp` claim (client-readable; signature not verified — the
 * backend validates tokens) and report whether it is expired or within a small
 * skew window of expiring. Returns false for non-JWT / malformed tokens so the
 * caller falls back to the reactive 401 path.
 */
function isTokenExpired(token: string): boolean {
  try {
    const payload = token.split('.')[1];
    if (!payload) return false;
    const { exp } = JSON.parse(
      atob(payload.replace(/-/g, '+').replace(/_/g, '/')),
    ) as { exp?: number };
    if (typeof exp !== 'number') return false;
    // Refresh 5s early so a request doesn't expire in flight.
    return Date.now() >= exp * 1000 - 5000;
  } catch {
    return false;
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  let { accessToken } = useAuthStore.getState();

  // Proactive refresh: if the in-memory token is already expired, refresh once
  // (deduped via refreshAccessTokenOnce) BEFORE firing so a burst of concurrent
  // queries on session resume doesn't each round-trip to a guaranteed 401 (the
  // "401 storm"). The reactive 401 handler below stays as a fallback for
  // server-side revocation / clock skew.
  if (accessToken && isTokenExpired(accessToken)) {
    accessToken = await refreshAccessTokenOnce();
    if (!accessToken) {
      useAuthStore.getState().clearAuth();
      throw new ApiError(401, 'Session expired');
    }
  }

  const headers = new Headers(options.headers);
  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let res = await fetch(`${API_BASE}${path}`, { ...options, headers, credentials: 'include' });

  // Reactive token refresh on 401 (covers both expired tokens and
  // page-reload where accessToken was cleared from memory but
  // the httpOnly refresh cookie is still present)
  if (res.status === 401) {
    const newToken = await refreshAccessTokenOnce();
    if (newToken) {
      headers.set('Authorization', `Bearer ${newToken}`);
      res = await fetch(`${API_BASE}${path}`, { ...options, headers, credentials: 'include' });
    } else {
      useAuthStore.getState().clearAuth();
      throw new ApiError(401, 'Session expired');
    }
  }

  if (!res.ok) {
    const raw = (await res.json().catch(() => null)) as {
      message?: unknown;
      error?: unknown;
      code?: unknown;
      remoteVersion?: unknown;
      localVersion?: unknown;
    } | null;
    throw new ApiError(
      res.status,
      messageFromErrorBody(raw, res),
      typeof raw?.code === 'string' ? raw.code : undefined,
      typeof raw?.remoteVersion === 'number' ? raw.remoteVersion : undefined,
      typeof raw?.localVersion === 'number' ? raw.localVersion : undefined,
    );
  }

  if (res.headers.get('content-type')?.includes('application/json') && !isBodyless(res.status)) {
    try {
      return (await res.json()) as T;
    } catch {
      // A response that promises JSON and delivers nothing parseable. Left
      // alone this rejects with a raw SyntaxError, which is not an ApiError —
      // so every caller's `err instanceof ApiError` branch misses it and the
      // user gets a parser message, or silence (#1178).
      throw new ApiError(
        res.status,
        `The server returned an empty or malformed response (HTTP ${res.status}). Please try again.`,
      );
    }
  }
  return undefined as T;
}

/** Statuses that carry no body at all, so there is nothing to parse. */
function isBodyless(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

/**
 * The message a failed response leaves the user holding.
 *
 * A JSON body with a `message` is this app's error contract — surface it
 * verbatim, because it was written to be read. Everything else is a response
 * the app never composed: an HTML error page from the nginx edge, an empty
 * body, a gateway failure. Those used to collapse to `res.statusText` — which
 * names the *proxy's* rule rather than the app's, and is an empty string over
 * HTTP/2, where it slipped past `??` and produced a toast with no text at all
 * — or to a bare `'Request failed'` that took a full code audit to trace to a
 * branch. Both now carry the status code (#1178).
 */
function messageFromErrorBody(
  body: { message?: unknown; error?: unknown } | null,
  res: Response,
): string {
  if (typeof body?.message === 'string' && body.message.trim()) return body.message;
  // Several admin routes answer `{error: <human text>}` (the shadow-migration
  // refusals, provider guards, probe 404s). Surface that text rather than a
  // bare status line — but only when it reads as prose; a single-token error
  // NAME ('InternalServerError') is not a message (#1116 review r3).
  if (typeof body?.error === 'string' && body.error.trim() && /\s/.test(body.error.trim())) {
    // Keep naming the status — the pre-existing contract for message-less
    // bodies — while surfacing the refusal text.
    return `${body.error.trim()} (HTTP ${res.status})`;
  }

  const reason = res.statusText.trim();
  return reason ? `${reason} (HTTP ${res.status})` : `Request failed (HTTP ${res.status})`;
}

/**
 * Call the backend logout endpoint to revoke tokens and clear the refresh cookie,
 * then clear frontend auth state. Always clears frontend state even if the backend
 * call fails (e.g. network error or expired token).
 */
export async function logoutApi(): Promise<void> {
  const { accessToken } = useAuthStore.getState();
  try {
    const headers: HeadersInit = {};
    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }
    await fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      headers,
      credentials: 'include',
    });
  } catch {
    // Best effort — always clear frontend state below
  }
  useAuthStore.getState().clearAuth();
}
