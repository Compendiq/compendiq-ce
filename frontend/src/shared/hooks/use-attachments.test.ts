import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { PreparedImage } from './use-prepare-image';

const mockToastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (m: string) => mockToastError(m) } }));

const mockExtract = vi.fn(async () => ({ text: 'doc text', format: 'pdf', pageCount: 3, truncated: false }));
vi.mock('./use-extract-document', () => ({
  useExtractDocument: () => ({ extractDocument: mockExtract, isExtracting: false, error: null }),
}));

const mockPrepare = vi.fn(async () => ({
  handle: 'a'.repeat(64), format: 'webp', width: 800, height: 600,
  fileSize: 1234, previewUrl: 'blob:preview',
}));
vi.mock('./use-prepare-image', () => ({
  usePrepareImage: () => ({ prepareImage: mockPrepare, isPreparing: false, error: null }),
}));

import { useAttachments } from './use-attachments';

function file(name: string, type: string): File {
  return new File(['x'], name, { type });
}

/** A promise plus its resolver, for controlling `prepareImage` resolution order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

beforeEach(() => {
  mockToastError.mockReset();
  mockExtract.mockClear();
  mockPrepare.mockClear();
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() });
});

describe('useAttachments routing', () => {
  it('routes an image to the prepare path', async () => {
    const { result } = renderHook(() => useAttachments({ imageEnabled: true }));
    await act(async () => { await result.current.pickFile(file('shot.png', 'image/png')); });
    expect(mockPrepare).toHaveBeenCalledTimes(1);
    expect(mockExtract).not.toHaveBeenCalled();
    expect(result.current.image).toMatchObject({ handle: 'a'.repeat(64) });
  });

  it('routes a document to the extract path', async () => {
    const { result } = renderHook(() => useAttachments({ imageEnabled: true }));
    await act(async () => { await result.current.pickFile(file('spec.pdf', 'application/pdf')); });
    expect(mockExtract).toHaveBeenCalledTimes(1);
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(result.current.document).toMatchObject({ filename: 'spec.pdf' });
  });

  /** Two independent slots: attaching one must not clear the other. */
  it('holds a document and an image at the same time', async () => {
    const { result } = renderHook(() => useAttachments({ imageEnabled: true }));
    await act(async () => { await result.current.pickFile(file('spec.pdf', 'application/pdf')); });
    await act(async () => { await result.current.pickFile(file('shot.png', 'image/png')); });
    expect(result.current.document).not.toBeNull();
    expect(result.current.image).not.toBeNull();
  });

  it('refuses SVG with its own message', async () => {
    const { result } = renderHook(() => useAttachments({ imageEnabled: true }));
    await act(async () => { await result.current.pickFile(file('d.svg', 'image/svg+xml')); });
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith(expect.stringMatching(/SVG/));
  });

  it('rejects an unknown type with one message naming both accepted sets', async () => {
    const { result } = renderHook(() => useAttachments({ imageEnabled: true }));
    await act(async () => { await result.current.pickFile(file('a.zip', 'application/zip')); });
    expect(mockToastError).toHaveBeenCalledTimes(1);
    const msg = mockToastError.mock.calls[0]![0] as string;
    expect(msg).toMatch(/PDF/);
    expect(msg).toMatch(/PNG/i);
  });

  it('refuses an image with the caller-supplied reason when vision is unavailable', async () => {
    const { result } = renderHook(() => useAttachments({
      imageEnabled: false, imageDisabledReason: "llama3.1 can't read images",
    }));
    await act(async () => { await result.current.pickFile(file('shot.png', 'image/png')); });
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith("llama3.1 can't read images");
  });

  it('still accepts a document when images are unavailable', async () => {
    const { result } = renderHook(() => useAttachments({ imageEnabled: false }));
    await act(async () => { await result.current.pickFile(file('spec.pdf', 'application/pdf')); });
    expect(result.current.document).not.toBeNull();
  });

  /** HEIC's browser-reported MIME is unreliable (often `''`), so the extension
   *  fallback in `looksLikeImage` is what keeps it off the document branch and
   *  its generic "Unsupported file" message. */
  it('routes a .heic file with an empty MIME type to the image path', async () => {
    const { result } = renderHook(() => useAttachments({ imageEnabled: true }));
    await act(async () => { await result.current.pickFile(file('photo.heic', '')); });
    expect(mockPrepare).toHaveBeenCalledTimes(1);
    expect(mockExtract).not.toHaveBeenCalled();
  });

  /** The disabled-reason toast must win over the SVG-specific one: vision being
   *  off is why the image doesn't attach, not its format. */
  it('shows the disabled-reason toast for an SVG when images are unavailable, not the SVG message', async () => {
    const { result } = renderHook(() => useAttachments({
      imageEnabled: false, imageDisabledReason: "llama3.1 can't read images",
    }));
    await act(async () => { await result.current.pickFile(file('d.svg', 'image/svg+xml')); });
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith("llama3.1 can't read images");
    expect(mockToastError).not.toHaveBeenCalledWith(expect.stringMatching(/SVG/));
  });
});

