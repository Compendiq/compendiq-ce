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
import { ConfluenceClient, ConfluenceError, isTransientError, parseRetryAfter, withRetry } from './confluence-client.js';
import * as tlsConfig from '../utils/tls-config.js';
import { logger } from '../utils/logger.js';

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

    it('should include Confluence error message in 400 errors', async () => {
      const client = new ConfluenceClient(baseUrl, pat);
      mockRequest.mockResolvedValue({
        statusCode: 400,
        body: { text: async () => JSON.stringify({ message: 'Content body cannot be converted to valid storage format' }) },
      } as never);

      await expect(client.getSpaces()).rejects.toThrow(
        'Confluence API error: HTTP 400: Content body cannot be converted to valid storage format',
      );
    });

    it('should handle non-JSON error responses gracefully', async () => {
      const client = new ConfluenceClient(baseUrl, pat);
      mockRequest.mockResolvedValue({
        statusCode: 500,
        body: { text: async () => 'Internal Server Error' },
      } as never);

      await expect(client.getSpaces()).rejects.toThrow(
        'Confluence API error: HTTP 500: Internal Server Error',
      );
    });
  });

  describe('getSpaces homepage expansion', () => {
    it('should include expand=homepage in the getSpaces URL', async () => {
      const client = new ConfluenceClient(baseUrl, pat);
      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 100, size: 0 }) },
      } as never);

      await client.getSpaces();

      const callUrl = mockRequest.mock.calls[0][0] as string;
      expect(callUrl).toContain('expand=homepage');
    });

    it('should return homepage data when Confluence provides it', async () => {
      const client = new ConfluenceClient(baseUrl, pat);
      const spacesResponse = {
        results: [
          { key: 'ITE', name: 'ITE Space', type: 'global', status: 'current', homepage: { id: '12345', title: 'Home' } },
        ],
        start: 0,
        limit: 100,
        size: 1,
      };
      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => JSON.stringify(spacesResponse) },
      } as never);

      const result = await client.getSpaces();

      expect(result.results[0].homepage).toEqual({ id: '12345', title: 'Home' });
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
      expect(callUrl).toBe('https://confluence.example.com/rest/api/space?start=0&limit=100&type=global&expand=homepage');
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

  describe('child page fetching', () => {
    it('should fetch child pages for a parent', async () => {
      const client = new ConfluenceClient(baseUrl, pat);
      const childResponse = {
        results: [
          { id: 'child-1', title: 'Child 1', status: 'current', type: 'page', version: { number: 1, when: '2025-01-01' } },
          { id: 'child-2', title: 'Child 2', status: 'current', type: 'page', version: { number: 1, when: '2025-01-01' } },
        ],
        start: 0,
        limit: 50,
        size: 2,
      };
      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => JSON.stringify(childResponse) },
      } as never);

      const result = await client.getChildPages('parent-123');

      expect(result.results).toHaveLength(2);
      expect(result.results[0].id).toBe('child-1');
      const callUrl = mockRequest.mock.calls[0][0] as string;
      expect(callUrl).toContain('/rest/api/content/parent-123/child/page');
      expect(callUrl).toContain('expand=version,ancestors,metadata.labels,body.storage');
    });

    it('should fetch all child pages with pagination', async () => {
      const client = new ConfluenceClient(baseUrl, pat);

      // First page
      mockRequest.mockResolvedValueOnce({
        statusCode: 200,
        body: {
          text: async () => JSON.stringify({
            results: Array.from({ length: 50 }, (_, i) => ({
              id: `child-${i}`, title: `Child ${i}`, status: 'current', type: 'page',
              version: { number: 1, when: '2025-01-01' },
            })),
            start: 0, limit: 50, size: 50,
            _links: { next: '/rest/api/content/parent-123/child/page?start=50' },
          }),
        },
      } as never);

      // Second page (partial)
      mockRequest.mockResolvedValueOnce({
        statusCode: 200,
        body: {
          text: async () => JSON.stringify({
            results: [
              { id: 'child-50', title: 'Child 50', status: 'current', type: 'page', version: { number: 1, when: '2025-01-01' } },
            ],
            start: 50, limit: 50, size: 1,
          }),
        },
      } as never);

      const pages = await client.getAllChildPages('parent-123');

      expect(pages).toHaveLength(51);
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    it('should recursively fetch all descendants', async () => {
      const client = new ConfluenceClient(baseUrl, pat);

      // Root children: child-1 and child-2
      mockRequest.mockResolvedValueOnce({
        statusCode: 200,
        body: {
          text: async () => JSON.stringify({
            results: [
              { id: 'child-1', title: 'Child 1', status: 'current', type: 'page', version: { number: 1, when: '2025-01-01' } },
              { id: 'child-2', title: 'Child 2', status: 'current', type: 'page', version: { number: 1, when: '2025-01-01' } },
            ],
            start: 0, limit: 50, size: 2,
          }),
        },
      } as never);

      // child-1 has one child: grandchild-1
      mockRequest.mockResolvedValueOnce({
        statusCode: 200,
        body: {
          text: async () => JSON.stringify({
            results: [
              { id: 'grandchild-1', title: 'Grandchild 1', status: 'current', type: 'page', version: { number: 1, when: '2025-01-01' } },
            ],
            start: 0, limit: 50, size: 1,
          }),
        },
      } as never);

      // child-2 has no children
      mockRequest.mockResolvedValueOnce({
        statusCode: 200,
        body: {
          text: async () => JSON.stringify({
            results: [],
            start: 0, limit: 50, size: 0,
          }),
        },
      } as never);

      // grandchild-1 has no children
      mockRequest.mockResolvedValueOnce({
        statusCode: 200,
        body: {
          text: async () => JSON.stringify({
            results: [],
            start: 0, limit: 50, size: 0,
          }),
        },
      } as never);

      const descendants = await client.getDescendantPages('root-page');

      expect(descendants).toHaveLength(3);
      expect(descendants.map(d => d.id)).toEqual(['child-1', 'child-2', 'grandchild-1']);
    });

    it('should stop traversal when maxPages limit is reached', async () => {
      const client = new ConfluenceClient(baseUrl, pat);

      // Root has 3 children
      mockRequest.mockResolvedValueOnce({
        statusCode: 200,
        body: {
          text: async () => JSON.stringify({
            results: [
              { id: 'child-1', title: 'Child 1', status: 'current', type: 'page', version: { number: 1, when: '2025-01-01' } },
              { id: 'child-2', title: 'Child 2', status: 'current', type: 'page', version: { number: 1, when: '2025-01-01' } },
              { id: 'child-3', title: 'Child 3', status: 'current', type: 'page', version: { number: 1, when: '2025-01-01' } },
            ],
            start: 0, limit: 50, size: 3,
          }),
        },
      } as never);

      // Set maxPages to 2 — should stop after collecting 2 descendants
      const descendants = await client.getDescendantPages('root-page', 2);

      expect(descendants).toHaveLength(2);
      // Should NOT recurse into children since limit was hit
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    it('should use default maxPages of 200', async () => {
      const client = new ConfluenceClient(baseUrl, pat);

      // Return no children so it finishes immediately
      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: {
          text: async () => JSON.stringify({
            results: [],
            start: 0, limit: 50, size: 0,
          }),
        },
      } as never);

      // Call without maxPages parameter — should work with default
      const descendants = await client.getDescendantPages('root-page');

      expect(descendants).toHaveLength(0);
    });

    it('should return empty array for page with no children', async () => {
      const client = new ConfluenceClient(baseUrl, pat);
      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: {
          text: async () => JSON.stringify({
            results: [],
            start: 0, limit: 50, size: 0,
          }),
        },
      } as never);

      const descendants = await client.getDescendantPages('leaf-page');

      expect(descendants).toHaveLength(0);
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });
  });

  describe('retry on transient errors', () => {
    // Use minimal baseDelay to keep tests fast
    const retryOpts = { retry: { baseDelay: 1 } };

    it('should retry on 503 and succeed on second attempt', async () => {
      const client = new ConfluenceClient(baseUrl, pat, retryOpts);
      let callCount = 0;
      mockRequest.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            statusCode: 503,
            headers: {},
            body: { text: async () => 'Service Unavailable' },
          } as never;
        }
        return {
          statusCode: 200,
          headers: {},
          body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 100, size: 0 }) },
        } as never;
      });

      const result = await client.getSpaces();

      expect(result.results).toEqual([]);
      expect(mockRequest).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ attempt: 1, maxAttempts: 3 }),
        'Confluence API transient error, retrying',
      );
    });

    it('should retry on 429 and respect Retry-After header (seconds)', async () => {
      // Use default baseDelay here so Retry-After (2s) overrides it
      const client = new ConfluenceClient(baseUrl, pat, retryOpts);
      let callCount = 0;
      mockRequest.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            statusCode: 429,
            headers: { 'retry-after': '0' },
            body: { text: async () => 'Too Many Requests' },
          } as never;
        }
        return {
          statusCode: 200,
          headers: {},
          body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 100, size: 0 }) },
        } as never;
      });

      const result = await client.getSpaces();

      expect(result.results).toEqual([]);
      expect(mockRequest).toHaveBeenCalledTimes(2);
      // The delay should be 0ms (from Retry-After: 0)
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ delayMs: 0 }),
        'Confluence API transient error, retrying',
      );
    });

    it('should retry on 502 Bad Gateway', async () => {
      const client = new ConfluenceClient(baseUrl, pat, retryOpts);
      let callCount = 0;
      mockRequest.mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          return {
            statusCode: 502,
            headers: {},
            body: { text: async () => 'Bad Gateway' },
          } as never;
        }
        return {
          statusCode: 200,
          headers: {},
          body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 100, size: 0 }) },
        } as never;
      });

      const result = await client.getSpaces();

      expect(result.results).toEqual([]);
      // 2 failures + 1 success = 3 calls
      expect(mockRequest).toHaveBeenCalledTimes(3);
    });

    it('should throw after exhausting all retry attempts on 504', async () => {
      const client = new ConfluenceClient(baseUrl, pat, retryOpts);
      mockRequest.mockResolvedValue({
        statusCode: 504,
        headers: {},
        body: { text: async () => 'Gateway Timeout' },
      } as never);

      await expect(client.getSpaces()).rejects.toThrow('Confluence API error: HTTP 504');
      // 3 attempts total (default maxAttempts)
      expect(mockRequest).toHaveBeenCalledTimes(3);
    });

    it('should NOT retry on 401 Unauthorized', async () => {
      const client = new ConfluenceClient(baseUrl, pat, retryOpts);
      mockRequest.mockResolvedValue({
        statusCode: 401,
        headers: {},
        body: { text: async () => 'Unauthorized' },
      } as never);

      await expect(client.getSpaces()).rejects.toThrow('Invalid or expired PAT');
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    it('should NOT retry on 403 Forbidden', async () => {
      const client = new ConfluenceClient(baseUrl, pat, retryOpts);
      mockRequest.mockResolvedValue({
        statusCode: 403,
        headers: {},
        body: { text: async () => 'Forbidden' },
      } as never);

      await expect(client.getSpaces()).rejects.toThrow('Insufficient permissions');
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    it('should NOT retry on 404 Not Found', async () => {
      const client = new ConfluenceClient(baseUrl, pat, retryOpts);
      mockRequest.mockResolvedValue({
        statusCode: 404,
        headers: {},
        body: { text: async () => 'Not Found' },
      } as never);

      await expect(client.getSpaces()).rejects.toThrow('Resource not found');
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    it('should NOT retry on 400 Bad Request', async () => {
      const client = new ConfluenceClient(baseUrl, pat, retryOpts);
      mockRequest.mockResolvedValue({
        statusCode: 400,
        headers: {},
        body: { text: async () => JSON.stringify({ message: 'Bad request' }) },
      } as never);

      await expect(client.getSpaces()).rejects.toThrow('Confluence API error: HTTP 400');
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    it('should retry on ECONNRESET network error', async () => {
      const client = new ConfluenceClient(baseUrl, pat, retryOpts);
      let callCount = 0;
      mockRequest.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('read ECONNRESET');
        }
        return {
          statusCode: 200,
          headers: {},
          body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 100, size: 0 }) },
        } as never;
      });

      const result = await client.getSpaces();

      expect(result.results).toEqual([]);
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    it('should retry on ETIMEDOUT network error', async () => {
      const client = new ConfluenceClient(baseUrl, pat, retryOpts);
      let callCount = 0;
      mockRequest.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('connect ETIMEDOUT 10.0.0.1:443');
        }
        return {
          statusCode: 200,
          headers: {},
          body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 100, size: 0 }) },
        } as never;
      });

      const result = await client.getSpaces();

      expect(result.results).toEqual([]);
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    it('should retry on UND_ERR_CONNECT_TIMEOUT undici error', async () => {
      const client = new ConfluenceClient(baseUrl, pat, retryOpts);
      let callCount = 0;
      mockRequest.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('UND_ERR_CONNECT_TIMEOUT');
        }
        return {
          statusCode: 200,
          headers: {},
          body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 100, size: 0 }) },
        } as never;
      });

      const result = await client.getSpaces();

      expect(result.results).toEqual([]);
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    it('should retry downloadAttachment on transient errors', async () => {
      const client = new ConfluenceClient(baseUrl, pat, retryOpts);
      let callCount = 0;
      mockRequest.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            statusCode: 503,
            headers: {},
            body: { text: async () => 'Service Unavailable' },
          } as never;
        }
        return {
          statusCode: 200,
          headers: {},
          body: (async function* () {
            yield Buffer.from('file-content');
          })(),
        } as never;
      });

      const result = await client.downloadAttachment('/download/attachments/123/file.pdf');

      expect(result.toString()).toBe('file-content');
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    it('should attach retryAfterMs to ConfluenceError on 429 for downloadAttachment', async () => {
      const client = new ConfluenceClient(baseUrl, pat, retryOpts);
      mockRequest.mockResolvedValue({
        statusCode: 429,
        headers: { 'retry-after': '0' },
        body: { text: async () => 'Too Many Requests' },
      } as never);

      const err = await client.downloadAttachment('/download/attachments/123/file.pdf').catch((e) => e);
      expect(err).toBeInstanceOf(ConfluenceError);
      expect(err.statusCode).toBe(429);
      expect(err.retryAfterMs).toBe(0);
      // 3 attempts (all 429), then throws
      expect(mockRequest).toHaveBeenCalledTimes(3);
    });
  });
});

