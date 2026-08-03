/**
 * `useAttachments` over the *real* `usePrepareImage` (#1154).
 *
 * Every other test in this directory mocks one hook to exercise the other, so
 * nothing covered how the two guards interact: `isPreparing` is a depth counter
 * owned by `usePrepareImage`, while cancelling is a request-id bump owned by
 * `useAttachments`. The question that needs an answer rather than an argument is
 * whether cancelling mid-flight can strand the counter — leaving the trigger
 * disabled and Send blocked with nothing left to release them.
 *
 * It cannot: the two live in different modules over disjoint state, and
 * `prepareImage`'s `finally` is unconditional. This pins that.
 *
 * Only the canvas decode and the network are mocked — jsdom implements no 2D
 * context, which is the one thing that cannot run here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Only the canvas decode is mocked; usePrepareImage and useAttachments are real.
vi.mock('../lib/downscale-image', async (orig) => ({
  ...(await orig() as object),
  downscaleImage: vi.fn(async () => ({
    blob: new Blob(['webp'], { type: 'image/webp' }), width: 8, height: 8,
  })),
}));
vi.mock('../lib/api', () => ({ refreshAccessTokenOnce: vi.fn() }));
vi.mock('../../stores/auth-store', () => ({
  useAuthStore: { getState: () => ({ accessToken: 'tok', clearAuth: vi.fn() }) },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import { useAttachments } from './use-attachments';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('useAttachments over the real staging hook', () => {
  it('clearAll mid-flight does not strand isPreparing/isBusy true', async () => {
    const staged = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => staged.promise));

    const { result } = renderHook(() => useAttachments({ imageEnabled: true }));
    let pick!: Promise<void>;
    await act(async () => {
      pick = result.current.pickFile(new File(['x'], 'a.png', { type: 'image/png' }));
    });
    expect(result.current.isPreparing, 'in flight').toBe(true);
    expect(result.current.isBusy).toBe(true);

    act(() => { result.current.clearAll(); });
    expect(result.current.isPreparing, 'still in flight after clearAll').toBe(true);

    await act(async () => {
      staged.resolve(new Response(JSON.stringify({
        handle: 'a'.repeat(64), format: 'webp', width: 8, height: 8, fileSize: 12,
      }), { status: 200 }));
      await pick;
    });

    expect(result.current.isPreparing, 'flag released by the finally').toBe(false);
    expect(result.current.isBusy).toBe(false);
    expect(result.current.image, 'cancelled result discarded').toBeNull();
  });
});