describe('useAttachments object URL lifecycle', () => {
  it('revokes the preview URL when the image is removed', async () => {
    const revoke = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: revoke });
    const { result } = renderHook(() => useAttachments({ imageEnabled: true }));
    await act(async () => { await result.current.pickFile(file('shot.png', 'image/png')); });
    act(() => { result.current.removeImage(); });
    expect(revoke).toHaveBeenCalledWith('blob:preview');
    expect(result.current.image).toBeNull();
  });

  it('revokes the preview URL on unmount', async () => {
    const revoke = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: revoke });
    const { result, unmount } = renderHook(() => useAttachments({ imageEnabled: true }));
    await act(async () => { await result.current.pickFile(file('shot.png', 'image/png')); });
    unmount();
    expect(revoke).toHaveBeenCalledWith('blob:preview');
  });

  /** The leak that ships silently: the unmount test above can't catch a
   *  regression here, because it only ever attaches one image. */
  it('revokes the first image preview when a second image replaces it', async () => {
    const revoke = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: revoke });
    mockPrepare
      .mockResolvedValueOnce({
        handle: 'a'.repeat(64), format: 'webp', width: 800, height: 600, fileSize: 1234, previewUrl: 'blob:first',
      })
      .mockResolvedValueOnce({
        handle: 'b'.repeat(64), format: 'webp', width: 800, height: 600, fileSize: 1234, previewUrl: 'blob:second',
      });

    const { result } = renderHook(() => useAttachments({ imageEnabled: true }));
    await act(async () => { await result.current.pickFile(file('one.png', 'image/png')); });
    await act(async () => { await result.current.pickFile(file('two.png', 'image/png')); });

    expect(revoke).toHaveBeenCalledWith('blob:first');
    expect(result.current.image).toMatchObject({ previewUrl: 'blob:second' });
  });

  /** Two fast picks: a late-resolving earlier call must not clobber a newer
   *  image, and its own (now-orphaned) previewUrl must not leak. */
  it('keeps the newer image and revokes a stale image that resolves after it', async () => {
    const revoke = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: revoke });
    const first = deferred<PreparedImage>();
    const second = deferred<PreparedImage>();
    mockPrepare.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);

    const { result } = renderHook(() => useAttachments({ imageEnabled: true }));

    let firstPick!: Promise<void>;
    let secondPick!: Promise<void>;
    act(() => { firstPick = result.current.pickFile(file('one.png', 'image/png')); });
    act(() => { secondPick = result.current.pickFile(file('two.png', 'image/png')); });

    await act(async () => {
      second.resolve({
        handle: 'b'.repeat(64), format: 'webp', width: 1, height: 1, fileSize: 1, previewUrl: 'blob:second',
      });
      await secondPick;
    });
    expect(result.current.image).toMatchObject({ previewUrl: 'blob:second' });

    await act(async () => {
      first.resolve({
        handle: 'a'.repeat(64), format: 'webp', width: 1, height: 1, fileSize: 1, previewUrl: 'blob:first',
      });
      await firstPick;
    });
    expect(result.current.image).toMatchObject({ previewUrl: 'blob:second' });
    expect(revoke).toHaveBeenCalledWith('blob:first');
  });

  it('revokes the previewUrl of a prepareImage call that resolves after unmount', async () => {
    const revoke = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: revoke });
    const pending = deferred<PreparedImage>();
    mockPrepare.mockImplementationOnce(() => pending.promise);

    const { result, unmount } = renderHook(() => useAttachments({ imageEnabled: true }));

    let pick!: Promise<void>;
    act(() => { pick = result.current.pickFile(file('shot.png', 'image/png')); });

    unmount();

    await act(async () => {
      pending.resolve({
        handle: 'a'.repeat(64), format: 'webp', width: 1, height: 1, fileSize: 1, previewUrl: 'blob:inflight',
      });
      await pick;
    });

    expect(revoke).toHaveBeenCalledWith('blob:inflight');
  });
});

