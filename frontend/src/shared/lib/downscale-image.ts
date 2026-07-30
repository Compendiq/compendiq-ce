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
