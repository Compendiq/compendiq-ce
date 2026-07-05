import { useState, useCallback } from 'react';
import { useAuthStore } from '../../stores/auth-store';
import { refreshAccessTokenOnce } from '../lib/api';
import type { ExtractPdfResponse } from '@compendiq/contracts';

export type ExtractPdfResult = ExtractPdfResponse;

/**
 * Hook for extracting text from a PDF file via the backend.
 * Uses raw fetch with FormData (bypasses apiFetch which sets Content-Type: application/json).
 */
export function useExtractPdf() {
  const [isExtracting, setIsExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const extractPdf = useCallback(async (file: File): Promise<ExtractPdfResult> => {
    setIsExtracting(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const doFetch = (token: string | null) => {
        const headers: HeadersInit = {};
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
        return fetch('/api/llm/extract-pdf', {
          method: 'POST',
          headers,
          credentials: 'include',
          body: formData,
        });
      };

      const { accessToken } = useAuthStore.getState();
      let res = await doFetch(accessToken);

      // Reactive token refresh on 401 — mirrors apiFetch. Re-issue the POST once
      // with a refreshed token before surfacing the failure.
      if (res.status === 401) {
        const newToken = await refreshAccessTokenOnce();
        if (newToken) {
          res = await doFetch(newToken);
        } else {
          useAuthStore.getState().clearAuth();
        }
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(body.message ?? `PDF extraction failed: ${res.status}`);
      }

      return await res.json() as ExtractPdfResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'PDF extraction failed';
      setError(message);
      throw err;
    } finally {
      setIsExtracting(false);
    }
  }, []);

  return { extractPdf, isExtracting, error };
}
