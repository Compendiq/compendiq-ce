import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn();
const mockRedisDel = vi.fn();
const mockRedisExpire = vi.fn();
let redis: {
  get: typeof mockRedisGet;
  set: typeof mockRedisSet;
  del: typeof mockRedisDel;
  expire: typeof mockRedisExpire;
} | null = null;

vi.mock('../../../core/services/redis-cache.js', () => ({
  getRedisClient: () => redis,
}));

vi.mock('../../../core/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  getNotionImportStatus,
  NOTION_IMPORT_LOCK_TTL_SEC,
  releaseNotionImportLock,
  resetNotionImportStatusForTests,
  setNotionImportStatus,
  tryStartNotionImport,
} from './notion-import-job.js';

describe('Notion import job status', () => {
  beforeEach(() => {
    resetNotionImportStatusForTests();
    mockRedisGet.mockReset();
    mockRedisSet.mockReset();
    mockRedisDel.mockReset();
    mockRedisExpire.mockReset();
    redis = null;
  });

  it('returns idle when nothing has been stored', async () => {
    await expect(getNotionImportStatus('user-1')).resolves.toEqual({ status: 'idle' });
  });

  it('round-trips importing and complete through memory when Redis is down', async () => {
    const lock = await tryStartNotionImport('user-1');
    expect(lock).toEqual(expect.any(String));
    await expect(getNotionImportStatus('user-1')).resolves.toEqual({ status: 'importing' });

    await setNotionImportStatus('user-1', {
      status: 'complete',
      items: [{ notionPageId: 'page-1', status: 'success', localPageId: 9 }],
    });
    await releaseNotionImportLock('user-1', lock!);
    await expect(getNotionImportStatus('user-1')).resolves.toEqual({
      status: 'complete',
      items: [{ notionPageId: 'page-1', status: 'success', localPageId: 9 }],
    });
  });

  it('rejects a second start while the lock is held in memory', async () => {
    expect(await tryStartNotionImport('user-1')).toEqual(expect.any(String));
    expect(await tryStartNotionImport('user-1')).toBeNull();
  });

  it('writes the lock with SET NX and a 10-minute TTL, status importing with the same TTL', async () => {
    const store = new Map<string, string>();
    redis = {
      get: mockRedisGet.mockImplementation(async (key: string) => store.get(key) ?? null),
      set: mockRedisSet.mockImplementation(async (key: string, value: string, opts?: { NX?: boolean }) => {
        if (opts?.NX && store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      }),
      del: mockRedisDel.mockImplementation(async (key: string) => {
        store.delete(key);
        return 1;
      }),
      expire: mockRedisExpire.mockResolvedValue(true),
    };

    const lock = await tryStartNotionImport('user-2');
    expect(lock).toEqual(expect.any(String));
    expect(mockRedisSet).toHaveBeenCalledWith(
      'notion:import:lock:user-2',
      lock,
      { NX: true, EX: NOTION_IMPORT_LOCK_TTL_SEC },
    );
    expect(mockRedisSet).toHaveBeenCalledWith(
      'notion:import:status:user-2',
      JSON.stringify({ status: 'importing' }),
      { EX: NOTION_IMPORT_LOCK_TTL_SEC },
    );
    expect(await tryStartNotionImport('user-2')).toBeNull();
    await expect(getNotionImportStatus('user-2')).resolves.toEqual({ status: 'importing' });
  });

  it('writes complete with a 24h TTL', async () => {
    redis = {
      get: mockRedisGet.mockResolvedValue(null),
      set: mockRedisSet.mockResolvedValue('OK'),
      del: mockRedisDel.mockResolvedValue(1),
      expire: mockRedisExpire.mockResolvedValue(true),
    };

    await setNotionImportStatus('user-2', {
      status: 'complete',
      items: [{ notionPageId: 'page-1', status: 'success', localPageId: 9 }],
    });
    expect(mockRedisSet).toHaveBeenCalledWith(
      'notion:import:status:user-2',
      JSON.stringify({
        status: 'complete',
        items: [{ notionPageId: 'page-1', status: 'success', localPageId: 9 }],
      }),
      { EX: 24 * 60 * 60 },
    );
  });

  it('treats a missing Redis key as idle and clears leftover memory', async () => {
    const lock = await tryStartNotionImport('user-3');
    expect(lock).toEqual(expect.any(String));
    await expect(getNotionImportStatus('user-3')).resolves.toEqual({ status: 'importing' });

    redis = {
      get: mockRedisGet.mockResolvedValue(null),
      set: mockRedisSet.mockResolvedValue('OK'),
      del: mockRedisDel.mockResolvedValue(1),
      expire: mockRedisExpire.mockResolvedValue(true),
    };
    await expect(getNotionImportStatus('user-3')).resolves.toEqual({ status: 'idle' });
    redis = null;
    await expect(getNotionImportStatus('user-3')).resolves.toEqual({ status: 'idle' });
  });

  it('treats importing status without a live lock as idle', async () => {
    const store = new Map<string, string>([
      ['notion:import:status:user-4', JSON.stringify({ status: 'importing' })],
    ]);
    redis = {
      get: mockRedisGet.mockImplementation(async (key: string) => store.get(key) ?? null),
      set: mockRedisSet.mockResolvedValue('OK'),
      del: mockRedisDel.mockImplementation(async (key: string) => {
        store.delete(key);
        return 1;
      }),
      expire: mockRedisExpire.mockResolvedValue(true),
    };

    await expect(getNotionImportStatus('user-4')).resolves.toEqual({ status: 'idle' });
    expect(mockRedisDel).toHaveBeenCalledWith('notion:import:status:user-4');
  });

  it('falls back to memory when Redis get throws', async () => {
    redis = {
      get: mockRedisGet,
      set: mockRedisSet.mockResolvedValue('OK'),
      del: mockRedisDel.mockResolvedValue(1),
      expire: mockRedisExpire.mockResolvedValue(true),
    };
    mockRedisGet.mockRejectedValue(new Error('redis down'));
    const lock = await tryStartNotionImport('user-5');
    expect(lock).toEqual(expect.any(String));

    mockRedisGet.mockRejectedValue(new Error('redis down'));
    await expect(getNotionImportStatus('user-5')).resolves.toEqual({ status: 'importing' });
  });
});
