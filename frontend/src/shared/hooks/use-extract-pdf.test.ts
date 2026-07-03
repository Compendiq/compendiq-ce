import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockSetAuth = vi.fn();
const mockClearAuth = vi.fn();
let storeState: Record<string, unknown> = {};

vi.mock('../../stores/auth-store', () => ({
  useAuthStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
}));

const { useExtractPdf } = await import('./use-extract-pdf');

const USER = { id: '1', username: 'test', role: 'user' };

function file(): File {
  return new File(['%PDF-1.4'], 'doc.pdf', { type: 'application/pdf' });
}

describe('useExtractPdf', () => {
  beforeEach(() => {
    storeState = {
      accessToken: 'valid-token',
      user: USER,
      isAuthenticated: true,
      setAuth: mockSetAuth,
      clearAuth: mockClearAuth,
    };
    mockSetAuth.mockClear();
    mockClearAuth.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refreshes the token and retries once on 401', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accessToken: 'new-token', user: USER }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: 'extracted' }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const { result } = renderHook(() => useExtractPdf());

    let out: unknown;
    await act(async () => {
      out = await result.current.extractPdf(file());
    });

    expect(out).toEqual({ text: 'extracted' });
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/auth/refresh',
      expect.objectContaining({ method: 'POST' }),
    );
    const retryHeaders = fetchSpy.mock.calls[2][1]?.headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe('Bearer new-token');
  });

  it('clears auth and throws when the refresh fails on 401', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response('Invalid', { status: 401 }));

    const { result } = renderHook(() => useExtractPdf());

    await act(async () => {
      await expect(result.current.extractPdf(file())).rejects.toThrow();
    });
    expect(mockClearAuth).toHaveBeenCalled();
  });
});
