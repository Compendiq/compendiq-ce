import { useAuthStore } from '../../stores/auth-store';

const API_BASE = '/api';

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
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

function refreshAccessTokenOnce(): Promise<string | null> {
  if (!pendingRefresh) {
    pendingRefresh = refreshAccessToken().finally(() => {
      pendingRefresh = null;
    });
  }
  return pendingRefresh;
}

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const { accessToken } = useAuthStore.getState();

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
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new ApiError(res.status, body.message ?? 'Request failed');
  }

  if (res.headers.get('content-type')?.includes('application/json')) {
    return res.json();
  }
  return undefined as T;
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
