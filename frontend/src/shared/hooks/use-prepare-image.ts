import { useState, useCallback, useRef } from 'react';
import type { PrepareImageResponse } from '@compendiq/contracts';
import { useAuthStore } from '../../stores/auth-store';
import { refreshAccessTokenOnce } from '../lib/api';
import { downscaleImage } from '../lib/downscale-image';

export type PreparedImage = PrepareImageResponse & {
  /** Object URL for the thumbnail. The holder MUST revoke it — see `useAttachments`. */
  previewUrl: string;
};

/**
 * Downscale an image and stage it for a Generate/Improve call (#1154).
 *
 * Deliberately shaped like `use-extract-document.ts`, down to the raw `fetch`:
 * `apiFetch` forces `Content-Type: application/json`, which strips the multipart
 * boundary. Same one-instance-per-surface rule, and `isPreparing` must be passed
 * down to whatever renders the spinner — two instances give two flags and the one
 * the spinner reads is not the one the upload flips (#940).
 *
 * `isPreparing` is derived from a **depth counter** for the same reason
 * `isExtracting` is: `useAttachments` gates its drop and paste handlers on
 * `disabled` alone, so a second image can be dropped while the first is still
 * staging. With a boolean the first `finally` would clear the flag while the
 * second was mid-flight, re-enabling the trigger and unblocking Send — and the
 * request would go without the handle that was still being minted. The flag
 * stays true until the *last* in-flight preparation settles; the public shape is
 * unchanged, consumers still read a plain boolean.
 */
export function usePrepareImage() {
  const [pendingCount, setPendingCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // `error` describes the most recently *started* preparation, and only that one
  // — overlapping calls otherwise let a slow earlier failure write its message
  // back over a pick the user has since replaced. Callers still see every
  // failure: each rejects its own promise, and that is what the surfaces toast.
  //
  // Nothing reads `error` today — `useAttachments` toasts off the rejection —
  // and `use-extract-document` exposes an identically unconsumed one. It is kept
  // for that parity and because a surface wanting an inline message needs no new
  // hook API to get one, but it is guarded rather than left to go stale.
  const requestIdRef = useRef(0);

  const prepareImage = useCallback(async (file: File): Promise<PreparedImage> => {
    const requestId = ++requestIdRef.current;
    setPendingCount((count) => count + 1);
    setError(null);
    try {
      // Always normalise first: the server then only ever sees WebP within the
      // edge cap, which makes its format/dimension/size rejections unreachable.
      const { blob } = await downscaleImage(file);
      const formData = new FormData();
      // Filename must agree with the re-encode — the server refuses bytes whose
      // sniffed format contradicts the claimed extension.
      formData.append('file', blob, 'attachment.webp');

      const doFetch = (token: string | null) => {
        const headers: HeadersInit = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;
        return fetch('/api/llm/prepare-image', {
          method: 'POST',
          headers,
          credentials: 'include',
          body: formData,
        });
      };

      const { accessToken } = useAuthStore.getState();
      let res = await doFetch(accessToken);
      if (res.status === 401) {
        const newToken = await refreshAccessTokenOnce();
        if (newToken) res = await doFetch(newToken);
        else useAuthStore.getState().clearAuth();
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(body.message ?? `Image staging failed: ${res.status}`);
      }

      const staged = await res.json() as PrepareImageResponse;
      return { ...staged, previewUrl: URL.createObjectURL(blob) };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Image staging failed';
      if (requestId === requestIdRef.current) setError(message);
      throw err;
    } finally {
      setPendingCount((count) => Math.max(0, count - 1));
    }
  }, []);

  return { prepareImage, isPreparing: pendingCount > 0, error };
}
