import {
  describe, it, expect, beforeAll, afterAll,
} from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  sniffImageFormat,
  readImageDimensions,
  validateImage,
  ImageValidationError,
  MAX_IMAGE_DIMENSION,
} from './image-validator.js';
import {
  buildPng, buildGif, buildWebpVp8x, buildJpeg, SVG_BYTES,
} from './test-image-fixtures.js';

describe('sniffImageFormat', () => {
  it.each([
    ['png', buildPng(4, 4)],
    ['gif', buildGif(4, 4)],
    ['webp', buildWebpVp8x(4, 4)],
    ['jpeg', buildJpeg(4, 4)],
  ] as const)('identifies %s from its magic bytes', (expected, bytes) => {
    expect(sniffImageFormat(bytes)).toBe(expected);
  });

  it('returns null for SVG — it is not a raster format', () => {
    expect(sniffImageFormat(SVG_BYTES)).toBeNull();
  });

  it('returns null for a PDF', () => {
    expect(sniffImageFormat(Buffer.from('%PDF-1.7\n'))).toBeNull();
  });

  it('returns null for a truncated buffer', () => {
    expect(sniffImageFormat(Buffer.from([0x89, 0x50]))).toBeNull();
  });

  it('does not mistake a RIFF container that is not WEBP', () => {
    const wav = Buffer.alloc(16);
    wav.write('RIFF', 0, 'ascii');
    wav.write('WAVE', 8, 'ascii');
    expect(sniffImageFormat(wav)).toBeNull();
  });
});

describe('readImageDimensions', () => {
  it.each([
    ['png', buildPng(800, 600)],
    ['gif', buildGif(800, 600)],
    ['webp', buildWebpVp8x(800, 600)],
    ['jpeg', buildJpeg(800, 600)],
  ] as const)('reads 800x600 from %s headers', (format, bytes) => {
    expect(readImageDimensions(bytes, format)).toEqual({ width: 800, height: 600 });
  });

  it('returns null when a JPEG has no SOF marker', () => {
    expect(readImageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'jpeg')).toBeNull();
  });
});

describe('validateImage', () => {
  it('accepts a well-formed PNG', () => {
    expect(validateImage(buildPng(64, 48), 'shot.png')).toEqual({
      format: 'png', width: 64, height: 48,
    });
  });

  it('rejects SVG as an unsupported media type', () => {
    try {
      validateImage(SVG_BYTES, 'diagram.svg');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ImageValidationError);
      expect((err as ImageValidationError).kind).toBe('mediaType');
    }
  });

  /** The client's claimed extension is never trusted, but a mismatch is a 415. */
  it('rejects PNG bytes claiming a .jpg extension', () => {
    try {
      validateImage(buildPng(8, 8), 'sneaky.jpg');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ImageValidationError).kind).toBe('mediaType');
    }
  });

  it('accepts a case-insensitive extension match', () => {
    expect(validateImage(buildPng(8, 8), 'SHOT.PNG').format).toBe('png');
  });

  it('accepts bytes with no filename at all', () => {
    expect(validateImage(buildPng(8, 8), undefined).format).toBe('png');
  });

  it('treats .jpeg and .jpg as the same format', () => {
    expect(validateImage(buildJpeg(8, 8), 'a.jpeg').format).toBe('jpeg');
    expect(validateImage(buildJpeg(8, 8), 'a.jpg').format).toBe('jpeg');
  });

  /**
   * A small file can declare enormous dimensions. Rejecting on the declared
   * value means nothing ever expands server-side — we never decode pixels.
   */
  it('rejects declared dimensions above the cap', () => {
    try {
      validateImage(buildPng(MAX_IMAGE_DIMENSION + 1, 8), 'huge.png');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ImageValidationError).kind).toBe('unprocessable');
      expect((err as Error).message).toMatch(/4096/);
    }
  });

  it('rejects unreadable dimensions', () => {
    try {
      validateImage(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'broken.jpg');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ImageValidationError).kind).toBe('unprocessable');
    }
  });
});

/**
 * The fixture builders above and the parsers in image-validator.ts were
 * written together from the same spec, so a shared wrong byte offset (e.g.
 * WebP's 24-bit LE VP8X canvas fields, or JPEG's SOFn marker walk) would be
 * invisible to those tests: both sides would agree on the same wrong number.
 *
 * This suite closes that gap by running the parsers against bytes from a
 * real encoder (ImageMagick) instead of our own hand-built buffers. It's
 * generated on the fly in beforeAll rather than committed as binary fixtures,
 * and skipped outright when `magick` isn't on PATH so CI without ImageMagick
 * still passes.
 */
function hasMagick(): boolean {
  try {
    execFileSync('magick', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasMagick())('real encoder output (ImageMagick)', () => {
  let dir: string;
  const files = {} as Record<'png' | 'jpeg' | 'webp' | 'gif', Buffer>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cq-image-validator-'));
    const sources: Record<'png' | 'jpeg' | 'webp' | 'gif', string> = {
      png: 'cq-real.png', jpeg: 'cq-real.jpg', webp: 'cq-real.webp', gif: 'cq-real.gif',
    };
    for (const [format, name] of Object.entries(sources) as Array<['png' | 'jpeg' | 'webp' | 'gif', string]>) {
      const path = join(dir, name);
      execFileSync('magick', ['-size', '800x600', 'xc:red', path]);
      files[format] = readFileSync(path);
    }
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['png', 'png'],
    ['jpeg', 'jpeg'],
    ['webp', 'webp'],
    ['gif', 'gif'],
  ] as const)('sniffs a real %s file as %s', (key, expected) => {
    expect(sniffImageFormat(files[key])).toBe(expected);
  });

  it.each(['png', 'jpeg', 'webp', 'gif'] as const)(
    'reads 800x600 from a real %s file',
    (format) => {
      expect(readImageDimensions(files[format], format)).toEqual({ width: 800, height: 600 });
    },
  );

  it('accepts every real file end-to-end through validateImage', () => {
    for (const [format, buf] of Object.entries(files)) {
      expect(validateImage(buf, `photo.${format}`)).toEqual({
        format, width: 800, height: 600,
      });
    }
  });
});
