import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetVisionCapability = vi.fn();
vi.mock('../../domains/llm/services/model-capabilities.js', () => ({
  getVisionCapability: (...args: unknown[]) => mockGetVisionCapability(...args),
}));

const mockLoadStagedImage = vi.fn();
vi.mock('../../core/services/image-staging.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/services/image-staging.js')>();
  return {
    ...actual,
    loadStagedImage: (...args: unknown[]) => mockLoadStagedImage(...args),
  };
});

import { resolveImagePart } from './_helpers.js';
import { ImageStagingUnavailableError } from '../../core/services/image-staging.js';

const HANDLE = 'a'.repeat(64);

/** Minimal stand-in for the httpErrors decorator the routes rely on. */
class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const fastify = {
  httpErrors: {
    unprocessableEntity: (m: string) => new HttpError(422, m),
    gone: (m: string) => new HttpError(410, m),
    serviceUnavailable: (m: string) => new HttpError(503, m),
  },
} as never;

beforeEach(() => {
  mockGetVisionCapability.mockReset().mockResolvedValue(true);
  mockLoadStagedImage.mockReset().mockResolvedValue({
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), format: 'png',
  });
});

describe('resolveImagePart', () => {
  it('returns an image_url part with a data URI of the staged bytes', async () => {
    const { part } = await resolveImagePart(fastify, 'u1', HANDLE, 'p1', 'qwen2.5vl');
    expect(part.type).toBe('image_url');
    expect((part as { image_url: { url: string } }).image_url.url)
      .toBe(`data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`);
  });

  it('returns the handle as the cache hash', async () => {
    const { hash } = await resolveImagePart(fastify, 'u1', HANDLE, 'p1', 'm');
    expect(hash).toBe(HANDLE);
  });

  it('uses the staged format in the data URI, not the extension', async () => {
    mockLoadStagedImage.mockResolvedValue({ bytes: Buffer.from([0xff]), format: 'webp' });
    const { part } = await resolveImagePart(fastify, 'u1', HANDLE, 'p1', 'm');
    expect((part as { image_url: { url: string } }).image_url.url).toMatch(/^data:image\/webp;/);
  });

  it('throws 422 when the model is text-only', async () => {
    mockGetVisionCapability.mockResolvedValue(false);
    await expect(resolveImagePart(fastify, 'u1', HANDLE, 'p1', 'llama3.1'))
      .rejects.toMatchObject({ status: 422 });
  });

  /** Fail closed: unknown is refused, not attempted. */
  it('throws 422 when capability is unknown', async () => {
    mockGetVisionCapability.mockResolvedValue(null);
    await expect(resolveImagePart(fastify, 'u1', HANDLE, 'p1', 'm'))
      .rejects.toMatchObject({ status: 422 });
  });

  /**
   * `null` is "not established", not "established as no". Reusing the
   * text-only wording would assert something the server never checked.
   */
  it('distinguishes an unconfirmed model from a known text-only one', async () => {
    mockGetVisionCapability.mockResolvedValue(null);
    const unknown = await resolveImagePart(fastify, 'u1', HANDLE, 'p1', 'm').catch((e: Error) => e);
    mockGetVisionCapability.mockResolvedValue(false);
    const textOnly = await resolveImagePart(fastify, 'u1', HANDLE, 'p1', 'm').catch((e: Error) => e);

    expect((unknown as Error).message).not.toBe((textOnly as Error).message);
    expect((unknown as Error).message).toMatch(/not been confirmed/i);
    expect((unknown as Error).message).not.toMatch(/cannot accept images/i);
    expect((textOnly as Error).message).toMatch(/cannot accept images/i);
  });

  it('names the offending model in the 422 message', async () => {
    mockGetVisionCapability.mockResolvedValue(false);
    await expect(resolveImagePart(fastify, 'u1', HANDLE, 'p1', 'llama3.1'))
      .rejects.toThrow(/llama3\.1/);
  });

  it('does not load the image when the gate refuses', async () => {
    mockGetVisionCapability.mockResolvedValue(false);
    await resolveImagePart(fastify, 'u1', HANDLE, 'p1', 'm').catch(() => {});
    expect(mockLoadStagedImage).not.toHaveBeenCalled();
  });

  it('throws 410 when the handle has expired', async () => {
    mockLoadStagedImage.mockResolvedValue(null);
    await expect(resolveImagePart(fastify, 'u1', HANDLE, 'p1', 'm'))
      .rejects.toMatchObject({ status: 410 });
  });

  /**
   * Redis being down is not an expiry — a 410 would tell the user to
   * re-attach, and the re-attach would 503 on the staging route anyway.
   */
  it('throws 503, not 410, when the staging store is unreachable', async () => {
    mockLoadStagedImage.mockRejectedValue(new ImageStagingUnavailableError());
    await expect(resolveImagePart(fastify, 'u1', HANDLE, 'p1', 'm'))
      .rejects.toMatchObject({ status: 503 });
  });

  it('does not swallow an unexpected staging error', async () => {
    mockLoadStagedImage.mockRejectedValue(new Error('boom'));
    await expect(resolveImagePart(fastify, 'u1', HANDLE, 'p1', 'm'))
      .rejects.toThrow('boom');
  });

  it('scopes the staged lookup to the calling user', async () => {
    await resolveImagePart(fastify, 'u7', HANDLE, 'p1', 'm');
    expect(mockLoadStagedImage).toHaveBeenCalledWith('u7', HANDLE);
  });
});
