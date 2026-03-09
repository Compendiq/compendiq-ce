import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { attachmentRoutes } from './attachments.js';

// Mock the attachment handler
vi.mock('../services/attachment-handler.js', () => ({
  readAttachment: vi.fn(),
  getMimeType: vi.fn(),
}));

import { readAttachment, getMimeType } from '../services/attachment-handler.js';

const mockReadAttachment = vi.mocked(readAttachment);
const mockGetMimeType = vi.mocked(getMimeType);

describe('Attachment routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    // Mock authenticate decorator
    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = 'test-user';
    });

    // Add userId to request type
    app.decorateRequest('userId', '');

    await app.register(attachmentRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should return 404 when attachment not found', async () => {
    mockReadAttachment.mockResolvedValue(null);

    const response = await app.inject({
      method: 'GET',
      url: '/api/attachments/page-123/image.png',
    });

    expect(response.statusCode).toBe(404);
  });

  it('should serve PNG attachment with correct headers', async () => {
    mockReadAttachment.mockResolvedValue(Buffer.from('fake-png-data'));
    mockGetMimeType.mockReturnValue('image/png');

    const response = await app.inject({
      method: 'GET',
      url: '/api/attachments/page-123/diagram.png',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['cache-control']).toBe('public, max-age=3600');
    expect(response.headers['content-security-policy']).toBeUndefined();
    expect(response.headers['content-disposition']).toBeUndefined();
  });

  it('should add sandbox CSP and attachment disposition for SVG files', async () => {
    mockReadAttachment.mockResolvedValue(Buffer.from('<svg>test</svg>'));
    mockGetMimeType.mockReturnValue('image/svg+xml');

    const response = await app.inject({
      method: 'GET',
      url: '/api/attachments/page-123/diagram.svg',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/svg+xml');
    expect(response.headers['content-security-policy']).toBe('sandbox');
    expect(response.headers['content-disposition']).toBe('attachment');
  });

  it('should not add SVG security headers for non-SVG files', async () => {
    mockReadAttachment.mockResolvedValue(Buffer.from('fake-jpeg'));
    mockGetMimeType.mockReturnValue('image/jpeg');

    const response = await app.inject({
      method: 'GET',
      url: '/api/attachments/page-123/photo.jpg',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-security-policy']).toBeUndefined();
    expect(response.headers['content-disposition']).toBeUndefined();
  });
});
