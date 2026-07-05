import { useAuthStore } from '../../stores/auth-store';
import { refreshAccessTokenOnce } from './api';

/**
 * Structured error body returned by the backend. Callers that need field-level
 * details (e.g. `{ error: 'invalid_cidr', cidr }`) read the extra keys off
 * `FetchJsonError.body`, which `apiFetch`'s `ApiError` discards.
 */
export interface FetchJsonErrorBody {
  error?: string;
  message?: string;
  [key: string]: unknown;
}

/**
 * Error thrown by {@link fetchJson}. Unlike `apiFetch`'s `ApiError`, it carries
 * both the HTTP `status` and the raw structured `body`, so call sites can branch
 * on 404 or surface backend field errors.
 */
export class FetchJsonError extends Error {
  constructor(
    public status: number,
    public body: FetchJsonErrorBody,
    message: string,
  ) {
    super(message);
    this.name = 'FetchJsonError';
  }
}

/**
 * Authenticated JSON fetch with the same reactive 401 refresh-and-retry as
 * `apiFetch`, but which preserves the backend's structured error body.
 *
 * On 401 it refreshes the access token via the httpOnly refresh cookie and
 * re-issues the request once; if the refresh fails it clears auth and throws
 * `FetchJsonError(401)`.
 */
export async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const buildHeaders = (token: string | null): Headers => {
    const headers = new Headers(init?.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (init?.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    return headers;
  };

  const { accessToken } = useAuthStore.getState();
  let res = await fetch(`/api${path}`, {
    ...init,
    headers: buildHeaders(accessToken),
    credentials: 'include',
  });

  if (res.status === 401) {
    const newToken = await refreshAccessTokenOnce();
    if (newToken) {
      res = await fetch(`/api${path}`, {
        ...init,
        headers: buildHeaders(newToken),
        credentials: 'include',
      });
    } else {
      useAuthStore.getState().clearAuth();
    }
  }

  if (!res.ok) {
    const body: FetchJsonErrorBody = await res.json().catch(() => ({}));
    throw new FetchJsonError(
      res.status,
      body,
      body.message ?? body.error ?? res.statusText,
    );
  }
  if (res.status === 204) return undefined as T;
  if (res.headers.get('content-type')?.includes('application/json')) {
    return res.json();
  }
  return undefined as T;
}
