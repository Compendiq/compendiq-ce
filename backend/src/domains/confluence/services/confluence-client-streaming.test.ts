import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable, Writable } from 'stream';

// Mock undici request
vi.mock('undici', () => ({
  request: vi.fn(),
}));

// Mock ssrf-guard to allow test URLs
vi.mock('../../../core/utils/ssrf-guard.js', () => ({
  validateUrl: vi.fn(),
  addAllowedBaseUrl: vi.fn(),
}));

// Mock logger
vi.mock('../../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// Mock tls-config
vi.mock('../../../core/utils/tls-config.js', () => ({
  confluenceDispatcher: { isMockDispatcher: true },
  buildConnectOptions: vi.fn().mockReturnValue(undefined),
  isVerifySslEnabled: vi.fn().mockReturnValue(true),
}));

// Mock fs (createWriteStream)
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    createWriteStream: vi.fn(),
  };
});

// Mock fs/promises (unlink)
vi.mock('fs/promises', () => ({
  unlink: vi.fn().mockResolvedValue(undefined),
}));

// Mock stream/promises (pipeline)
vi.mock('stream/promises', () => ({
  pipeline: vi.fn(),
}));

import { request } from 'undici';
import { createWriteStream } from 'fs';
import { unlink } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { ConfluenceClient, ConfluenceError, AttachmentTooLargeError } from './confluence-client.js';

const mockRequest = vi.mocked(request);
const mockCreateWriteStream = vi.mocked(createWriteStream);
const mockPipeline = vi.mocked(pipeline);
const mockUnlink = vi.mocked(unlink);

