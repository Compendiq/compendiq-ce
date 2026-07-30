import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import multipart from '@fastify/multipart';

const mockLogAuditEvent = vi.fn();
vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../core/services/rate-limit-service.js', () => ({
  getRateLimits: async () => ({ llmEmbedding: { max: 1000 } }),
}));

const mockStageImage = vi.fn();
vi.mock('../../core/services/image-staging.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/services/image-staging.js')>();
  return { ...actual, stageImage: (...args: unknown[]) => mockStageImage(...args) };
});

import { prepareImageRoutes } from './prepare-image.js';
import { createMultipartPayload } from '../../core/services/test-document-fixtures.js';
import { buildPng, buildJpeg, SVG_BYTES } from '../../core/services/test-image-fixtures.js';
import { ImageStagingUnavailableError } from '../../core/services/image-staging.js';
import { MAX_IMAGE_BYTES } from '../../core/services/image-validator.js';

const HANDLE = 'a'.repeat(64);

async function startApp() {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  // Mirrors app.ts's global registration, which is deliberately looser than the
  // image route's own per-request limit (the document path shares this plugin).
  await app.register(multipart, {
    limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 0 },
  });
  app.decorate('authenticate', async () => {});
  app.decorateRequest('userId', '');
  app.addHook('onRequest', async (req) => { (req as { userId: string }).userId = 'u1'; });
  await app.register(prepareImageRoutes);
  await app.ready();
  return app;
}

async function post(app: Awaited<ReturnType<typeof startApp>>, filename: string, content: Buffer) {
  const { body, boundary } = createMultipartPayload(filename, content);
  return app.inject({
    method: 'POST',
    url: '/llm/prepare-image',
    payload: body,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
}

beforeEach(() => {
  mockStageImage.mockReset().mockResolvedValue(HANDLE);
  mockLogAuditEvent.mockReset();
});

describe('POST /llm/prepare-image', () => {
  it('accepts a PNG and returns the handle with sniffed metadata', async () => {
    const app = await startApp();
    const res = await post(app, 'shot.png', buildPng(800, 600));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      handle: HANDLE, format: 'png', width: 800, height: 600,
      fileSize: buildPng(800, 600).length,
    });
  });

  it('accepts a JPEG', async () => {
    const app = await startApp();
    const res = await post(app, 'photo.jpg', buildJpeg(64, 48));
    expect(res.statusCode).toBe(200);
    expect(res.json().format).toBe('jpeg');
  });

  it('refuses SVG with 415', async () => {
    const app = await startApp();
    const res = await post(app, 'diagram.svg', SVG_BYTES);
    expect(res.statusCode).toBe(415);
  });

  it('refuses a PDF with 415', async () => {
    const app = await startApp();
    const res = await post(app, 'doc.pdf', Buffer.from('%PDF-1.7\n'));
    expect(res.statusCode).toBe(415);
  });

  it('refuses PNG bytes claiming .jpg with 415', async () => {
    const app = await startApp();
    const res = await post(app, 'sneaky.jpg', buildPng(8, 8));
    expect(res.statusCode).toBe(415);
  });

  it('refuses oversized dimensions with 422', async () => {
    const app = await startApp();
    const res = await post(app, 'huge.png', buildPng(5000, 10));
    expect(res.statusCode).toBe(422);
  });

  it('returns 400 when no file is uploaded', async () => {
    const app = await startApp();
    const res = await app.inject({
      method: 'POST', url: '/llm/prepare-image',
      payload: '', headers: { 'content-type': 'multipart/form-data; boundary=x' },
    });
    expect(res.statusCode).toBe(400);
  });

  /**
   * The multipart stream is capped at `MAX_IMAGE_BYTES`, so an oversized upload
   * is truncated rather than buffered whole — the point being that the process
   * never holds more than the ceiling regardless of what the client sends.
   */
  it('returns 413 for an upload over the byte ceiling and never stages it', async () => {
    const app = await startApp();
    const oversized = Buffer.concat([buildPng(8, 8), Buffer.alloc(MAX_IMAGE_BYTES + 1024, 0x00)]);
    const res = await post(app, 'huge.png', oversized);
    expect(res.statusCode).toBe(413);
    expect(mockStageImage).not.toHaveBeenCalled();
  });

  it('returns 503 when staging is unavailable', async () => {
    mockStageImage.mockRejectedValue(new ImageStagingUnavailableError());
    const app = await startApp();
    const res = await post(app, 'shot.png', buildPng(8, 8));
    expect(res.statusCode).toBe(503);
  });

  it('audits a successful staging without logging bytes', async () => {
    const app = await startApp();
    await post(app, 'shot.png', buildPng(8, 8));

    const [, action, , , meta] = mockLogAuditEvent.mock.calls[0]!;
    expect(action).toBe('IMAGE_PREPARED');
    expect(meta).toMatchObject({ format: 'png', width: 8, height: 8 });
    expect(JSON.stringify(meta)).not.toContain('base64');
  });
});
