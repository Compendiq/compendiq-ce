/**
 * HTTP route-level tests for /api/local-attachments (#302 Gap 4).
 *
 * The service layer (`local-attachment-service.ts`) is covered separately
 * against real Postgres. These tests focus on the route-specific logic that
 * sits in front of the service:
 *
 *   - dataUri parsing + MIME allowlist (`decodeDataUri`)
 *   - in-handler 413 branch (needs `bodyLimit` option on the route)
 *   - Zod + custom error → HTTP status mapping
 *   - SVG Content-Security-Policy + content-disposition hardening
 *   - XML sibling filename transform + failure surfacing
 *   - bodyLimit option actually raising Fastify's 1 MB default
 *
 * The service module is fully mocked — we're not testing DB writes here,
 * we're testing the HTTP shell around them.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';

// Mock the service layer before importing the routes so the `import` of
// the route module picks up the mocks. We use `vi.hoisted` so the mock
// fns are available both inside the factory and in the test body.
const serviceMocks = vi.hoisted(() => ({
  putLocalAttachment: vi.fn(),
  getLocalAttachment: vi.fn(),
  listLocalAttachments: vi.fn(),
}));

vi.mock('../../core/services/local-attachment-service.js', async () => {
  // Re-export the real `LocalAttachmentError` + constant so `instanceof`
  // checks in the route still work; only swap out the side-effecting fns.
  const actual = await vi.importActual<
    typeof import('../../core/services/local-attachment-service.js')
  >('../../core/services/local-attachment-service.js');
  return {
    ...actual,
    putLocalAttachment: serviceMocks.putLocalAttachment,
    getLocalAttachment: serviceMocks.getLocalAttachment,
    listLocalAttachments: serviceMocks.listLocalAttachments,
  };
});

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { localAttachmentsRoutes } from './local-attachments.js';
import { LocalAttachmentError } from '../../core/services/local-attachment-service.js';

/** Smallest valid PNG (1×1 transparent). */
const VALID_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const VALID_PNG_DATA_URI = `data:image/png;base64,${VALID_PNG_B64}`;

