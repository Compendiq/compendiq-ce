import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_IMAGE_FORMATS,
  ImageHandleSchema,
  PrepareImageResponseSchema,
  GenerateRequestSchema,
  ImproveRequestSchema,
} from './llm.js';

const VALID_HANDLE = 'a'.repeat(64);

describe('SUPPORTED_IMAGE_FORMATS', () => {
  it('excludes svg so the sniffing table and UI accept list cannot drift', () => {
    expect(SUPPORTED_IMAGE_FORMATS).not.toContain('svg');
  });

  it('is exactly the four raster formats', () => {
    expect([...SUPPORTED_IMAGE_FORMATS]).toEqual(['png', 'jpeg', 'webp', 'gif']);
  });
});

describe('ImageHandleSchema', () => {
  it('accepts 64 lowercase hex chars', () => {
    expect(() => ImageHandleSchema.parse(VALID_HANDLE)).not.toThrow();
  });

  it('rejects a wrong-length hex string', () => {
    expect(() => ImageHandleSchema.parse('a'.repeat(63))).toThrow();
  });

  it('rejects uppercase hex', () => {
    expect(() => ImageHandleSchema.parse('A'.repeat(64))).toThrow();
  });

  // The handle is interpolated into `llm:img:<userId>:<sha256>`. These are the
  // key-injection cases, not stylistic ones.
  it.each([':', '*', '/', '\n', ' '])('rejects a handle containing %j', (ch) => {
    expect(() => ImageHandleSchema.parse('a'.repeat(63) + ch)).toThrow();
  });
});

describe('PrepareImageResponseSchema', () => {
  it('accepts a well-formed response', () => {
    expect(() => PrepareImageResponseSchema.parse({
      format: 'png', handle: VALID_HANDLE, width: 800, height: 600, fileSize: 1234,
    })).not.toThrow();
  });

  it('rejects svg as a format', () => {
    expect(() => PrepareImageResponseSchema.parse({
      format: 'svg', handle: VALID_HANDLE, width: 8, height: 8, fileSize: 1,
    })).toThrow();
  });

  it('rejects zero or negative dimensions', () => {
    expect(() => PrepareImageResponseSchema.parse({
      format: 'png', handle: VALID_HANDLE, width: 0, height: 600, fileSize: 1,
    })).toThrow();
  });
});

describe('imageHandle on request schemas', () => {
  it('is optional on GenerateRequestSchema', () => {
    expect(() => GenerateRequestSchema.parse({ prompt: 'hi' })).not.toThrow();
  });

  it('is accepted on GenerateRequestSchema', () => {
    const parsed = GenerateRequestSchema.parse({ prompt: 'hi', imageHandle: VALID_HANDLE });
    expect(parsed.imageHandle).toBe(VALID_HANDLE);
  });

  it('rejects a malformed handle on ImproveRequestSchema', () => {
    expect(() => ImproveRequestSchema.parse({
      content: 'x', type: 'clarity', imageHandle: 'nope',
    })).toThrow();
  });
});
