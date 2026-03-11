import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { attachmentRoutes } from './attachments.js';

// Mock the attachment handler
vi.mock('../services/attachment-handler.js', () => ({
  readAttachment: vi.fn(),
  fetchAndCacheAttachment: vi.fn(),
  getMimeType: vi.fn(),
}));

// Mock sync-service to provide getClientForUser
const mockGetClientForUser = vi.fn();
vi.mock('../services/sync-service.js', () => ({
  getClientForUser: (...args: unknown[]) => mockGetClientForUser(...args),
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { readAttachment, fetchAndCacheAttachment, getMimeType } from '../services/attachment-handler.js';

const mockReadAttachment = vi.mocked(readAttachment);
const mockFetchAndCacheAttachment = vi.mocked(fetchAndCacheAttachment);
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

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 404 with reason no_confluence_client when user has no PAT configured', async () => {
    mockReadAttachment.mockResolvedValue(null);
    mockGetClientForUser.mockResolvedValue(null);

    const response = await app.inject({
      method: 'GET',
      url: '/api/attachments/page-123/image.png',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ reason: 'no_confluence_client' });
    // Should not attempt on-demand fetch without a client
    expect(mockFetchAndCacheAttachment).not.toHaveBeenCalled();
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
    // Should not attempt on-demand fetch when cache hit
    expect(mockGetClientForUser).not.toHaveBeenCalled();
    expect(mockFetchAndCacheAttachment).not.toHaveBeenCalled();
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

  describe('on-demand fetch fallback', () => {
    it('should fetch from Confluence when cache misses and serve the result', async () => {
      const imageData = Buffer.from('fetched-from-confluence');
      mockReadAttachment.mockResolvedValue(null);
      mockGetClientForUser.mockResolvedValue({ /* mock client */ });
      mockFetchAndCacheAttachment.mockResolvedValue(imageData);
      mockGetMimeType.mockReturnValue('image/png');

      const response = await app.inject({
        method: 'GET',
        url: '/api/attachments/page-456/screenshot.png',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('image/png');
      expect(response.body).toBe('fetched-from-confluence');
      expect(mockFetchAndCacheAttachment).toHaveBeenCalledWith(
        expect.anything(), // the client
        'test-user',
        'page-456',
        'screenshot.png',
      );
    });

    it('should return 404 with reason not_found_in_confluence when fetch returns null', async () => {
      mockReadAttachment.mockResolvedValue(null);
      mockGetClientForUser.mockResolvedValue({ /* mock client */ });
      mockFetchAndCacheAttachment.mockResolvedValue(null);

      const response = await app.inject({
        method: 'GET',
        url: '/api/attachments/page-456/missing.png',
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ reason: 'not_found_in_confluence' });
    });

    it('should return 500 when on-demand fetch throws an error', async () => {
      mockReadAttachment.mockResolvedValue(null);
      mockGetClientForUser.mockResolvedValue({ /* mock client */ });
      mockFetchAndCacheAttachment.mockRejectedValue(new Error('Confluence unreachable'));

      const response = await app.inject({
        method: 'GET',
        url: '/api/attachments/page-456/broken.png',
      });

      expect(response.statusCode).toBe(500);
    });

    it('should return 404 with reason no_confluence_client when user has no Confluence credentials', async () => {
      mockReadAttachment.mockResolvedValue(null);
      mockGetClientForUser.mockResolvedValue(null);

      const response = await app.inject({
        method: 'GET',
        url: '/api/attachments/page-456/image.png',
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ reason: 'no_confluence_client' });
      expect(mockFetchAndCacheAttachment).not.toHaveBeenCalled();
    });
  });
});
