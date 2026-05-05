import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../db/postgres.js', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
}));

// `redis-cache-bus` is referenced by `cached-setting.ts`. Mock it so the
// `subscribe` + `onReconnect` calls during init are no-ops — tests verify
// behaviour against the cold-load path only.
const mockSubscribe = vi.fn(() => () => undefined);
const mockOnReconnect = vi.fn(() => () => undefined);
vi.mock('./redis-cache-bus.js', () => ({
  subscribe: (...args: unknown[]) => mockSubscribe(...args),
  onReconnect: (fn: () => void | Promise<void>) => mockOnReconnect(fn),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  getAdminAccessDeniedRetentionDays,
  getLlmConcurrency,
  getLlmMaxQueueDepth,
  initLlmQueueSettings,
  _resetLlmQueueSettingsForTests,
} from './admin-settings-service.js';

describe('getAdminAccessDeniedRetentionDays (#264)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    delete process.env.RETENTION_ADMIN_ACCESS_DENIED_DAYS;
  });

  afterEach(() => {
    delete process.env.RETENTION_ADMIN_ACCESS_DENIED_DAYS;
  });

  it('returns the persisted admin_settings value when in range', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ setting_value: '30' }] });
    await expect(getAdminAccessDeniedRetentionDays()).resolves.toBe(30);
  });

  it('honours the env fallback when the admin_settings row is absent', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    process.env.RETENTION_ADMIN_ACCESS_DENIED_DAYS = '45';
    await expect(getAdminAccessDeniedRetentionDays()).resolves.toBe(45);
  });

  it('returns the hard default of 90 when both the DB row and the env var are missing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(getAdminAccessDeniedRetentionDays()).resolves.toBe(90);
  });

  it('rejects an out-of-range DB value (1) and falls back to env / default', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ setting_value: '1' }] });
    await expect(getAdminAccessDeniedRetentionDays()).resolves.toBe(90);
  });

  it('rejects an out-of-range DB value (4000) and falls back to env / default', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ setting_value: '4000' }] });
    await expect(getAdminAccessDeniedRetentionDays()).resolves.toBe(90);
  });

  it('rejects a non-numeric DB value and falls back', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ setting_value: 'banana' }] });
    await expect(getAdminAccessDeniedRetentionDays()).resolves.toBe(90);
  });

  it('never throws when the DB query rejects — swallows and falls back', async () => {
    mockQuery.mockRejectedValueOnce(new Error('pool exhausted'));
    await expect(getAdminAccessDeniedRetentionDays()).resolves.toBe(90);
  });

  it('rejects an out-of-range env override and falls through to the hard default', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    process.env.RETENTION_ADMIN_ACCESS_DENIED_DAYS = '6'; // below min
    await expect(getAdminAccessDeniedRetentionDays()).resolves.toBe(90);
  });

  it('accepts boundary values — 7 and 3650', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ setting_value: '7' }] });
    await expect(getAdminAccessDeniedRetentionDays()).resolves.toBe(7);

    mockQuery.mockResolvedValueOnce({ rows: [{ setting_value: '3650' }] });
    await expect(getAdminAccessDeniedRetentionDays()).resolves.toBe(3650);
  });
});

