import { useState, useCallback } from 'react';
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
 */
export function usePrepareImage() {
  const [isPreparing, setIsPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prepareImage = useCallback(async (file: File): Promise<PreparedImage> => {
    setIsPreparing(true);
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
      setError(message);
      throw err;
    } finally {
      setIsPreparing(false);
    }
  }, []);

  return { prepareImage, isPreparing, error };
}
