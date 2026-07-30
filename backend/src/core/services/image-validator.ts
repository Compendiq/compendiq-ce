import { SUPPORTED_IMAGE_FORMATS, type ImageFormat } from '@compendiq/contracts';

/**
 * #1154: image validation for AI source material.
 *
 * Deliberately dependency-free. `sharp` and `image-size` would each solve the
 * dimension read, but neither is worth a native build or a supply-chain
 * addition for four header layouts — and the server never decodes pixels, so
 * a declared-dimension bomb is refused before anything expands.
 *
 * Ceilings are lower than the document path's 20 MB: base64 inflates the
 * payload ~1.37x and the result lands in a prompt.
 */

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 4096;

export type ImageValidationErrorKind = 'mediaType' | 'unprocessable';

export class ImageValidationError extends Error {
  constructor(public readonly kind: ImageValidationErrorKind, message: string) {
    super(message);
    this.name = 'ImageValidationError';
  }
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Format from the bytes alone. Never consults a filename or Content-Type. */
export function sniffImageFormat(buf: Buffer): ImageFormat | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 6) {
    const head = buf.subarray(0, 6).toString('ascii');
    if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'webp';
  return null;
}

/** JPEG frame-header markers. Excludes 0xC4 (DHT), 0xC8 (JPG), 0xCC (DAC). */
const JPEG_SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
  let off = 2; // skip SOI
  while (off + 9 <= buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1]!;
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2;
      continue;
    }
    const segLen = buf.readUInt16BE(off + 2);
    if (JPEG_SOF.has(marker)) {
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    if (segLen < 2) return null; // malformed; refuse rather than loop
    off += 2 + segLen;
  }
  return null;
}

function webpDimensions(buf: Buffer): { width: number; height: number } | null {
  const chunk = buf.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X' && buf.length >= 30) {
    return {
      width: buf.readUIntLE(24, 3) + 1,
      height: buf.readUIntLE(27, 3) + 1,
    };
  }
  if (chunk === 'VP8L' && buf.length >= 25) {
    const bits = buf.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === 'VP8 ' && buf.length >= 30) {
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }
  return null;
}

export function readImageDimensions(
  buf: Buffer,
  format: ImageFormat,
): { width: number; height: number } | null {
  switch (format) {
    case 'png':
      if (buf.length < 24) return null;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    case 'gif':
      if (buf.length < 10) return null;
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    case 'jpeg':
      return jpegDimensions(buf);
    case 'webp':
      return webpDimensions(buf);
  }
}

const EXTENSION_TO_FORMAT: Record<string, ImageFormat> = {
  png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp', gif: 'gif',
};

export function validateImage(
  buf: Buffer,
  filename: string | undefined,
): { format: ImageFormat; width: number; height: number } {
  // Defence in depth. `prepare-image.ts` caps the multipart stream at the same
  // constant and answers 413 before this runs, so reaching here means either a
  // new caller or a limit that stopped being applied — and staging the bytes is
  // what puts them in a shared `noeviction` Redis.
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new ImageValidationError(
      'unprocessable',
      `Image is ${buf.length} bytes; the maximum is ${MAX_IMAGE_BYTES}.`,
    );
  }

  const format = sniffImageFormat(buf);
  if (!format) {
    throw new ImageValidationError(
      'mediaType',
      `Unsupported image format. Supported: ${SUPPORTED_IMAGE_FORMATS.join(', ')}. SVG is not accepted.`,
    );
  }

  // The extension never decides the format, but disagreeing with the bytes is
  // itself a signal worth refusing.
  const ext = filename?.split('.').pop()?.toLowerCase();
  if (ext && EXTENSION_TO_FORMAT[ext] && EXTENSION_TO_FORMAT[ext] !== format) {
    throw new ImageValidationError(
      'mediaType',
      `File claims .${ext} but the bytes are ${format}`,
    );
  }

  const dims = readImageDimensions(buf, format);
  if (!dims || dims.width <= 0 || dims.height <= 0) {
    throw new ImageValidationError('unprocessable', `Could not read ${format} dimensions`);
  }
  if (dims.width > MAX_IMAGE_DIMENSION || dims.height > MAX_IMAGE_DIMENSION) {
    throw new ImageValidationError(
      'unprocessable',
      `Image is ${dims.width}x${dims.height}; the maximum is ${MAX_IMAGE_DIMENSION} on each edge. Resize it and try again.`,
    );
  }
  return { format, ...dims };
}
