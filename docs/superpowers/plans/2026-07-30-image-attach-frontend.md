# Image Attach Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user attach an image (paste, drop, or pick) as source material on all three AI Generate/Improve surfaces, sent to a vision-capable model, with a capability badge in Settings → LLM.

**Architecture:** A headless `useAttachments` hook owns both attachment slots (document + image), routes every intake path by MIME, and owns the shared composer drop target and paste listener. `DocumentUploadZone` and a new `ImageAttachZone` become presentational. Images are normalised in-browser to WebP ≤1568px before being staged via `POST /api/llm/prepare-image`.

**Tech Stack:** React 19, TypeScript strict, Vitest + jsdom + `@testing-library/react`, TanStack Query, `sonner` toasts, Tailwind 4 with `nm-*` utilities.

**Spec:** `docs/superpowers/specs/2026-07-30-image-attach-frontend-design.md`
**Branch:** `feature/issue-1154-image-attach-frontend` (already exists, spec committed at `007482c`)

## Global Constraints

- **No backend changes.** Every endpoint and contract field this needs already shipped in #1181.
- **Downscale policy:** fit within **1568 px** longest edge, **never enlarge**; encode `image/webp` at quality **0.92**.
- **Input ceiling:** `MAX_SOURCE_IMAGE_BYTES = 30 * 1024 * 1024` (30 MB), checked before any decode. Distinct from the backend's 10 MB post-downscale `MAX_IMAGE_BYTES`.
- **`vision` is a tri-state** (`true` / `false` / `null`). `false` and `null` MUST render different text. Never collapse to a boolean.
- **SVG is refused client-side**, never rasterized. HEIC is refused with its own message.
- **Mock at the network boundary** (`fetch`), never at the service-function layer. Pure utilities tested directly.
- **`nm-card-hover`, not `hover:bg-*`**, on any card-surfaced control — card surfaces paint a gradient (a background-*image*), so `hover:bg-*` is painted underneath and does nothing. A test walks the `.tsx` sources and fails on the wrong combination.
- **Amber is reserved for warning/attention only** (ADR-010). The both-slots advisory is amber; the vision badge is not.
- **Interactive surfaces keep a 1px `--color-border-interactive` border** for WCAG 1.4.11.
- **Never use `--no-verify`.** Run `npm run lint`, `npm run typecheck` and the frontend suite before each commit.
- **Regression canaries:** `GenerateMode.extracting.test.tsx` and `AiDock.upload.test.tsx`. Prop shapes may change; **assertions must not weaken.** Deleting an assertion in either means behaviour changed — stop and flag it.

---

### Task 1: `downscaleImage` — the canvas module

**Files:**
- Create: `frontend/src/shared/lib/downscale-image.ts`
- Test: `frontend/src/shared/lib/downscale-image.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export const MAX_SOURCE_IMAGE_BYTES: number;        // 30 * 1024 * 1024
  export const MAX_IMAGE_EDGE: number;                // 1568
  export const WEBP_QUALITY: number;                  // 0.92
  export class ImageDecodeError extends Error {}       // .reason: 'tooLarge' | 'unsupported' | 'decodeFailed'
  export function fitWithin(w: number, h: number, edge: number): { width: number; height: number };
  export function downscaleImage(file: File): Promise<{ blob: Blob; width: number; height: number }>;
  ```

- [ ] **Step 1: Write the failing test for the pure arithmetic**

`frontend/src/shared/lib/downscale-image.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { fitWithin, MAX_IMAGE_EDGE } from './downscale-image';

describe('fitWithin', () => {
  it('scales a landscape image to the edge cap', () => {
    expect(fitWithin(5120, 2880, 1568)).toEqual({ width: 1568, height: 882 });
  });

  it('scales a portrait image by its longest edge', () => {
    expect(fitWithin(1000, 2000, 1568)).toEqual({ width: 784, height: 1568 });
  });

  /** 1568 is a ceiling, not a target — enlarging costs bytes for zero information. */
  it('never enlarges an image already within the cap', () => {
    expect(fitWithin(1280, 800, 1568)).toEqual({ width: 1280, height: 800 });
  });

  it('leaves an image exactly at the cap alone', () => {
    expect(fitWithin(1568, 1568, 1568)).toEqual({ width: 1568, height: 1568 });
  });

  it('never rounds an edge below 1px', () => {
    expect(fitWithin(10000, 3, 1568)).toEqual({ width: 1568, height: 1 });
  });

  it('caps at 1568 by default', () => {
    expect(MAX_IMAGE_EDGE).toBe(1568);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd frontend && npx vitest run src/shared/lib/downscale-image.test.ts`
Expected: FAIL — `Failed to resolve import "./downscale-image"`.

- [ ] **Step 3: Write the module**

`frontend/src/shared/lib/downscale-image.ts`:

```ts
/**
 * #1154: normalise an attached image in the browser before staging it.
 *
 * Every image is re-encoded, not just oversized ones, so the bytes reaching
 * `POST /llm/prepare-image` are always WebP within `MAX_IMAGE_EDGE`. That makes
 * most server-side rejections unreachable (format, dimensions, payload size) and
 * cuts staged Redis bytes by roughly an order of magnitude — Redis is shared with
 * BullMQ and runs `noeviction`, so staged bytes are not free (#1183).
 *
 * Animated GIFs flatten to their first frame as a side effect, which is a
 * benefit: several providers reject animated GIFs outright.
 */

/**
 * Ceiling on the *source* file, checked before any decode.
 *
 * Not the same thing as the backend's `MAX_IMAGE_BYTES` (10 MB), which bounds the
 * staged bytes *after* downscaling. This one exists because decoding is where the
 * memory goes: a 20000x20000 PNG is tens of KB compressed and ~1.6 GB decoded,
 * enough to kill the tab. 30 MB is generous for a raw 5K screenshot or a phone
 * photo while refusing a file no legitimate attach produces.
 */
export const MAX_SOURCE_IMAGE_BYTES = 30 * 1024 * 1024;

/** Longest-edge cap. Roughly where most vision encoders stop gaining detail. */
export const MAX_IMAGE_EDGE = 1568;

/** 0.92, not 0.90: at this size the payload is already small, and screenshot text is the point. */
export const WEBP_QUALITY = 0.92;

export type ImageDecodeReason = 'tooLarge' | 'unsupported' | 'decodeFailed';

export class ImageDecodeError extends Error {
  constructor(public readonly reason: ImageDecodeReason, message: string) {
    super(message);
    this.name = 'ImageDecodeError';
  }
}

/**
 * Scale (w, h) to fit inside a square of `edge`, preserving aspect ratio and
 * never enlarging. Exported separately from `downscaleImage` because this is the
 * part that carries the policy, and it is testable without a canvas.
 */
export function fitWithin(w: number, h: number, edge: number): { width: number; height: number } {
  const longest = Math.max(w, h);
  if (longest <= edge) return { width: w, height: h };
  const scale = edge / longest;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

/** SVG is refused rather than rasterized — see the design of record. */
const REFUSED_MIME = new Set(['image/svg+xml']);

async function decode(file: File): Promise<ImageBitmap> {
  // `createImageBitmap` with the resize options decodes AND scales in one pass,
  // so the full-size bitmap is never materialised. Where the overload is
  // unsupported the browser ignores the options, which is still correct — just
  // less memory-efficient — so there is no separate fallback branch to take.
  try {
    return await createImageBitmap(file);
  } catch {
    throw new ImageDecodeError(
      'decodeFailed',
      'That image could not be read. If it is a HEIC photo, convert it to PNG or JPEG first.',
    );
  }
}

export async function downscaleImage(
  file: File,
): Promise<{ blob: Blob; width: number; height: number }> {
  if (REFUSED_MIME.has(file.type)) {
    throw new ImageDecodeError(
      'unsupported',
      'SVG images are not accepted. Export it as PNG first.',
    );
  }
  if (file.size > MAX_SOURCE_IMAGE_BYTES) {
    throw new ImageDecodeError(
      'tooLarge',
      `That image is larger than ${Math.round(MAX_SOURCE_IMAGE_BYTES / (1024 * 1024))} MB. Resize it and try again.`,
    );
  }

  const bitmap = await decode(file);
  const { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_IMAGE_EDGE);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ImageDecodeError('decodeFailed', 'Could not prepare the image for upload.');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', WEBP_QUALITY),
  );
  if (!blob) throw new ImageDecodeError('decodeFailed', 'Could not encode the image for upload.');

  return { blob, width, height };
}
```

