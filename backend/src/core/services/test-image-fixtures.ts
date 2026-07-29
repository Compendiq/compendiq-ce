import { deflateSync } from 'zlib';

/**
 * Real bytes, not stubs — the validator's whole job is byte inspection, so
 * fixtures that only look right would make every assertion meaningless. Same
 * principle as test-document-fixtures.ts.
 */

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function buildPng(width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3)); // filter byte 0 + RGB, all black
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function buildGif(width: number, height: number): Buffer {
  const buf = Buffer.alloc(13);
  buf.write('GIF89a', 0, 'ascii');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

/** WebP extended (VP8X): canvas dimensions are 24-bit LE, stored minus one. */
export function buildWebpVp8x(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf;
}

/** Minimal JPEG: SOI, then an SOF0 frame header carrying the dimensions. */
export function buildJpeg(width: number, height: number): Buffer {
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);  // SOF0
  sof.writeUInt16BE(8, 2);       // segment length
  sof[4] = 8;                    // sample precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 1;                    // component count
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}

export const SVG_BYTES = Buffer.from(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>',
  'utf8',
);

/**
 * Genuine encoder output, captured as base64 rather than committed as binary
 * files (repo policy forbids committing binaries). These exist because the
 * builders above and image-validator.ts's parsers were written from the same
 * spec — a shared wrong byte offset (WebP's 24-bit LE VP8X fields, JPEG's
 * SOFn marker walk) would be invisible to hand-built fixtures, since both
 * sides would agree on the same wrong number. Constants below are real
 * ImageMagick 7.1.2-29 (Q16-HDRI) output, decoded from files it actually
 * wrote, not assembled by hand — so they catch what the builders above can't.
 *
 * All five encode the same 40x30 canvas (deliberately non-square, so a
 * transposed width/height would fail) — `xc:red` at this size keeps every
 * constant well under 1 KB of source. The two WebP constants are separate
 * because `magick` picks a different chunk layout (VP8 vs VP8L) depending on
 * whether lossless encoding is requested, and the parser has to handle both.
 *
 * Regenerate with:
 *   magick -size 40x30 xc:red /tmp/x.png
 *   magick -size 40x30 xc:red /tmp/x.jpg
 *   magick -size 40x30 xc:red /tmp/x.webp                        # VP8  (lossy)
 *   magick -size 40x30 xc:red -define webp:lossless=true /tmp/x-lossless.webp  # VP8L
 *   magick -size 40x30 xc:red /tmp/x.gif
 * then `base64 -i /tmp/x.<ext>`.
 */
export const REAL_PNG_40x30_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACgAAAAeAQMAAABkE86eAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gcdFRUZImvuWQAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wNy0yOVQyMToyMToyNSswMDowMKZfzi0AAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDctMjlUMjE6MjE6MjUrMDA6MDDXAnaRAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA3LTI5VDIxOjIxOjI1KzAwOjAwgBdXTgAAAAxJREFUCNdjYBh6AAAAtAABXnGQvwAAAABJRU5ErkJggg==';

export const REAL_JPEG_40x30_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAeACgDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAcJ/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AnRDGqYAAAAAAAAAAAAAAAAAAD//Z';

/** VP8 (lossy) — the chunk `magick` writes by default for a plain .webp. */
export const REAL_WEBP_VP8_40x30_BASE64 =
  'UklGRk4AAABXRUJQVlA4IEIAAABQAwCdASooAB4APpFGnkslo6KhpWgAsBIJZwDO3oAAK/fDcAD+7qY//2LOWwLx//7nA/7nA/7nA/jbB+29aoAAAAA=';

/** VP8L (lossless) — a different chunk layout the parser must handle too. */
export const REAL_WEBP_VP8L_40x30_BASE64 =
  'UklGRhwAAABXRUJQVlA4TA8AAAAvJ0AHAAcQ/Y/+ByKi/wEA';

export const REAL_GIF_40x30_BASE64 =
  'R0lGODlhKAAeAPAAAP8AAAAAACH5BAAAAAAALAAAAAAoAB4AAAIhhI+py+0Po5y02ouz3rz7D4biSJbmiabqyrbuC8fyTHMFADs=';
