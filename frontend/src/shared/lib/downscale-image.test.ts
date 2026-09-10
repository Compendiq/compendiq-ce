import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fitWithin, MAX_IMAGE_EDGE, downscaleImage, ImageDecodeError, MAX_SOURCE_IMAGE_BYTES } from './downscale-image';

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

  it('refuses an image whose decoded pixel count exceeds the ceiling', async () => {
    stubBitmap(20000, 20000);
    await expect(downscaleImage(imageFile('bomb.png', 'image/png')))
      .rejects.toMatchObject({ reason: 'tooLarge' });
    // `toBlobArgs` staying null only proves the *encode* never ran. The point
    // of refusing here is that no second buffer is allocated at all, so assert
    // the canvas was never even created — `stubCanvas` spies `createElement`,
    // which is the allocation itself.
    expect(toBlobArgs).toBeNull();
    expect(document.createElement).not.toHaveBeenCalled();
  });

  /** Same contract for the two refusals that precede the decode. */
  it('allocates no canvas for a refused SVG or an oversized source file', async () => {
    stubBitmap(100, 100);
    await expect(downscaleImage(imageFile('d.svg', 'image/svg+xml'))).rejects.toThrow();
    await expect(
      downscaleImage(imageFile('huge.png', 'image/png', MAX_SOURCE_IMAGE_BYTES + 1)),
    ).rejects.toThrow();
    expect(document.createElement).not.toHaveBeenCalled();
  });

  it('accepts an 8K screenshot, which is under the pixel ceiling', async () => {
    stubBitmap(7680, 4320);
    const result = await downscaleImage(imageFile('8k.png', 'image/png'));
    expect(result).toMatchObject({ width: 1568, height: 882 });
  });
});
