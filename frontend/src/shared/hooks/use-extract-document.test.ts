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

const { useExtractDocument } = await import('./use-extract-document');

const USER = { id: '1', username: 'test', role: 'user' };

function file(name = 'doc.pdf', type = 'application/pdf'): File {
  return new File(['%PDF-1.4'], name, { type });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('useExtractDocument', () => {
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

  it('posts the file to the canonical extract-document path', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ format: 'pdf', text: 'extracted' }));

    const { result } = renderHook(() => useExtractDocument());
    await act(async () => {
      await result.current.extractDocument(file());
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/llm/extract-document',
      expect.objectContaining({ method: 'POST', body: expect.any(FormData) }),
    );
  });

  // The format is decided server-side from the bytes, so the hook is format-
  // blind: whatever comes back is returned untouched, `totalPages` and all.
  it.each([
    ['pdf', { format: 'pdf', text: 'pdf text', totalPages: 3 }],
    ['docx', { format: 'docx', text: 'docx text' }],
    ['md', { format: 'md', text: '# heading' }],
    ['txt', { format: 'txt', text: 'plain' }],
    ['rtf', { format: 'rtf', text: 'rich' }],
    ['odt', { format: 'odt', text: 'open document' }],
  ])('returns the %s response verbatim', async (_format, payload) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(payload));

    const { result } = renderHook(() => useExtractDocument());
    let out: unknown;
    await act(async () => {
      out = await result.current.extractDocument(file());
    });

    expect(out).toEqual(payload);
  });

  it('surfaces the server message on a rejected upload', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'Unsupported file type' }), {
        status: 415,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { result } = renderHook(() => useExtractDocument());
    await act(async () => {
      await expect(result.current.extractDocument(file('x.png', 'image/png')))
        .rejects.toThrow('Unsupported file type');
    });
    expect(result.current.error).toBe('Unsupported file type');
  });

  it('refreshes the token and retries once on 401', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ accessToken: 'new-token', user: USER }))
      .mockResolvedValueOnce(jsonResponse({ format: 'pdf', text: 'extracted' }));

    const { result } = renderHook(() => useExtractDocument());

    let out: unknown;
    await act(async () => {
      out = await result.current.extractDocument(file());
    });

    expect(out).toEqual({ format: 'pdf', text: 'extracted' });
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

    const { result } = renderHook(() => useExtractDocument());

    await act(async () => {
      await expect(result.current.extractDocument(file())).rejects.toThrow();
    });
    expect(mockClearAuth).toHaveBeenCalled();
  });
});