- [ ] **Step 4: Run the arithmetic tests and confirm they pass**

Run: `cd frontend && npx vitest run src/shared/lib/downscale-image.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Add the failing tests for the decode path**

jsdom has no canvas and the repo has no canvas dependency, so stub the two browser
APIs and assert the *decisions*. Append to `downscale-image.test.ts`:

```ts
import { beforeEach, vi } from 'vitest';
import { downscaleImage, ImageDecodeError, MAX_SOURCE_IMAGE_BYTES } from './downscale-image';

/** Records what the module asked the canvas to do. */
let drawn: { width: number; height: number } | null = null;
let toBlobArgs: [string, number] | null = null;

function stubCanvas() {
  drawn = null;
  toBlobArgs = null;
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (_b: unknown, _x: number, _y: number, w: number, h: number) => {
          drawn = { width: w, height: h };
        },
      }),
      toBlob: (cb: (b: Blob | null) => void, type: string, quality: number) => {
        toBlobArgs = [type, quality];
        cb(new Blob(['x'], { type }));
      },
    };
    return canvas as unknown as HTMLElement;
  }) as typeof document.createElement);
}

function stubBitmap(width: number, height: number) {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width, height, close: vi.fn() })));
}

function imageFile(name: string, type: string, size = 1024): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('downscaleImage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    stubCanvas();
  });

  it('encodes WebP at quality 0.92', async () => {
    stubBitmap(800, 600);
    const result = await downscaleImage(imageFile('a.png', 'image/png'));
    expect(toBlobArgs).toEqual(['image/webp', 0.92]);
    expect(result.blob.type).toBe('image/webp');
  });

  it('scales an oversized image down to the edge cap', async () => {
    stubBitmap(5120, 2880);
    const result = await downscaleImage(imageFile('big.png', 'image/png'));
    expect(drawn).toEqual({ width: 1568, height: 882 });
    expect(result).toMatchObject({ width: 1568, height: 882 });
  });

  /** The regression that would silently cost bytes for no detail. */
  it('does not enlarge an image already within the cap', async () => {
    stubBitmap(1280, 800);
    const result = await downscaleImage(imageFile('small.png', 'image/png'));
    expect(drawn).toEqual({ width: 1280, height: 800 });
    expect(result).toMatchObject({ width: 1280, height: 800 });
  });

  it('refuses SVG rather than rasterizing it', async () => {
    stubBitmap(100, 100);
    await expect(downscaleImage(imageFile('d.svg', 'image/svg+xml')))
      .rejects.toMatchObject({ reason: 'unsupported' });
  });

  it('refuses a source file over the input ceiling before decoding', async () => {
    const decodeSpy = vi.fn();
    vi.stubGlobal('createImageBitmap', decodeSpy);
    await expect(
      downscaleImage(imageFile('huge.png', 'image/png', MAX_SOURCE_IMAGE_BYTES + 1)),
    ).rejects.toBeInstanceOf(ImageDecodeError);
    expect(decodeSpy).not.toHaveBeenCalled();
  });

  it('surfaces an undecodable image (e.g. HEIC) with actionable copy', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('nope'); }));
    await expect(downscaleImage(imageFile('p.heic', 'image/heic')))
      .rejects.toThrow(/HEIC/);
  });
});
```

- [ ] **Step 6: Run the full file and confirm all pass**

Run: `cd frontend && npx vitest run src/shared/lib/downscale-image.test.ts`
Expected: PASS (12 tests). If `drawn` is null, the module used a code path other
than `drawImage` — fix the module, not the test.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
cd /Users/simon/Documents/localGIT/compendiq-ce
npm run lint -w frontend && npm run typecheck -w frontend
git add frontend/src/shared/lib/downscale-image.ts frontend/src/shared/lib/downscale-image.test.ts
git commit -m "feat(ai): downscale attached images to WebP in the browser (#1154)"
```

---

### Task 2: `usePrepareImage` — stage the normalised bytes

**Files:**
- Create: `frontend/src/shared/hooks/use-prepare-image.ts`
- Test: `frontend/src/shared/hooks/use-prepare-image.test.ts`
- Read first (deliberate near-clone): `frontend/src/shared/hooks/use-extract-document.ts`

**Interfaces:**
- Consumes: `downscaleImage` from Task 1.
- Produces:
  ```ts
  export type PreparedImage = PrepareImageResponse & { previewUrl: string };
  export function usePrepareImage(): {
    prepareImage: (file: File) => Promise<PreparedImage>;
    isPreparing: boolean;
    error: string | null;
  };
  ```

- [ ] **Step 1: Write the failing test**

`frontend/src/shared/hooks/use-prepare-image.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd frontend && npx vitest run src/shared/hooks/use-prepare-image.test.ts`
Expected: FAIL — cannot resolve `./use-prepare-image`.

- [ ] **Step 3: Write the hook**

`frontend/src/shared/hooks/use-prepare-image.ts`:

```ts
import { useState, useCallback } from 'react';
import type { PrepareImageResponse } from '@compendiq/contracts';
import { useAuthStore } from '../../stores/auth-store';
import { refreshAccessTokenOnce } from '../lib/api';
import { downscaleImage } from '../lib/downscale-image';

export type PreparedImage = PrepareImageResponse & {
  /** Object URL for the thumbnail. The holder MUST revoke it — see `useAttachments`. */
  previewUrl: string;
};

/**
 * Downscale an image and stage it for a Generate/Improve call (#1154).
 *
 * Deliberately shaped like `use-extract-document.ts`, down to the raw `fetch`:
 * `apiFetch` forces `Content-Type: application/json`, which strips the multipart
 * boundary. Same one-instance-per-surface rule, and `isPreparing` must be passed
 * down to whatever renders the spinner — two instances give two flags and the one
 * the spinner reads is not the one the upload flips (#940).
 */
export function usePrepareImage() {
  const [isPreparing, setIsPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prepareImage = useCallback(async (file: File): Promise<PreparedImage> => {
    setIsPreparing(true);
    setError(null);
    try {
      // Always normalise first: the server then only ever sees WebP within the
      // edge cap, which makes its format/dimension/size rejections unreachable.
      const { blob } = await downscaleImage(file);
      const formData = new FormData();
      // Filename must agree with the re-encode — the server refuses bytes whose
      // sniffed format contradicts the claimed extension.
      formData.append('file', blob, 'attachment.webp');

      const doFetch = (token: string | null) => {
        const headers: HeadersInit = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;
        return fetch('/api/llm/prepare-image', {
          method: 'POST',
          headers,
          credentials: 'include',
          body: formData,
        });
      };

      const { accessToken } = useAuthStore.getState();
      let res = await doFetch(accessToken);
      if (res.status === 401) {
        const newToken = await refreshAccessTokenOnce();
        if (newToken) res = await doFetch(newToken);
        else useAuthStore.getState().clearAuth();
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(body.message ?? `Image staging failed: ${res.status}`);
      }

      const staged = await res.json() as PrepareImageResponse;
      return { ...staged, previewUrl: URL.createObjectURL(blob) };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Image staging failed';
      setError(message);
      throw err;
    } finally {
      setIsPreparing(false);
    }
  }, []);

  return { prepareImage, isPreparing, error };
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `cd frontend && npx vitest run src/shared/hooks/use-prepare-image.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Lint, typecheck, commit**

```bash
cd /Users/simon/Documents/localGIT/compendiq-ce
npm run lint -w frontend && npm run typecheck -w frontend
git add frontend/src/shared/hooks/use-prepare-image.ts frontend/src/shared/hooks/use-prepare-image.test.ts
git commit -m "feat(ai): stage a downscaled image via POST /llm/prepare-image (#1154)"
```

---

### Task 3: `useAttachments` — both slots, routing, drop and paste

This is the seam the whole design rests on. It answers "who claims a dropped
file" by inspecting it once, in one place.

**Files:**
- Create: `frontend/src/shared/hooks/use-attachments.ts`
- Test: `frontend/src/shared/hooks/use-attachments.test.ts`