// 100-byte SVG
const VALID_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
const VALID_SVG_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(VALID_SVG).toString('base64')}`;

describe('Local Attachment Routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) {
        reply.status(400).send({
          error: 'ValidationError',
          message: error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
          statusCode: 400,
        });
        return;
      }
      reply.status(error.statusCode ?? 500).send({
        error: error.message,
        statusCode: error.statusCode ?? 500,
      });
    });

    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = 'test-user-id';
    });
    app.decorateRequest('userId', '');

    await app.register(localAttachmentsRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── dataUri parsing ────────────────────────────────────────────────────

  it('accepts a valid image/png data URI', async () => {
    serviceMocks.putLocalAttachment.mockResolvedValueOnce({
      id: 1,
      pageId: 42,
      filename: 'diagram.png',
      contentType: 'image/png',
      sizeBytes: 70,
      sha256: 'abc',
      createdBy: 'test-user-id',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/local-attachments/42/diagram.png',
      payload: { dataUri: VALID_PNG_DATA_URI },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.filename).toBe('diagram.png');
    expect(serviceMocks.putLocalAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: 42,
        filename: 'diagram.png',
        contentType: 'image/png',
        userId: 'test-user-id',
      }),
    );
  });

  it('accepts a valid image/svg+xml data URI', async () => {
    serviceMocks.putLocalAttachment.mockResolvedValueOnce({
      id: 2,
      pageId: 42,
      filename: 'vec.svg',
      contentType: 'image/svg+xml',
      sizeBytes: VALID_SVG.length,
      sha256: 'sha',
      createdBy: 'test-user-id',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/local-attachments/42/vec.svg',
      payload: { dataUri: VALID_SVG_DATA_URI },
    });

    expect(res.statusCode).toBe(200);
    // The service received the correct MIME through from the data URI.
    expect(serviceMocks.putLocalAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'image/svg+xml' }),
    );
  });

  it('rejects a non-data-URI string with 400 BAD_DATA_URI', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/local-attachments/42/diagram.png',
      payload: { dataUri: 'https://evil.example/img.png' },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('BAD_DATA_URI');
    expect(serviceMocks.putLocalAttachment).not.toHaveBeenCalled();
  });

  it('rejects a data URI with an invalid MIME shape', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/local-attachments/42/diagram.png',
      payload: { dataUri: 'data:not-a-mime;base64,AAAA' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BAD_DATA_URI');
    expect(serviceMocks.putLocalAttachment).not.toHaveBeenCalled();
  });

  // ── GET one: SVG response hardening ────────────────────────────────────

  it('sets CSP sandbox + content-disposition=attachment on SVG responses', async () => {
    serviceMocks.getLocalAttachment.mockResolvedValueOnce({
      data: Buffer.from(VALID_SVG),
      record: {
        id: 3,
        pageId: 42,
        filename: 'vec.svg',
        contentType: 'image/svg+xml',
        sizeBytes: VALID_SVG.length,
        sha256: 'sha',
        createdBy: 'test-user-id',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/local-attachments/42/vec.svg',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('svg');
    expect(res.headers['content-disposition']).toBe('attachment');
    expect(res.headers['content-security-policy']).toBe('sandbox');
  });

  it('sets content-disposition=inline on non-SVG responses (no CSP)', async () => {
    serviceMocks.getLocalAttachment.mockResolvedValueOnce({
      data: Buffer.from(VALID_PNG_B64, 'base64'),
      record: {
        id: 4,
        pageId: 42,
        filename: 'diagram.png',
        contentType: 'image/png',
        sizeBytes: 70,
        sha256: 'sha',
        createdBy: 'test-user-id',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/local-attachments/42/diagram.png',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('png');
    expect(res.headers['content-disposition']).toBe('inline');
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  // ── XML sibling: filename transform + write ────────────────────────────

  it('writes the XML sibling under the matching .drawio filename', async () => {
    serviceMocks.putLocalAttachment
      .mockResolvedValueOnce({
        id: 5,
        pageId: 42,
        filename: 'diagram.png',
        contentType: 'image/png',
        sizeBytes: 70,
        sha256: 'png-sha',
        createdBy: 'test-user-id',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .mockResolvedValueOnce({
        id: 6,
        pageId: 42,
        filename: 'diagram.drawio',
        contentType: 'application/xml',
        sizeBytes: 12,
        sha256: 'xml-sha',
        createdBy: 'test-user-id',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/local-attachments/42/diagram.png',
      payload: { dataUri: VALID_PNG_DATA_URI, xml: '<mxfile/>' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.xmlFilename).toBe('diagram.drawio');
    expect(body.xmlSize).toBe(12);

    // Second call writes the XML as application/xml under .drawio
    expect(serviceMocks.putLocalAttachment).toHaveBeenCalledTimes(2);
    expect(serviceMocks.putLocalAttachment).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        pageId: 42,
        filename: 'diagram.drawio',
        contentType: 'application/xml',
      }),
    );
  });

  it('returns xmlWriteFailed + success=false when XML sibling write throws', async () => {
    serviceMocks.putLocalAttachment
      .mockResolvedValueOnce({
        id: 7,
        pageId: 42,
        filename: 'diagram.png',
        contentType: 'image/png',
        sizeBytes: 70,
        sha256: 'png-sha',
        createdBy: 'test-user-id',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      // XML sibling write fails (e.g. disk full, DB constraint)
      .mockRejectedValueOnce(new Error('disk full'));

    const res = await app.inject({
      method: 'PUT',
      url: '/api/local-attachments/42/diagram.png',
      payload: { dataUri: VALID_PNG_DATA_URI, xml: '<mxfile/>' },
    });

    // Route returns 200 (PNG was persisted) but flags the failure loudly.
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Not a bare success — this was the bug.
    expect(body.success).toBe(false);
    expect(body.xmlWriteFailed).toBe(true);
    expect(body.xmlWriteError).toBe('disk full');
    expect(body.xmlFilename).toBeUndefined();
  });

  it('preserves LocalAttachmentError code in xmlWriteError', async () => {
    serviceMocks.putLocalAttachment
      .mockResolvedValueOnce({
        id: 8,
        pageId: 42,
        filename: 'diagram.png',
        contentType: 'image/png',
        sizeBytes: 70,
        sha256: 'png-sha',
        createdBy: 'test-user-id',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .mockRejectedValueOnce(new LocalAttachmentError('INVALID_FILENAME', 'bad xml name'));

    const res = await app.inject({
      method: 'PUT',
      url: '/api/local-attachments/42/diagram.png',
      payload: { dataUri: VALID_PNG_DATA_URI, xml: '<mxfile/>' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.xmlWriteFailed).toBe(true);
    expect(body.xmlWriteError).toBe('INVALID_FILENAME');
  });

  // ── error → status mapping ─────────────────────────────────────────────

  it('maps service FORBIDDEN → 403', async () => {
    serviceMocks.putLocalAttachment.mockRejectedValueOnce(
      new LocalAttachmentError('FORBIDDEN', 'no access'),
    );

    const res = await app.inject({
      method: 'PUT',
      url: '/api/local-attachments/42/diagram.png',
      payload: { dataUri: VALID_PNG_DATA_URI },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('FORBIDDEN');
  });

  it('maps service PAGE_NOT_FOUND → 404', async () => {
    serviceMocks.listLocalAttachments.mockRejectedValueOnce(
      new LocalAttachmentError('PAGE_NOT_FOUND', 'missing'),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/local-attachments/9999/list',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('PAGE_NOT_FOUND');
  });

  it('maps service TOO_LARGE → 413', async () => {
    serviceMocks.putLocalAttachment.mockRejectedValueOnce(
      new LocalAttachmentError('TOO_LARGE', 'over cap'),
    );

    const res = await app.inject({
      method: 'PUT',
      url: '/api/local-attachments/42/diagram.png',
      payload: { dataUri: VALID_PNG_DATA_URI },
    });

    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('TOO_LARGE');
  });

  it('maps service INVALID_FILENAME → 400', async () => {
    serviceMocks.putLocalAttachment.mockRejectedValueOnce(
      new LocalAttachmentError('INVALID_FILENAME', 'bad'),
    );

    const res = await app.inject({
      method: 'PUT',
      url: '/api/local-attachments/42/diagram.png',
      payload: { dataUri: VALID_PNG_DATA_URI },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_FILENAME');
  });

  it('returns 404 on GET when service throws NOT_FOUND', async () => {
    serviceMocks.getLocalAttachment.mockRejectedValueOnce(
      new LocalAttachmentError('NOT_FOUND', 'missing'),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/local-attachments/42/missing.png',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('NOT_FOUND');
  });

  // ── bodyLimit: the 25 MB Zod cap is only reachable when the route
  //    option raises Fastify's 1 MB default. A 2 MB payload proves the
  //    cap has been lifted above the default. ─────────────────────────

  it('accepts a payload above Fastify\'s 1 MB default (bodyLimit raised)', async () => {
    // 2 MiB of raw bytes → ~2.67 MiB when base64-encoded, well above the
    // 1 MB default Fastify body limit but below the 25 MB service cap.
    const twoMB = Buffer.alloc(2 * 1024 * 1024, 0x41);
    const largeDataUri = `data:image/png;base64,${twoMB.toString('base64')}`;

    serviceMocks.putLocalAttachment.mockResolvedValueOnce({
      id: 99,
      pageId: 42,
      filename: 'big.png',
      contentType: 'image/png',
      sizeBytes: twoMB.length,
      sha256: 'big-sha',
      createdBy: 'test-user-id',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/local-attachments/42/big.png',
      payload: { dataUri: largeDataUri },
    });

    // Without the per-route `bodyLimit` option, Fastify would reject this
    // with a generic 413 before the handler ever runs. The fact that the
    // handler succeeds proves the cap has been raised to at least 2 MB.
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  // ── list endpoint sanity ───────────────────────────────────────────────

  it('lists attachments with URL-encoded filenames', async () => {
    serviceMocks.listLocalAttachments.mockResolvedValueOnce([
      {
        id: 1,
        pageId: 42,
        filename: 'diagram with spaces.png',
        contentType: 'image/png',
        sizeBytes: 123,
        sha256: 'sha',
        createdBy: 'test-user-id',
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-02'),
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/local-attachments/42/list',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0].url).toBe('/api/local-attachments/42/diagram%20with%20spaces.png');
    expect(body.attachments[0].size).toBe(123);
  });
});
