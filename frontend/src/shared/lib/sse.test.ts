import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSetAuth = vi.fn();
const mockClearAuth = vi.fn();
let storeState: Record<string, unknown> = {};

vi.mock('../../stores/auth-store', () => ({
  useAuthStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
}));

const { streamSSE } = await import('./sse');
const { ApiError } = await import('./api');

const USER = { id: '1', username: 'test', role: 'user' };

function sseResponse(lines: string): Response {
  return new Response(lines, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

describe('streamSSE', () => {
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

  it('yields parsed events on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      sseResponse('data: {"content":"hi","done":true}\n'),
    );

    const result = await collect(streamSSE('/ai/ask', { q: 'x' }));
    expect(result).toEqual([{ content: 'hi', done: true }]);
  });

  it('refreshes the access token and retries once on 401', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      // Initial POST: token expired
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      // Refresh: success
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accessToken: 'new-token', user: USER }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      // Retry POST: streams
      .mockResolvedValueOnce(sseResponse('data: {"content":"ok","done":true}\n'));

    const result = await collect(streamSSE('/ai/ask', { q: 'x' }));

    expect(result).toEqual([{ content: 'ok', done: true }]);
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/auth/refresh',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(mockSetAuth).toHaveBeenCalledWith('new-token', USER);
    // The retried POST must carry the refreshed token.
    const retryHeaders = fetchSpy.mock.calls[2][1]?.headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe('Bearer new-token');
  });

  it('clears auth and throws ApiError(401) when the refresh fails', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      // Refresh: fails
      .mockResolvedValueOnce(new Response('Invalid', { status: 401 }));

    await expect(collect(streamSSE('/ai/ask', {}))).rejects.toMatchObject({
      name: 'ApiError',
      statusCode: 401,
    });
    expect(mockClearAuth).toHaveBeenCalled();
  });

  it('does not refresh on 403 and throws ApiError(403)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(collect(streamSSE('/ai/ask', {}))).rejects.toBeInstanceOf(ApiError);
    // Only the single POST — no refresh attempt.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockClearAuth).not.toHaveBeenCalled();
  });
});
