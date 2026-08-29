import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

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
  getRagPinIdentifiersEnabled,
  invalidateRagPinIdentifiersCache,
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
  getRagImagesPerPageMax,
  getRagImageIndexExternal,
  invalidateRagImageIntakeCache,
  getRagImageLegEnabled,
  invalidateRagImageLegCache,
  getRagAnswerMaxImages,
  invalidateRagAnswerMaxImagesCache,
  RAG_ANSWER_MAX_IMAGES_DEFAULT,
  RAG_IMAGES_PER_PAGE_MAX_DEFAULT,
  getRagEfSearch,
  resolveRagEfSearch,
  invalidateRagEfSearchCache,
  noteRagEfSearchRowSaved,
  warnIfRagEfSearchEnvSet,
  RAG_EF_SEARCH_DEFAULT,
} from './admin-settings-service.js';
import { logger } from '../utils/logger.js';

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

  it("clamps a negative to 0 (off) — '-1' reads as a stronger kill switch, never the default (#1270 m11)", async () => {
    respondWith('-1');
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

  it("rejects parseInt truncation shapes — '1e4' and '8,000' must not become live tiny budgets (#1270 F5)", async () => {
    respondWith('1e4');
    expect(await getRagContextCharsPerPage()).toBe(RAG_CONTEXT_CHARS_DEFAULT);
    invalidateRagContextCharsCache();
    respondWith('8,000');
    expect(await getRagContextCharsPerPage()).toBe(RAG_CONTEXT_CHARS_DEFAULT);
  });

  it("a transient DB failure fails toward the operator's LAST KNOWN value, never re-enabling a disabled feature (#1270 F8)", async () => {
    vi.useFakeTimers();
    try {
      respondWith('0');
      expect(await getRagContextCharsPerPage()).toBe(0);
      // TTL expires; the settings SELECT blips. The stored 0 must survive.
      vi.advanceTimersByTime(61_000);
      mockQuery.mockRejectedValue(new Error('pool hiccup'));
      expect(await getRagContextCharsPerPage()).toBe(0);
      // And the error path did not refresh the TTL: recovery is immediate.
      respondWith('9000');
      expect(await getRagContextCharsPerPage()).toBe(9000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('rag_pin_identifiers kill switch (#1107 / #1273 M11)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    invalidateRagPinIdentifiersCache();
  });

  it('defaults ON when absent, and on DB failure', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await getRagPinIdentifiersEnabled()).toBe(true);
    invalidateRagPinIdentifiersCache();
    mockQuery.mockRejectedValue(new Error('down'));
    expect(await getRagPinIdentifiersEnabled()).toBe(true);
  });

  it("the literal '0'/'false'/'off' disables; anything else stays on", async () => {
    for (const [raw, expected] of [['0', false], ['false', false], ['off', false], ['1', true], ['yes', true]] as Array<[string, boolean]>) {
      invalidateRagPinIdentifiersCache();
      mockQuery.mockResolvedValue({ rows: [{ setting_value: raw }] });
      expect(await getRagPinIdentifiersEnabled()).toBe(expected);
    }
  });
});

describe('image-index intake knobs (#1115 P2)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    invalidateRagImageIntakeCache();
  });

  it('caps images per page at the default when the row is absent or the DB is down', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await getRagImagesPerPageMax()).toBe(RAG_IMAGES_PER_PAGE_MAX_DEFAULT);
    invalidateRagImageIntakeCache();
    mockQuery.mockRejectedValue(new Error('down'));
    expect(await getRagImagesPerPageMax()).toBe(RAG_IMAGES_PER_PAGE_MAX_DEFAULT);
  });

  it('clamps the cap into [1, 200] and refuses a malformed value', async () => {
    for (const [raw, expected] of [
      ['5', 5],
      ['200', 200],
      // Above the ceiling clamps; below the floor and unparseable fall back to
      // the default, which is `safeIntOr`'s semantics on every sibling knob
      // (`'1e3'` parses as 1 and must not silently become a cap of one).
      ['500', 200],
      ['0', RAG_IMAGES_PER_PAGE_MAX_DEFAULT],
      ['1e3', RAG_IMAGES_PER_PAGE_MAX_DEFAULT],
      ['nonsense', RAG_IMAGES_PER_PAGE_MAX_DEFAULT],
    ] as Array<[string, number]>) {
      invalidateRagImageIntakeCache();
      mockQuery.mockResolvedValue({ rows: [{ setting_key: 'rag_images_per_page_max', setting_value: raw }] });
      expect(await getRagImagesPerPageMax()).toBe(expected);
    }
  });

  it('indexes externally-fetched images by default, and on a DB failure', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await getRagImageIndexExternal()).toBe(true);
    invalidateRagImageIntakeCache();
    mockQuery.mockRejectedValue(new Error('down'));
    expect(await getRagImageIndexExternal()).toBe(true);
  });

  it("only the literal '0'/'false'/'off' excludes external images", async () => {
    for (const [raw, expected] of [
      ['0', false],
      ['false', false],
      ['off', false],
      ['1', true],
      ['yes', true],
      ['', true],
    ] as Array<[string, boolean]>) {
      invalidateRagImageIntakeCache();
      mockQuery.mockResolvedValue({ rows: [{ setting_key: 'rag_image_index_external', setting_value: raw }] });
      expect(await getRagImageIndexExternal()).toBe(expected);
    }
  });

  it('reads both knobs in ONE query, so a per-page read costs one round-trip', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { setting_key: 'rag_images_per_page_max', setting_value: '7' },
        { setting_key: 'rag_image_index_external', setting_value: '0' },
      ],
    });
    expect(await getRagImagesPerPageMax()).toBe(7);
    expect(await getRagImageIndexExternal()).toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe('rag_image_leg_enabled (#1115 P3)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    invalidateRagImageLegCache();
  });

  it('defaults ON when absent, and on DB failure', async () => {
    // Soft-fail must not narrow retrieval: an operator looking at a result set
    // that silently lost its image leg cannot tell a DB hiccup from a corpus
    // with no matching pictures. Same direction as the intake knobs.
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await getRagImageLegEnabled()).toBe(true);
    invalidateRagImageLegCache();
    mockQuery.mockRejectedValue(new Error('down'));
    expect(await getRagImageLegEnabled()).toBe(true);
  });

  it("the literal '0'/'false'/'off' disables; anything else stays on", async () => {
    for (const [raw, expected] of [
      ['0', false], ['false', false], ['off', false], ['FALSE', false],
      ['1', true], ['yes', true], ['', true],
    ] as Array<[string, boolean]>) {
      invalidateRagImageLegCache();
      mockQuery.mockResolvedValue({ rows: [{ setting_value: raw }] });
      expect(await getRagImageLegEnabled()).toBe(expected);
    }
  });

  it('is cached, so the per-request gate costs no round-trip inside the TTL', async () => {
    mockQuery.mockResolvedValue({ rows: [{ setting_value: 'off' }] });
    expect(await getRagImageLegEnabled()).toBe(false);
    expect(await getRagImageLegEnabled()).toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe('rag_answer_max_images (#1115 P4)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    invalidateRagAnswerMaxImagesCache();
  });

  it('defaults to 2 when absent, and on DB failure', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await getRagAnswerMaxImages()).toBe(RAG_ANSWER_MAX_IMAGES_DEFAULT);
    expect(RAG_ANSWER_MAX_IMAGES_DEFAULT).toBe(2);
    invalidateRagAnswerMaxImagesCache();
    mockQuery.mockRejectedValue(new Error('down'));
    expect(await getRagAnswerMaxImages()).toBe(RAG_ANSWER_MAX_IMAGES_DEFAULT);
  });

  it('reads 0 as a real value — the off switch, not an absent row', async () => {
    // The one place this reader differs from `rag_images_per_page_max`, whose
    // floor is 1. A `'0'` here must resolve to 0 and NOT fall back to the
    // default, or the panel's own off switch would be unreachable and every
    // vision-capable deployment would keep sending image bytes.
    mockQuery.mockResolvedValue({ rows: [{ setting_value: '0' }] });
    expect(await getRagAnswerMaxImages()).toBe(0);
  });

  it('accepts the whole [0, 8] range and clamps above it', async () => {
    for (const [raw, expected] of [
      ['0', 0], ['1', 1], ['8', 8], ['9', 8], ['400', 8],
    ] as Array<[string, number]>) {
      invalidateRagAnswerMaxImagesCache();
      mockQuery.mockResolvedValue({ rows: [{ setting_value: raw }] });
      expect(await getRagAnswerMaxImages(), raw).toBe(expected);
    }
  });

  it('falls back on a shape the operator cannot have meant', async () => {
    // A STRICT digit shape, for `rag_images_per_page_max`'s reason read the
    // other way round: `parseInt('1e3')` is 1, and a permissive parse would
    // read a fat-fingered row as "show the model one picture" rather than as
    // a typo. Negatives and decimals fall back for the same reason.
    for (const raw of ['', '-1', '2.5', '1e3', 'two', ' ']) {
      invalidateRagAnswerMaxImagesCache();
      mockQuery.mockResolvedValue({ rows: [{ setting_value: raw }] });
      expect(await getRagAnswerMaxImages(), raw).toBe(RAG_ANSWER_MAX_IMAGES_DEFAULT);
    }
  });

  it('is cached, so the per-request gate costs no round-trip inside the TTL', async () => {
    mockQuery.mockResolvedValue({ rows: [{ setting_value: '4' }] });
    expect(await getRagAnswerMaxImages()).toBe(4);
    expect(await getRagAnswerMaxImages()).toBe(4);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe('rag_ef_search (#1285)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    invalidateRagEfSearchCache();
    delete process.env.RAG_EF_SEARCH;
  });

  afterEach(() => {
    delete process.env.RAG_EF_SEARCH;
    invalidateRagEfSearchCache();
  });

  it('defaults to 100 when the row is absent, and on DB failure', async () => {
    // Soft-fail direction: a failed admin_settings read must degrade the
    // TUNING, never the search. 100 is the floor every deployment ran at
    // before this knob existed.
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await getRagEfSearch()).toBe(RAG_EF_SEARCH_DEFAULT);
    expect(RAG_EF_SEARCH_DEFAULT).toBe(100);
    invalidateRagEfSearchCache();
    mockQuery.mockRejectedValue(new Error('down'));
    expect(await getRagEfSearch()).toBe(RAG_EF_SEARCH_DEFAULT);
  });

  it('accepts pgvector’s whole [1, 1000] range and clamps above it', async () => {
    for (const [raw, expected] of [
      ['1', 1], ['40', 40], ['250', 250], ['1000', 1000], ['1001', 1000], ['99999', 1000],
    ] as Array<[string, number]>) {
      invalidateRagEfSearchCache();
      mockQuery.mockResolvedValue({ rows: [{ setting_value: raw }] });
      expect(await getRagEfSearch(), raw).toBe(expected);
    }
  });

  it('falls back on a shape the operator cannot have meant, 0 included', async () => {
    // Strict digit shape for `rag_answer_max_images`' reason: `parseInt('1e3')`
    // is 1, and 1 is a LEGAL ef_search — a permissive parse would read a
    // fat-fingered row as "walk one candidate" and quietly gut recall rather
    // than reading as the typo it is. `'0'` is not a value either: pgvector's
    // floor is 1, so a zero row means "unset", not "off".
    for (const raw of ['', '0', '-1', '2.5', '1e3', 'wide', ' ']) {
      invalidateRagEfSearchCache();
      mockQuery.mockResolvedValue({ rows: [{ setting_value: raw }] });
      expect(await getRagEfSearch(), raw).toBe(RAG_EF_SEARCH_DEFAULT);
    }
  });

  it('reads RAG_EF_SEARCH only while no row exists — a present row always wins', async () => {
    // ADR-021's rule: the env var is a BOOTSTRAP fallback, never a hot-path
    // read over a present row. A deployment that saves the panel once leaves
    // the variable inert for good.
    process.env.RAG_EF_SEARCH = '250';
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await getRagEfSearch()).toBe(250);

    invalidateRagEfSearchCache();
    mockQuery.mockResolvedValue({ rows: [{ setting_value: '150' }] });
    expect(await getRagEfSearch()).toBe(150);
  });

  it('ignores an out-of-range or malformed RAG_EF_SEARCH', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    for (const raw of ['0', '-5', '1001', 'garbage', '1e3']) {
      invalidateRagEfSearchCache();
      process.env.RAG_EF_SEARCH = raw;
      expect(await getRagEfSearch(), raw).toBe(RAG_EF_SEARCH_DEFAULT);
    }
  });

  it('never reinstates RAG_EF_SEARCH over a value the server actually read', async () => {
    // Review r1's concern, narrowed by #1512 to the instance it is actually
    // about: one that SAVED the panel and still carries a stale variable. A
    // failed read is not evidence that the row vanished, so what stands is the
    // value the server last resolved FROM that row — and a retired variable is
    // never reinstated over it.
    vi.useFakeTimers();
    try {
      mockQuery.mockResolvedValue({ rows: [{ setting_value: '150' }] });
      expect(await resolveRagEfSearch()).toEqual({ value: 150, source: 'row' });

      // TTL expires; the settings SELECT blips with the variable set.
      vi.advanceTimersByTime(61_000);
      process.env.RAG_EF_SEARCH = '900';
      mockQuery.mockRejectedValue(new Error('connection reset'));
      expect(await resolveRagEfSearch()).toEqual({ value: 150, source: 'row' });
    } finally {
      vi.useRealTimers();
    }

    // …and the bootstrap is still reached when the read SUCCEEDS and the row
    // is genuinely absent, which is the case it exists for.
    invalidateRagEfSearchCache();
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await getRagEfSearch()).toBe(900);
  });

  it('holds an env-configured floor across a transient read failure (#1512)', async () => {
    // The standard upgrade state: `RAG_EF_SEARCH` set, no row. At cache expiry
    // ONE pool-pressure or statement-timeout failure used to resolve
    // `{100, 'default'}` and cache it for a full TTL — every kNN probe on that
    // pod dropped from a 400 floor to 100, and `GET /api/admin/settings`
    // reported `ragEfSearchFromEnv: false`, so the panel lost the env note AND
    // its one-key `Keep` remedy exactly while the value was wrong. Fail toward
    // the operator's last known setting, the direction
    // `getRagContextCharsPerPage` already takes.
    vi.useFakeTimers();
    try {
      process.env.RAG_EF_SEARCH = '400';
      mockQuery.mockResolvedValue({ rows: [] });
      expect(await resolveRagEfSearch()).toEqual({ value: 400, source: 'env' });

      vi.advanceTimersByTime(61_000);
      mockQuery.mockRejectedValue(new Error('statement timeout'));
      expect(await resolveRagEfSearch()).toEqual({ value: 400, source: 'env' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reaches the bootstrap on a COLD resolve that threw (#1512)', async () => {
    // Nothing has resolved yet, so there is no last-known value to hold — and
    // the JSDoc, `.env.example`, ADMIN-GUIDE and the startup notice all promise
    // this instance is still running on the variable. A first read that blipped
    // is not the moment to retire it behind the operator's back.
    process.env.RAG_EF_SEARCH = '400';
    mockQuery.mockRejectedValue(new Error('pool exhausted'));
    expect(await resolveRagEfSearch()).toEqual({ value: 400, source: 'env' });
  });

  it('does not reinstate RAG_EF_SEARCH in the window right after a save (#1512)', async () => {
    // Review r1 of #1512. The first shape of this fix gated the cold bootstrap
    // on an EMPTY CACHE — and the admin PUT empties the cache on every save, so
    // the panel's own refetch ran straight into a window where one blipped
    // SELECT reinstated the retired variable OVER the row just written, called
    // it `source: 'env'`, and re-offered `Keep 900` — a one-click overwrite of
    // the admin's 150, on the very instance ADR-021 says the environment is
    // inert on. The write hands its value over instead of dropping it, so what
    // stands under a failed read is the row, as a row.
    process.env.RAG_EF_SEARCH = '900';
    mockQuery.mockResolvedValue({ rows: [{ setting_value: '120' }] });
    expect(await resolveRagEfSearch()).toEqual({ value: 120, source: 'row' });

    // Exactly what the PUT handler runs when the `rag_ef_search` row lands.
    noteRagEfSearchRowSaved(150);
    mockQuery.mockRejectedValue(new Error('statement timeout'));
    expect(await resolveRagEfSearch()).toEqual({ value: 150, source: 'row' });
  });

  it('holds a FIRST save across a blipped read, so one save really does retire the variable (#1512)', async () => {
    // The upgrade instance, which is the one the whole deprecation story is
    // about: running on the variable, no row, admin saves once. Nothing has
    // ever been READ from the row here, so only the write itself can tell the
    // reader a row now exists.
    process.env.RAG_EF_SEARCH = '900';
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await resolveRagEfSearch()).toEqual({ value: 900, source: 'env' });

    noteRagEfSearchRowSaved(150);
    mockQuery.mockRejectedValue(new Error('pool exhausted'));
    expect(await resolveRagEfSearch()).toEqual({ value: 150, source: 'row' });
  });

  it('holds a save that lands while the failing read is in flight (#1512, review r2)', async () => {
    // The window the two branches above do not cover on their own: the PUT
    // does not wait for readers, so `noteRagEfSearchRowSaved` can land BETWEEN
    // a reader's expiry check and its SELECT rejecting. The reader captured the
    // pre-save cache before awaiting, so holding that capture discards the save
    // — and re-caches the RETIRED variable as `source: 'env'` over the row the
    // admin just wrote, which is the one-click `Keep 900` overwrite this whole
    // fix exists to remove. Worse than one call: that poisoned entry becomes
    // the next reader's last resolution, and the written row is only ever
    // consulted with an empty cache, so it stays shadowed until a read
    // succeeds.
    vi.useFakeTimers();
    try {
      process.env.RAG_EF_SEARCH = '900';
      mockQuery.mockResolvedValue({ rows: [] });
      expect(await resolveRagEfSearch()).toEqual({ value: 900, source: 'env' });

      vi.advanceTimersByTime(61_000);
      const held = Promise.withResolvers<{ rows: Array<{ setting_value: string }> }>();
      mockQuery.mockImplementationOnce(() => held.promise);
      const inFlight = resolveRagEfSearch();
      await Promise.resolve();
      // Exactly what the admin PUT runs, mid-read.
      noteRagEfSearchRowSaved(150);
      held.reject(new Error('statement timeout'));
      expect(await inFlight).toEqual({ value: 150, source: 'row' });

      // …and the next reader, still failing, holds the row rather than a
      // resolution the save had already invalidated.
      vi.advanceTimersByTime(61_000);
      mockQuery.mockRejectedValue(new Error('statement timeout'));
      expect(await resolveRagEfSearch()).toEqual({ value: 150, source: 'row' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-validates the saved value rather than holding a number the reader would reject', async () => {
    // The row evidence is served as `source: 'row'`, so it must clear the same
    // bar the reader's own parse does — otherwise a bad write would be held as
    // if the reader had produced it. The route's schema already bounds this;
    // the reader does not get to assume that.
    process.env.RAG_EF_SEARCH = '400';
    noteRagEfSearchRowSaved(1001);
    mockQuery.mockRejectedValue(new Error('down'));
    expect(await resolveRagEfSearch()).toEqual({ value: 400, source: 'env' });
  });

  it('reports where the floor came from, for the panel that has to offer a remedy', async () => {
    // Review r1 — the panel's Save is a pure value diff, so on an instance
    // running on the env var the number on screen already equals the server's
    // and nothing can be saved. It needs the SOURCE, not just the value.
    mockQuery.mockResolvedValue({ rows: [{ setting_value: '250' }] });
    expect(await resolveRagEfSearch()).toEqual({ value: 250, source: 'row' });

    invalidateRagEfSearchCache();
    process.env.RAG_EF_SEARCH = '250';
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await resolveRagEfSearch()).toEqual({ value: 250, source: 'env' });

    invalidateRagEfSearchCache();
    delete process.env.RAG_EF_SEARCH;
    expect(await resolveRagEfSearch()).toEqual({ value: 100, source: 'default' });

    // A failed COLD read reaches the variable, and reports it as `env`
    // (#1512): `default` is what strips the panel's note and its `Keep`
    // remedy, and it would do so on exactly the instance the deprecation
    // story promises is still running on the variable.
    invalidateRagEfSearchCache();
    process.env.RAG_EF_SEARCH = '250';
    mockQuery.mockRejectedValue(new Error('down'));
    expect(await resolveRagEfSearch()).toEqual({ value: 250, source: 'env' });
  });

  it('is cached, so four kNN callsites cost no round-trip inside the TTL', async () => {
    mockQuery.mockResolvedValue({ rows: [{ setting_value: '200' }] });
    expect(await getRagEfSearch()).toBe(200);
    expect(await getRagEfSearch()).toBe(200);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    // The admin PUT invalidates, so a saved value takes effect on the writing
    // pod immediately rather than up to a minute later.
    invalidateRagEfSearchCache();
    mockQuery.mockResolvedValue({ rows: [{ setting_value: '300' }] });
    expect(await getRagEfSearch()).toBe(300);
  });
});

describe('warnIfRagEfSearchEnvSet (#1285)', () => {
  beforeEach(() => {
    delete process.env.RAG_EF_SEARCH;
    vi.mocked(logger.warn).mockClear();
  });

  afterEach(() => {
    delete process.env.RAG_EF_SEARCH;
  });

  it('says nothing when the variable is unset', () => {
    warnIfRagEfSearchEnvSet();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('names the row that supersedes it and the panel that writes it', () => {
    // LEGACY-LLM-VARS semantics, not FTS_LANGUAGE's: there is no seed row, so
    // the value stays LIVE on every instance until an admin saves the panel
    // once. The notice has to say exactly that, or an operator reads
    // "deprecated" as "already ignored".
    process.env.RAG_EF_SEARCH = '250';
    warnIfRagEfSearchEnvSet();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [, message] = vi.mocked(logger.warn).mock.calls[0] as [unknown, string];
    expect(message).toContain('RAG_EF_SEARCH is deprecated');
    expect(message).toContain('rag_ef_search');
    expect(message).toContain('Settings → AI Models → Retrieval');
    // #1512 narrowed this branch from "row exists" to "row has been READ", the
    // way the out-of-range branch below is already pinned: a row whose first
    // read threw has not retired the variable yet, so "exists" is the one word
    // the notice cannot use.
    expect(message).toContain('while no `rag_ef_search` row has been read');
  });

  it('says the value is IGNORED when it is outside pgvector’s bound', async () => {
    // Review r1 — the reader silently drops a value the old module-load
    // reader accepted (it validated 1..10000 against pgvector's 1..1000), so
    // an instance running `RAG_EF_SEARCH=2000` drops from a 1000 floor to 100
    // on upgrade. "It is used" is the one thing that must not be said there.
    process.env.RAG_EF_SEARCH = '2000';
    warnIfRagEfSearchEnvSet();
    const [, message] = vi.mocked(logger.warn).mock.calls[0] as [unknown, string];
    expect(message).toContain('2000');
    expect(message).toContain('is ignored');
    expect(message).toContain('100');
    expect(message).not.toContain('it is used only while');
    // Review r2 — and the fallback has to be scoped to the no-row case, the
    // way the in-range branch already scopes "it is used". This function
    // reads `process.env` and never the row, so "the floor falls back to 100"
    // stated flatly is false on every instance that HAS saved the panel: with
    // `RAG_EF_SEARCH=2000` and a saved row of 300 every probe runs at 300
    // while boot claims 100.
    // #1512 narrowed both branches from "exists" to "has been read": a row
    // whose first read threw has not retired the variable yet, so "exists" is
    // the one word the notice cannot use.
    expect(message).toContain('while no `rag_ef_search` row has been read');
    // …and it is still resolved that way, which is what the notice claims.
    invalidateRagEfSearchCache();
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await getRagEfSearch()).toBe(RAG_EF_SEARCH_DEFAULT);
    invalidateRagEfSearchCache();
  });

  /**
   * The tests above prove the function warns. They cannot prove anything CALLS
   * it: `index.ts` boots a server and no suite imports it, so deleting the call
   * site leaves every backend test green — and with it the only thing telling
   * an upgrading operator that their `RAG_EF_SEARCH=250` is now one save away
   * from being ignored. Read the source, the way `fts-language.test.ts` does
   * for its own notice.
   */
  describe('the startup call site', () => {
    const source = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');

    it('is wired into index.ts', () => {
      expect(
        source,
        'backend/src/index.ts must call warnIfRagEfSearchEnvSet() at startup',
      ).toContain('warnIfRagEfSearchEnvSet();');
    });

    it('runs after migrations, so the table the message points at exists', () => {
      const migrations = source.indexOf('await runMigrations()');
      const warn = source.indexOf('warnIfRagEfSearchEnvSet();');
      expect(migrations).toBeGreaterThanOrEqual(0);
      expect(warn).toBeGreaterThan(migrations);
    });
  });
});

/**
 * The `RAG_EF_SEARCH` bootstrap's own log line (#1512, review r2). It is the
 * only user-visible output of the `reason` parameter, and it is emitted once
 * per PROCESS — which the suites above have already spent — so these cases
 * need a fresh module instance, `llm-config.test.ts`' pattern.
 */
describe('the RAG_EF_SEARCH bootstrap notice (#1512, review r2)', () => {
  beforeEach(() => {
    vi.resetModules();
    mockQuery.mockReset();
    delete process.env.RAG_EF_SEARCH;
  });

  afterEach(() => {
    delete process.env.RAG_EF_SEARCH;
  });

  // Dynamic on purpose: a static import is bound once, and what these cases
  // exercise is module LOAD — the one-shot flags a fresh process starts with.
  // The logger is re-imported the same way so the assertions read whichever
  // instance the reset registry handed the service.
  async function freshService() {
    const service = await import('./admin-settings-service.js');
    const { logger: freshLogger } = await import('../utils/logger.js');
    const info = vi.mocked(freshLogger.info);
    info.mockClear();
    return {
      service,
      messages: () => info.mock.calls.map(([, message]) => message as string),
    };
  }

  it('names the read failure on a read-failed bootstrap, and still reports an absent row afterwards', async () => {
    const { service, messages } = await freshService();

    // A cold resolve whose SELECT threw: "no row" is not established here, and
    // an operator debugging a floor drop who reads it concludes their save
    // never landed (review r1).
    process.env.RAG_EF_SEARCH = '400';
    mockQuery.mockRejectedValue(new Error('pool exhausted'));
    expect(await service.resolveRagEfSearch()).toEqual({ value: 400, source: 'env' });
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toContain('Could not read the rag_ef_search row');
    expect(messages()[0]).not.toContain('No rag_ef_search row —');

    // …and the accurate diagnosis still gets said. One one-shot flag for both
    // reasons let the hedged line swallow it for the process lifetime, so the
    // instance that really has no row only ever saw "could not read" — the
    // inverse of the confusion the `reason` split was added to prevent.
    service.invalidateRagEfSearchCache();
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await service.resolveRagEfSearch()).toEqual({ value: 400, source: 'env' });
    expect(messages()).toHaveLength(2);
    expect(messages()[1]).toContain('No rag_ef_search row —');
  });

  it('says each reason once, not once per resolve', async () => {
    // Why the flags exist at all: this runs on every kNN probe's cache miss.
    const { service, messages } = await freshService();
    process.env.RAG_EF_SEARCH = '400';
    mockQuery.mockResolvedValue({ rows: [] });
    for (let i = 0; i < 3; i++) {
      service.invalidateRagEfSearchCache();
      expect(await service.resolveRagEfSearch()).toEqual({ value: 400, source: 'env' });
    }
    expect(messages()).toHaveLength(1);
  });
});