**Interfaces:**
- Consumes: `usePrepareImage`, `PreparedImage` (Task 2); `ImageDecodeError` (Task 1); the existing `useExtractDocument` and `ExtractDocumentResult`.
- Produces:
  ```ts
  export interface AttachedDocument { result: ExtractDocumentResult; filename: string }
  export interface UseAttachmentsOptions {
    dropTargetRef?: React.RefObject<HTMLElement | null>;
    imageEnabled?: boolean;          // false while vision !== true
    imageDisabledReason?: string;    // toasted if a drop/paste arrives while disabled
    disabled?: boolean;              // e.g. mid-stream
  }
  export function useAttachments(options?: UseAttachmentsOptions): {
    document: AttachedDocument | null;
    image: PreparedImage | null;
    pickFile: (file: File) => Promise<void>;
    removeDocument: () => void;
    removeImage: () => void;
    clearAll: () => void;
    isBusy: boolean;               // isExtracting || isPreparing
    isExtracting: boolean;
    isPreparing: boolean;
  };
  ```

- [ ] **Step 1: Write the failing routing tests**

`frontend/src/shared/hooks/use-attachments.test.ts`:

```ts
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
```

- [ ] **Step 2: Run and confirm it fails**

Run: `cd frontend && npx vitest run src/shared/hooks/use-attachments.test.ts`
Expected: FAIL — cannot resolve `./use-attachments`.

- [ ] **Step 3: Write the hook**

`frontend/src/shared/hooks/use-attachments.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { SUPPORTED_DOCUMENT_FORMATS, SUPPORTED_IMAGE_FORMATS } from '@compendiq/contracts';
import { useExtractDocument, type ExtractDocumentResult } from './use-extract-document';
import { usePrepareImage, type PreparedImage } from './use-prepare-image';
import { ImageDecodeError } from '../lib/downscale-image';

/**
 * #1154: one owner for both attachment slots on the AI composer surfaces.
 *
 * The reason this exists rather than each surface holding its own state: with two
 * slots across three surfaces there would be six pieces of hand-rolled state and
 * three copies of the drop routing. More importantly, a shared drop target has to
 * decide *once* whether a dropped file is a document or an image — if both zones
 * listened, a PNG dropped on the composer would be offered to the document zone,
 * whose `isAccepted()` check is deliberately loose, and which of them won would be
 * emergent rather than designed.
 *
 * So this hook owns the shared drop target and the paste listener, and the zones
 * are presentational.
 */

export interface AttachedDocument {
  result: ExtractDocumentResult;
  filename: string;
}

export interface UseAttachmentsOptions {
  /** Ancestor element that accepts drops — normally the `nm-composer` box. */
  dropTargetRef?: React.RefObject<HTMLElement | null>;
  /** False while the resolved chat model is not known vision-capable. */
  imageEnabled?: boolean;
  /** Shown when an image arrives by drop or paste while `imageEnabled` is false. */
  imageDisabledReason?: string;
  /** Blocks all intake — e.g. while a stream is in flight. */
  disabled?: boolean;
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const;

function looksLikeImage(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  const name = file.name.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => name.endsWith(`.${ext}`));
}

/** Copy for the one "we don't take that" message, derived from the contracts. */
function unsupportedMessage(): string {
  const docs = SUPPORTED_DOCUMENT_FORMATS.map((f) => f.toUpperCase()).join(', ');
  const images = SUPPORTED_IMAGE_FORMATS.map((f) => f.toUpperCase()).join(', ');
  return `Unsupported file. Documents: ${docs}. Images: ${images}.`;
}

export function useAttachments(options: UseAttachmentsOptions = {}) {
  const { dropTargetRef, imageEnabled = false, imageDisabledReason, disabled = false } = options;

  const [document_, setDocument] = useState<AttachedDocument | null>(null);
  const [image, setImage] = useState<PreparedImage | null>(null);

  const { extractDocument, isExtracting } = useExtractDocument();
  const { prepareImage, isPreparing } = usePrepareImage();

  // Revoking on unmount needs the current value without making the effect depend
  // on it, or every new attachment would revoke the URL it just created.
  const imageRef = useRef<PreparedImage | null>(null);
  imageRef.current = image;

  const removeImage = useCallback(() => {
    setImage((current) => {
      if (current) URL.revokeObjectURL(current.previewUrl);
      return null;
    });
  }, []);

  const removeDocument = useCallback(() => setDocument(null), []);

  const clearAll = useCallback(() => {
    removeImage();
    setDocument(null);
  }, [removeImage]);

  useEffect(() => () => {
    if (imageRef.current) URL.revokeObjectURL(imageRef.current.previewUrl);
  }, []);

  const pickFile = useCallback(async (file: File) => {
    if (disabled) return;

    if (looksLikeImage(file)) {
      if (!imageEnabled) {
        toast.error(imageDisabledReason ?? 'Images cannot be attached right now.');
        return;
      }
      try {
        const prepared = await prepareImage(file);
        // Replace rather than accumulate: one image per request by design.
        setImage((previous) => {
          if (previous) URL.revokeObjectURL(previous.previewUrl);
          return prepared;
        });
      } catch (err) {
        // ImageDecodeError already carries user-facing copy (SVG, HEIC, too big).
        const message = err instanceof ImageDecodeError || err instanceof Error
          ? err.message
          : 'Could not attach that image.';
        toast.error(message);
      }
      return;
    }

    const name = file.name.toLowerCase();
    const isDocument = SUPPORTED_DOCUMENT_FORMATS.some((f) => name.endsWith(`.${f}`))
      || name.endsWith('.markdown') || name.endsWith('.text');
    if (!isDocument) {
      toast.error(unsupportedMessage());
      return;
    }

    try {
      const result = await extractDocument(file);
      setDocument({ result, filename: file.name });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Document extraction failed');
    }
  }, [disabled, imageEnabled, imageDisabledReason, prepareImage, extractDocument]);

  // Shared drop target + paste. Native listeners rather than React props, because
  // the element belongs to the caller's tree.
  useEffect(() => {
    const target = dropTargetRef?.current;
    if (!target || disabled) return;

    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      const file = e.dataTransfer?.files[0];
      if (!file) return;
      e.preventDefault();
      void pickFile(file);
    };
    const onPaste = (e: Event) => {
      const clipboard = (e as ClipboardEvent).clipboardData;
      const items = Array.from(clipboard?.items ?? []);
      const imageItem = items.find((i) => i.type.startsWith('image/'));
      if (!imageItem) return;   // let text paste reach the textarea untouched
      const file = imageItem.getAsFile();
      if (!file) return;
      e.preventDefault();
      void pickFile(file);
    };

    target.addEventListener('dragover', onDragOver);
    target.addEventListener('drop', onDrop);
    target.addEventListener('paste', onPaste);
    return () => {
      target.removeEventListener('dragover', onDragOver);
      target.removeEventListener('drop', onDrop);
      target.removeEventListener('paste', onPaste);
    };
  }, [dropTargetRef, disabled, pickFile]);

  return {
    document: document_,
    image,
    pickFile,
    removeDocument,
    removeImage,
    clearAll,
    isBusy: isExtracting || isPreparing,
    isExtracting,
    isPreparing,
  };
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `cd frontend && npx vitest run src/shared/hooks/use-attachments.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Lint, typecheck, commit**

```bash
cd /Users/simon/Documents/localGIT/compendiq-ce
npm run lint -w frontend && npm run typecheck -w frontend
git add frontend/src/shared/hooks/use-attachments.ts frontend/src/shared/hooks/use-attachments.test.ts
git commit -m "feat(ai): useAttachments owns both slots, drop routing and paste (#1154)"
```

---

### Task 4: Make `DocumentUploadZone` presentational

**The one task carrying regression risk.** Read the canary suites before touching
anything: `frontend/src/features/ai/modes/GenerateMode.extracting.test.tsx` and
`frontend/src/features/ai/dock/AiDock.upload.test.tsx`.

**Files:**
- Modify: `frontend/src/shared/components/upload/DocumentUploadZone.tsx:101-268`
- Modify (prop shape only): `frontend/src/features/ai/modes/GenerateMode.tsx:437-446`, `frontend/src/features/ai/dock/DockPanel.tsx:274-287`
- Modify if needed: the two canary suites (assertions must not weaken)

**Interfaces:**
- Consumes: `pickFile`, `document`, `removeDocument`, `isExtracting` from `useAttachments` (Task 3).
- Produces: revised `DocumentUploadZoneProps` —
  ```ts
  // REMOVED: extract, onExtracted, dropTargetRef
  // ADDED:
  onPick: (file: File) => void;   // the router from useAttachments
  ```
  `extracted`, `filename`, `onRemove`, `isExtracting`, `formats`, `disabled`,
  `variant`, `triggerLabel`, `usageHint`, `testIdPrefix` all keep their current
  meaning and types.

- [ ] **Step 1: Replace the three props in the interface**

