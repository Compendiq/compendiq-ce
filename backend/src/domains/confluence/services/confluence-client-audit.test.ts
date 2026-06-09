import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock undici request (low-level HTTP) — same boundary the other client tests mock.
vi.mock('undici', () => ({ request: vi.fn() }));
vi.mock('../../../core/utils/ssrf-guard.js', () => ({
  validateUrl: vi.fn(),
  addAllowedBaseUrl: vi.fn(),
  resolveConfluenceUrl: vi.fn((url: string) => url),
}));
vi.mock('../../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../core/utils/tls-config.js', () => ({
  confluenceDispatcher: {},
  buildConnectOptions: vi.fn().mockReturnValue(undefined),
  isVerifySslEnabled: vi.fn().mockReturnValue(true),
}));
vi.mock('./confluence-rate-limiter.js', () => ({ acquireToken: vi.fn().mockResolvedValue(undefined) }));

import { request } from 'undici';
import { ConfluenceClient, AuditUnavailableError } from './confluence-client.js';

const mockRequest = vi.mocked(request);

function jsonResponse(statusCode: number, payload: unknown) {
  return { statusCode, headers: {}, body: { text: async () => JSON.stringify(payload) } } as never;
}

describe('ConfluenceClient audit access', () => {
  const client = new ConfluenceClient('https://confluence.example.com', 'pat');

  beforeEach(() => vi.clearAllMocks());

  describe('getAuditRetention', () => {
    it('fetches /rest/api/audit/retention and returns the parsed period', async () => {
      mockRequest.mockResolvedValue(jsonResponse(200, { number: 3, units: 'YEARS' }));

      const retention = await client.getAuditRetention();

      expect(retention).toEqual({ number: 3, units: 'YEARS' });
      expect(String(mockRequest.mock.calls[0]![0])).toContain('/rest/api/audit/retention');
    });
  });

  describe('getAuditRecords', () => {
    it('queries from startDate (epoch ms) and returns normalized records', async () => {
      mockRequest.mockResolvedValue(
        jsonResponse(200, {
          results: [
            {
              creationDate: 1700000000000,
              category: 'Permissions',
              summary: 'Page restrictions updated',
              affectedObject: { id: '12345', type: 'page', name: 'Secret' },
            },
          ],
          start: 0,
          limit: 1000,
          size: 1,
        }),
      );

      const records = await client.getAuditRecords({ startDate: 1699990000000 });

      const url = String(mockRequest.mock.calls[0]![0]);
      expect(url).toContain('/rest/api/audit?');
      expect(url).toContain('startDate=1699990000000');
      expect(records).toHaveLength(1);
      expect(records[0]!.category).toBe('Permissions');
      expect(records[0]!.affectedObject).toEqual({ id: '12345', type: 'page', name: 'Secret' });
    });

    it('normalizes affectedObject.objectType to .type', async () => {
      mockRequest.mockResolvedValue(
        jsonResponse(200, {
          results: [{ creationDate: 1, category: 'Permissions', affectedObject: { id: '7', objectType: 'page', name: 'P' } }],
          start: 0,
          limit: 1000,
          size: 1,
        }),
      );

      const records = await client.getAuditRecords({ startDate: 0 });

      expect(records[0]!.affectedObject?.type).toBe('page');
    });

    it('paginates across multiple pages', async () => {
      mockRequest
        .mockResolvedValueOnce(
          jsonResponse(200, {
            results: [{ creationDate: 1, category: 'Permissions', affectedObject: { id: 'a', type: 'page', name: 'A' } }],
            start: 0,
            limit: 1,
            size: 1,
            _links: { next: '/rest/api/audit?start=1&limit=1' },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse(200, {
            results: [{ creationDate: 2, category: 'Permissions', affectedObject: { id: 'b', type: 'page', name: 'B' } }],
            start: 1,
            limit: 1,
            size: 1,
          }),
        );

      const records = await client.getAuditRecords({ startDate: 0, limit: 1 });

      expect(records.map((r) => r.affectedObject?.id)).toEqual(['a', 'b']);
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    it('throws AuditUnavailableError on 403 (no admin permission)', async () => {
      mockRequest.mockResolvedValue({ statusCode: 403, headers: {}, body: { text: async () => 'Forbidden' } } as never);
      await expect(client.getAuditRecords({ startDate: 0 })).rejects.toThrow(AuditUnavailableError);
    });

    it('throws AuditUnavailableError on 404 (audit unavailable)', async () => {
      mockRequest.mockResolvedValue({ statusCode: 404, headers: {}, body: { text: async () => 'Not found' } } as never);
      await expect(client.getAuditRecords({ startDate: 0 })).rejects.toThrow(AuditUnavailableError);
    });
  });
});
