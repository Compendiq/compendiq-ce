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

/** A promise plus its resolver, for overlapping two in-flight extractions. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
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

  /**
   * A shared composer drop target accepts a second file while the first is
   * still in flight (#1154), so `isExtracting` is a depth counter rather than a
   * boolean. With a boolean the first upload to finish would clear the flag
   * while the second was still running — re-enabling the paperclip and the dock's
   * Improve chip mid-extraction, which is the invariant #940 exists to protect.
   */
  it('stays busy until the last of two overlapping extractions settles', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const { result } = renderHook(() => useExtractDocument());

    let firstCall!: Promise<unknown>;
    let secondCall!: Promise<unknown>;
    await act(async () => { firstCall = result.current.extractDocument(file()); });
    await act(async () => { secondCall = result.current.extractDocument(file('b.pdf')); });
    expect(result.current.isExtracting).toBe(true);

    // The first finishing must NOT clear the flag — the second is still running.
    await act(async () => {
      first.resolve(jsonResponse({ format: 'pdf', text: 'first' }));
      await firstCall;
    });
    expect(result.current.isExtracting).toBe(true);

    await act(async () => {
      second.resolve(jsonResponse({ format: 'pdf', text: 'second' }));
      await secondCall;
    });
    expect(result.current.isExtracting).toBe(false);
  });

  /**
   * `error` describes the newest extraction only. Overlap made the alternative
   * incoherent: starting the second call already cleared the first's message,
   * so letting a stale failure write its own back would resurrect the error of
   * a request the user had replaced. Both callers still see their own rejection.
   */
  it('does not let a superseded extraction write its failure into error', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const { result } = renderHook(() => useExtractDocument());

    let firstCall!: Promise<unknown>;
    let secondCall!: Promise<unknown>;
    await act(async () => { firstCall = result.current.extractDocument(file()); });
    await act(async () => { secondCall = result.current.extractDocument(file('b.pdf')); });

    await act(async () => {
      second.resolve(jsonResponse({ format: 'pdf', text: 'second' }));
      await secondCall;
    });
    await act(async () => {
      first.resolve(new Response(JSON.stringify({ message: 'stale failure' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      }));
      await expect(firstCall).rejects.toThrow('stale failure');
    });

    expect(result.current.error).toBeNull();
  });

  /** A failure must release its own slot, or the surface stays disabled forever. */
  it('stops being busy when an overlapping extraction rejects', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const { result } = renderHook(() => useExtractDocument());

    let firstCall!: Promise<unknown>;
    let secondCall!: Promise<unknown>;
    await act(async () => { firstCall = result.current.extractDocument(file()); });
    await act(async () => { secondCall = result.current.extractDocument(file('b.pdf')); });

    await act(async () => {
      first.resolve(new Response('nope', { status: 500 }));
      await expect(firstCall).rejects.toThrow();
    });
    expect(result.current.isExtracting).toBe(true);

    await act(async () => {
      second.resolve(jsonResponse({ format: 'pdf', text: 'second' }));
      await secondCall;
    });
    expect(result.current.isExtracting).toBe(false);
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