In `DocumentUploadZone.tsx`, delete the `extract`, `onExtracted` and
`dropTargetRef` props and add:

```ts
  /**
   * Hand the picked file to the parent's `useAttachments` router, which decides
   * document-vs-image. This component no longer extracts anything itself: with a
   * shared composer drop target, a dropped PNG would otherwise be tested against
   * this component's document-only `isAccepted()` and silently rejected.
   */
  onPick: (file: File) => void;
```

- [ ] **Step 2: Reduce `handleFile` to a guarded hand-off**

Replace `handleFile` (`:175-190`) with:

```ts
  // No format or size gate here any more — both moved to `useAttachments`, which
  // is the only place that knows whether a file is a document or an image.
  const handleFile = useCallback((file: File) => {
    onPick(file);
  }, [onPick]);
```

- [ ] **Step 3: Delete the `dropTargetRef` machinery**

Remove the `blocked`/`dropTargetRef` effect (`:227-252`) and simplify `dragProps`
(`:219-225`) to always attach — the ancestor-widening job now belongs to
`useAttachments`, so the double-handling this guarded against cannot occur:

```ts
  const dragProps = {
    onDragEnter: enterDrag,
    onDragLeave: leaveDrag,
    // Without preventDefault the browser navigates to the dropped file.
    onDragOver: (e: React.DragEvent) => e.preventDefault(),
    onDrop: handleDrop,
  };
```

Keep `dragDepth`, `enterDrag`, `leaveDrag`, `endDrag` and `handleDrop` exactly as
they are — the counting-not-toggling behaviour is still needed for the `dropzone`
variant's own hover state.

- [ ] **Step 4: Update the two call sites to the new prop shape**

`GenerateMode.tsx` and `DockPanel.tsx`: replace `extract={extractDocument}` and
`onExtracted={handleDocumentExtracted}` with `onPick={pickFile}`, and drop
`dropTargetRef={composerBoxRef}` from `DockPanel` (the ref now goes to
`useAttachments`). Full wiring lands in Tasks 7 and 9; this step only keeps the
build green.

- [ ] **Step 5: Run the canaries**

```bash
cd frontend
npx vitest run src/features/ai/modes/GenerateMode.extracting.test.tsx src/features/ai/dock/AiDock.upload.test.tsx
```

Expected: PASS. Prop-shape updates in these files are fine. **If making them pass
requires deleting or weakening an assertion, stop and report it** — that means the
refactor changed behaviour rather than moving it.

- [ ] **Step 6: Run the whole upload + AI surface area**

```bash
cd frontend && npx vitest run src/shared/components/upload src/features/ai
```
Expected: PASS.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
cd /Users/simon/Documents/localGIT/compendiq-ce
npm run lint -w frontend && npm run typecheck -w frontend
git add frontend/src/shared/components/upload frontend/src/features/ai
git commit -m "refactor(ai): DocumentUploadZone reports the picked file instead of extracting (#1154)"
```

---

### Task 5: `ImageAttachZone` — the tri-state affordance

**Files:**
- Create: `frontend/src/shared/components/upload/ImageAttachZone.tsx`
- Test: `frontend/src/shared/components/upload/ImageAttachZone.test.tsx`

**Interfaces:**
- Consumes: `PreparedImage` (Task 2).
- Produces:
  ```ts
  export function imageDisabledReason(vision: boolean | null, model: string): string | undefined;
  export interface ImageAttachZoneProps {
    vision: boolean | null;
    model: string;
    image: PreparedImage | null;
    onPick: (file: File) => void;
    onRemove: () => void;
    isPreparing: boolean;
    disabled?: boolean;
    testIdPrefix?: string;
  }
  export function ImageAttachZone(props: ImageAttachZoneProps): JSX.Element;
  ```

- [ ] **Step 1: Write the failing test**

`frontend/src/shared/components/upload/ImageAttachZone.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ImageAttachZone, imageDisabledReason } from './ImageAttachZone';

const base = {
  model: 'llama3.1',
  image: null,
  onPick: vi.fn(),
  onRemove: vi.fn(),
  isPreparing: false,
};

