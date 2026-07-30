import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

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
