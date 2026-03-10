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
});
