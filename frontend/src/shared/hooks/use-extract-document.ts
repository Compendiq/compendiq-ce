import { useState, useCallback, useRef } from 'react';
import { useAuthStore } from '../../stores/auth-store';
import { refreshAccessTokenOnce } from '../lib/api';
import type { ExtractDocumentResponse } from '@compendiq/contracts';

export type ExtractDocumentResult = ExtractDocumentResponse;

/**
 * Upload a document and get its text back (#1131).
 *
 * One call for all six supported formats — the server sniffs the format from
 * the bytes, so there is nothing here to branch on. Raw `fetch` with FormData
 * rather than `apiFetch`, which forces `Content-Type: application/json` and
 * would strip the multipart boundary.
 *
 * Hold **one instance per upload surface** and pass both `extractDocument` and
 * `isExtracting` down: two instances give you two `isExtracting` flags, and the
 * one the spinner reads is not the one the upload flips (#940).
 *
 * `isExtracting` is derived from a **depth counter**, not a boolean, because two
 * extractions can overlap — a shared composer drop target accepts a second file
 * while the first is still in flight (#1154). With a boolean, the first upload
 * to finish would clear the flag while the second was still running, re-enabling
 * the trigger and the Improve chip mid-extraction and letting the user send with
 * the wrong document attached. That is the invariant #940 exists to protect, so
 * the flag stays true until the *last* in-flight extraction settles. The public
 * shape is unchanged: consumers still read a plain boolean.
 */
export function useExtractDocument() {
  const [pendingCount, setPendingCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // `error` describes the most recently *started* extraction, and only that
  // one. Overlapping calls made the alternative incoherent: the start of a
  // second extraction already cleared the first's message, so a failure that
  // resolved afterwards would write its message back over a request the user
  // had since replaced. Callers still see every failure — each rejects its own
  // promise, and that is what the surfaces actually toast.
  const requestIdRef = useRef(0);

  const extractDocument = useCallback(async (file: File): Promise<ExtractDocumentResult> => {
    const requestId = ++requestIdRef.current;
    setPendingCount((count) => count + 1);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const doFetch = (token: string | null) => {
        const headers: HeadersInit = {};
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
        return fetch('/api/llm/extract-document', {
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
        throw new Error(body.message ?? `Document extraction failed: ${res.status}`);
      }

      return await res.json() as ExtractDocumentResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Document extraction failed';
      if (requestId === requestIdRef.current) setError(message);
      throw err;
    } finally {
      setPendingCount((count) => Math.max(0, count - 1));
    }
  }, []);

  return { extractDocument, isExtracting: pendingCount > 0, error };
}
