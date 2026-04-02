import { useState, useCallback } from 'react';
import { useAuthStore } from '../../stores/auth-store';
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

      const { accessToken } = useAuthStore.getState();
      const headers: HeadersInit = {};
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
      }

      const res = await fetch('/api/llm/extract-pdf', {
        method: 'POST',
        headers,
        credentials: 'include',
        body: formData,
      });

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