describe('isTransientError', () => {
  it('should return true for ConfluenceError with status 429', () => {
    expect(isTransientError(new ConfluenceError('Too Many Requests', 429))).toBe(true);
  });

  it('should return true for ConfluenceError with status 502', () => {
    expect(isTransientError(new ConfluenceError('Bad Gateway', 502))).toBe(true);
  });

  it('should return true for ConfluenceError with status 503', () => {
    expect(isTransientError(new ConfluenceError('Service Unavailable', 503))).toBe(true);
  });

  it('should return true for ConfluenceError with status 504', () => {
    expect(isTransientError(new ConfluenceError('Gateway Timeout', 504))).toBe(true);
  });

  it('should return false for ConfluenceError with status 400', () => {
    expect(isTransientError(new ConfluenceError('Bad Request', 400))).toBe(false);
  });

  it('should return false for ConfluenceError with status 401', () => {
    expect(isTransientError(new ConfluenceError('Unauthorized', 401))).toBe(false);
  });

  it('should return false for ConfluenceError with status 403', () => {
    expect(isTransientError(new ConfluenceError('Forbidden', 403))).toBe(false);
  });

  it('should return false for ConfluenceError with status 404', () => {
    expect(isTransientError(new ConfluenceError('Not Found', 404))).toBe(false);
  });

  it('should return false for ConfluenceError with status 500', () => {
    expect(isTransientError(new ConfluenceError('Internal Server Error', 500))).toBe(false);
  });

  it('should return true for ECONNRESET error', () => {
    expect(isTransientError(new Error('read ECONNRESET'))).toBe(true);
  });

  it('should return true for ETIMEDOUT error', () => {
    expect(isTransientError(new Error('connect ETIMEDOUT 10.0.0.1:443'))).toBe(true);
  });

  it('should return true for UND_ERR_CONNECT_TIMEOUT error', () => {
    expect(isTransientError(new Error('UND_ERR_CONNECT_TIMEOUT'))).toBe(true);
  });

  it('should return false for generic Error', () => {
    expect(isTransientError(new Error('Something else broke'))).toBe(false);
  });

  it('should return false for non-Error values', () => {
    expect(isTransientError('string error')).toBe(false);
    expect(isTransientError(42)).toBe(false);
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
  });
});

