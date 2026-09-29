import { LOGOUT_BUSY_CODE, REFRESH_BUSY_CODE } from '@compendiq/contracts';
import { useAuthStore } from '../../stores/auth-store';
import { withAuthCookieLock } from './auth-cookie-lock';
import { discardDraftsOnSignOut } from './editor-drafts';

const API_BASE = '/api';

export class ApiError extends Error {
  /**
   * `reason` (#1615) — the category slug some admin routes send beside
   * `error` (the probe-gated assignment PUTs answer 422 `{ error, reason }`,
   * where `reason` is what a client branches on and `error` is the prose).
   * Additive: routes that send none leave it undefined.
   */
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
    public remoteVersion?: number,
    public localVersion?: number,
    public reason?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The refresh did not complete, but the session may still be valid: a network
 * error, a server or proxy error, 408/429, or the backend's retry-safe busy
 * 503 on every attempt. Callers keep the session and surface this error
 * instead of logging out.
 */
export class RefreshUnavailableError extends ApiError {
  constructor() {
    super(503, 'Your session could not be refreshed right now. Please try again.');
    this.name = 'RefreshUnavailableError';
  }
}

/** Pauses before the second and third attempt after a retry-safe busy 503. */
const REFRESH_RETRY_DELAYS_MS = [1_000, 3_000];

/** A 503 whose body carries `code`: the backend rolled back, so a retry is safe. */
async function isMarkedBusy(res: Response, code: string): Promise<boolean> {
  if (res.status !== 503) return false;
  const body: unknown = await res.json().catch(() => null);
  return typeof body === 'object' && body !== null && 'code' in body && body.code === code;
}

const REFRESH_BUSY = Symbol('refresh busy');

/**
 * One `POST /auth/refresh`. Resolves the new access token, `null` when the
 * session is gone (401/403 and other non-transient 4xx), or REFRESH_BUSY for
 * the backend's retry-safe busy 503. Rejects with RefreshUnavailableError for
 * every other transient failure without retrying: after a network error or a
 * proxy 5xx the rotation may already have committed, and presenting the
 * consumed cookie again would be treated as token reuse.
 */
async function refreshAttempt(): Promise<string | null | typeof REFRESH_BUSY> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
  } catch {
    throw new RefreshUnavailableError();
  }
  if (res.ok) {
    try {
      const data = await res.json();
      useAuthStore.getState().setAuth(data.accessToken, data.user);
      return data.accessToken;
    } catch {
      return null;
    }
  }
  if (await isMarkedBusy(res, REFRESH_BUSY_CODE)) return REFRESH_BUSY;
  if (res.status >= 500 || res.status === 408 || res.status === 429) throw new RefreshUnavailableError();
  return null;
}

/**
 * Deduplicates concurrent refresh calls. When multiple requests get 401
 * simultaneously (e.g. page load with expired token), only the first
 * triggers an actual refresh; all others await the same promise.
 *
 * Each attempt runs under the browser-wide auth-cookie lock, so tabs sharing
 * the HttpOnly refresh cookie never present it concurrently — the backend
 * treats refresh tokens as single-use and revokes the whole family when one
 * is presented twice. On every acquisition a tab first adopts a token another
 * tab broadcast (auth-store BroadcastChannel) since this refresh began,
 * instead of rotating again; without a broadcast it rotates the
 * already-updated cookie in turn. After the backend's retry-safe busy 503 the
 * lock is released for the backoff, so other tabs (and logout) are not held
 * up and a sibling's successful refresh is adopted on the next attempt.
 *
 * Resolves `null` only when the session is gone (callers then clear auth);
 * rejects with RefreshUnavailableError when the refresh did not complete, in
 * which case callers must keep the session.
 */
let pendingRefresh: Promise<string | null> | null = null;

async function refreshWithBackoff(observedToken: string | null): Promise<string | null> {
  for (let attempt = 0; ; attempt += 1) {
    const outcome = await withAuthCookieLock(async () => {
      const current = useAuthStore.getState().accessToken;
      if (current && current !== observedToken && !isTokenExpired(current)) return current;
      return refreshAttempt();
    });
    if (outcome !== REFRESH_BUSY) return outcome;
    const delay = REFRESH_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) throw new RefreshUnavailableError();
    const pause = Promise.withResolvers<void>();
    setTimeout(pause.resolve, delay);
    await pause.promise;
  }
}

export function refreshAccessTokenOnce(): Promise<string | null> {
  if (!pendingRefresh) {
    pendingRefresh = refreshWithBackoff(useAuthStore.getState().accessToken).finally(() => {
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

  const request = () => fetch(`${API_BASE}${path}`, { ...options, headers, credentials: 'include' });
  // Login/registration responses replace the refresh cookie. Send them under
  // the auth-cookie lock so a refresh in another tab cannot present the
  // previous cookie concurrently and overwrite the new session's cookie with
  // a successor of the old one.
  const send = path === '/auth/login' || path === '/auth/register'
    ? () => withAuthCookieLock(request)
    : request;

  let res = await send();

  // Reactive token refresh on 401 (covers both expired tokens and
  // page-reload where accessToken was cleared from memory but
  // the httpOnly refresh cookie is still present)
  if (res.status === 401) {
    const newToken = await refreshAccessTokenOnce();
    if (newToken) {
      headers.set('Authorization', `Bearer ${newToken}`);
      res = await send();
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
      reason?: unknown;
    } | null;
    throw new ApiError(
      res.status,
      messageFromErrorBody(raw, res),
      typeof raw?.code === 'string' ? raw.code : undefined,
      typeof raw?.remoteVersion === 'number' ? raw.remoteVersion : undefined,
      typeof raw?.localVersion === 'number' ? raw.localVersion : undefined,
      typeof raw?.reason === 'string' ? raw.reason : undefined,
    );
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/octet-stream') && !isBodyless(res.status)) {
    return (await res.blob()) as T;
  }

  if (contentType.includes('application/json') && !isBodyless(res.status)) {
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

/** Authenticated binary GET for same-origin client-model assets (#1418). */
export async function apiFetchBlob(path: string, options: RequestInit = {}): Promise<Blob> {
  const blob = await apiFetch<Blob | undefined>(path, options);
  if (blob instanceof Blob) return blob;
  throw new ApiError(500, 'Expected binary asset');
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
 * then clear frontend auth state. Frontend state is cleared even if the backend
 * call fails (e.g. network error, proxy error or expired token), except on the
 * backend's marked busy 503: the server could not revoke anything and kept the
 * cookie, so the session stays and this rejects with an ApiError the caller
 * shows, leaving a retry possible.
 *
 * A completed sign-out also discards the user's local editor drafts, so the
 * next account in this browser cannot be offered them. Other session loss
 * (plain `clearAuth()`) keeps them for the same user's next sign-in.
 */
export async function logoutApi(): Promise<void> {
  const { accessToken, user } = useAuthStore.getState();
  let res: Response | null = null;
  try {
    const headers: HeadersInit = {};
    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }
    // Logout clears the refresh cookie; keep it from overlapping another
    // tab's refresh of the same cookie.
    res = await withAuthCookieLock(() => fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      headers,
      credentials: 'include',
    }));
  } catch {
    // Best effort — always clear frontend state below
  }
  if (res && await isMarkedBusy(res, LOGOUT_BUSY_CODE)) {
    throw new ApiError(503, 'Sign-out did not complete. Please try again.', LOGOUT_BUSY_CODE);
  }
  discardDraftsOnSignOut(user?.id ?? null);
  useAuthStore.getState().clearAuth();
}