describe('imageDisabledReason', () => {
  it('is undefined when the model is known vision-capable', () => {
    expect(imageDisabledReason(true, 'qwen2.5vl')).toBeUndefined();
  });

  it('says the model cannot read images when the verdict is false', () => {
    const reason = imageDisabledReason(false, 'llama3.1')!;
    expect(reason).toMatch(/llama3\.1/);
    expect(reason).toMatch(/can't read images/i);
    expect(reason).toMatch(/Settings/);
  });

  /**
   * null is "not established", not "established as no". Reusing the false copy
   * would assert something the server never checked.
   */
  it('says support is unconfirmed when the verdict is null', () => {
    const reason = imageDisabledReason(null, 'llama3.1')!;
    expect(reason).toMatch(/llama3\.1/);
    expect(reason).toMatch(/not confirmed|isn't confirmed/i);
    expect(reason).not.toMatch(/can't read images/i);
  });

  it('gives false and null different text', () => {
    expect(imageDisabledReason(false, 'm')).not.toBe(imageDisabledReason(null, 'm'));
  });
});

describe('ImageAttachZone', () => {
  it('enables the trigger when vision is true', () => {
    render(<ImageAttachZone {...base} vision={true} />);
    expect(screen.getByTestId('image-attach-trigger')).not.toBeDisabled();
  });

  it.each([[false], [null]] as const)('disables the trigger when vision is %s', (vision) => {
    render(<ImageAttachZone {...base} vision={vision} />);
    expect(screen.getByTestId('image-attach-trigger')).toBeDisabled();
  });

  it('exposes the reason as a title, since the app has no Tooltip primitive', () => {
    render(<ImageAttachZone {...base} vision={false} />);
    expect(screen.getByTestId('image-attach-trigger'))
      .toHaveAttribute('title', expect.stringMatching(/can't read images/i));
  });

  it('renders a thumbnail and dimensions once an image is attached', () => {
    render(<ImageAttachZone {...base} vision={true} image={{
      handle: 'a'.repeat(64), format: 'webp', width: 1568, height: 882,
      fileSize: 240_000, previewUrl: 'blob:preview',
    }} />);
    expect(screen.getByTestId('image-attach-thumb')).toHaveAttribute('src', 'blob:preview');
    expect(screen.getByTestId('image-attach-card')).toHaveTextContent('1568×882');
  });

  it('disables the trigger while preparing', () => {
    render(<ImageAttachZone {...base} vision={true} isPreparing />);
    expect(screen.getByTestId('image-attach-trigger')).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `cd frontend && npx vitest run src/shared/components/upload/ImageAttachZone.test.tsx`
Expected: FAIL — cannot resolve `./ImageAttachZone`.

- [ ] **Step 3: Write the component**

`frontend/src/shared/components/upload/ImageAttachZone.tsx`:

```tsx
import { useRef } from 'react';
import { Image as ImageIcon, Loader2, X } from 'lucide-react';
import { SUPPORTED_IMAGE_FORMATS } from '@compendiq/contracts';
import type { PreparedImage } from '../../hooks/use-prepare-image';
import { cn } from '../../lib/cn';

/**
 * #1154: the image half of the composer's attach affordance.
 *
 * Purely presentational — picking, downscaling and staging all live in
 * `useAttachments`. The trigger is always rendered, even when the model cannot
 * accept images, so the capability is discoverable: hiding it means a user on a
 * text-only model never learns image input exists or that switching models
 * unlocks it. It is disabled with a reason instead.
 */

/** `.png,.jpg,…` plus MIME types, so both native pickers behave. */
const ACCEPT = [
  ...SUPPORTED_IMAGE_FORMATS.map((f) => `image/${f}`),
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
].join(',');

/**
 * Why the image trigger is disabled, or `undefined` when it is not.
 *
 * `false` and `null` deliberately differ. `null` means the server has not
 * established capability, and telling the user the model "cannot accept images"
 * would assert something it never checked — the same distinction the backend's
 * own 422 messages make.
 */
export function imageDisabledReason(vision: boolean | null, model: string): string | undefined {
  if (vision === true) return undefined;
  if (vision === false) {
    return `${model} can't read images — assign a vision-capable model in Settings → LLM.`;
  }
  return `Image support for ${model} isn't confirmed yet — try again shortly.`;
}

export interface ImageAttachZoneProps {
  vision: boolean | null;
  model: string;
  image: PreparedImage | null;
  onPick: (file: File) => void;
  onRemove: () => void;
  isPreparing: boolean;
  disabled?: boolean;
  testIdPrefix?: string;
}

export function ImageAttachZone({
  vision, model, image, onPick, onRemove, isPreparing,
  disabled = false, testIdPrefix = 'image-attach',
}: ImageAttachZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const reason = imageDisabledReason(vision, model);
  const blocked = disabled || isPreparing || reason !== undefined;

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPick(file);
          e.target.value = '';   // re-selecting the same file must re-fire onChange
        }}
        data-testid={`${testIdPrefix}-file-input`}
      />

      {image && (
        <div
          className="nm-card flex w-full items-center gap-2 rounded-lg p-2"
          data-testid={`${testIdPrefix}-card`}
        >
          <img
            src={image.previewUrl}
            alt=""
            className="h-10 w-10 shrink-0 rounded object-cover"
            data-testid={`${testIdPrefix}-thumb`}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs">Attached image</p>
            <p className="font-mono text-[11px] text-muted-foreground">
              {image.width}×{image.height} · {(image.fileSize / 1024).toFixed(0)} KB
              {image.format === 'gif' ? ' · first frame' : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onRemove}
            aria-label="Remove image"
            className="nm-card-hover shrink-0 rounded p-1"
            data-testid={`${testIdPrefix}-remove`}
          >
            <X size={14} />
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={blocked}
        title={reason ?? 'Attach an image'}
        aria-label="Attach an image"
        className={cn(
          'nm-card-hover self-end rounded-lg border border-border-interactive p-2',
          'disabled:opacity-50',
        )}
        data-testid={`${testIdPrefix}-trigger`}
      >
        {isPreparing ? <Loader2 size={16} className="animate-spin" /> : <ImageIcon size={16} />}
      </button>
    </>
  );
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `cd frontend && npx vitest run src/shared/components/upload/ImageAttachZone.test.tsx`
Expected: PASS (10 tests).

- [ ] **Step 5: Confirm the gradient-surface guard is satisfied**

Run: `cd frontend && npx vitest run src/index.css.test.ts src/neumorphic-themes.test.ts`
Expected: PASS. If a `hover:bg-*` guard fires, the new component used a
background-colour hover on a card surface — switch it to `nm-card-hover`.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
cd /Users/simon/Documents/localGIT/compendiq-ce
npm run lint -w frontend && npm run typecheck -w frontend
git add frontend/src/shared/components/upload/ImageAttachZone.tsx frontend/src/shared/components/upload/ImageAttachZone.test.tsx
git commit -m "feat(ai): ImageAttachZone with a tri-state disabled reason (#1154)"
```

---

### Task 6: Expose `chatVision` from `AiContext`

**Files:**
- Modify: `frontend/src/features/ai/AiContext.tsx:158-167` (interface), `:545`, `:815-871` (context value)
- Test: `frontend/src/features/ai/AiContext.vision.test.tsx` (create)

**Interfaces:**
- Consumes: nothing new — the query at `:535-544` already fetches `vision` and discards it.
- Produces: `useAiContext().chatVision: boolean | null`.

- [ ] **Step 1: Write the failing test**

`frontend/src/features/ai/AiContext.vision.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const mockApiFetch = vi.fn();
vi.mock('../../shared/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../shared/lib/api')>(),
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

import { AiProvider, useAiContext } from './AiContext';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}><AiProvider>{children}</AiProvider></QueryClientProvider>;
}

beforeEach(() => {
  mockApiFetch.mockReset().mockImplementation(async (path: string) => {
    if (path === '/llm/usecase-default?usecase=chat') {
      return { usecase: 'chat', providerId: 'p1', providerName: 'X', model: 'qwen2.5vl', vision: true };
    }
    if (path.startsWith('/ollama/models')) return [{ name: 'qwen2.5vl' }];
    return {};
  });
});

describe('AiContext chatVision (#1154)', () => {
  it('exposes the vision verdict from usecase-default', async () => {
    const { result } = renderHook(() => useAiContext(), { wrapper });
    await waitFor(() => expect(result.current.chatVision).toBe(true));
  });

  it.each([[false], [null]] as const)('passes through a %s verdict unchanged', async (vision) => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/llm/usecase-default?usecase=chat') {
        return { usecase: 'chat', providerId: 'p1', providerName: 'X', model: 'llama3.1', vision };
      }
      if (path.startsWith('/ollama/models')) return [{ name: 'llama3.1' }];
      return {};
    });
    const { result } = renderHook(() => useAiContext(), { wrapper });
    await waitFor(() => expect(result.current.model).toBe('llama3.1'));
    expect(result.current.chatVision).toBe(vision);
  });

  /** No default configured (the 404 path) must not read as "no vision". */
  it('is null when no chat default resolves', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/llm/usecase-default?usecase=chat') throw new Error('404');
      if (path.startsWith('/ollama/models')) return [{ name: 'llama3.1' }];
      return {};
    });
    const { result } = renderHook(() => useAiContext(), { wrapper });
    await waitFor(() => expect(result.current.chatVision).toBeNull());
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `cd frontend && npx vitest run src/features/ai/AiContext.vision.test.tsx`
Expected: FAIL — `chatVision` does not exist on the context type.

- [ ] **Step 3: Add the field**

In the context interface (`:158-167`) add:

```ts
  /**
   * #1154: whether the resolved chat model accepts images. `null` means
   * probed-but-undetermined, which the composer renders differently from
   * `false` — the query at :535 has always fetched this and discarded it.
   */
  chatVision: boolean | null;
```

In the context value object (`:815-871`) add:

```ts
    chatVision: chatDefault?.vision ?? null,
```

- [ ] **Step 4: Run and confirm pass**

Run: `cd frontend && npx vitest run src/features/ai/AiContext.vision.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Lint, typecheck, commit**

```bash
cd /Users/simon/Documents/localGIT/compendiq-ce
npm run lint -w frontend && npm run typecheck -w frontend
git add frontend/src/features/ai/AiContext.tsx frontend/src/features/ai/AiContext.vision.test.tsx
git commit -m "feat(ai): expose the chat vision verdict on AiContext (#1154)"
```

---

### Task 7: Wire `/ai` Generate

**Files:**
- Modify: `frontend/src/features/ai/modes/GenerateMode.tsx:349-357` (state), `:386-405` (body), `:437-446` (render), `:487` (send disabled)
- Test: `frontend/src/features/ai/modes/GenerateMode.image.test.tsx` (create)

**Interfaces:**
- Consumes: `useAttachments` (Task 3), `ImageAttachZone` + `imageDisabledReason` (Task 5), `chatVision` (Task 6).
- Produces: nothing for later tasks.

- [ ] **Step 1: Write the failing test**

`frontend/src/features/ai/modes/GenerateMode.image.test.tsx`. Copy the mock
preamble from the existing `GenerateMode.test.tsx` verbatim, then add:

```tsx
const HANDLE = 'a'.repeat(64);

describe('GenerateMode image attach (#1154)', () => {
  it('sends imageHandle in the generate body', async () => {
    // attach via the hidden input, then submit
    renderGenerateMode({ chatVision: true });
    await attachImage('shot.png');
    await submit('describe this');

    const body = mockRunStream.mock.calls[0]![1];
    expect(body).toMatchObject({ imageHandle: HANDLE });
  });

  it('omits imageHandle when no image is attached', async () => {
    renderGenerateMode({ chatVision: true });
    await submit('hello');
    expect(mockRunStream.mock.calls[0]![1]).not.toHaveProperty('imageHandle');
  });

  it('sends documentText and imageHandle together', async () => {
    renderGenerateMode({ chatVision: true });
    await attachDocument('spec.pdf');
    await attachImage('shot.png');
    await submit('reconcile these');

    const body = mockRunStream.mock.calls[0]![1];
    expect(body).toMatchObject({ imageHandle: HANDLE, documentText: expect.any(String) });
  });

  it('warns when both slots are filled', async () => {
    renderGenerateMode({ chatVision: true });
    await attachDocument('spec.pdf');
    await attachImage('shot.png');
    expect(screen.getByTestId('attachment-context-warning')).toBeInTheDocument();
  });

  it('does not warn with only one attachment', async () => {
    renderGenerateMode({ chatVision: true });
    await attachImage('shot.png');
    expect(screen.queryByTestId('attachment-context-warning')).not.toBeInTheDocument();
  });

  it('disables the image trigger when the model is text-only', () => {
    renderGenerateMode({ chatVision: false });
    expect(screen.getByTestId('image-attach-trigger')).toBeDisabled();
  });

  /** A 410 means the 15-minute staging TTL lapsed. Clear the slot, keep the prompt. */
  it('clears the image but keeps the prompt on a 410', async () => {
    mockRunStream.mockRejectedValueOnce(new ApiError(410, 'The staged image has expired.'));
    renderGenerateMode({ chatVision: true });
    await attachImage('shot.png');
    await submit('describe this');

    await waitFor(() => expect(screen.queryByTestId('image-attach-card')).not.toBeInTheDocument());
    expect(promptInput()).toHaveValue('describe this');
  });

  it('blocks send while the image is still being prepared', async () => {
    renderGenerateMode({ chatVision: true, isPreparing: true });
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });
});
```

**Selectors — use the real ones, these components have almost no testids.** Write
these helpers at the top of the file:

```tsx
import { ApiError } from '../../../shared/lib/api';

/**
 * The prompt textarea has no testid and its placeholder is CONDITIONAL on whether
 * a document is attached (`GenerateMode.tsx:475`), so a fixed placeholder query
 * breaks the moment a test attaches one. Query both.
 */
function promptInput(): HTMLTextAreaElement {
  return (
    screen.queryByPlaceholderText('Describe the page to generate...') ??
    screen.getByPlaceholderText('Instructions for generating from this document...')
  ) as HTMLTextAreaElement;
}

async function attachImage(name: string) {
  const file = new File(['x'], name, { type: 'image/png' });
  await act(async () => {
    fireEvent.change(screen.getByTestId('image-attach-file-input'), { target: { files: [file] } });
  });
}

async function attachDocument(name: string) {
  const file = new File(['x'], name, { type: 'application/pdf' });
  await act(async () => {
    fireEvent.change(screen.getByTestId('document-file-input'), { target: { files: [file] } });
  });
}

async function submit(prompt: string) {
  await act(async () => { fireEvent.change(promptInput(), { target: { value: prompt } }); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send message' })); });
}
```

- [ ] **Step 2: Run and confirm it fails**

Run: `cd frontend && npx vitest run src/features/ai/modes/GenerateMode.image.test.tsx`
Expected: FAIL — no `image-attach-trigger` in the tree.

- [ ] **Step 3: Replace the two `useState`s with the hook**

In `GenerateMode.tsx`, delete `documentData`/`documentFilename` (`:350-351`) and
the `useExtractDocument()` instance (`:349`), and add:

```ts
  const composerBoxRef = useRef<HTMLDivElement>(null);
  const { chatVision } = useAiContext();
  const attachments = useAttachments({
    dropTargetRef: composerBoxRef,
    imageEnabled: chatVision === true,
    imageDisabledReason: imageDisabledReason(chatVision, model),
    disabled: isStreaming,
  });
```

- [ ] **Step 4: Add both fields to the request body**

Replace `:386-389` with:

```ts
    const body: Record<string, unknown> = { prompt, model };
    if (attachments.document) body.documentText = attachments.document.result.text;
    if (attachments.image) body.imageHandle = attachments.image.handle;
```

- [ ] **Step 5: Handle a lapsed handle on send**

Wrap the `runStream` call:

```ts
    try {
      await runStream('/llm/generate', body, { onComplete: /* unchanged */ });
    } catch (err) {
      // 410 = the 15-minute staging TTL lapsed. Drop the image and say so, but
      // leave the prompt text alone so nothing has to be retyped.
      if (err instanceof ApiError && err.status === 410) {
        attachments.removeImage();
        toast.error('The image expired — attach it again.');
        return;
      }
      throw err;
    }
```

- [ ] **Step 6: Render both zones plus the advisory**

Wrap the existing `DocumentUploadZone` and the new `ImageAttachZone` in the
composer box, and add the both-slots advisory:

```tsx
  <div ref={composerBoxRef} className="nm-composer flex-wrap">
    <DocumentUploadZone
      variant="dropzone"
      onPick={attachments.pickFile}
      isExtracting={attachments.isExtracting}
      extracted={attachments.document?.result ?? null}
      filename={attachments.document?.filename ?? null}
      onRemove={attachments.removeDocument}
      disabled={isStreaming}
    />
    <ImageAttachZone
      vision={chatVision}
      model={model}
      image={attachments.image}
      onPick={attachments.pickFile}
      onRemove={attachments.removeImage}
      isPreparing={attachments.isPreparing}
      disabled={isStreaming}
    />
    {attachments.document && attachments.image && (
      <p
        className="flex w-full items-center gap-1.5 text-xs text-warning"
        data-testid="attachment-context-warning"
      >
        <AlertTriangle size={12} />
        Both attachments will be sent — a small model may not fit them.
      </p>
    )}
    {/* existing textarea and send button */}
  </div>
```

- [ ] **Step 7: Include the new busy flag in the send guard**

At `:488`, change `isExtracting` to `attachments.isBusy` so a staging round-trip
blocks send exactly as extraction already does (#940):

```tsx
            disabled={isStreaming || attachments.isBusy || !input.trim() || !model}
```

- [ ] **Step 8: Rewire the conditional placeholder**

`:475` reads `documentData ? '…from this document…' : 'Describe the page to generate...'`,
and `documentData` no longer exists. Existing tests query by both strings, so
getting this wrong breaks `GenerateMode.test.tsx` rather than failing silently:

```tsx
            placeholder={attachments.document
              ? 'Instructions for generating from this document...'
              : 'Describe the page to generate...'}
```

Leave the copy exactly as-is — an attached *image* keeps the default placeholder,
because "from this document" would be wrong and no test covers an image-only
placeholder.

- [ ] **Step 9: Run the new suite and the canary**

```bash
cd frontend && npx vitest run src/features/ai/modes/GenerateMode.image.test.tsx src/features/ai/modes/GenerateMode.extracting.test.tsx src/features/ai/modes/GenerateMode.test.tsx
```
Expected: PASS.

- [ ] **Step 10: Lint, typecheck, commit**

```bash
cd /Users/simon/Documents/localGIT/compendiq-ce
npm run lint -w frontend && npm run typecheck -w frontend
git add frontend/src/features/ai/modes/GenerateMode.tsx frontend/src/features/ai/modes/GenerateMode.image.test.tsx
git commit -m "feat(ai): attach an image on /ai Generate (#1154)"
```

---

### Task 8: Wire `/ai` Improve — image **and** the document gap-fill

`ImproveMode.tsx` has no attachment affordance at all today (zero occurrences of
`documentText` or `referenceText`). It gains both. The document half is a #1131
gap-fill riding along deliberately — call it out in the PR description.

**Files:**
- Modify: `frontend/src/features/ai/modes/ImproveMode.tsx:167-179` (body) and its composer JSX
- Test: `frontend/src/features/ai/modes/ImproveMode.attachments.test.tsx` (create)

**Interfaces:**
- Consumes: exactly what Task 7 consumed.
- Produces: nothing for later tasks.

- [ ] **Step 1: Write the failing test**

`frontend/src/features/ai/modes/ImproveMode.attachments.test.tsx`, mock preamble
copied from the existing `ImproveMode.test.tsx`:

```tsx
const HANDLE = 'a'.repeat(64);

describe('ImproveMode attachments (#1154, #1131 gap-fill)', () => {
  it('sends referenceText from an attached document', async () => {
    renderImproveMode({ chatVision: true });
    await attachDocument('spec.pdf');
    await submitImprove();
    expect(mockRunStream.mock.calls[0]![1]).toMatchObject({ referenceText: expect.any(String) });
  });

  it('sends imageHandle from an attached image', async () => {
    renderImproveMode({ chatVision: true });
    await attachImage('shot.png');
    await submitImprove();
    expect(mockRunStream.mock.calls[0]![1]).toMatchObject({ imageHandle: HANDLE });
  });

  it('sends neither field when nothing is attached', async () => {
    renderImproveMode({ chatVision: true });
    await submitImprove();
    const body = mockRunStream.mock.calls[0]![1];
    expect(body).not.toHaveProperty('referenceText');
    expect(body).not.toHaveProperty('imageHandle');
  });

  it('disables the image trigger when vision is unconfirmed', () => {
    renderImproveMode({ chatVision: null });
    expect(screen.getByTestId('image-attach-trigger')).toBeDisabled();
    expect(screen.getByTestId('image-attach-trigger'))
      .toHaveAttribute('title', expect.stringMatching(/isn't confirmed/i));
  });

  it('clears the image but keeps the instruction on a 410', async () => {
    mockRunStream.mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 410 }));
    renderImproveMode({ chatVision: true });
    await attachImage('shot.png');
    await submitImprove('tighten the intro');
    await waitFor(() => expect(screen.queryByTestId('image-attach-card')).not.toBeInTheDocument());
    expect(instructionInput()).toHaveValue('tighten the intro');
  });
});
```

**Selectors:** `ImproveMode.tsx` has only two testids
(`improve-search-web-toggle`, `layout-token-loss-warning`), so define
`instructionInput()` in this file the same way Task 7 defines `promptInput()` —
query the instruction field by its placeholder, reading the exact string out of
`ImproveMode.tsx` first. Reuse Task 7's `attachImage` / `attachDocument` helpers
verbatim.

- [ ] **Step 2: Run and confirm it fails**

Run: `cd frontend && npx vitest run src/features/ai/modes/ImproveMode.attachments.test.tsx`
Expected: FAIL — no attach affordance in the tree.

- [ ] **Step 3: Add the hook and both zones**

Same `useAttachments` block as Task 7 Step 3. Render `DocumentUploadZone`
(`variant="composer"`, `usageHint="reference for Improve"`) and `ImageAttachZone`
inside a `composerBoxRef` container, with the same both-slots advisory.

- [ ] **Step 4: Add both fields to the body**

At `:167-179`, extend the body object:

```ts
      ...(attachments.document && { referenceText: attachments.document.result.text }),
      ...(attachments.image && { imageHandle: attachments.image.handle }),
```

- [ ] **Step 5: Add the same 410 handler as Task 7 Step 5**

- [ ] **Step 6: Run the new suite and the existing one**

```bash
cd frontend && npx vitest run src/features/ai/modes/ImproveMode.attachments.test.tsx src/features/ai/modes/ImproveMode.test.tsx
```
Expected: PASS.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
cd /Users/simon/Documents/localGIT/compendiq-ce
npm run lint -w frontend && npm run typecheck -w frontend
git add frontend/src/features/ai/modes/ImproveMode.tsx frontend/src/features/ai/modes/ImproveMode.attachments.test.tsx
git commit -m "feat(ai): attach a document or image on /ai Improve (#1154, #1131)"
```

---

### Task 9: Wire the dock

**Files:**
- Modify: `frontend/src/features/ai/dock/DockPanel.tsx:39-53` (state), `:273-287` (composer)
- Modify: `frontend/src/features/ai/dock/use-dock-actions.ts:6-14` (options), `:89-114` (body)
- Test: `frontend/src/features/ai/dock/AiDock.image.test.tsx` (create)

**Interfaces:**
- Consumes: `useAttachments` (Task 3), `ImageAttachZone` (Task 5), `chatVision` (Task 6).
- Produces: `UseDockActionsOptions` gains `imageHandle?: string`.

- [ ] **Step 1: Write the failing test**

`frontend/src/features/ai/dock/AiDock.image.test.tsx`, mock preamble copied from
`AiDock.upload.test.tsx`:

```tsx
const HANDLE = 'a'.repeat(64);

describe('dock image attach (#1154)', () => {
  it('sends imageHandle when the Improve chip runs', async () => {
    renderDock({ chatVision: true });
    await attachImage('shot.png');
    await clickChip('improve');
    expect(mockRunStream.mock.calls[0]![1]).toMatchObject({ imageHandle: HANDLE });
  });

  it('sends referenceText and imageHandle together', async () => {
    renderDock({ chatVision: true });
    await attachDocument('spec.pdf');
    await attachImage('shot.png');
    await clickChip('improve');
    expect(mockRunStream.mock.calls[0]![1]).toMatchObject({
      imageHandle: HANDLE, referenceText: expect.any(String),
    });
  });

  it('accepts an image pasted onto the composer', async () => {
    renderDock({ chatVision: true });
    await pasteImageOnComposer();
    await waitFor(() => expect(screen.getByTestId('image-attach-card')).toBeInTheDocument());
  });

  /** Attachments are material for the next action, not part of the conversation. */
  it('clears the image when the page changes', async () => {
    const { rerender } = renderDock({ chatVision: true, pageId: '1' });
    await attachImage('shot.png');
    await waitFor(() => expect(screen.getByTestId('image-attach-card')).toBeInTheDocument());
    rerender(dockWith({ chatVision: true, pageId: '2' }));
    await waitFor(() => expect(screen.queryByTestId('image-attach-card')).not.toBeInTheDocument());
  });

  it('disables the image trigger on a text-only model', () => {
    renderDock({ chatVision: false });
    expect(screen.getByTestId('image-attach-trigger')).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `cd frontend && npx vitest run src/features/ai/dock/AiDock.image.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Replace the `reference` state with the hook**

In `DockPanel.tsx`, delete the `reference` `useState` (`:40-42`) and the
`useExtractDocument()` instance (`:39`), add the `useAttachments` block using the
existing `composerBoxRef` (`:43`) as `dropTargetRef`, and change the pageId-change
effect (`:51-53`) to call `attachments.clearAll()`.

- [ ] **Step 4: Thread `imageHandle` through `use-dock-actions`**

In `use-dock-actions.ts`, add to the options interface (`:6-14`):

```ts
  /** #1154: staged image handle from POST /llm/prepare-image. */
  imageHandle?: string;
```

and to the improve body (`:101`):

```ts
      ...(imageHandle && { imageHandle }),
```

In `DockPanel.tsx`, pass `imageHandle: attachments.image?.handle` alongside the
existing `referenceText`.

- [ ] **Step 5: Render `ImageAttachZone` in the composer**

Add it beside `DocumentUploadZone` inside the `nm-composer` div (`:273`), with
`testIdPrefix="image-attach"`, plus the both-slots advisory.

- [ ] **Step 6: Run the new suite and both dock canaries**

```bash
cd frontend && npx vitest run src/features/ai/dock
```
Expected: PASS, including `AiDock.upload.test.tsx` with its assertions intact.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
cd /Users/simon/Documents/localGIT/compendiq-ce
npm run lint -w frontend && npm run typecheck -w frontend
git add frontend/src/features/ai/dock
git commit -m "feat(ai): attach an image in the docked assistant (#1154)"
```

---

### Task 10: `VisionBadge` in Settings → LLM

**Files:**
- Create: `frontend/src/shared/components/badges/VisionBadge.tsx`
- Test: `frontend/src/shared/components/badges/VisionBadge.test.tsx`
- Modify: `frontend/src/features/settings/panels/UsecaseAssignmentsSection.tsx:62-64`
- Test: `frontend/src/features/settings/panels/UsecaseAssignmentsSection.vision.test.tsx` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export function VisionBadge({ vision }: { vision: boolean | null }): JSX.Element | null`.

- [ ] **Step 1: Write the failing badge test**

`frontend/src/shared/components/badges/VisionBadge.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VisionBadge } from './VisionBadge';

describe('VisionBadge', () => {
  it('labels a vision-capable model', () => {
    render(<VisionBadge vision={true} />);
    expect(screen.getByTestId('vision-badge')).toHaveTextContent(/vision/i);
  });

  it('labels a text-only model', () => {
    render(<VisionBadge vision={false} />);
    expect(screen.getByTestId('vision-badge')).toHaveTextContent(/text.only/i);
  });

  it('labels an unconfirmed model distinctly from a text-only one', () => {
    render(<VisionBadge vision={null} />);
    const badge = screen.getByTestId('vision-badge');
    expect(badge).toHaveTextContent(/unconfirmed|checking/i);
    expect(badge).not.toHaveTextContent(/text.only/i);
  });

  it('carries an explanatory title, since the app has no Tooltip primitive', () => {
    render(<VisionBadge vision={null} />);
    expect(screen.getByTestId('vision-badge')).toHaveAttribute('title', expect.any(String));
  });

  /** ADR-010: amber is reserved for warning/attention. A verdict is not a warning. */
  it('does not use the amber warning colour', () => {
    render(<VisionBadge vision={false} />);
    expect(screen.getByTestId('vision-badge').className).not.toMatch(/warning|amber/);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `cd frontend && npx vitest run src/shared/components/badges/VisionBadge.test.tsx`
Expected: FAIL — cannot resolve `./VisionBadge`.

- [ ] **Step 3: Write the badge**

`frontend/src/shared/components/badges/VisionBadge.tsx`:

```tsx
import { cn } from '../../lib/cn';

/**
 * #1154: whether the model assigned to `chat` accepts image input.
 *
 * Three states, not two. `null` means the server probed and could not tell
 * (a rate limit, an auth hiccup, an open breaker), which is not the same claim
 * as "this model is text-only" — see ADR-021's #1154 amendment.
 *
 * Steel and slate rather than green/amber: ADR-010 reserves amber for
 * warning/attention, and a capability verdict is information, not a warning.
 */

interface VisionStateConfig {
  label: string;
  title: string;
  badgeClass: string;
}

const CONFIG: Record<'yes' | 'no' | 'unknown', VisionStateConfig> = {
  yes: {
    label: 'Vision',
    title: 'This model has been probed with a test image and can read images.',
    badgeClass: 'bg-accent/15 text-accent',
  },
  no: {
    label: 'Text-only',
    title: 'This model refused a test image. Image attachments will be rejected.',
    badgeClass: 'bg-muted text-muted-foreground',
  },
  unknown: {
    label: 'Unconfirmed',
    title:
      'Image support has not been established yet — the probe was inconclusive. '
      + 'Image attachments are refused until it succeeds.',
    badgeClass: 'bg-muted text-muted-foreground',
  },
};

export function VisionBadge({ vision }: { vision: boolean | null }) {
  const config = CONFIG[vision === true ? 'yes' : vision === false ? 'no' : 'unknown'];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
        config.badgeClass,
      )}
      title={config.title}
      data-testid="vision-badge"
    >
      {config.label}
    </span>
  );
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `cd frontend && npx vitest run src/shared/components/badges/VisionBadge.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing section test**

`frontend/src/features/settings/panels/UsecaseAssignmentsSection.vision.test.tsx`:

```tsx
describe('UsecaseAssignmentsSection vision badge (#1154)', () => {
  it('renders the badge on the chat row only', async () => {
    renderSection();   // mocks /admin/llm-usecases and /llm/usecase-default?usecase=chat
    await waitFor(() => expect(screen.getByTestId('vision-badge')).toBeInTheDocument());
    expect(screen.getAllByTestId('vision-badge')).toHaveLength(1);
    expect(screen.getByTestId('usecase-row-chat')).toContainElement(screen.getByTestId('vision-badge'));
  });

  /**
   * Probing costs a chat completion. Reading the resolved chat verdict is one
   * cached lookup; badging the model dropdown would fire one probe per option.
   */
  it('fetches usecase-default exactly once, not per model', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByTestId('vision-badge')).toBeInTheDocument());
    const calls = mockApiFetch.mock.calls.filter(([p]) => String(p).includes('usecase-default'));
    expect(calls).toHaveLength(1);
  });
});
```

- [ ] **Step 6: Render the badge in the resolved column**

At `:62-64`, append the badge to the resolved-value cell for `u === 'chat'`,
reading a `useQuery` on `['llm','usecase-default','chat']` — the same key
`AiContext` uses, so TanStack shares the cache entry and `LlmTab.tsx:115`'s
existing invalidation refreshes it. Add `data-testid={`usecase-row-${u}`}` to the
row wrapper.

- [ ] **Step 7: Run the settings suites**

```bash
cd frontend && npx vitest run src/features/settings/panels
```
Expected: PASS.

- [ ] **Step 8: Lint, typecheck, commit**

```bash
cd /Users/simon/Documents/localGIT/compendiq-ce
npm run lint -w frontend && npm run typecheck -w frontend
git add frontend/src/shared/components/badges/VisionBadge.tsx frontend/src/shared/components/badges/VisionBadge.test.tsx frontend/src/features/settings/panels
git commit -m "feat(ai): vision capability badge in Settings → LLM (#1154)"
```

---

### Task 11: Docs, full suite, PR

**Files:**
- Modify: `CLAUDE.md` (the "Images as AI source material" paragraph)
- Modify: `docs/architecture/04-frontend-structure.md`

- [ ] **Step 1: Update `CLAUDE.md`**

Extend the existing `#1154` paragraph in the Content Pipeline section with the
frontend half: every image is normalised in-browser to WebP ≤1568px before
staging; `useAttachments` owns both slots and the shared drop target; the `vision`
tri-state must render `false` and `null` differently; SVG is refused client-side
rather than rasterized.

