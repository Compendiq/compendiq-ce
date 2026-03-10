import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAuthenticatedSrc, fetchAuthenticatedBlob } from './use-authenticated-src';

// Mock the auth store
vi.mock('../../stores/auth-store', () => ({
  useAuthStore: {
    getState: vi.fn(() => ({ accessToken: 'test-jwt-token', setAuth: vi.fn(), clearAuth: vi.fn() })),
  },
}));

describe('use-authenticated-src', () => {
  const originalFetch = globalThis.fetch;
  const mockCreateObjectURL = vi.fn(() => 'blob:http://localhost/fake-blob-url');
  const mockRevokeObjectURL = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.URL.createObjectURL = mockCreateObjectURL;
    globalThis.URL.revokeObjectURL = mockRevokeObjectURL;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('useAuthenticatedSrc', () => {
    it('returns error state when src is null', async () => {
      const { result } = renderHook(() => useAuthenticatedSrc(null));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
        expect(result.current.error).toBe(true);
        expect(result.current.blobSrc).toBeNull();
      });
    });

    it('passes through external URLs without fetching', async () => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;

      const { result } = renderHook(() =>
        useAuthenticatedSrc('https://example.com/image.png'),
      );

      await waitFor(() => {
        expect(result.current.blobSrc).toBe('https://example.com/image.png');
        expect(result.current.loading).toBe(false);
        expect(result.current.error).toBe(false);
      });

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('fetches /api/ URLs with Authorization header and returns blob URL', async () => {
      const mockBlob = new Blob(['image-data'], { type: 'image/png' });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        blob: () => Promise.resolve(mockBlob),
      });

      const { result } = renderHook(() =>
        useAuthenticatedSrc('/api/attachments/page-1/diagram.png'),
      );

      await waitFor(() => {
        expect(result.current.blobSrc).toBe('blob:http://localhost/fake-blob-url');
        expect(result.current.loading).toBe(false);
        expect(result.current.error).toBe(false);
      });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/attachments/page-1/diagram.png',
        expect.objectContaining({
          headers: { Authorization: 'Bearer test-jwt-token' },
          credentials: 'include',
        }),
      );
    });

    it('sets error state on fetch failure', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });

      const { result } = renderHook(() =>
        useAuthenticatedSrc('/api/attachments/page-1/missing.png'),
      );

      await waitFor(() => {
        expect(result.current.error).toBe(true);
        expect(result.current.loading).toBe(false);
        expect(result.current.blobSrc).toBeNull();
      });
    });

    it('sets error state on network error', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network failure'));

      const { result } = renderHook(() =>
        useAuthenticatedSrc('/api/attachments/page-1/diagram.png'),
      );

      await waitFor(() => {
        expect(result.current.error).toBe(true);
        expect(result.current.loading).toBe(false);
      });
    });

    it('attempts token refresh on 401 and retries', async () => {
      const mockBlob = new Blob(['image-data'], { type: 'image/png' });
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        // Refresh endpoint
        if (typeof url === 'string' && url.includes('/auth/refresh')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              accessToken: 'refreshed-token',
              user: { id: '1', username: 'test', role: 'user' },
            }),
          });
        }
        callCount++;
        // First call returns 401, second call (after refresh) returns 200
        if (callCount === 1) {
          return Promise.resolve({ ok: false, status: 401 });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          blob: () => Promise.resolve(mockBlob),
        });
      });

      const { result } = renderHook(() =>
        useAuthenticatedSrc('/api/attachments/page-1/diagram.png'),
      );

      await waitFor(() => {
        expect(result.current.blobSrc).toBe('blob:http://localhost/fake-blob-url');
        expect(result.current.error).toBe(false);
      });
    });

    it('revokes blob URL on unmount', async () => {
      const mockBlob = new Blob(['image-data'], { type: 'image/png' });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        blob: () => Promise.resolve(mockBlob),
      });

      const { result, unmount } = renderHook(() =>
        useAuthenticatedSrc('/api/attachments/page-1/diagram.png'),
      );

      await waitFor(() => {
        expect(result.current.blobSrc).toBe('blob:http://localhost/fake-blob-url');
      });

      unmount();

      expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/fake-blob-url');
    });
  });

  describe('fetchAuthenticatedBlob', () => {
    it('fetches with auth header and returns blob URL', async () => {
      const mockBlob = new Blob(['image-data'], { type: 'image/png' });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        blob: () => Promise.resolve(mockBlob),
      });

      const result = await fetchAuthenticatedBlob('/api/attachments/page-1/img.png');

      expect(result).toBe('blob:http://localhost/fake-blob-url');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/attachments/page-1/img.png',
        expect.objectContaining({
          headers: { Authorization: 'Bearer test-jwt-token' },
        }),
      );
    });

    it('returns null on fetch failure', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      const result = await fetchAuthenticatedBlob('/api/attachments/page-1/img.png');

      expect(result).toBeNull();
    });

    it('returns null on network error', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const result = await fetchAuthenticatedBlob('/api/attachments/page-1/img.png');

      expect(result).toBeNull();
    });

    it('attempts token refresh on 401', async () => {
      const mockBlob = new Blob(['image-data'], { type: 'image/png' });
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (typeof url === 'string' && url.includes('/auth/refresh')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              accessToken: 'refreshed-token',
              user: { id: '1', username: 'test', role: 'user' },
            }),
          });
        }
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ ok: false, status: 401 });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          blob: () => Promise.resolve(mockBlob),
        });
      });

      const result = await fetchAuthenticatedBlob('/api/attachments/page-1/img.png');

      expect(result).toBe('blob:http://localhost/fake-blob-url');
    });
  });
});
