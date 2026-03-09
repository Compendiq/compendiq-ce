import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock undici request
vi.mock('undici', () => ({
  request: vi.fn(),
}));

// Mock ssrf-guard to allow test URLs
vi.mock('../utils/ssrf-guard.js', () => ({
  validateUrl: vi.fn(),
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// Mock tls-config — default: no custom dispatcher
const mockDispatcher = { isMockDispatcher: true };
vi.mock('../utils/tls-config.js', () => ({
  confluenceDispatcher: undefined,
  buildConnectOptions: vi.fn().mockReturnValue(undefined),
  isVerifySslEnabled: vi.fn().mockReturnValue(true),
}));

import { request } from 'undici';
import { ConfluenceClient, ConfluenceError } from './confluence-client.js';
import * as tlsConfig from '../utils/tls-config.js';

const mockRequest = vi.mocked(request);

describe('ConfluenceClient', () => {
  const baseUrl = 'https://confluence.example.com';
  const pat = 'test-pat-token';

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to no dispatcher by default
    (tlsConfig as { confluenceDispatcher: unknown }).confluenceDispatcher = undefined;
  });

  describe('TLS dispatcher', () => {
    it('should not set dispatcher when no custom TLS config', async () => {
      const client = new ConfluenceClient(baseUrl, pat);
      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 100, size: 0 }) },
      } as never);

      await client.getSpaces();

      const callArgs = mockRequest.mock.calls[0];
      expect(callArgs[1]).not.toHaveProperty('dispatcher');
    });

    it('should pass dispatcher when custom TLS config exists', async () => {
      (tlsConfig as { confluenceDispatcher: unknown }).confluenceDispatcher = mockDispatcher;

      const client = new ConfluenceClient(baseUrl, pat);
      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 100, size: 0 }) },
      } as never);

      await client.getSpaces();

      const callArgs = mockRequest.mock.calls[0];
      expect((callArgs[1] as Record<string, unknown>).dispatcher).toBe(mockDispatcher);
    });

    it('should pass dispatcher for attachment downloads', async () => {
      (tlsConfig as { confluenceDispatcher: unknown }).confluenceDispatcher = mockDispatcher;

      const client = new ConfluenceClient(baseUrl, pat);
      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: (async function* () {
          yield Buffer.from('file-content');
        })(),
      } as never);

      await client.downloadAttachment('/download/attachments/123/file.pdf');

      const callArgs = mockRequest.mock.calls[0];
      expect((callArgs[1] as Record<string, unknown>).dispatcher).toBe(mockDispatcher);
    });
  });

  describe('request headers', () => {
    it('should send Bearer PAT in Authorization header', async () => {
      const client = new ConfluenceClient(baseUrl, pat);
      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 100, size: 0 }) },
      } as never);

      await client.getSpaces();

      const callArgs = mockRequest.mock.calls[0];
      const headers = (callArgs[1] as Record<string, unknown>).headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${pat}`);
      expect(headers.Accept).toBe('application/json');
    });
  });

  describe('error handling', () => {
    it('should throw ConfluenceError with 401 for unauthorized', async () => {
      const client = new ConfluenceClient(baseUrl, pat);
      mockRequest.mockResolvedValue({
        statusCode: 401,
        body: { text: async () => 'Unauthorized' },
      } as never);

      await expect(client.getSpaces()).rejects.toThrow(ConfluenceError);
      await expect(client.getSpaces()).rejects.toThrow('Invalid or expired PAT');
    });

    it('should throw ConfluenceError with 403 for forbidden', async () => {
      const client = new ConfluenceClient(baseUrl, pat);
      mockRequest.mockResolvedValue({
        statusCode: 403,
        body: { text: async () => 'Forbidden' },
      } as never);

      await expect(client.getSpaces()).rejects.toThrow('Insufficient permissions');
    });

    it('should throw ConfluenceError with 404 for not found', async () => {
      const client = new ConfluenceClient(baseUrl, pat);
      mockRequest.mockResolvedValue({
        statusCode: 404,
        body: { text: async () => 'Not found' },
      } as never);

      await expect(client.getSpaces()).rejects.toThrow('Resource not found');
    });
  });

  describe('URL handling', () => {
    it('should strip trailing slashes from base URL', async () => {
      const client = new ConfluenceClient('https://confluence.example.com///', pat);
      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 100, size: 0 }) },
      } as never);

      await client.getSpaces();

      const callUrl = mockRequest.mock.calls[0][0] as string;
      expect(callUrl).toBe('https://confluence.example.com/rest/api/space?start=0&limit=100&type=global');
    });
  });

  describe('label management', () => {
    it('should fetch labels for a page', async () => {
      const client = new ConfluenceClient(baseUrl, pat);
      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => JSON.stringify({ results: [{ name: 'api' }, { name: 'security' }] }) },
      } as never);

      const labels = await client.getLabels('12345');

      expect(labels).toEqual(['api', 'security']);
      const callUrl = mockRequest.mock.calls[0][0] as string;
      expect(callUrl).toContain('/rest/api/content/12345/label');
    });

    it('should add labels to a page', async () => {
      const client = new ConfluenceClient(baseUrl, pat);
      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => JSON.stringify({ results: [] }) },
      } as never);

      await client.addLabels('12345', ['api', 'security']);

      const callArgs = mockRequest.mock.calls[0];
      const callUrl = callArgs[0] as string;
      const opts = callArgs[1] as Record<string, unknown>;
      expect(callUrl).toContain('/rest/api/content/12345/label');
      expect(opts.method).toBe('POST');
      expect(opts.body).toBe(JSON.stringify([
        { prefix: 'global', name: 'api' },
        { prefix: 'global', name: 'security' },
      ]));
    });

    it('should skip addLabels when labels array is empty', async () => {
      const client = new ConfluenceClient(baseUrl, pat);

      await client.addLabels('12345', []);

      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('should remove a label from a page', async () => {
      const client = new ConfluenceClient(baseUrl, pat);
      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => '{}' },
      } as never);

      await client.removeLabel('12345', 'api');

      const callArgs = mockRequest.mock.calls[0];
      const callUrl = callArgs[0] as string;
      const opts = callArgs[1] as Record<string, unknown>;
      expect(callUrl).toContain('/rest/api/content/12345/label/api');
      expect(opts.method).toBe('DELETE');
    });

    it('should set labels by computing diff', async () => {
      const client = new ConfluenceClient(baseUrl, pat);

      // First call: getLabels returns ['api', 'old-tag']
      // Second call: removeLabel for 'old-tag'
      // Third call: addLabels for ['security']
      let callCount = 0;
      mockRequest.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            statusCode: 200,
            body: { text: async () => JSON.stringify({ results: [{ name: 'api' }, { name: 'old-tag' }] }) },
          } as never;
        }
        return {
          statusCode: 200,
          body: { text: async () => '{}' },
        } as never;
      });

      await client.setLabels('12345', ['api', 'security']);

      // 1: getLabels, 2: removeLabel('old-tag'), 3: addLabels(['security'])
      expect(mockRequest).toHaveBeenCalledTimes(3);
    });
  });
});
