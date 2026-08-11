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
  getRagConfidenceThreshold,
  getRagConfidenceThresholdRerank,
  getRagContextCharsPerPage,
  invalidateRagContextCharsCache,
  RAG_CONTEXT_CHARS_DEFAULT,
  RAG_CONTEXT_CHARS_MAX,
  initLlmQueueSettings,
  invalidateRagConfidenceThresholdCache,
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

describe('confidence-threshold getters (#1105, per-basis since #1268 review)', () => {
  function respondWith(values: Record<string, string>) {
    mockQuery.mockImplementation(async (_sql: string, params?: unknown[]) => {
      const key = Array.isArray(params) ? (params[0] as string) : '';
      const v = values[key];
      return v === undefined ? { rows: [] } : { rows: [{ setting_value: v }] };
    });
  }

  beforeEach(() => {
    mockQuery.mockReset();
    invalidateRagConfidenceThresholdCache();
  });

  it('returns the persisted value for a plain decimal in [0, 1)', async () => {
    respondWith({ rag_confidence_threshold: '0.35' });
    expect(await getRagConfidenceThreshold()).toBe(0.35);
  });

  it('defaults to 0 (gate off) when the row is absent', async () => {
    respondWith({});
    expect(await getRagConfidenceThreshold()).toBe(0);
    expect(await getRagConfidenceThresholdRerank()).toBe(0);
  });

  it('the two bases read their own keys and never cross (#1268 B2)', async () => {
    respondWith({
      rag_confidence_threshold: '0.4',
      rag_confidence_threshold_rerank: '0.1',
    });
    expect(await getRagConfidenceThreshold()).toBe(0.4);
    expect(await getRagConfidenceThresholdRerank()).toBe(0.1);
  });

  it("rejects '1' — maximal strictness must not silently mean off (#1268 M4)", async () => {
    respondWith({ rag_confidence_threshold: '1' });
    expect(await getRagConfidenceThreshold()).toBe(0);
  });

  it("rejects locale/percent shapes ('0,35', '35%') instead of parseFloat-ing them to nonsense", async () => {
    // parseFloat('0,35') === 0: an in-range value that silently disables the
    // gate while looking accepted. Strict shape rejects it loudly.
    respondWith({ rag_confidence_threshold: '0,35' });
    expect(await getRagConfidenceThreshold()).toBe(0);
    invalidateRagConfidenceThresholdCache();
    respondWith({ rag_confidence_threshold: '35%' });
    expect(await getRagConfidenceThreshold()).toBe(0);
  });

  it('accepts the boundary 0 and the shape .5', async () => {
    respondWith({ rag_confidence_threshold: '0', rag_confidence_threshold_rerank: '.5' });
    expect(await getRagConfidenceThreshold()).toBe(0);
    expect(await getRagConfidenceThresholdRerank()).toBe(0.5);
  });

  it("treats an empty/whitespace row as UNSET — default 0, no warning (#1268 review)", async () => {
    // A panel's "clear" writing '' must not become a once-a-minute WARN for
    // the life of the process.
    const { logger } = await import('../utils/logger.js');
    vi.mocked(logger.warn).mockClear();
    respondWith({ rag_confidence_threshold: '' });
    expect(await getRagConfidenceThreshold()).toBe(0);
    invalidateRagConfidenceThresholdCache();
    respondWith({ rag_confidence_threshold: '   ' });
    expect(await getRagConfidenceThreshold()).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
    // A genuinely malformed value still warns loudly.
    invalidateRagConfidenceThresholdCache();
    respondWith({ rag_confidence_threshold: 'banana' });
    expect(await getRagConfidenceThreshold()).toBe(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('never throws when the DB query rejects — gate off', async () => {
    mockQuery.mockRejectedValue(new Error('postgres unreachable'));
    expect(await getRagConfidenceThreshold()).toBe(0);
  });

  it('caches per key within the TTL and re-reads after invalidation', async () => {
    respondWith({ rag_confidence_threshold: '0.35' });
    await getRagConfidenceThreshold();
    await getRagConfidenceThreshold();
    expect(mockQuery).toHaveBeenCalledTimes(1);

    respondWith({ rag_confidence_threshold: '0.6' });
    // Still cached — the new DB value is not visible yet.
    expect(await getRagConfidenceThreshold()).toBe(0.35);
    invalidateRagConfidenceThresholdCache();
    expect(await getRagConfidenceThreshold()).toBe(0.6);
  });
});

describe('rag_context_chars_per_page getter (#1106 PR 2)', () => {
  function respondWith(value?: string) {
    mockQuery.mockImplementation(async () =>
      value === undefined ? { rows: [] } : { rows: [{ setting_value: value }] },
    );
  }

  beforeEach(() => {
    mockQuery.mockReset();
    invalidateRagContextCharsCache();
  });

  it('returns the persisted budget and caches it within the TTL', async () => {
    respondWith('9000');
    expect(await getRagContextCharsPerPage()).toBe(9000);
    await getRagContextCharsPerPage();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('accepts 0 as the operator kill switch — assembly off, not a fallback to default', async () => {
    respondWith('0');
    expect(await getRagContextCharsPerPage()).toBe(0);
  });

  it('defaults to 6000 when absent, and clamps to the 24000 cap', async () => {
    respondWith();
    expect(await getRagContextCharsPerPage()).toBe(RAG_CONTEXT_CHARS_DEFAULT);
    invalidateRagContextCharsCache();
    respondWith('999999');
    expect(await getRagContextCharsPerPage()).toBe(RAG_CONTEXT_CHARS_MAX);
  });

  it('falls back to the default on garbage and on DB failure', async () => {
    respondWith('lots');
    expect(await getRagContextCharsPerPage()).toBe(RAG_CONTEXT_CHARS_DEFAULT);
    invalidateRagContextCharsCache();
    mockQuery.mockRejectedValue(new Error('postgres unreachable'));
    expect(await getRagContextCharsPerPage()).toBe(RAG_CONTEXT_CHARS_DEFAULT);
  });
});