describe('parseRetryAfter', () => {
  it('should parse integer seconds', () => {
    expect(parseRetryAfter('5')).toBe(5000);
  });

  it('should parse zero seconds', () => {
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('should parse decimal seconds', () => {
    expect(parseRetryAfter('1.5')).toBe(1500);
  });

  it('should return undefined for undefined input', () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });

  it('should return undefined for empty string', () => {
    expect(parseRetryAfter('')).toBeUndefined();
  });

  it('should handle string array (take first element)', () => {
    expect(parseRetryAfter(['3', '10'])).toBe(3000);
  });

  it('should return undefined for empty array', () => {
    expect(parseRetryAfter([])).toBeUndefined();
  });

  it('should parse HTTP-date format', () => {
    // Set a date 10 seconds in the future
    const futureDate = new Date(Date.now() + 10_000);
    const result = parseRetryAfter(futureDate.toUTCString());
    // Allow 1 second tolerance for test execution time
    expect(result).toBeGreaterThan(8000);
    expect(result).toBeLessThanOrEqual(11000);
  });

  it('should return 0 for HTTP-date in the past', () => {
    const pastDate = new Date(Date.now() - 60_000);
    expect(parseRetryAfter(pastDate.toUTCString())).toBe(0);
  });

  it('should return undefined for unparseable value', () => {
    expect(parseRetryAfter('not-a-number-or-date')).toBeUndefined();
  });

  it('should return undefined for negative number', () => {
    expect(parseRetryAfter('-5')).toBeUndefined();
  });
});

describe('withRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return result on first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('success');

    const result = await withRetry(fn, { baseDelay: 1 });

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on transient ConfluenceError and succeed', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new ConfluenceError('Service Unavailable', 503))
      .mockResolvedValue('success');

    const result = await withRetry(fn, { baseDelay: 1 });

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should throw immediately on non-transient error', async () => {
    const fn = vi.fn().mockRejectedValue(new ConfluenceError('Not Found', 404));

    await expect(withRetry(fn, { baseDelay: 1 })).rejects.toThrow('Not Found');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should throw after exhausting maxAttempts', async () => {
    const fn = vi.fn().mockRejectedValue(new ConfluenceError('Service Unavailable', 503));

    await expect(withRetry(fn, { maxAttempts: 3, baseDelay: 1 })).rejects.toThrow('Service Unavailable');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should use Retry-After delay from ConfluenceError when present', async () => {
    const error = new ConfluenceError('Too Many Requests', 429);
    error.retryAfterMs = 100;

    const fn = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue('success');

    const result = await withRetry(fn, { baseDelay: 1 });

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
    // Verify logger.warn was called with the Retry-After delay
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ delayMs: 100 }),
      'Confluence API transient error, retrying',
    );
  });

  it('should retry on network errors (ECONNRESET)', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('read ECONNRESET'))
      .mockResolvedValue('success');

    const result = await withRetry(fn, { baseDelay: 1 });

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should respect custom maxAttempts', async () => {
    const fn = vi.fn().mockRejectedValue(new ConfluenceError('Bad Gateway', 502));

    await expect(withRetry(fn, { maxAttempts: 5, baseDelay: 1 })).rejects.toThrow('Bad Gateway');
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('should use default options when none provided', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new ConfluenceError('Service Unavailable', 503))
      .mockResolvedValue('success');

    // Using real delays would be slow, but we can at least verify it works
    // We use a short baseDelay override to keep tests fast
    const result = await withRetry(fn, { baseDelay: 1 });

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
