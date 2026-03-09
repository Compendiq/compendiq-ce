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

// Mock tls-config — default: no connect options
const mockBuildConnectOptions = vi.fn().mockReturnValue(undefined);
const mockIsVerifySslEnabled = vi.fn().mockReturnValue(true);
vi.mock('../utils/tls-config.js', () => ({
  buildConnectOptions: (...args: unknown[]) => mockBuildConnectOptions(...args),
  isVerifySslEnabled: (...args: unknown[]) => mockIsVerifySslEnabled(...args),
}));

import { request } from 'undici';
import { ConfluenceClient, ConfluenceError } from './confluence-client.js';

const mockRequest = vi.mocked(request);

describe('ConfluenceClient', () => {
  const baseUrl = 'https://confluence.example.com';
  const pat = 'test-pat-token';

  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildConnectOptions.mockReturnValue(undefined);
    mockIsVerifySslEnabled.mockReturnValue(true);
  });

  describe('SSL configuration', () => {
    it('should not set connect options when SSL is verified and no CA bundle', async () => {
      mockBuildConnectOptions.mockReturnValue(undefined);

      const client = new ConfluenceClient(baseUrl, pat);
      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 100, size: 0 }) },
      } as never);

      await client.getSpaces();

      const callArgs = mockRequest.mock.calls[0];
      expect(callArgs[1]).not.toHaveProperty('connect');
    });

    it('should disable SSL verification when CONFLUENCE_VERIFY_SSL=false', async () => {
      mockBuildConnectOptions.mockReturnValue({ rejectUnauthorized: false });

      const client = new ConfluenceClient(baseUrl, pat);
      mockRequest.mockResolvedValue({
        statusCode: 200,
        body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 100, size: 0 }) },
      } as never);

      await client.getSpaces();

      const callArgs = mockRequest.mock.calls[0];
      expect(callArgs[1]).toHaveProperty('connect', { rejectUnauthorized: false });
    });

    it('should pass CA bundle in connect options when configured', async () => {
      const fakeCaBundle = '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----';
      mockBuildConnectOptions.mockReturnValue({ ca: fakeCaBundle });

      const client = new ConfluenceClient(baseUrl, pat);
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
      mockBuildConnectOptions.mockReturnValue({ rejectUnauthorized: false });

      const client = new ConfluenceClient(baseUrl, pat);
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

  describe('downloadAttachment SSL', () => {
    it('should disable SSL for downloads when CONFLUENCE_VERIFY_SSL=false', async () => {
      mockBuildConnectOptions.mockReturnValue({ rejectUnauthorized: false });

      const client = new ConfluenceClient(baseUrl, pat);
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

    it('should pass CA bundle for downloads when configured', async () => {
      const fakeCaBundle = '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----';
      mockBuildConnectOptions.mockReturnValue({ ca: fakeCaBundle });

      const client = new ConfluenceClient(baseUrl, pat);
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