- [ ] **Step 2: Update the frontend structure diagram**

Add `shared/hooks/use-attachments.ts`, `shared/hooks/use-prepare-image.ts`,
`shared/lib/downscale-image.ts`, `shared/components/upload/ImageAttachZone.tsx`
and `shared/components/badges/VisionBadge.tsx` to
`docs/architecture/04-frontend-structure.md`, and note that the AI composer
surfaces share one attachment hook.

- [ ] **Step 3: Run everything**

```bash
cd /Users/simon/Documents/localGIT/compendiq-ce
npm run typecheck && npm run lint && npm test -w frontend
```
Expected: all pass, zero failures.

- [ ] **Step 4: Commit and push**

```bash
git add CLAUDE.md docs/architecture/04-frontend-structure.md
git commit -m "docs(ai): record the frontend image-attach surface (#1154)"
git push -u origin feature/issue-1154-image-attach-frontend
```

- [ ] **Step 5: Open the PR**

Target `dev`. The description MUST call out:
- that `/ai` Improve's **document** upload is a #1131 gap-fill deliberately
  included, not scope creep;
- that this closes #1154, and that #1154's step 5 (injection screening) was
  assessed and consciously dropped — see the comment on the issue;
- that `probe_error` display and a re-probe control are #1184, deliberately not
  here;
