import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConfluenceClient, ConfluenceError } from './confluence-client.js';

// Mock undici request
vi.mock('undici', () => ({
  request: vi.fn(),
}));

// Mock ssrf-guard to allow test URLs
vi.mock('../utils/ssrf-guard.js', () => ({
  validateUrl: vi.fn(),
}));

import { request } from 'undici';

const mockRequest = vi.mocked(request);

describe('ConfluenceClient', () => {
  const baseUrl = 'https://confluence.example.com';
  const pat = 'test-pat-token';

  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.CONFLUENCE_VERIFY_SSL;
  });

  afterEach(() => {
    delete process.env.CONFLUENCE_VERIFY_SSL;
  });

  describe('SSL configuration', () => {
    it('should verify SSL by default', async () => {
      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 100, size: 0 }) },
      } as never);

      const client = new ConfluenceClient(baseUrl, pat);
      await client.getSpaces();

      const callArgs = mockRequest.mock.calls[0];
      // When verifySsl is true, connect option should NOT be set
      expect(callArgs[1]).not.toHaveProperty('connect');
    });

    it('should disable SSL verification when CONFLUENCE_VERIFY_SSL=false', async () => {
      process.env.CONFLUENCE_VERIFY_SSL = 'false';

      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 100, size: 0 }) },
      } as never);

      const client = new ConfluenceClient(baseUrl, pat);
      await client.getSpaces();

      const callArgs = mockRequest.mock.calls[0];
      expect(callArgs[1]).toHaveProperty('connect', { rejectUnauthorized: false });
    });

    it('should keep SSL verification when CONFLUENCE_VERIFY_SSL=true', async () => {
      process.env.CONFLUENCE_VERIFY_SSL = 'true';

      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 100, size: 0 }) },
      } as never);

      const client = new ConfluenceClient(baseUrl, pat);
      await client.getSpaces();

      const callArgs = mockRequest.mock.calls[0];
      expect(callArgs[1]).not.toHaveProperty('connect');
    });
  });

  describe('request headers', () => {
    it('should send Bearer PAT in Authorization header', async () => {
      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 100, size: 0 }) },
      } as never);

      const client = new ConfluenceClient(baseUrl, pat);
      await client.getSpaces();

      const callArgs = mockRequest.mock.calls[0];
      expect(callArgs[1]).toHaveProperty('headers');
      const headers = (callArgs[1] as Record<string, unknown>).headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${pat}`);
      expect(headers.Accept).toBe('application/json');
    });
  });

  describe('error handling', () => {
    it('should throw ConfluenceError with 401 for unauthorized', async () => {
      mockRequest.mockResolvedValue({
        statusCode: 401,
        body: { text: async () => 'Unauthorized' },
      } as never);

      const client = new ConfluenceClient(baseUrl, pat);
      await expect(client.getSpaces()).rejects.toThrow(ConfluenceError);
      await expect(client.getSpaces()).rejects.toThrow('Invalid or expired PAT');
    });

    it('should throw ConfluenceError with 403 for forbidden', async () => {
      mockRequest.mockResolvedValue({
        statusCode: 403,
        body: { text: async () => 'Forbidden' },
      } as never);

      const client = new ConfluenceClient(baseUrl, pat);
      await expect(client.getSpaces()).rejects.toThrow('Insufficient permissions');
    });

    it('should throw ConfluenceError with 404 for not found', async () => {
      mockRequest.mockResolvedValue({
        statusCode: 404,
        body: { text: async () => 'Not found' },
      } as never);

      const client = new ConfluenceClient(baseUrl, pat);
      await expect(client.getSpaces()).rejects.toThrow('Resource not found');
    });
  });

  describe('URL handling', () => {
    it('should strip trailing slashes from base URL', async () => {
      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 100, size: 0 }) },
      } as never);

      const client = new ConfluenceClient('https://confluence.example.com///', pat);
      await client.getSpaces();

      const callUrl = mockRequest.mock.calls[0][0] as string;
      expect(callUrl).toBe('https://confluence.example.com/rest/api/space?start=0&limit=100&type=global');
    });
  });

  describe('downloadAttachment SSL', () => {
    it('should disable SSL for downloads when CONFLUENCE_VERIFY_SSL=false', async () => {
      process.env.CONFLUENCE_VERIFY_SSL = 'false';

      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: (async function* () {
          yield Buffer.from('file-content');
        })(),
      } as never);

      const client = new ConfluenceClient(baseUrl, pat);
      await client.downloadAttachment('/download/attachments/123/file.pdf');

      const callArgs = mockRequest.mock.calls[0];
      expect(callArgs[1]).toHaveProperty('connect', { rejectUnauthorized: false });
    });
  });
});