describe('ConfluenceClient.downloadAttachmentToFile', () => {
  const baseUrl = 'https://confluence.example.com';
  const pat = 'test-pat-token';

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: pipeline succeeds
    mockPipeline.mockResolvedValue(undefined as never);
    // Default: createWriteStream returns a mock writable
    mockCreateWriteStream.mockReturnValue(new Writable({
      write(_chunk, _encoding, callback) { callback(); },
    }) as never);
  });

  it('should stream attachment to file on success', async () => {
    const client = new ConfluenceClient(baseUrl, pat);
    const mockBody = Readable.from([Buffer.from('file-content')]);

    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: { 'content-length': '12' },
      body: mockBody,
    } as never);

    await client.downloadAttachmentToFile('/download/attachments/123/file.pdf', '/tmp/file.pdf');

    // Verify request was made with correct URL and auth
    expect(mockRequest).toHaveBeenCalledTimes(1);
    const callUrl = mockRequest.mock.calls[0][0] as string;
    expect(callUrl).toBe('https://confluence.example.com/download/attachments/123/file.pdf');
    const callOpts = mockRequest.mock.calls[0][1] as Record<string, unknown>;
    expect((callOpts.headers as Record<string, string>).Authorization).toBe(`Bearer ${pat}`);

    // Verify createWriteStream was called with correct path
    expect(mockCreateWriteStream).toHaveBeenCalledWith('/tmp/file.pdf');

    // Verify pipeline was called (source, transform, destination)
    expect(mockPipeline).toHaveBeenCalledTimes(1);

    // Verify no cleanup was attempted (success path)
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it('should throw ConfluenceError on non-200 status code', async () => {
    const client = new ConfluenceClient(baseUrl, pat);
    const mockBody = { destroy: vi.fn() };

    mockRequest.mockResolvedValue({
      statusCode: 404,
      headers: {},
      body: mockBody,
    } as never);

    await expect(
      client.downloadAttachmentToFile('/download/attachments/123/missing.pdf', '/tmp/out.pdf'),
    ).rejects.toThrow(ConfluenceError);

    await expect(
      client.downloadAttachmentToFile('/download/attachments/123/missing.pdf', '/tmp/out.pdf'),
    ).rejects.toThrow('Failed to download attachment: HTTP 404');

    // Verify body was destroyed to release the socket
    expect(mockBody.destroy).toHaveBeenCalled();
  });

  it('should reject with AttachmentTooLargeError when Content-Length exceeds limit', async () => {
    const client = new ConfluenceClient(baseUrl, pat);
    const mockBody = { destroy: vi.fn() };
    const maxSize = 1024; // 1 KB limit

    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: { 'content-length': '2048' },
      body: mockBody,
    } as never);

    const err = await client.downloadAttachmentToFile(
      '/download/attachments/123/huge.pdf',
      '/tmp/huge.pdf',
      maxSize,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AttachmentTooLargeError);
    expect((err as AttachmentTooLargeError).actualSize).toBe(2048);
    expect((err as AttachmentTooLargeError).maxSize).toBe(1024);
    expect(mockBody.destroy).toHaveBeenCalled();

    // Should not have started streaming
    expect(mockPipeline).not.toHaveBeenCalled();
  });

  it('should clean up partial file when pipeline fails', async () => {
    const client = new ConfluenceClient(baseUrl, pat);
    const mockBody = Readable.from([Buffer.from('partial-data')]);

    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: mockBody,
    } as never);

    const pipelineError = new Error('Network interrupted');
    mockPipeline.mockRejectedValue(pipelineError);

    await expect(
      client.downloadAttachmentToFile('/download/attachments/123/file.pdf', '/tmp/partial.pdf'),
    ).rejects.toThrow('Network interrupted');

    // Verify partial file cleanup was attempted
    expect(mockUnlink).toHaveBeenCalledWith('/tmp/partial.pdf');
  });

  it('should clean up partial file when size limit exceeded during streaming', async () => {
    const client = new ConfluenceClient(baseUrl, pat);
    const mockBody = Readable.from([Buffer.from('data')]);
    const maxSize = 100;

    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {}, // No Content-Length header — size unknown upfront
      body: mockBody,
    } as never);

    // Simulate the pipeline calling the transform and exceeding size
    mockPipeline.mockImplementation(async (...args: unknown[]) => {
      // The second argument is the async generator transform
      const transform = args[1] as (source: AsyncIterable<Buffer>) => AsyncIterable<Buffer>;
      // Create a source that yields chunks exceeding maxSize
      async function* bigSource(): AsyncGenerator<Buffer> {
        yield Buffer.alloc(maxSize + 1);
      }
      // Iterate the transform to trigger the size check
      const iter = transform(bigSource());
      // Consume the iterator to trigger the size check
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of iter) { /* triggers AttachmentTooLargeError */ }
    });

    const err = await client.downloadAttachmentToFile(
      '/download/attachments/123/file.pdf',
      '/tmp/toobig.pdf',
      maxSize,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AttachmentTooLargeError);
    // Verify cleanup
    expect(mockUnlink).toHaveBeenCalledWith('/tmp/toobig.pdf');
  });

  it('should tolerate unlink failure during cleanup (file may not exist)', async () => {
    const client = new ConfluenceClient(baseUrl, pat);
    const mockBody = Readable.from([Buffer.from('data')]);

    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: mockBody,
    } as never);

    mockPipeline.mockRejectedValue(new Error('Write error'));
    mockUnlink.mockRejectedValue(new Error('ENOENT: no such file'));

    // Should still throw the original error, not the cleanup error
    await expect(
      client.downloadAttachmentToFile('/download/attachments/123/file.pdf', '/tmp/ghost.pdf'),
    ).rejects.toThrow('Write error');

    expect(mockUnlink).toHaveBeenCalledWith('/tmp/ghost.pdf');
  });

  it('should use 120-second timeout for streaming downloads', async () => {
    const client = new ConfluenceClient(baseUrl, pat);
    const mockBody = Readable.from([Buffer.from('data')]);

    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: mockBody,
    } as never);

    await client.downloadAttachmentToFile('/download/attachments/123/file.pdf', '/tmp/file.pdf');

    const callOpts = mockRequest.mock.calls[0][1] as Record<string, unknown>;
    const signal = callOpts.signal as AbortSignal;
    // AbortSignal.timeout(120_000) — just verify it exists
    expect(signal).toBeDefined();
  });

  it('should use default maxSizeBytes of 50 MB', async () => {
    const client = new ConfluenceClient(baseUrl, pat);
    const fiftyOneMB = 51 * 1024 * 1024;
    const mockBody = { destroy: vi.fn() };

    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: { 'content-length': String(fiftyOneMB) },
      body: mockBody,
    } as never);

    const err = await client.downloadAttachmentToFile(
      '/download/attachments/123/huge.bin',
      '/tmp/huge.bin',
      // No maxSizeBytes argument — use default
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AttachmentTooLargeError);
    expect((err as AttachmentTooLargeError).maxSize).toBe(50 * 1024 * 1024);
  });

  it('should allow downloads when Content-Length is within limit', async () => {
    const client = new ConfluenceClient(baseUrl, pat);
    const mockBody = Readable.from([Buffer.from('ok')]);

    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: { 'content-length': '2' },
      body: mockBody,
    } as never);

    await expect(
      client.downloadAttachmentToFile('/download/attachments/123/small.txt', '/tmp/small.txt', 1024),
    ).resolves.toBeUndefined();
  });

  it('should handle missing Content-Length header gracefully', async () => {
    const client = new ConfluenceClient(baseUrl, pat);
    const mockBody = Readable.from([Buffer.from('data-no-length')]);

    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {}, // No content-length
      body: mockBody,
    } as never);

    // Should proceed to streaming without upfront rejection
    await expect(
      client.downloadAttachmentToFile('/download/attachments/123/unknown-size.bin', '/tmp/out.bin'),
    ).resolves.toBeUndefined();

    expect(mockPipeline).toHaveBeenCalledTimes(1);
  });
});
