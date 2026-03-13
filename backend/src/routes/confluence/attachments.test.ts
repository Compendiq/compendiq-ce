import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { attachmentRoutes } from './attachments.js';

// Mock the attachment handler
vi.mock('../../domains/confluence/services/attachment-handler.js', () => ({
  readAttachment: vi.fn(),
  fetchAndCachePageImage: vi.fn(),
  getMimeType: vi.fn(),
  writeAttachmentCache: vi.fn(),
}));

const mockQuery = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

// Mock sync-service to provide getClientForUser
const mockGetClientForUser = vi.fn();
vi.mock('../../domains/confluence/services/sync-service.js', () => ({
  getClientForUser: (...args: unknown[]) => mockGetClientForUser(...args),
}));

// Mock logger
vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { readAttachment, fetchAndCachePageImage, getMimeType, writeAttachmentCache } from '../../domains/confluence/services/attachment-handler.js';

const mockReadAttachment = vi.mocked(readAttachment);
const mockFetchAndCachePageImage = vi.mocked(fetchAndCachePageImage);
const mockGetMimeType = vi.mocked(getMimeType);
const mockWriteAttachmentCache = vi.mocked(writeAttachmentCache);

// Valid 1x1 transparent PNG (smallest valid PNG file)
const VALID_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const VALID_PNG_DATA_URI = `data:image/png;base64,${VALID_PNG_BASE64}`;

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
    mockQuery.mockResolvedValue({
      rows: [{ body_storage: '<ac:image><ri:attachment ri:filename="screenshot.png" /></ac:image>', space_key: 'OPS' }],
    });
  });

  it('should return 404 when the page is not in the user selected spaces', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'GET',
      url: '/api/attachments/page-123/image.png',
    });

    expect(response.statusCode).toBe(404);
    expect(mockReadAttachment).not.toHaveBeenCalled();
    expect(mockGetClientForUser).not.toHaveBeenCalled();
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
    expect(mockFetchAndCachePageImage).not.toHaveBeenCalled();
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
    expect(mockFetchAndCachePageImage).not.toHaveBeenCalled();
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
      mockFetchAndCachePageImage.mockResolvedValue(imageData);
      mockGetMimeType.mockReturnValue('image/png');

      const response = await app.inject({
        method: 'GET',
        url: '/api/attachments/page-456/screenshot.png',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('image/png');
      expect(response.body).toBe('fetched-from-confluence');
      expect(mockFetchAndCachePageImage).toHaveBeenCalledWith(
        expect.anything(), // the client
        'test-user',
        'page-456',
        'screenshot.png',
        '<ac:image><ri:attachment ri:filename="screenshot.png" /></ac:image>',
        'OPS',
      );
    });

    it('should return 404 with reason not_found_in_confluence when fetch returns null', async () => {
      mockReadAttachment.mockResolvedValue(null);
      mockGetClientForUser.mockResolvedValue({ /* mock client */ });
      mockFetchAndCachePageImage.mockResolvedValue(null);

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
      mockFetchAndCachePageImage.mockRejectedValue(new Error('Confluence unreachable'));

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
      expect(mockFetchAndCachePageImage).not.toHaveBeenCalled();
    });
  });

  describe('PUT /api/attachments/:pageId/:filename', () => {
    const mockClient = {
      updateAttachment: vi.fn().mockResolvedValue({ id: 'att-1', title: 'diagram.png' }),
    };

    it('should return 400 when dataUri is missing', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/attachments/page-123/diagram.png',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ message: expect.stringMatching(/dataUri|Invalid input/) });
    });

    it('should return 400 when dataUri is not a PNG data URI', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/attachments/page-123/diagram.png',
        payload: { dataUri: 'data:image/jpeg;base64,abc123' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ message: expect.stringContaining('PNG') });
    });

    it('should return 400 when PNG data is not valid PNG', async () => {
      // Valid base64 but not a PNG file
      const notPngBase64 = Buffer.from('not a png file at all').toString('base64');
      const response = await app.inject({
        method: 'PUT',
        url: '/api/attachments/page-123/diagram.png',
        payload: { dataUri: `data:image/png;base64,${notPngBase64}` },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ message: expect.stringContaining('valid PNG') });
    });

    it('should return 404 when page is not in user selected spaces', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/attachments/page-999/diagram.png',
        payload: { dataUri: VALID_PNG_DATA_URI },
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 400 when user has no Confluence client', async () => {
      mockGetClientForUser.mockResolvedValue(null);

      const response = await app.inject({
        method: 'PUT',
        url: '/api/attachments/page-123/diagram.png',
        payload: { dataUri: VALID_PNG_DATA_URI },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ message: expect.stringContaining('PAT') });
    });

    it('should upload to Confluence and update local cache on success', async () => {
      mockGetClientForUser.mockResolvedValue(mockClient);
      mockWriteAttachmentCache.mockResolvedValue('/data/attachments/page-123/diagram.png');

      const response = await app.inject({
        method: 'PUT',
        url: '/api/attachments/page-123/diagram.png',
        payload: { dataUri: VALID_PNG_DATA_URI },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ success: true, filename: 'diagram.png' });

      // Verify Confluence upload was called
      expect(mockClient.updateAttachment).toHaveBeenCalledWith(
        'page-123',
        'diagram.png',
        expect.any(Buffer),
        'image/png',
      );

      // Verify local cache was updated
      expect(mockWriteAttachmentCache).toHaveBeenCalledWith(
        'test-user',
        'page-123',
        'diagram.png',
        expect.any(Buffer),
      );
    });

    it('should return 500 when Confluence upload fails', async () => {
      mockGetClientForUser.mockResolvedValue({
        updateAttachment: vi.fn().mockRejectedValue(new Error('Confluence down')),
      });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/attachments/page-123/diagram.png',
        payload: { dataUri: VALID_PNG_DATA_URI },
      });

      expect(response.statusCode).toBe(500);
    });
  });
});