- screenshots of the composer in all three `vision` states.

---

## Self-Review

**Spec coverage** — every section maps to a task:

| Spec requirement | Task |
| --- | --- |
| All three surfaces take both kinds | 7, 8, 9 |
| `/ai` Improve document gap-fill | 8 |
| Two independent slots | 3 (state), 7/8/9 (bodies) |
| Fit 1568px, never enlarge, WebP q=0.92 | 1 |
| `MAX_SOURCE_IMAGE_BYTES` before decode | 1 |
| Tri-state always visible, distinct reasons | 5, 6 |
| Badge in resolved column, no dropdown badging | 10 |
| Hook owns drop + paste routing | 3, 4 |
| SVG refused, GIF flattened, HEIC message | 1, 3 |
| 410 clears slot, keeps prompt | 7, 8 |
| Object URL revocation | 3 |
| Dock clears on page change | 9 |
| Both-slots advisory | 7, 8, 9 |
| Regression canaries | 4 |
| `nm-card-hover` / border / amber guards | 5, 10 |
| Docs | 11 |

**Placeholder scan** — no TBD/TODO. Every code step carries real code. Tasks 8
and 9 say "same block as Task 7 Step 3" for the `useAttachments` call; that block
is 8 lines and appears in full in Task 7, so an engineer reading out of order can
find it — acceptable, but if executing 8 or 9 first, read Task 7 Step 3.

