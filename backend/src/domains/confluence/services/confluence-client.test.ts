import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock undici request
vi.mock('undici', () => ({
  request: vi.fn(),
}));

// Mock ssrf-guard to allow test URLs
vi.mock('../../../core/utils/ssrf-guard.js', () => ({
  validateUrl: vi.fn(),
  addAllowedBaseUrl: vi.fn(),
  resolveConfluenceUrl: vi.fn((url: string) => url),
}));

// Mock logger
vi.mock('../../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// Mock tls-config — always provides a dispatcher (undici v7 redirect interceptor)
const mockDefaultDispatcher = { isDefaultDispatcher: true };
const mockCustomDispatcher = { isCustomDispatcher: true };
vi.mock('../../../core/utils/tls-config.js', () => ({
  confluenceDispatcher: { isDefaultDispatcher: true },
  buildConnectOptions: vi.fn().mockReturnValue(undefined),
  isVerifySslEnabled: vi.fn().mockReturnValue(true),
}));

import { request } from 'undici';
import { ConfluenceClient, ConfluenceError, isTransientError, parseRetryAfter, withRetry, buildDownloadUrl, buildDownloadUrlCandidates } from './confluence-client.js';
import * as tlsConfig from '../../../core/utils/tls-config.js';
import { logger } from '../../../core/utils/logger.js';
import { resetRateLimiter } from './confluence-rate-limiter.js';

const mockRequest = vi.mocked(request);

describe('ConfluenceClient', () => {
  const baseUrl = 'https://confluence.example.com';
  const pat = 'test-pat-token';

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to default dispatcher
    (tlsConfig as { confluenceDispatcher: unknown }).confluenceDispatcher = mockDefaultDispatcher;
  });

  describe('TLS dispatcher', () => {
    it('should always pass dispatcher for redirect support', async () => {
      const client = new ConfluenceClient(baseUrl, pat);
      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 100, size: 0 }) },
      } as never);

      await client.getSpaces();

      const callArgs = mockRequest.mock.calls[0];
      expect((callArgs[1] as Record<string, unknown>).dispatcher).toBeDefined();
    });

    it('should pass custom dispatcher when custom TLS config exists', async () => {
      (tlsConfig as { confluenceDispatcher: unknown }).confluenceDispatcher = mockCustomDispatcher;

      const client = new ConfluenceClient(baseUrl, pat);
      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 100, size: 0 }) },
      } as never);

      await client.getSpaces();

      const callArgs = mockRequest.mock.calls[0];
      expect((callArgs[1] as Record<string, unknown>).dispatcher).toBe(mockCustomDispatcher);
    });

    it('should pass dispatcher for attachment downloads', async () => {
      (tlsConfig as { confluenceDispatcher: unknown }).confluenceDispatcher = mockCustomDispatcher;

      const client = new ConfluenceClient(baseUrl, pat);
      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: (async function* () {
          yield Buffer.from('file-content');
        })(),
      } as never);

      await client.downloadAttachment('/download/attachments/123/file.pdf');

      const callArgs = mockRequest.mock.calls[0];
      expect((callArgs[1] as Record<string, unknown>).dispatcher).toBe(mockCustomDispatcher);
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

    it('should throw a typed ConfluenceError with a body excerpt for non-JSON 2xx responses (#746)', async () => {
      const client = new ConfluenceClient(baseUrl, pat);
      // e.g. a reverse proxy / SSO portal answering 200 with an HTML login page
      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => '<!DOCTYPE html><html><head><title>Sign in</title></head><body>SSO</body></html>' },
      } as never);

      const err = await client.getSpaces().then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(ConfluenceError);
      expect((err as ConfluenceError).statusCode).toBe(200);
      expect((err as ConfluenceError).message).toContain('non-JSON');
      expect((err as ConfluenceError).message).toContain('<!DOCTYPE html');
      // Not a transient error — withRetry must rethrow without retrying.
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    it('resolves (does not throw) on a 204 No Content with an empty body — #853', async () => {
      const client = new ConfluenceClient(baseUrl, pat);
      // Confluence DC's DELETE /content/{id} answers 204 with an EMPTY body. An
      // empty 2xx is a legitimate success with no payload — it must NOT be
      // treated as a non-JSON error (JSON.parse('') throwing). Before the fix,
      // deletePage rejected with ConfluenceError(204), and the delete route
      // mistook that for a failure and rolled back the local delete — leaving
      // the page visible in Compendiq while it was trashed upstream (#853).
      mockRequest.mockResolvedValue({
        statusCode: 204,
        headers: {},
        body: { text: async () => '' },
      } as never);

      await expect(client.deletePage('688131')).resolves.toBeUndefined();
      // Not a transient error path — no retries.
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    it('resolves on an empty 200 body (empty success payload)', async () => {
      const client = new ConfluenceClient(baseUrl, pat);
      mockRequest.mockResolvedValue({
        statusCode: 200,
        headers: {},
        body: { text: async () => '   ' },
      } as never);

      await expect(client.deletePage('42')).resolves.toBeUndefined();
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

  describe('findPageByTitle', () => {
    it('searches by exact title and optional space key', async () => {
      const client = new ConfluenceClient(baseUrl, pat);
      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => JSON.stringify({ results: [{ id: '123', title: 'Shared Assets' }], start: 0, limit: 1, size: 1 }) },
      } as never);

      const result = await client.findPageByTitle('OPS', 'Shared Assets');

      expect(result).toMatchObject({ id: '123', title: 'Shared Assets' });
      const callUrl = mockRequest.mock.calls[0][0] as string;
      expect(callUrl).toContain(encodeURIComponent('space="OPS" AND type=page AND title="Shared Assets"'));
    });

    it('escapes a double-quote in the space key so it cannot break out of the CQL literal', async () => {
      const client = new ConfluenceClient(baseUrl, pat);
      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 1, size: 0 }) },
      } as never);

      // ri:space-key sourced from page XHTML could contain a quote to inject CQL.
      await client.findPageByTitle('OPS" OR space="SECRET', 'Shared Assets');

      const callUrl = mockRequest.mock.calls[0][0] as string;
      const decodedCql = decodeURIComponent(callUrl.split('cql=')[1].split('&')[0]);
      // The quote is escaped, so the value stays inside the space="..." literal
      // and no bare ` OR space=` clause leaks into the query.
      expect(decodedCql).toContain('space="OPS\\" OR space=\\"SECRET" AND ');
      expect(decodedCql).not.toContain('space="OPS" OR space="SECRET"');
    });
  });

  describe('getModifiedPages', () => {
    it('escapes a double-quote in the space key so it cannot break out of the CQL literal', async () => {
      const client = new ConfluenceClient(baseUrl, pat);
      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 50, size: 0 }) },
      } as never);

      await client.getModifiedPages(new Date('2026-06-01T00:00:00Z'), 'OPS" OR space="SECRET');

      const callUrl = mockRequest.mock.calls[0][0] as string;
      const decodedCql = decodeURIComponent(callUrl.split('cql=')[1].split('&')[0]);
      expect(decodedCql).toContain('space="OPS\\" OR space=\\"SECRET" AND type=page');
      expect(decodedCql).not.toContain('space="OPS" OR space="SECRET"');
    });

    it('uses a minute-granular datetime lower bound widened by a 24h overlap margin (#858)', async () => {
      const client = new ConfluenceClient(baseUrl, pat);
      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 50, size: 0 }) },
      } as never);

      await client.getModifiedPages(new Date('2026-07-10T02:00:00Z'), 'OPS');

      const callUrl = mockRequest.mock.calls[0][0] as string;
      const decodedCql = decodeURIComponent(callUrl.split('cql=')[1].split('&')[0]);
      // A minute-granular datetime literal, not a bare calendar date.
      expect(decodedCql).toMatch(/lastmodified>="\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}"/);
      // Lower bound widened ~24h below `since` to absorb the instance timezone offset.
      expect(decodedCql).toContain('lastmodified>="2026/07/09 02:00"');
      expect(decodedCql).not.toContain('lastmodified>="2026-07-10"');
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

  describe('getPageAttachments pagination', () => {
    it('combines results across multiple pages and stops when last page is partial', async () => {
      const client = new ConfluenceClient(baseUrl, pat);

      // First page: exactly 100 results (full page — must fetch next)
      const firstPageResults = Array.from({ length: 100 }, (_, i) => ({
        id: `att-${i}`,
        title: `attachment-${i}.png`,
        mediaType: 'image/png',
        _links: { download: `/download/att-${i}.png` },
      }));

      // Second page: 30 results (partial — stop here)
      const secondPageResults = Array.from({ length: 30 }, (_, i) => ({
        id: `att-${100 + i}`,
        title: `attachment-${100 + i}.png`,
        mediaType: 'image/png',
        _links: { download: `/download/att-${100 + i}.png` },
      }));

      mockRequest
        .mockResolvedValueOnce({
          statusCode: 200,
          headers: {},
          body: {
            text: async () =>
              JSON.stringify({ results: firstPageResults, start: 0, limit: 100, size: 100 }),
          },
        } as never)
        .mockResolvedValueOnce({
          statusCode: 200,
          headers: {},
          body: {
            text: async () =>
              JSON.stringify({ results: secondPageResults, start: 100, limit: 100, size: 30 }),
          },
        } as never);

      const result = await client.getPageAttachments('page-42');

      expect(result.results).toHaveLength(130);
      expect(result.size).toBe(130);
      expect(mockRequest).toHaveBeenCalledTimes(2);

      // First request: start=0
      const firstUrl = mockRequest.mock.calls[0][0] as string;
      expect(firstUrl).toContain('start=0');
      expect(firstUrl).toContain('limit=100');
      expect(firstUrl).toContain('/child/attachment');

      // Second request: start=100
      const secondUrl = mockRequest.mock.calls[1][0] as string;
      expect(secondUrl).toContain('start=100');
    });

    it('returns all results from a single page when fewer than 100 attachments', async () => {
      const client = new ConfluenceClient(baseUrl, pat);

      const singlePageResults = Array.from({ length: 5 }, (_, i) => ({
        id: `att-${i}`,
        title: `file-${i}.png`,
        mediaType: 'image/png',
        _links: { download: `/download/file-${i}.png` },
      }));

      mockRequest.mockResolvedValueOnce({
        statusCode: 200,
        headers: {},
        body: {
          text: async () =>
            JSON.stringify({ results: singlePageResults, start: 0, limit: 100, size: 5 }),
        },
      } as never);

      const result = await client.getPageAttachments('page-1');

      expect(result.results).toHaveLength(5);
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    it('returns empty results when page has no attachments', async () => {
      const client = new ConfluenceClient(baseUrl, pat);

      mockRequest.mockResolvedValueOnce({
        statusCode: 200,
        headers: {},
        body: {
          text: async () =>
            JSON.stringify({ results: [], start: 0, limit: 100, size: 0 }),
        },
      } as never);

      const result = await client.getPageAttachments('page-empty');

      expect(result.results).toHaveLength(0);
      expect(result.size).toBe(0);
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

    it('should try raw URL first with spaces encoded and colons preserved', async () => {
      const client = new ConfluenceClient(baseUrl, pat, retryOpts);
      mockRequest.mockResolvedValue({
        statusCode: 200,
        headers: {},
        body: (async function* () {
          yield Buffer.from('file-content');
        })(),
      } as never);

      await client.downloadAttachment('/download/attachments/228459100/image2018-1-22 9:26:20.png?version=1&api=v2');

      const callUrl = mockRequest.mock.calls[0][0] as string;
      // Raw URL first: spaces → %20, colons preserved as-is
      expect(callUrl).toBe(
        'https://confluence.example.com/download/attachments/228459100/image2018-1-22%209:26:20.png?version=1&api=v2',
      );
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

  describe('mutation retry matrix (#1776)', () => {
    // A 502/503/504 or a dropped connection can come back after Confluence has
    // already applied a POST/PUT/DELETE, so a mutation gets one attempt and its
    // caller sees that original error. A 429 is refused before processing and
    // stays retryable for every method; GETs keep retrying all of them. Each
    // case runs fetch → withRetry against a stateful fake Confluence behind the
    // mocked undici `request`, so a re-sent mutation meets the state its first
    // attempt left behind. Fake timers fast-forward every retry sleep whatever
    // its length: no case asserts a delay beyond "not before Retry-After".
    const RUNBOOK = '42';
    const NEW_TITLE = 'Incident review';
    const MAX_ATTEMPTS = 3;
    const RETRY_AFTER_MS = 2_000;
    const STATUS_TEXT: Record<number, string> = {
      429: 'Too Many Requests',
      502: 'Bad Gateway',
      503: 'Service Unavailable',
      504: 'Gateway Timeout',
    };

    /** How the fake answers a failing request; `landed` = it applied the request first. */
    type Failure = { label: string; landed: boolean } & (
      | { statusCode: number }
      | { code: string; message: string }
    );
    const RATE_LIMITED: Failure = { label: 'HTTP 429', statusCode: 429, landed: false };
    /** Failures after which a mutation's outcome is unknown. */
    const AMBIGUOUS: Failure[] = [
      { label: 'HTTP 502', statusCode: 502, landed: true },
      { label: 'HTTP 503', statusCode: 503, landed: true },
      { label: 'HTTP 504', statusCode: 504, landed: true },
      { label: 'ECONNRESET', code: 'ECONNRESET', message: 'read ECONNRESET', landed: true },
      { label: 'ETIMEDOUT', code: 'ETIMEDOUT', message: 'read ETIMEDOUT', landed: true },
      // Message is synthetic: undici's ConnectTimeoutError carries this code but message 'Connect Timeout Error …'; see isTransientError message match
      { label: 'UND_ERR_CONNECT_TIMEOUT', code: 'UND_ERR_CONNECT_TIMEOUT', message: 'UND_ERR_CONNECT_TIMEOUT', landed: false },
    ];

    const MUTATIONS = [
      {
        name: 'createPage', method: 'POST', path: '/rest/api/content',
        send: (client: ConfluenceClient) => client.createPage('OPS', NEW_TITLE, '<p>Timeline</p>'),
        resolved: { id: '100', title: NEW_TITLE, version: { number: 1 } },
      },
      {
        name: 'updatePage', method: 'PUT', path: `/rest/api/content/${RUNBOOK}`,
        send: (client: ConfluenceClient) => client.updatePage(RUNBOOK, 'Runbook', '<p>Revised</p>', 5),
        resolved: { id: RUNBOOK, title: 'Runbook', version: { number: 6 } },
      },
      {
        name: 'deletePage', method: 'DELETE', path: `/rest/api/content/${RUNBOOK}`,
        send: (client: ConfluenceClient) => client.deletePage(RUNBOOK),
        resolved: undefined,
      },
      {
        name: 'addLabels', method: 'POST', path: `/rest/api/content/${RUNBOOK}/label`,
        send: (client: ConfluenceClient) => client.addLabels(RUNBOOK, ['security']),
        resolved: undefined,
      },
      {
        name: 'removeLabel', method: 'DELETE', path: `/rest/api/content/${RUNBOOK}/label/legacy`,
        send: (client: ConfluenceClient) => client.removeLabel(RUNBOOK, 'legacy'),
        resolved: undefined,
      },
    ];
    const READS = [
      {
        name: 'getPage', path: `/rest/api/content/${RUNBOOK}`,
        send: (client: ConfluenceClient) => client.getPage(RUNBOOK),
      },
      {
        name: 'getPageAttachments', path: `/rest/api/content/${RUNBOOK}/child/attachment`,
        send: (client: ConfluenceClient) => client.getPageAttachments(RUNBOOK),
      },
      {
        name: 'downloadAttachment', path: `/download/attachments/${RUNBOOK}/runbook.pdf`,
        send: (client: ConfluenceClient) => client.downloadAttachment(`/download/attachments/${RUNBOOK}/runbook.pdf`),
      },
    ];

    interface UpstreamPage { title: string; version: number; labels: Set<string> }
    /** What crossed the wire, the errors its sockets threw, and the upstream state left behind. */
    interface FakeConfluence { requests: string[]; thrown: Error[]; pages: Map<string, UpstreamPage> }
    /** How a call settled. */
    type Outcome = { resolved?: unknown; rejected?: unknown };

    /**
     * Fake Confluence DC holding one page (`42`, "Runbook", version 5, labels
     * ops + legacy). It answers the first `failing` requests with `failure` and
     * every later one from its state.
     */
    function fakeConfluence(failure: Failure, failing = 1): FakeConfluence {
      const requests: string[] = [];
      const thrown: Error[] = [];
      const pages = new Map<string, UpstreamPage>([[RUNBOOK, { title: 'Runbook', version: 5, labels: new Set(['ops', 'legacy']) }]]);
      let nextId = 100;

      /** Applies one request to the upstream state; returns the status and payload DC answers with. */
      const apply = (method: string, path: string, body: unknown): [number, unknown?] => {
        if (method === 'POST' && path === '/rest/api/content') {
          const { title } = body as { title: string };
          if ([...pages.values()].some((page) => page.title === title)) {
            return [400, { message: 'A page with this title already exists' }];
          }
          const id = String(nextId++);
          pages.set(id, { title, version: 1, labels: new Set() });
          return [200, { id, title, version: { number: 1 } }];
        }
        const [, id = '', labels, label] = /^\/rest\/api\/content\/([^/]+)(\/label(?:\/([^/]+))?)?$/.exec(path) ?? [];
        const page = pages.get(id);
        if (!page) return [404];
        if (method === 'PUT' && !labels) {
          const { title, version } = body as { title: string; version: { number: number } };
          if (version.number !== page.version + 1) {
            return [409, { message: `Version must be incremented when updating a page. Current Version is: ${page.version}` }];
          }
          Object.assign(page, { title, version: version.number });
          return [200, { id, title, version: { number: page.version } }];
        }
        if (method === 'DELETE' && !labels) {
          pages.delete(id);
          return [204];
        }
        if (method === 'POST' && labels && !label) {
          for (const { name } of body as Array<{ name: string }>) page.labels.add(name);
          return [200, { results: [...page.labels].map((name) => ({ prefix: 'global', name })) }];
        }
        if (method === 'DELETE' && label) return page.labels.delete(label) ? [204] : [404];
        return [404];
      };

      mockRequest.mockImplementation(async (url: unknown, options?: { method?: string; body?: unknown }) => {
        const method = options?.method ?? 'GET';
        const path = new URL(String(url)).pathname;
        requests.push(`${method} ${path}`);
        const body: unknown = typeof options?.body === 'string' ? JSON.parse(options.body) : undefined;
        let answer: [number, unknown?];
        if (requests.length > failing) {
          answer = apply(method, path, body);
        } else {
          if (failure.landed) apply(method, path, body);
          if ('code' in failure) {
            const error = Object.assign(new Error(failure.message), { code: failure.code });
            thrown.push(error);
            throw error;
          }
          answer = [failure.statusCode, STATUS_TEXT[failure.statusCode]];
        }
        const [statusCode, payload] = answer;
        const text = typeof payload === 'string' ? payload : payload === undefined ? '' : JSON.stringify(payload);
        return {
          statusCode,
          headers: statusCode === 429 ? { 'retry-after': String(RETRY_AFTER_MS / 1000) } : {},
          body: { text: async () => text },
        } as never;
      });
      return { requests, thrown, pages };
    }

    const newClient = () => new ConfluenceClient(baseUrl, pat, { retry: { maxAttempts: MAX_ATTEMPTS } });

    /** Attaches at once, so a rejection is never unhandled while the clock moves. */
    const settle = (call: Promise<unknown>): Promise<Outcome> =>
      call.then((resolved) => ({ resolved }), (rejected: unknown) => ({ rejected }));

    /** Fast-forwards every retry sleep, whatever its length, then reports the wire and the outcome. */
    async function finish(settled: Promise<Outcome>, fake: FakeConfluence) {
      await vi.runAllTimersAsync();
      return { requests: fake.requests, ...(await settled) };
    }

    /** The rejection the caller must see: that very status, or the error the socket threw. */
    const original = (failure: Failure, fake: FakeConfluence) =>
      'statusCode' in failure
        ? expect.objectContaining({ name: 'ConfluenceError', statusCode: failure.statusCode })
        : fake.thrown.at(-1);

    beforeEach(() => {
      // A full token bucket, so acquireToken() never queues behind the fake clock.
      resetRateLimiter();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });

    afterEach(() => {
      vi.useRealTimers();
      // Leave no stateful fake behind for the suites that follow.
      mockRequest.mockReset();
    });

    it.each(MUTATIONS.flatMap((mutation) => AMBIGUOUS.map((failure) => ({ ...mutation, failure, on: failure.label }))))(
      '$name sends one $method on $on and rejects with that original error',
      async ({ method, path, send, failure }) => {
        const fake = fakeConfluence(failure);

        expect(await finish(settle(send(newClient())), fake)).toEqual({
          requests: [`${method} ${path}`],
          rejected: original(failure, fake),
        });
      },
    );

    it.each(MUTATIONS)(
      '$name re-sends its $method after a 429, not before Retry-After, and succeeds',
      async ({ method, path, send, resolved }) => {
        const fake = fakeConfluence(RATE_LIMITED);
        const settled = settle(send(newClient()));

        await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS - 1);
        expect(fake.requests).toEqual([`${method} ${path}`]);

        expect(await finish(settled, fake)).toEqual({
          requests: [`${method} ${path}`, `${method} ${path}`],
          resolved,
        });
      },
    );

    it.each(READS.flatMap((read) => [RATE_LIMITED, ...AMBIGUOUS].map((failure) => ({ ...read, failure, on: failure.label }))))(
      '$name retries its GET on $on up to maxAttempts',
      async ({ path, send, failure }) => {
        const fake = fakeConfluence(failure, Infinity);

        expect(await finish(settle(send(newClient())), fake)).toEqual({
          requests: Array.from({ length: MAX_ATTEMPTS }, () => `GET ${path}`),
          rejected: original(failure, fake),
        });
      },
    );

    it('reproduction: a create that landed but answered 504 surfaces that 504 after one POST, with one upstream page', async () => {
      const fake = fakeConfluence({ label: 'HTTP 504', statusCode: 504, landed: true });

      expect(await finish(settle(newClient().createPage('OPS', NEW_TITLE, '<p>Timeline</p>')), fake)).toEqual({
        requests: ['POST /rest/api/content'],
        rejected: expect.objectContaining({
          name: 'ConfluenceError',
          statusCode: 504,
          message: 'Confluence API error: HTTP 504: Gateway Timeout',
        }),
      });
      expect([...fake.pages.values()].filter((page) => page.title === NEW_TITLE)).toHaveLength(1);
    });

    describe('isTransientError(err, method)', () => {
      const CASES: Failure[] = [
        RATE_LIMITED,
        ...AMBIGUOUS,
        { label: 'HTTP 400', statusCode: 400, landed: false },
        { label: 'HTTP 500', statusCode: 500, landed: false },
      ];
      const RETRIED_FOR_SAFE_METHODS = {
        'HTTP 429': true, 'HTTP 502': true, 'HTTP 503': true, 'HTTP 504': true,
        ECONNRESET: true, ETIMEDOUT: true, UND_ERR_CONNECT_TIMEOUT: true,
        'HTTP 400': false, 'HTTP 500': false,
      };
      const RETRIED_FOR_MUTATIONS = {
        'HTTP 429': true, 'HTTP 502': false, 'HTTP 503': false, 'HTTP 504': false,
        ECONNRESET: false, ETIMEDOUT: false, UND_ERR_CONNECT_TIMEOUT: false,
        'HTTP 400': false, 'HTTP 500': false,
      };

      it.each([
        { method: 'GET', retries: 'a 429, a 502/503/504 and a network error', expected: RETRIED_FOR_SAFE_METHODS },
        { method: 'HEAD', retries: 'a 429, a 502/503/504 and a network error', expected: RETRIED_FOR_SAFE_METHODS },
        { method: 'POST', retries: 'only a 429', expected: RETRIED_FOR_MUTATIONS },
        { method: 'PUT', retries: 'only a 429', expected: RETRIED_FOR_MUTATIONS },
        { method: 'DELETE', retries: 'only a 429', expected: RETRIED_FOR_MUTATIONS },
      ])('$method retries $retries', ({ method, expected }) => {
        const decisions = CASES.map((failure): [string, boolean] => [
          failure.label,
          isTransientError(
            'statusCode' in failure
              ? new ConfluenceError(`HTTP ${failure.statusCode}`, failure.statusCode)
              : Object.assign(new Error(failure.message), { code: failure.code }),
            method,
          ),
        ]);
        expect(Object.fromEntries(decisions)).toEqual(expected);
      });
    });
  });

  describe('getAllPageIds (#706 deletion reconciliation)', () => {
    it('returns the set of live page ids without expanding body/version', async () => {
      const client = new ConfluenceClient(baseUrl, pat);
      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: {
          text: async () =>
            JSON.stringify({
              results: [{ id: '1' }, { id: '2' }, { id: '3' }],
              start: 0,
              limit: 200,
              size: 3,
            }),
        },
      } as never);

      const ids = await client.getAllPageIds('DEV');

      expect(ids).toEqual(new Set(['1', '2', '3']));
      // Cheap listing: no expand= query (avoids fetching body/version/ancestors).
      const callUrl = mockRequest.mock.calls[0][0] as string;
      expect(callUrl).toContain('spaceKey=DEV');
      expect(callUrl).toContain('type=page');
      expect(callUrl).not.toContain('expand=');
    });

    it('paginates until the listing is exhausted', async () => {
      const client = new ConfluenceClient(baseUrl, pat);
      const firstPage = Array.from({ length: 200 }, (_, i) => ({ id: String(i) }));
      mockRequest
        .mockResolvedValueOnce({
          statusCode: 200,
          body: {
            text: async () =>
              JSON.stringify({ results: firstPage, start: 0, limit: 200, size: 200, _links: { next: '/next' } }),
          },
        } as never)
        .mockResolvedValueOnce({
          statusCode: 200,
          body: { text: async () => JSON.stringify({ results: [{ id: '200' }], start: 200, limit: 200, size: 1 }) },
        } as never);

      const ids = await client.getAllPageIds('DEV');

      expect(ids.size).toBe(201);
      expect(ids.has('200')).toBe(true);
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    it('follows _links.next even when a page is shorter than the limit (#903)', async () => {
      // Confluence DC may clamp a page below the requested limit (permission
      // filtering, server-side max) while still advertising more via _links.next.
      // The listing must be driven by the presence of `next`, not by size<limit,
      // or the remaining ids are silently truncated.
      const client = new ConfluenceClient(baseUrl, pat);
      const firstPage = Array.from({ length: 40 }, (_, i) => ({ id: String(i) }));
      const secondPage = Array.from({ length: 10 }, (_, i) => ({ id: String(40 + i) }));
      mockRequest
        .mockResolvedValueOnce({
          statusCode: 200,
          body: {
            text: async () =>
              JSON.stringify({
                results: firstPage,
                start: 0,
                limit: 200,
                size: 40,
                _links: { next: '/rest/api/content?spaceKey=DEV&type=page&start=40&limit=200' },
              }),
          },
        } as never)
        .mockResolvedValueOnce({
          statusCode: 200,
          body: {
            text: async () =>
              JSON.stringify({ results: secondPage, start: 40, limit: 200, size: 10 }),
          },
        } as never);

      const ids = await client.getAllPageIds('DEV');

      expect(ids.size).toBe(50);
      expect(ids.has('49')).toBe(true);
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });
  });
});

describe('getPageRestrictions', () => {
  const baseUrl = 'https://confluence.example.com';
  const pat = 'test-pat-token';
  // maxAttempts:1 + short delay so transient-retry-then-fallback tests don't spin the clock
  const retryOpts = { retry: { maxAttempts: 1, baseDelay: 1 } };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses a normal response with read + update restrictions', async () => {
    const client = new ConfluenceClient(baseUrl, pat, retryOpts);
    const response = {
      results: [
        {
          operation: 'read',
          restrictions: {
            user: {
              results: [
                { userKey: 'user-key-alice', username: 'alice', displayName: 'Alice Doe' },
              ],
            },
            group: { results: [{ name: 'confluence-administrators' }] },
          },
        },
        {
          operation: 'update',
          restrictions: {
            user: {
              results: [
                { userKey: 'user-key-bob', username: 'bob' },
              ],
            },
            group: { results: [{ name: 'editors' }] },
          },
        },
      ],
      start: 0,
      limit: 100,
      size: 2,
    };
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: { text: async () => JSON.stringify(response) },
    } as never);

    const result = await client.getPageRestrictions('12345');

    expect(result).toEqual([
      {
        operation: 'read',
        restrictions: {
          users: [{ userKey: 'user-key-alice', username: 'alice', displayName: 'Alice Doe' }],
          groups: [{ name: 'confluence-administrators' }],
        },
      },
      {
        operation: 'update',
        restrictions: {
          users: [{ userKey: 'user-key-bob', username: 'bob' }],
          groups: [{ name: 'editors' }],
        },
      },
    ]);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    const callUrl = mockRequest.mock.calls[0][0] as string;
    expect(callUrl).toContain('/rest/api/content/12345/restriction');
    expect(callUrl).toContain('expand=restrictions.user,restrictions.group');
    expect(callUrl).not.toContain('/experimental/');
  });

  it('returns [] on 404 from primary path without calling fallback', async () => {
    const client = new ConfluenceClient(baseUrl, pat, retryOpts);
    mockRequest.mockResolvedValue({
      statusCode: 404,
      headers: {},
      body: { text: async () => 'Not Found' },
    } as never);

    const result = await client.getPageRestrictions('12345');

    expect(result).toEqual([]);
    // Only the primary path attempted — no fallback on 404
    expect(mockRequest).toHaveBeenCalledTimes(1);
    const callUrl = mockRequest.mock.calls[0][0] as string;
    expect(callUrl).not.toContain('/experimental/');
  });

  it('falls back to the experimental path when primary returns 500', async () => {
    const client = new ConfluenceClient(baseUrl, pat, retryOpts);
    let callCount = 0;
    mockRequest.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          statusCode: 500,
          headers: {},
          body: { text: async () => 'Internal Server Error' },
        } as never;
      }
      // Experimental path succeeds
      return {
        statusCode: 200,
        headers: {},
        body: {
          text: async () => JSON.stringify({
            results: [
              {
                operation: 'read',
                restrictions: {
                  user: { results: [{ userKey: 'u1', username: 'alice' }] },
                  group: { results: [] },
                },
              },
            ],
            start: 0, limit: 100, size: 1,
          }),
        },
      } as never;
    });

    const result = await client.getPageRestrictions('12345');

    expect(result).toEqual([
      {
        operation: 'read',
        restrictions: {
          users: [{ userKey: 'u1', username: 'alice' }],
          groups: [],
        },
      },
    ]);
    expect(mockRequest).toHaveBeenCalledTimes(2);
    const firstUrl = mockRequest.mock.calls[0][0] as string;
    const secondUrl = mockRequest.mock.calls[1][0] as string;
    expect(firstUrl).toContain('/rest/api/content/12345/restriction');
    expect(firstUrl).not.toContain('/experimental/');
    expect(secondUrl).toContain('/rest/experimental/content/12345/restriction');
  });

  it('throws ConfluenceError naming both paths when both attempts fail', async () => {
    const client = new ConfluenceClient(baseUrl, pat, retryOpts);
    let callCount = 0;
    mockRequest.mockImplementation(async () => {
      callCount++;
      return {
        statusCode: callCount === 1 ? 500 : 400,
        headers: {},
        body: { text: async () => (callCount === 1 ? 'Internal Server Error' : 'Bad Request') },
      } as never;
    });

    const err = await client.getPageRestrictions('12345').catch((e) => e);

    expect(err).toBeInstanceOf(ConfluenceError);
    // Error message must name BOTH attempted URLs so operators can diagnose DC-version mismatches
    expect((err as Error).message).toContain('/rest/api/content/12345/restriction');
    expect((err as Error).message).toContain('/rest/experimental/content/12345/restriction');
    // And include the last status code from the experimental path (400)
    expect((err as Error).message).toContain('400');
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('returns [] on 404 from the experimental fallback path (older DC)', async () => {
    const client = new ConfluenceClient(baseUrl, pat, retryOpts);
    let callCount = 0;
    mockRequest.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          statusCode: 500,
          headers: {},
          body: { text: async () => 'Internal Server Error' },
        } as never;
      }
      return {
        statusCode: 404,
        headers: {},
        body: { text: async () => 'Not Found' },
      } as never;
    });

    const result = await client.getPageRestrictions('12345');

    expect(result).toEqual([]);
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('handles empty restrictions.user.results and group.results arrays', async () => {
    const client = new ConfluenceClient(baseUrl, pat, retryOpts);
    const response = {
      results: [
        {
          operation: 'read',
          restrictions: {
            user: { results: [] },
            group: { results: [] },
          },
        },
      ],
      start: 0, limit: 100, size: 1,
    };
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: { text: async () => JSON.stringify(response) },
    } as never);

    const result = await client.getPageRestrictions('12345');

    expect(result).toEqual([
      { operation: 'read', restrictions: { users: [], groups: [] } },
    ]);
  });

  it('handles DC responses that omit the user / group keys entirely when empty', async () => {
    const client = new ConfluenceClient(baseUrl, pat, retryOpts);
    const response = {
      results: [
        { operation: 'read', restrictions: {} },       // both keys missing
        { operation: 'update', restrictions: null },    // restrictions envelope missing
      ],
      start: 0, limit: 100, size: 2,
    };
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: { text: async () => JSON.stringify(response) },
    } as never);

    const result = await client.getPageRestrictions('12345');

    expect(result).toEqual([
      { operation: 'read', restrictions: { users: [], groups: [] } },
      { operation: 'update', restrictions: { users: [], groups: [] } },
    ]);
  });
});

