import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fs before importing the module
vi.mock('fs', () => ({
  readFileSync: vi.fn(() => { throw new Error('File not found'); }),
}));

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

  // We need to dynamically import the module after mocks are set up
  // and env vars are configured, since caBundleContents is loaded at module level.
  async function createClient(envOverrides: Record<string, string | undefined> = {}) {
    const originalEnv = { ...process.env };
    Object.assign(process.env, envOverrides);

    // Reset module registry so caBundleContents is re-evaluated
    vi.resetModules();

    // Re-mock after resetModules
    vi.doMock('fs', () => ({
      readFileSync: vi.fn((...args: unknown[]) => {
        const mockFn = envOverrides._mockCaBundle
          ? () => envOverrides._mockCaBundle
          : () => { throw new Error('File not found'); };
        return mockFn();
      }),
    }));
    vi.doMock('undici', () => ({ request: mockRequest }));
    vi.doMock('../utils/ssrf-guard.js', () => ({ validateUrl: vi.fn() }));

    const mod = await import('./confluence-client.js');
    const client = new mod.ConfluenceClient(baseUrl, pat);

    // Restore env
    for (const key of Object.keys(envOverrides)) {
      if (key.startsWith('_')) continue;
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }

    return { client, ConfluenceClient: mod.ConfluenceClient, ConfluenceError: mod.ConfluenceError };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('SSL configuration', () => {
    it('should not set connect options when SSL is verified and no CA bundle', async () => {
      const { client } = await createClient({
        CONFLUENCE_VERIFY_SSL: 'true',
        NODE_EXTRA_CA_CERTS: undefined,
      });

      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 100, size: 0 }) },
      } as never);

      await client.getSpaces();

      const callArgs = mockRequest.mock.calls[0];
      expect(callArgs[1]).not.toHaveProperty('connect');
    });

    it('should disable SSL verification when CONFLUENCE_VERIFY_SSL=false', async () => {
      const { client } = await createClient({
        CONFLUENCE_VERIFY_SSL: 'false',
        NODE_EXTRA_CA_CERTS: undefined,
      });

      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 100, size: 0 }) },
      } as never);

      await client.getSpaces();

      const callArgs = mockRequest.mock.calls[0];
      expect(callArgs[1]).toHaveProperty('connect', { rejectUnauthorized: false });
    });

    it('should pass CA bundle in connect options when NODE_EXTRA_CA_CERTS is set', async () => {
      const fakeCaBundle = '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----';
      const { client } = await createClient({
        CONFLUENCE_VERIFY_SSL: 'true',
        NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt',
        _mockCaBundle: fakeCaBundle,
      });

      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 100, size: 0 }) },
      } as never);

      await client.getSpaces();

      const callArgs = mockRequest.mock.calls[0];
      expect(callArgs[1]).toHaveProperty('connect');
      expect((callArgs[1] as Record<string, unknown>).connect).toEqual({ ca: fakeCaBundle });
    });

    it('should prefer rejectUnauthorized=false over CA bundle when CONFLUENCE_VERIFY_SSL=false', async () => {
      const { client } = await createClient({
        CONFLUENCE_VERIFY_SSL: 'false',
        NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt',
        _mockCaBundle: 'fake-ca-bundle',
      });

      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 100, size: 0 }) },
      } as never);

      await client.getSpaces();

      const callArgs = mockRequest.mock.calls[0];
      expect(callArgs[1]).toHaveProperty('connect', { rejectUnauthorized: false });
    });
  });

  describe('request headers', () => {
    it('should send Bearer PAT in Authorization header', async () => {
      const { client } = await createClient({ NODE_EXTRA_CA_CERTS: undefined });

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
      const { client, ConfluenceError } = await createClient({ NODE_EXTRA_CA_CERTS: undefined });

      mockRequest.mockResolvedValue({
        statusCode: 401,
        body: { text: async () => 'Unauthorized' },
      } as never);

      await expect(client.getSpaces()).rejects.toThrow(ConfluenceError);
      await expect(client.getSpaces()).rejects.toThrow('Invalid or expired PAT');
    });

    it('should throw ConfluenceError with 403 for forbidden', async () => {
      const { client } = await createClient({ NODE_EXTRA_CA_CERTS: undefined });

      mockRequest.mockResolvedValue({
        statusCode: 403,
        body: { text: async () => 'Forbidden' },
      } as never);

      await expect(client.getSpaces()).rejects.toThrow('Insufficient permissions');
    });

    it('should throw ConfluenceError with 404 for not found', async () => {
      const { client } = await createClient({ NODE_EXTRA_CA_CERTS: undefined });

      mockRequest.mockResolvedValue({
        statusCode: 404,
        body: { text: async () => 'Not found' },
      } as never);

      await expect(client.getSpaces()).rejects.toThrow('Resource not found');
    });
  });

  describe('URL handling', () => {
    it('should strip trailing slashes from base URL', async () => {
      vi.resetModules();
      vi.doMock('fs', () => ({
        readFileSync: vi.fn(() => { throw new Error('not found'); }),
      }));
      vi.doMock('undici', () => ({ request: mockRequest }));
      vi.doMock('../utils/ssrf-guard.js', () => ({ validateUrl: vi.fn() }));
      delete process.env.NODE_EXTRA_CA_CERTS;

      const mod = await import('./confluence-client.js');
      const client = new mod.ConfluenceClient('https://confluence.example.com///', pat);

      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 100, size: 0 }) },
      } as never);

      await client.getSpaces();

      const callUrl = mockRequest.mock.calls[0][0] as string;
      expect(callUrl).toBe('https://confluence.example.com/rest/api/space?start=0&limit=100&type=global');
    });
  });

  describe('downloadAttachment SSL', () => {
    it('should disable SSL for downloads when CONFLUENCE_VERIFY_SSL=false', async () => {
      const { client } = await createClient({
        CONFLUENCE_VERIFY_SSL: 'false',
        NODE_EXTRA_CA_CERTS: undefined,
      });

      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: (async function* () {
          yield Buffer.from('file-content');
        })(),
      } as never);

      await client.downloadAttachment('/download/attachments/123/file.pdf');

      const callArgs = mockRequest.mock.calls[0];
      expect(callArgs[1]).toHaveProperty('connect', { rejectUnauthorized: false });
    });

    it('should pass CA bundle for downloads when NODE_EXTRA_CA_CERTS is set', async () => {
      const fakeCaBundle = '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----';
      const { client } = await createClient({
        CONFLUENCE_VERIFY_SSL: 'true',
        NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt',
        _mockCaBundle: fakeCaBundle,
      });

      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: (async function* () {
          yield Buffer.from('file-content');
        })(),
      } as never);

      await client.downloadAttachment('/download/attachments/123/file.pdf');

      const callArgs = mockRequest.mock.calls[0];
      expect((callArgs[1] as Record<string, unknown>).connect).toEqual({ ca: fakeCaBundle });
    });
  });
});