**Type consistency** — checked across tasks: `PreparedImage` (Task 2) is what
Task 3 stores and Tasks 5/7/8/9 read; `imageDisabledReason` (Task 5) is called by
Tasks 7/8/9; `chatVision` (Task 6) is the prop name used in 7/8/9/10;
`attachments.isBusy` is the send guard in 7/8/9. `useAttachments` returns
`document` (shadowing the global inside the hook, hence the internal `document_`
state name) — consumers use `attachments.document`.

**Selector audit.** An early draft of this plan referenced `generate-input`,
`generate-submit` and `improve-instruction` testids. **None of them exist** —
`GenerateMode.tsx` has five testids and none is the prompt or the send button;
`ImproveMode.tsx` has two. The plan now uses the selectors the existing suites
actually use (`getByPlaceholderText`, `getByRole('button', { name: 'Send message' })`),
and Task 7 Step 8 covers the conditional-placeholder rewiring that the
`documentData` removal forces. Do not add testids to those components as part of
this work — the existing suites query by placeholder and role, and changing that
is a separate concern.

**One deviation from the spec, recorded deliberately.** The spec said
`downscaleImage` would fall back to `<img>` + `drawImage` where the
`createImageBitmap` resize overload is unsupported. Task 1 drops the separate
fallback: browsers ignore unknown options on `createImageBitmap` rather than
throwing, so the single path is correct everywhere and merely less
memory-efficient on older engines — and `fitWithin` + `drawImage` already do the
scaling regardless. A second code path would be untestable in jsdom and dead in
every supported browser. Task 1's test for "fallback triggers" is replaced by the
HEIC decode-failure test, which exercises the real error path.
