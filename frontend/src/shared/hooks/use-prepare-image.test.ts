import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../lib/downscale-image', () => ({
  downscaleImage: vi.fn(async () => ({
    blob: new Blob(['webp-bytes'], { type: 'image/webp' }),
    width: 800,
    height: 600,
  })),
}));

const mockRefresh = vi.fn();
vi.mock('../lib/api', () => ({ refreshAccessTokenOnce: () => mockRefresh() }));

vi.mock('../../stores/auth-store', () => ({
  useAuthStore: { getState: () => ({ accessToken: 'tok', clearAuth: vi.fn() }) },
}));

import { usePrepareImage } from './use-prepare-image';

const HANDLE = 'a'.repeat(64);
const OK = {
  handle: HANDLE, format: 'webp', width: 800, height: 600, fileSize: 1234,
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(OK), { status: 200 })));
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() });
  mockRefresh.mockReset();
});

describe('usePrepareImage', () => {
  it('posts multipart to /api/llm/prepare-image with a bearer token', async () => {
    const { result } = renderHook(() => usePrepareImage());
    await act(async () => { await result.current.prepareImage(new File(['x'], 'a.png', { type: 'image/png' })); });

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('/api/llm/prepare-image');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).body).toBeInstanceOf(FormData);
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
  });

  /** apiFetch would force a JSON Content-Type and strip the multipart boundary. */
  it('does not set Content-Type by hand', async () => {
    const { result } = renderHook(() => usePrepareImage());
    await act(async () => { await result.current.prepareImage(new File(['x'], 'a.png', { type: 'image/png' })); });
    const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    expect(Object.keys(init.headers as object)).not.toContain('Content-Type');
  });

  it('returns the staged handle plus a preview URL', async () => {
    const { result } = renderHook(() => usePrepareImage());
    let prepared!: Awaited<ReturnType<typeof result.current.prepareImage>>;
    await act(async () => { prepared = await result.current.prepareImage(new File(['x'], 'a.png', { type: 'image/png' })); });
    expect(prepared).toMatchObject({ handle: HANDLE, format: 'webp', previewUrl: 'blob:preview' });
  });

  it('retries once with a refreshed token on 401', async () => {
    mockRefresh.mockResolvedValue('tok2');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(OK), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => usePrepareImage());
    await act(async () => { await result.current.prepareImage(new File(['x'], 'a.png', { type: 'image/png' })); });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1]![1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok2' });
  });

  it('surfaces the server message on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ message: 'Image staging is unavailable because Redis is not reachable' }),
      { status: 503 },
    )));
    const { result } = renderHook(() => usePrepareImage());
    await expect(result.current.prepareImage(new File(['x'], 'a.png', { type: 'image/png' })))
      .rejects.toThrow(/Redis is not reachable/);
  });
});
