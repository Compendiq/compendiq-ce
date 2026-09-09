import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn();
let redis: { get: typeof mockRedisGet; set: typeof mockRedisSet } | null = null;

vi.mock('../../../core/services/redis-cache.js', () => ({
  getRedisClient: () => redis,
}));

vi.mock('../../../core/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  getNotionImportStatus,
  resetNotionImportStatusForTests,
  setNotionImportStatus,
} from './notion-import-job.js';

describe('Notion import job status', () => {
  beforeEach(() => {
    resetNotionImportStatusForTests();
    mockRedisGet.mockReset();
    mockRedisSet.mockReset();
    redis = null;
  });

  it('returns idle when nothing has been stored', async () => {
    await expect(getNotionImportStatus('user-1')).resolves.toEqual({ status: 'idle' });
  });

  it('round-trips importing and complete through memory when Redis is down', async () => {
    await setNotionImportStatus('user-1', { status: 'importing' });
    await expect(getNotionImportStatus('user-1')).resolves.toEqual({ status: 'importing' });

    await setNotionImportStatus('user-1', {
      status: 'complete',
      items: [{ notionPageId: 'page-1', status: 'success', localPageId: 9 }],
    });
    await expect(getNotionImportStatus('user-1')).resolves.toEqual({
      status: 'complete',
      items: [{ notionPageId: 'page-1', status: 'success', localPageId: 9 }],
    });
  });

  it('writes Redis with a 24h TTL and prefers Redis on read', async () => {
    redis = { get: mockRedisGet, set: mockRedisSet };
    mockRedisSet.mockResolvedValue('OK');
    mockRedisGet.mockResolvedValue(JSON.stringify({ status: 'importing' }));

    await setNotionImportStatus('user-2', { status: 'importing' });
    expect(mockRedisSet).toHaveBeenCalledWith(
      'notion:import:status:user-2',
      JSON.stringify({ status: 'importing' }),
      { EX: 24 * 60 * 60 },
    );

    await expect(getNotionImportStatus('user-2')).resolves.toEqual({ status: 'importing' });
    expect(mockRedisGet).toHaveBeenCalledWith('notion:import:status:user-2');
  });

  it('falls back to memory when Redis get throws', async () => {
    redis = { get: mockRedisGet, set: mockRedisSet };
    mockRedisSet.mockResolvedValue('OK');
    await setNotionImportStatus('user-3', { status: 'error', error: 'Notion resource not found' });
    mockRedisGet.mockRejectedValue(new Error('redis down'));

    await expect(getNotionImportStatus('user-3')).resolves.toEqual({
      status: 'error',
      error: 'Notion resource not found',
    });
  });
});
