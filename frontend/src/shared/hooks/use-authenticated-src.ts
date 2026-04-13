import { useState, useEffect, useRef } from 'react';
import { useAuthStore } from '../../stores/auth-store';
import { refreshAccessTokenOnce } from '../lib/api';

/**
 * Fetches a protected API resource with the auth token and returns a blob URL.
 *
 * Browser `<img>` tags cannot send Authorization headers on their own, so
 * images served by authenticated API routes (e.g. `/api/attachments/...`)
 * would get a 401.  This hook fetches the resource via JS `fetch` with the
 * Bearer token, creates a blob object URL, and revokes it on cleanup.
 *
 * Returns `{ blobSrc, loading, error }`.
 */
export function useAuthenticatedSrc(apiUrl: string | null): {
  blobSrc: string | null;
  loading: boolean;
  error: boolean;
} {
  const [blobSrc, setBlobSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!apiUrl);
  const [error, setError] = useState(false);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    // Nothing to fetch
    if (!apiUrl) {
      setLoading(false);
      setError(true);
      return;
    }

    // Only handle internal API URLs — external URLs can be loaded directly
    if (!apiUrl.startsWith('/api/')) {
      setBlobSrc(apiUrl);
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function fetchImage() {
      setLoading(true);
      setError(false);

      const token = useAuthStore.getState().accessToken;

      const headers: HeadersInit = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      try {
        let res = await fetch(apiUrl!, { headers, credentials: 'include' });

        // On 401, attempt a silent token refresh and retry once
        if (res.status === 401) {
          const newToken = await refreshAccessTokenOnce();
          if (newToken && !cancelled) {
            headers['Authorization'] = `Bearer ${newToken}`;
            res = await fetch(apiUrl!, { headers, credentials: 'include' });
          }
        }

        if (!res.ok || cancelled) {
          if (!cancelled) {
            setError(true);
            setLoading(false);
          }
          return;
        }

        const blob = await res.blob();
        if (cancelled) return;

        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setBlobSrc(url);
        setLoading(false);
      } catch {
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
      }
    }

    fetchImage();

    return () => {
      cancelled = true;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [apiUrl]);

  return { blobSrc, loading, error };
}

/**
 * Fetch an authenticated image as a blob URL (non-hook imperative version).
 *
 * Used by ArticleViewer to rewrite `<img>` src attributes in the rendered DOM
 * without creating a React component per image.
 *
 * Returns the blob URL, or null on failure.  The caller must revoke the URL
 * when done (via URL.revokeObjectURL).
 */
export async function fetchAuthenticatedBlob(apiUrl: string): Promise<string | null> {
  const token = useAuthStore.getState().accessToken;

  const headers: HeadersInit = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    let res = await fetch(apiUrl, { headers, credentials: 'include' });

    if (res.status === 401) {
      const newToken = await refreshAccessTokenOnce();
      if (newToken) {
        headers['Authorization'] = `Bearer ${newToken}`;
        res = await fetch(apiUrl, { headers, credentials: 'include' });
      }
    }

    if (!res.ok) return null;

    const blob = await res.blob();
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

