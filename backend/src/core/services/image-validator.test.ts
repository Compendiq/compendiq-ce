import { describe, it, expect } from 'vitest';
import {
  sniffImageFormat,
  readImageDimensions,
  validateImage,
  ImageValidationError,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_BYTES,
} from './image-validator.js';
import {
  buildPng, buildGif, buildWebpVp8x, buildJpeg, SVG_BYTES,
  REAL_PNG_40x30_BASE64, REAL_JPEG_40x30_BASE64,
  REAL_WEBP_VP8_40x30_BASE64, REAL_WEBP_VP8L_40x30_BASE64,
  REAL_GIF_40x30_BASE64,
} from './test-image-fixtures.js';

/**
 * Pinned, not derived: these two numbers are the memory contract with a shared
 * `noeviction` Redis (#1183) and with the ~1.37x base64 inflation
 * `resolveImagePart` pays per in-flight stream, so raising either is a capacity
 * decision rather than a tweak. See ADR-021's `#1154` amendment.
 */
describe('ceilings', () => {
  it('caps a staged image at 5 MB', () => {
    expect(MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024);
  });

  /**
   * The dimension cap does NOT move with the byte cap. Dimensions bound what
   * the model is asked to look at; bytes bound what Redis holds, and only the
   * bytes are a memory ceiling. 4096 stays reachable in the formats the feature
   * actually uses (a 4096x4096 WebP or JPEG is comfortably under 5 MB) — it is
   * lossless PNG at full dimensions that hits the byte cap first, which the
   * 413 answers by naming re-encoding as the remedy.
   */
  it('caps each edge at 4096', () => {
    expect(MAX_IMAGE_DIMENSION).toBe(4096);
  });
});

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
   * Defence in depth: the route's multipart limit answers 413 first, so this
   * only fires for a new caller or a limit that stopped being applied — and
   * staging is what puts the bytes in a shared `noeviction` Redis.
   */
  it('rejects a buffer over the byte ceiling', () => {
    const png = buildPng(8, 8);
    const oversized = Buffer.concat([png, Buffer.alloc(MAX_IMAGE_BYTES, 0x00)]);
    try {
      validateImage(oversized, 'huge.png');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ImageValidationError);
      expect((err as ImageValidationError).kind).toBe('unprocessable');
    }
  });

  it('accepts a buffer exactly at the byte ceiling', () => {
    const png = buildPng(8, 8);
    const atLimit = Buffer.concat([png, Buffer.alloc(MAX_IMAGE_BYTES - png.length, 0x00)]);
    expect(atLimit.length).toBe(MAX_IMAGE_BYTES);
    expect(validateImage(atLimit, 'big.png').format).toBe('png');
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
 * This suite closes that gap by running the parsers against genuine
 * ImageMagick output (captured as base64 in test-image-fixtures.ts — see the
 * comment there for provenance and regeneration steps) instead of our own
 * hand-built buffers. These run unconditionally, with no `magick` dependency
 * at test time, so they provide real regression coverage in CI.
 */
describe('real encoder output (captured, not hand-built)', () => {
  const realFiles = {
    png: Buffer.from(REAL_PNG_40x30_BASE64, 'base64'),
    jpeg: Buffer.from(REAL_JPEG_40x30_BASE64, 'base64'),
    webp: Buffer.from(REAL_WEBP_VP8_40x30_BASE64, 'base64'),
    webpLossless: Buffer.from(REAL_WEBP_VP8L_40x30_BASE64, 'base64'),
    gif: Buffer.from(REAL_GIF_40x30_BASE64, 'base64'),
  } as const;

  it.each([
    ['png', 'png'],
    ['jpeg', 'jpeg'],
    ['webp', 'webp'],
    ['webpLossless', 'webp'],
    ['gif', 'gif'],
  ] as const)('sniffs the real %s file as %s', (key, expected) => {
    expect(sniffImageFormat(realFiles[key])).toBe(expected);
  });

  it('captured the lossy WebP as a VP8 chunk, not VP8X or VP8L', () => {
    expect(realFiles.webp.subarray(12, 16).toString('ascii')).toBe('VP8 ');
  });

  it('captured the lossless WebP as a VP8L chunk', () => {
    expect(realFiles.webpLossless.subarray(12, 16).toString('ascii')).toBe('VP8L');
  });

  it.each(['png', 'jpeg', 'webp', 'webpLossless', 'gif'] as const)(
    'reads 40x30 from the real %s file',
    (key) => {
      const format = sniffImageFormat(realFiles[key])!;
      expect(readImageDimensions(realFiles[key], format)).toEqual({ width: 40, height: 30 });
    },
  );

  it('accepts every real file end-to-end through validateImage', () => {
    for (const [key, buf] of Object.entries(realFiles)) {
      const format = sniffImageFormat(buf)!;
      expect(validateImage(buf, `photo-${key}.${format}`)).toEqual({
        format, width: 40, height: 30,
      });
    }
  });
});