describe('useAttachments paste', () => {
  it('intercepts a pasted image on the drop target', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const ref = { current: target };
    renderHook(() => useAttachments({ dropTargetRef: ref, imageEnabled: true }));

    const png = file('pasted.png', 'image/png');
    const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
      clipboardData: unknown;
    };
    Object.defineProperty(event, 'clipboardData', {
      value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => png }] },
    });
    await act(async () => { target.dispatchEvent(event); });

    expect(mockPrepare).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    target.remove();
  });

  /** Pasting text must reach the textarea untouched. */
  it('ignores a paste with no image item', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    renderHook(() => useAttachments({ dropTargetRef: { current: target }, imageEnabled: true }));

    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] },
    });
    await act(async () => { target.dispatchEvent(event); });

    expect(mockPrepare).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    target.remove();
  });
});

describe('useAttachments drop', () => {
  function dropEvent(dataTransfer: { files: File[] }): Event & { dataTransfer: unknown } {
    const event = new Event('drop', { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    return event;
  }

  it('routes a dropped PNG to the image path and a dropped PDF to the document path', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    renderHook(() => useAttachments({ dropTargetRef: { current: target }, imageEnabled: true }));

    await act(async () => { target.dispatchEvent(dropEvent({ files: [file('shot.png', 'image/png')] })); });
    expect(mockPrepare).toHaveBeenCalledTimes(1);
    expect(mockExtract).not.toHaveBeenCalled();

    await act(async () => { target.dispatchEvent(dropEvent({ files: [file('spec.pdf', 'application/pdf')] })); });
    expect(mockExtract).toHaveBeenCalledTimes(1);

    target.remove();
  });

  /** A drop that reaches the browser's default handler navigates the tab away
   *  from whatever the user had typed — this must never be reachable, file or
   *  not. */
  it('always prevents the default action, even when no file is dropped', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    renderHook(() => useAttachments({ dropTargetRef: { current: target }, imageEnabled: true }));

    const event = dropEvent({ files: [] });
    act(() => { target.dispatchEvent(event); });

    expect(event.defaultPrevented).toBe(true);
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockExtract).not.toHaveBeenCalled();
    target.remove();
  });

  it('swallows a drop while disabled — prevented, but nothing attached', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    renderHook(() => useAttachments({
      dropTargetRef: { current: target }, imageEnabled: true, disabled: true,
    }));

    const event = dropEvent({ files: [file('shot.png', 'image/png')] });
    act(() => { target.dispatchEvent(event); });

    expect(event.defaultPrevented).toBe(true);
    expect(mockPrepare).not.toHaveBeenCalled();
    target.remove();
  });
});

describe('useAttachments drag-over state', () => {
  /** Counted, not toggled: a composer full of children fires `dragleave` every
   *  time the pointer crosses into one of them, even mid-drag. */
  it('counts drag depth so a nested dragleave does not clear the hint early', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const { result } = renderHook(() => useAttachments({
      dropTargetRef: { current: target }, imageEnabled: true,
    }));

    act(() => { target.dispatchEvent(new Event('dragenter', { bubbles: true })); });
    act(() => { target.dispatchEvent(new Event('dragenter', { bubbles: true })); });
    expect(result.current.isDragOver).toBe(true);

    act(() => { target.dispatchEvent(new Event('dragleave', { bubbles: true })); });
    expect(result.current.isDragOver).toBe(true);

    act(() => { target.dispatchEvent(new Event('dragleave', { bubbles: true })); });
    expect(result.current.isDragOver).toBe(false);

    target.remove();
  });
});
