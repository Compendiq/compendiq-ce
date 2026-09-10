import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn();
const mockRedisDel = vi.fn();
const mockRedisEval = vi.fn();
let redis: {
  get: typeof mockRedisGet;
  set: typeof mockRedisSet;
  del: typeof mockRedisDel;
  eval: typeof mockRedisEval;
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
  renewNotionImportLock,
  resetNotionImportStatusForTests,
  setNotionImportStatus,
  tryStartNotionImport,
} from './notion-import-job.js';

function storeRedis(store: Map<string, string>) {
  return {
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
    eval: mockRedisEval.mockImplementation(
      async (script: string, opts: { keys: string[]; arguments: string[] }) => {
        const held = store.get(opts.keys[0]);
        if (held !== opts.arguments[0]) return 0;
        if (script.includes('redis.call("del"')) {
          store.delete(opts.keys[0]);
          return 1;
        }
        if (script.includes('redis.call("set"')) {
          store.set(opts.keys[1], opts.arguments[1]);
          return 1;
        }
        return 1;
      },
    ),
  };
}

describe('Notion import job status', () => {
  beforeEach(() => {
    resetNotionImportStatusForTests();
    mockRedisGet.mockReset();
    mockRedisSet.mockReset();
    mockRedisDel.mockReset();
    mockRedisEval.mockReset();
    redis = null;
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns idle when nothing has been stored', async () => {
    await expect(getNotionImportStatus('user-1')).resolves.toEqual({ status: 'idle' });
  });

  it('round-trips importing and complete through memory when Redis is down', async () => {
    const lock = await tryStartNotionImport('user-1');
    expect(lock).toEqual(expect.any(String));
    await expect(getNotionImportStatus('user-1')).resolves.toEqual({ status: 'importing' });

    expect(
      await setNotionImportStatus(
        'user-1',
        {
          status: 'complete',
          items: [{ notionPageId: 'page-1', status: 'success', localPageId: 9 }],
        },
        lock!,
      ),
    ).toBe(true);
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
    redis = storeRedis(store);

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

  it('writes complete with a 24h TTL only while the lock token matches', async () => {
    const store = new Map<string, string>();
    redis = storeRedis(store);
    const lock = await tryStartNotionImport('user-2');

    await setNotionImportStatus(
      'user-2',
      {
        status: 'complete',
        items: [{ notionPageId: 'page-1', status: 'success', localPageId: 9 }],
      },
      lock!,
    );
    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("set"'),
      {
        keys: ['notion:import:lock:user-2', 'notion:import:status:user-2'],
        arguments: [
          lock,
          JSON.stringify({
            status: 'complete',
            items: [{ notionPageId: 'page-1', status: 'success', localPageId: 9 }],
          }),
          String(24 * 60 * 60),
        ],
      },
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
      eval: mockRedisEval,
    };
    await expect(getNotionImportStatus('user-3')).resolves.toEqual({ status: 'idle' });
    redis = null;
    await expect(getNotionImportStatus('user-3')).resolves.toEqual({ status: 'idle' });
  });

  it('treats importing status without a live lock as idle', async () => {
    const store = new Map<string, string>([
      ['notion:import:status:user-4', JSON.stringify({ status: 'importing' })],
    ]);
    redis = storeRedis(store);

    await expect(getNotionImportStatus('user-4')).resolves.toEqual({ status: 'idle' });
    expect(mockRedisDel).toHaveBeenCalledWith('notion:import:status:user-4');
  });

  it('falls back to memory when Redis get throws', async () => {
    redis = {
      get: mockRedisGet,
      set: mockRedisSet.mockResolvedValue('OK'),
      del: mockRedisDel.mockResolvedValue(1),
      eval: mockRedisEval,
    };
    mockRedisGet.mockRejectedValue(new Error('redis down'));
    const lock = await tryStartNotionImport('user-5');
    expect(lock).toEqual(expect.any(String));

    mockRedisGet.mockRejectedValue(new Error('redis down'));
    await expect(getNotionImportStatus('user-5')).resolves.toEqual({ status: 'importing' });
  });

  it('fail-closes start when Redis SET NX throws', async () => {
    redis = {
      get: mockRedisGet,
      set: mockRedisSet.mockRejectedValue(new Error('redis down')),
      del: mockRedisDel,
      eval: mockRedisEval,
    };
    expect(await tryStartNotionImport('user-6')).toBeNull();
    await expect(getNotionImportStatus('user-6')).resolves.toEqual({ status: 'idle' });
  });

  it('renews with Lua and does not extend a lock held by another token', async () => {
    const store = new Map<string, string>();
    redis = storeRedis(store);
    const lock = await tryStartNotionImport('user-7');
    store.set('notion:import:lock:user-7', 'other-token');

    await renewNotionImportLock('user-7', lock!);
    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("expire"'),
      {
        keys: ['notion:import:lock:user-7', 'notion:import:status:user-7'],
        arguments: [lock, String(NOTION_IMPORT_LOCK_TTL_SEC)],
      },
    );
    expect(store.get('notion:import:lock:user-7')).toBe('other-token');
  });

  it('releases with Lua and does not delete a lock held by another token', async () => {
    const store = new Map<string, string>();
    redis = storeRedis(store);
    const lock = await tryStartNotionImport('user-7');
    store.set('notion:import:lock:user-7', 'other-token');

    await releaseNotionImportLock('user-7', lock!);
    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("del"'),
      {
        keys: ['notion:import:lock:user-7'],
        arguments: [lock],
      },
    );
    expect(store.get('notion:import:lock:user-7')).toBe('other-token');
  });

  it('does not let a late complete overwrite a newer run', async () => {
    const store = new Map<string, string>();
    redis = storeRedis(store);
    const stale = await tryStartNotionImport('user-8');
    store.set('notion:import:lock:user-8', 'fresh-token');
    store.set('notion:import:status:user-8', JSON.stringify({ status: 'importing' }));

    expect(
      await setNotionImportStatus(
        'user-8',
        {
          status: 'complete',
          items: [{ notionPageId: 'stale', status: 'success', localPageId: 1 }],
        },
        stale!,
      ),
    ).toBe(false);
    expect(JSON.parse(store.get('notion:import:status:user-8')!)).toEqual({ status: 'importing' });
  });

  it('does not let a late memory complete overwrite a lock acquired after TTL', async () => {
    vi.useFakeTimers();
    const stale = await tryStartNotionImport('user-9');
    vi.advanceTimersByTime(NOTION_IMPORT_LOCK_TTL_SEC * 1000 + 1);
    const fresh = await tryStartNotionImport('user-9');
    expect(fresh).toEqual(expect.any(String));
    expect(fresh).not.toBe(stale);

    expect(
      await setNotionImportStatus(
        'user-9',
        {
          status: 'complete',
          items: [{ notionPageId: 'stale', status: 'success', localPageId: 1 }],
        },
        stale!,
      ),
    ).toBe(false);
    await expect(getNotionImportStatus('user-9')).resolves.toEqual({ status: 'importing' });
    expect(
      await setNotionImportStatus(
        'user-9',
        {
          status: 'complete',
          items: [{ notionPageId: 'fresh', status: 'success', localPageId: 2 }],
        },
        fresh!,
      ),
    ).toBe(true);
    await releaseNotionImportLock('user-9', fresh!);
    await expect(getNotionImportStatus('user-9')).resolves.toEqual({
      status: 'complete',
      items: [{ notionPageId: 'fresh', status: 'success', localPageId: 2 }],
    });
  });
});
