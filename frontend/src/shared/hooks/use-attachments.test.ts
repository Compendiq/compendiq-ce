import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { SUPPORTED_DOCUMENT_FORMATS } from '@compendiq/contracts';
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

import { useAttachments, MAX_DOCUMENT_BYTES } from './use-attachments';

function file(name: string, type: string): File {
  return new File(['x'], name, { type });
}

/** A file that reports a size without allocating one. */
function sizedFile(name: string, type: string, size: number): File {
  const f = file(name, type);
  Object.defineProperty(f, 'size', { value: size });
  return f;
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

/**
 * The document gates, which lived in `DocumentUploadZone` until #1154 made it
 * presentational. They moved here rather than being dropped: this hook is the
 * only place that knows a file is a document rather than an image, so it is the
 * only place that can decide whether the document rules apply at all.
 */
describe('useAttachments document gates', () => {
  /**
   * Every supported extension, with an *empty* MIME type — which is what Chrome
   * reports for `.md` (and often `.rtf`) on some platforms. Acceptance is by
   * extension precisely so those files are not rejected for a MIME the browser
   * declined to guess.
   */
  it.each(SUPPORTED_DOCUMENT_FORMATS)('accepts a .%s by extension alone', async (format) => {
    const { result } = renderHook(() => useAttachments({ imageEnabled: true }));
    await act(async () => { await result.current.pickFile(file(`notes.${format}`, '')); });

    expect(mockExtract).toHaveBeenCalledTimes(1);
    expect(mockToastError).not.toHaveBeenCalled();
    expect(result.current.document).toMatchObject({ filename: `notes.${format}` });
  });

  /** The two long-form aliases the picker also offers. */
  it.each(['markdown', 'text'])('accepts the .%s alias', async (ext) => {
    const { result } = renderHook(() => useAttachments({ imageEnabled: true }));
    await act(async () => { await result.current.pickFile(file(`notes.${ext}`, '')); });

    expect(mockExtract).toHaveBeenCalledTimes(1);
  });

  it('names every supported document format when it refuses a file', async () => {
    const { result } = renderHook(() => useAttachments({ imageEnabled: true }));
    await act(async () => { await result.current.pickFile(file('archive.zip', 'application/zip')); });

    const message = mockToastError.mock.calls[0]![0] as string;
    for (const format of SUPPORTED_DOCUMENT_FORMATS) {
      expect(message).toContain(format.toUpperCase());
    }
    expect(mockExtract).not.toHaveBeenCalled();
  });

  /** Mirrors the server's multipart cap, so a doomed POST is never sent. */
  it('refuses a document over 20 MB without contacting the server', async () => {
    const { result } = renderHook(() => useAttachments({ imageEnabled: true }));
    await act(async () => {
      await result.current.pickFile(sizedFile('huge.pdf', 'application/pdf', MAX_DOCUMENT_BYTES + 1));
    });

    expect(mockToastError).toHaveBeenCalledWith('File exceeds 20 MB limit');
    expect(mockExtract).not.toHaveBeenCalled();
    expect(result.current.document).toBeNull();
  });

  it('accepts a document exactly on the 20 MB limit', async () => {
    const { result } = renderHook(() => useAttachments({ imageEnabled: true }));
    await act(async () => {
      await result.current.pickFile(sizedFile('big.pdf', 'application/pdf', MAX_DOCUMENT_BYTES));
    });

    expect(mockExtract).toHaveBeenCalledTimes(1);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  /**
   * The document twin of the image path's stale-result guard. The shared drop
   * target accepts a second file while the first is still extracting, so a slow
   * earlier request must lose rather than clobber the newer document.
   */
  it('keeps the newer document and discards an earlier extraction that resolves after it', async () => {
    const first = deferred<{ text: string; format: string }>();
    const second = deferred<{ text: string; format: string }>();
    mockExtract
      .mockImplementationOnce(() => first.promise as ReturnType<typeof mockExtract>)
      .mockImplementationOnce(() => second.promise as ReturnType<typeof mockExtract>);

    const { result } = renderHook(() => useAttachments({ imageEnabled: true }));

    let firstPick!: Promise<void>;
    let secondPick!: Promise<void>;
    act(() => { firstPick = result.current.pickFile(file('one.pdf', 'application/pdf')); });
    act(() => { secondPick = result.current.pickFile(file('two.pdf', 'application/pdf')); });

    await act(async () => {
      second.resolve({ text: 'second doc', format: 'pdf' });
      await secondPick;
    });
    expect(result.current.document).toMatchObject({ filename: 'two.pdf' });

    await act(async () => {
      first.resolve({ text: 'first doc', format: 'pdf' });
      await firstPick;
    });
    expect(result.current.document).toMatchObject({ filename: 'two.pdf' });
    expect(result.current.document?.result.text).toBe('second doc');
  });

  /*
   * There is deliberately NO "does not set state after unmount" test for the
   * document path, and it should not be added.
   *
   * The image path's equivalent test is meaningful because an orphaned
   * `prepareImage` result leaks an object URL, so the guard has an observable
   * consequence (`revokeObjectURL`) to assert on. A discarded extraction is just
   * text: `setDocument` after unmount is a silent no-op in React 18/19, and
   * `renderHook`'s `result.current` is frozen at the last render either way. A
   * test asserting `document === null` after unmount therefore passes whether or
   * not the `mountedRef` guard exists — verified by removing the guard and
   * watching it still pass. The guard stays (it is correct, symmetric with the
   * image path, and becomes load-bearing the moment this slot gains a side
   * effect), but a test that cannot fail is worse than no test: it reads as
   * coverage.
   */

  it('surfaces the extraction error and attaches nothing', async () => {
    mockExtract.mockRejectedValueOnce(new Error('PDF contains no extractable text'));

    const { result } = renderHook(() => useAttachments({ imageEnabled: true }));
    await act(async () => { await result.current.pickFile(file('report.pdf', 'application/pdf')); });

    expect(mockToastError).toHaveBeenCalledWith('PDF contains no extractable text');
    expect(result.current.document).toBeNull();
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