describe('getPageAncestors', () => {
  const baseUrl = 'https://confluence.example.com';
  const pat = 'test-pat-token';
  const retryOpts = { retry: { maxAttempts: 1, baseDelay: 1 } };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the ancestor array in Confluence root-first order', async () => {
    const client = new ConfluenceClient(baseUrl, pat, retryOpts);
    // Confluence returns ancestors root-first: [root, intermediate]
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: {
        text: async () => JSON.stringify({
          id: '12345',
          ancestors: [
            { id: 'root-1', title: 'Root' },
            { id: 'parent-1', title: 'Immediate Parent' },
          ],
        }),
      },
    } as never);

    const result = await client.getPageAncestors('12345');

    expect(result).toEqual([{ id: 'root-1' }, { id: 'parent-1' }]);
    const callUrl = mockRequest.mock.calls[0][0] as string;
    expect(callUrl).toContain('/rest/api/content/12345?expand=ancestors');
  });

  it('returns [] for a top-level page (ancestors key missing or empty)', async () => {
    const client = new ConfluenceClient(baseUrl, pat, retryOpts);

    // First sub-case: ancestors key entirely absent
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      headers: {},
      body: { text: async () => JSON.stringify({ id: '12345' }) },
    } as never);

    const missing = await client.getPageAncestors('12345');
    expect(missing).toEqual([]);

    // Second sub-case: ancestors: []
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      headers: {},
      body: { text: async () => JSON.stringify({ id: '12345', ancestors: [] }) },
    } as never);

    const empty = await client.getPageAncestors('12345');
    expect(empty).toEqual([]);
  });

  it('throws ConfluenceError on non-200 response', async () => {
    const client = new ConfluenceClient(baseUrl, pat, retryOpts);
    mockRequest.mockResolvedValue({
      statusCode: 500,
      headers: {},
      body: { text: async () => 'Internal Server Error' },
    } as never);

    await expect(client.getPageAncestors('12345')).rejects.toThrow(ConfluenceError);
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

describe('buildDownloadUrl', () => {
  const base = 'https://confluence.example.com';

  it('should encode spaces in filenames', () => {
    const url = buildDownloadUrl('/download/attachments/123/image 2018.png', base);
    expect(url).toBe('https://confluence.example.com/download/attachments/123/image%202018.png');
  });

  it('should encode colons in filenames', () => {
    const url = buildDownloadUrl('/download/attachments/228459100/image2018-1-22 9:26:20.png', base);
    expect(url).toBe(
      'https://confluence.example.com/download/attachments/228459100/image2018-1-22%209%3A26%3A20.png',
    );
  });

  it('should preserve query string as-is', () => {
    const url = buildDownloadUrl(
      '/download/attachments/123/file.png?version=1&modificationDate=1516609580000&api=v2',
      base,
    );
    expect(url).toBe(
      'https://confluence.example.com/download/attachments/123/file.png?version=1&modificationDate=1516609580000&api=v2',
    );
  });

  it('should not double-encode already percent-encoded filenames', () => {
    const url = buildDownloadUrl('/download/attachments/123/image%202018.png', base);
    expect(url).toBe('https://confluence.example.com/download/attachments/123/image%202018.png');
  });

  it('should decode + as space then re-encode', () => {
    const url = buildDownloadUrl('/download/attachments/123/image+2018.png', base);
    expect(url).toBe('https://confluence.example.com/download/attachments/123/image%202018.png');
  });

  it('should handle simple paths without special characters', () => {
    const url = buildDownloadUrl('/download/attachments/123/file.pdf', base);
    expect(url).toBe('https://confluence.example.com/download/attachments/123/file.pdf');
  });

  it('should encode brackets and other special characters', () => {
    const url = buildDownloadUrl('/download/attachments/123/report (final).png', base);
    expect(url).toBe(
      'https://confluence.example.com/download/attachments/123/report%20(final).png',
    );
  });

  it('should handle paths without query string', () => {
    const url = buildDownloadUrl('/download/attachments/123/file.png', base);
    expect(url).toBe('https://confluence.example.com/download/attachments/123/file.png');
  });
});

describe('buildDownloadUrlCandidates', () => {
  const base = 'https://confluence.example.com';

  it('should return a single URL for simple paths (all strategies produce the same URL)', () => {
    const urls = buildDownloadUrlCandidates('/download/attachments/123/file.pdf', base);
    expect(urls).toEqual([
      'https://confluence.example.com/download/attachments/123/file.pdf',
    ]);
  });

  it('should return 3 unique URLs for filenames with special chars and query params', () => {
    const urls = buildDownloadUrlCandidates(
      '/download/attachments/123/image 2018-1-22 9:26:20.png?version=1&api=v2',
      base,
    );
    expect(urls).toEqual([
      // 1. Raw URL with literal spaces escaped to %20
      'https://confluence.example.com/download/attachments/123/image%202018-1-22%209:26:20.png?version=1&api=v2',
      // 2. Fully encoded path + query (colons also encoded)
      'https://confluence.example.com/download/attachments/123/image%202018-1-22%209%3A26%3A20.png?version=1&api=v2',
      // 3. Raw path without query params
      'https://confluence.example.com/download/attachments/123/image%202018-1-22%209:26:20.png',
    ]);
  });

  it('should return raw URL first preserving + encoding from Confluence', () => {
    const urls = buildDownloadUrlCandidates(
      '/download/attachments/123/image+name.png',
      base,
    );
    expect(urls).toEqual([
      // 1. Raw: + preserved (Confluence uses + for spaces in paths)
      'https://confluence.example.com/download/attachments/123/image+name.png',
      // 2. Encoded: + decoded as space then re-encoded as %20
      'https://confluence.example.com/download/attachments/123/image%20name.png',
    ]);
  });

  it('should return 2 URLs when only query param removal produces a unique URL', () => {
    const urls = buildDownloadUrlCandidates(
      '/download/attachments/123/file.pdf?version=1&modificationDate=123&api=v2',
      base,
    );
    expect(urls).toEqual([
      'https://confluence.example.com/download/attachments/123/file.pdf?version=1&modificationDate=123&api=v2',
      'https://confluence.example.com/download/attachments/123/file.pdf',
    ]);
  });
});

describe('downloadAttachment fallback strategies', () => {
  const baseUrl = 'https://confluence.example.com';
  const pat = 'test-pat';
  const retryOpts = { maxAttempts: 1, baseDelay: 1 };
  const mockRequest = request as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should try raw URL first, then fallback to encoded URL on 500', async () => {
    const client = new ConfluenceClient(baseUrl, pat, { retry: retryOpts });
    let callCount = 0;
    mockRequest.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First strategy (raw URL) fails with 500
        return {
          statusCode: 500,
          headers: {},
          body: { text: async () => 'Internal Server Error' },
        } as never;
      }
      // Second strategy (encoded URL) succeeds
      return {
        statusCode: 200,
        headers: {},
        body: (async function* () {
          yield Buffer.from('image-data');
        })(),
      } as never;
    });

    const result = await client.downloadAttachment(
      '/download/attachments/123/image+2018-1-22+9%3A26%3A20.png?version=1&api=v2',
    );

    expect(result.toString()).toBe('image-data');
    // Raw URL failed, encoded URL succeeded
    expect(mockRequest).toHaveBeenCalledTimes(2);
    // First call should be the raw URL (preserving + and %3A from Confluence)
    const firstUrl = mockRequest.mock.calls[0][0] as string;
    expect(firstUrl).toBe(
      'https://confluence.example.com/download/attachments/123/image+2018-1-22+9%3A26%3A20.png?version=1&api=v2',
    );
  });

  it('should try URL without query params when both raw and encoded fail', async () => {
    const client = new ConfluenceClient(baseUrl, pat, { retry: retryOpts });
    let callCount = 0;
    mockRequest.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        return {
          statusCode: 500,
          headers: {},
          body: { text: async () => 'Internal Server Error' },
        } as never;
      }
      return {
        statusCode: 200,
        headers: {},
        body: (async function* () {
          yield Buffer.from('image-data');
        })(),
      } as never;
    });

    const result = await client.downloadAttachment(
      '/download/attachments/123/image 9:26.png?version=1&api=v2',
    );

    expect(result.toString()).toBe('image-data');
    expect(mockRequest).toHaveBeenCalledTimes(3);
    // Third call is raw URL without query params (spaces → %20, colons preserved)
    const thirdUrl = mockRequest.mock.calls[2][0] as string;
    expect(thirdUrl).toBe(
      'https://confluence.example.com/download/attachments/123/image%209:26.png',
    );
  });

  it('should throw immediately on 429 without trying fallback URLs', async () => {
    const client = new ConfluenceClient(baseUrl, pat, { retry: retryOpts });
    mockRequest.mockResolvedValue({
      statusCode: 429,
      headers: { 'retry-after': '0' },
      body: { text: async () => 'Rate limited' },
    } as never);

    await expect(
      client.downloadAttachment('/download/attachments/123/image+name.png?version=1&api=v2'),
    ).rejects.toThrow(ConfluenceError);

    // Only 1 call — 429 throws immediately, no fallback
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('should use dispatcher for redirect support in download requests', async () => {
    const client = new ConfluenceClient(baseUrl, pat, { retry: retryOpts });
    mockRequest.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: (async function* () {
        yield Buffer.from('data');
      })(),
    } as never);

    await client.downloadAttachment('/download/attachments/123/file.pdf');

    const opts = mockRequest.mock.calls[0][1] as Record<string, unknown>;
    // maxRedirections removed in undici v7; redirect is handled by the dispatcher's interceptor
    expect(opts.dispatcher).toBeDefined();
    expect(opts.maxRedirections).toBeUndefined();
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