// ─── #113 Phase B-3 — getLlmConcurrency / getLlmMaxQueueDepth ─────────────
describe('LLM queue cluster-wide cached getters (Phase B-3)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockSubscribe.mockReset();
    mockOnReconnect.mockReset();
    mockSubscribe.mockReturnValue(() => undefined);
    mockOnReconnect.mockReturnValue(() => undefined);
    delete process.env.LLM_CONCURRENCY;
    delete process.env.LLM_MAX_QUEUE_DEPTH;
    _resetLlmQueueSettingsForTests();
  });

  afterEach(() => {
    delete process.env.LLM_CONCURRENCY;
    delete process.env.LLM_MAX_QUEUE_DEPTH;
  });

  it('returns hardcoded defaults (4, 50) when uninitialised + no env vars', () => {
    expect(getLlmConcurrency()).toBe(4);
    expect(getLlmMaxQueueDepth()).toBe(50);
  });

  it('honours LLM_CONCURRENCY / LLM_MAX_QUEUE_DEPTH env when uninitialised', () => {
    process.env.LLM_CONCURRENCY = '8';
    process.env.LLM_MAX_QUEUE_DEPTH = '200';
    expect(getLlmConcurrency()).toBe(8);
    expect(getLlmMaxQueueDepth()).toBe(200);
  });

  it('cold-loads concurrency from admin_settings.llm_concurrency', async () => {
    mockQuery.mockImplementation(async (_sql: string, params?: unknown[]) => {
      if (Array.isArray(params) && params[0] === 'llm_concurrency') {
        return { rows: [{ setting_value: '12' }] };
      }
      return { rows: [] };
    });
    await initLlmQueueSettings();
    expect(getLlmConcurrency()).toBe(12);
  });

  it('cold-loads max-queue-depth from admin_settings.llm_max_queue_depth', async () => {
    mockQuery.mockImplementation(async (_sql: string, params?: unknown[]) => {
      if (Array.isArray(params) && params[0] === 'llm_max_queue_depth') {
        return { rows: [{ setting_value: '300' }] };
      }
      return { rows: [] };
    });
    await initLlmQueueSettings();
    expect(getLlmMaxQueueDepth()).toBe(300);
  });

  it('falls back to default on out-of-range concurrency (0)', async () => {
    // A corrupted DB row should NOT turn into pLimit(0). Defensive parse.
    mockQuery.mockImplementation(async (_sql: string, params?: unknown[]) => {
      if (Array.isArray(params) && params[0] === 'llm_concurrency') {
        return { rows: [{ setting_value: '0' }] };
      }
      return { rows: [] };
    });
    await initLlmQueueSettings();
    expect(getLlmConcurrency()).toBe(4);
  });

  it('falls back to default on out-of-range concurrency (101)', async () => {
    mockQuery.mockImplementation(async (_sql: string, params?: unknown[]) => {
      if (Array.isArray(params) && params[0] === 'llm_concurrency') {
        return { rows: [{ setting_value: '101' }] };
      }
      return { rows: [] };
    });
    await initLlmQueueSettings();
    expect(getLlmConcurrency()).toBe(4);
  });

  it('falls back to default on non-numeric DB value', async () => {
    mockQuery.mockImplementation(async (_sql: string, params?: unknown[]) => {
      if (Array.isArray(params) && params[0] === 'llm_concurrency') {
        return { rows: [{ setting_value: 'banana' }] };
      }
      return { rows: [] };
    });
    await initLlmQueueSettings();
    expect(getLlmConcurrency()).toBe(4);
  });

  it('subscribes to admin:llm:settings on init', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await initLlmQueueSettings();
    // makeCachedSetting subscribes once per cached getter — two getters → 2 subs.
    const channels = mockSubscribe.mock.calls.map((c) => c[0]);
    expect(channels).toContain('admin:llm:settings');
    expect(channels.filter((c) => c === 'admin:llm:settings')).toHaveLength(2);
  });

  it('falls back to env on cold-load DB failure (cached-setting soft-fails)', async () => {
    process.env.LLM_CONCURRENCY = '6';
    mockQuery.mockRejectedValue(new Error('postgres unreachable'));
    await initLlmQueueSettings();
    expect(getLlmConcurrency()).toBe(6);
  });

  it('re-init replaces the previous getters', async () => {
    mockQuery.mockImplementation(async (_sql: string, params?: unknown[]) => {
      if (Array.isArray(params) && params[0] === 'llm_concurrency') {
        return { rows: [{ setting_value: '12' }] };
      }
      return { rows: [] };
    });
    await initLlmQueueSettings();
    expect(getLlmConcurrency()).toBe(12);

    mockQuery.mockImplementation(async (_sql: string, params?: unknown[]) => {
      if (Array.isArray(params) && params[0] === 'llm_concurrency') {
        return { rows: [{ setting_value: '20' }] };
      }
      return { rows: [] };
    });
    await initLlmQueueSettings();
    expect(getLlmConcurrency()).toBe(20);
  });
});
