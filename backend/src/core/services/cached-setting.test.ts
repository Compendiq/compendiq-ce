/**
 * Unit tests for makeCachedSetting — the v0.4 epic §3.5 helper that wraps
 * admin_settings reads behind an in-process cache that invalidates via the
 * cluster-wide cache-bus.
 *
 * Contract:
 *   - Async factory cold-loads from admin_settings at startup.
 *   - The returned sync getter returns the cached value with no DB round-trip.
 *   - A cache-bus event on the configured channel triggers re-read from DB.
 *   - A cache-bus reconnect triggers re-read from DB (missed events are not
 *     replayed by Redis pub/sub, so we cold-load as a recovery strategy).
 *   - parse(null) handles the "row missing" case; defaultValue is returned
 *     if DB errors prevent cold-load.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../db/postgres.js', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
}));

const mockSubscribe = vi.fn();
const mockOnReconnect = vi.fn();
vi.mock('./redis-cache-bus.js', () => ({
  subscribe: (channel: string, handler: (payload: unknown) => void) =>
    mockSubscribe(channel, handler),
  onReconnect: (handler: () => void | Promise<void>) => mockOnReconnect(handler),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { makeCachedSetting } from './cached-setting.js';
import { logger } from '../utils/logger.js';

interface TestConfig {
  enabled: boolean;
  list: string[];
}

const defaultValue: TestConfig = { enabled: false, list: [] };

function parse(raw: string | null): TestConfig {
  if (!raw) return defaultValue;
  return { ...defaultValue, ...(JSON.parse(raw) as Partial<TestConfig>) };
}

describe('makeCachedSetting', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockSubscribe.mockReset().mockReturnValue(() => {});
    mockOnReconnect.mockReset().mockReturnValue(() => {});
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('cold-load', () => {
    it('reads the admin_settings row on startup and returns its parsed value via the sync getter', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ setting_value: JSON.stringify({ enabled: true, list: ['a', 'b'] }) }],
      });

      const get = await makeCachedSetting<TestConfig>({
        key: 'test_setting',
        cacheBusChannel: 'ip_allowlist:changed',
        parse,
        defaultValue,
      });

      expect(get()).toEqual({ enabled: true, list: ['a', 'b'] });
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('FROM admin_settings'),
        ['test_setting'],
      );
    });

    it('returns the parsed null-case (defaultValue) when the DB row is absent', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const get = await makeCachedSetting<TestConfig>({
        key: 'test_setting',
        cacheBusChannel: 'ip_allowlist:changed',
        parse,
        defaultValue,
      });

      expect(get()).toEqual(defaultValue);
    });

    it('falls back to defaultValue and logs a warn when the DB query rejects at cold-load', async () => {
      mockQuery.mockRejectedValueOnce(new Error('pool exhausted'));

      const get = await makeCachedSetting<TestConfig>({
        key: 'test_setting',
        cacheBusChannel: 'ip_allowlist:changed',
        parse,
        defaultValue,
      });

      expect(get()).toEqual(defaultValue);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error), key: 'test_setting' }),
        expect.stringContaining('cold-load failed'),
      );
    });

    it('falls back to defaultValue and logs a warn when the parse function throws', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ setting_value: 'not-valid-json{' }],
      });

      const get = await makeCachedSetting<TestConfig>({
        key: 'test_setting',
        cacheBusChannel: 'ip_allowlist:changed',
        parse,
        defaultValue,
      });

      expect(get()).toEqual(defaultValue);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('in-process cache', () => {
    it('subsequent getter calls do not hit the DB', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ setting_value: JSON.stringify({ enabled: true, list: ['x'] }) }],
      });

      const get = await makeCachedSetting<TestConfig>({
        key: 'test_setting',
        cacheBusChannel: 'ip_allowlist:changed',
        parse,
        defaultValue,
      });

      get();
      get();
      get();

      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });

  describe('cache-bus invalidation', () => {
    it('registers a handler on the configured channel at startup', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await makeCachedSetting<TestConfig>({
        key: 'test_setting',
        cacheBusChannel: 'ip_allowlist:changed',
        parse,
        defaultValue,
      });

      expect(mockSubscribe).toHaveBeenCalledWith(
        'ip_allowlist:changed',
        expect.any(Function),
      );
    });

    it('re-reads the DB when the cache-bus fires and the getter reflects the new value', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ setting_value: JSON.stringify({ enabled: false, list: [] }) }],
      });

      const get = await makeCachedSetting<TestConfig>({
        key: 'test_setting',
        cacheBusChannel: 'ip_allowlist:changed',
        parse,
        defaultValue,
      });
      expect(get().enabled).toBe(false);

      // Second DB read — the invalidation path
      mockQuery.mockResolvedValueOnce({
        rows: [{ setting_value: JSON.stringify({ enabled: true, list: ['new'] }) }],
      });

      const handler = mockSubscribe.mock.calls[0][1] as (payload: unknown) => Promise<void>;
      await handler({ at: Date.now() });

      expect(get()).toEqual({ enabled: true, list: ['new'] });
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('keeps the last-known value and logs a warn if the re-read fails', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ setting_value: JSON.stringify({ enabled: true, list: ['good'] }) }],
      });

      const get = await makeCachedSetting<TestConfig>({
        key: 'test_setting',
        cacheBusChannel: 'ip_allowlist:changed',
        parse,
        defaultValue,
      });

      mockQuery.mockRejectedValueOnce(new Error('pool exhausted'));
      const handler = mockSubscribe.mock.calls[0][1] as (payload: unknown) => Promise<void>;
      await handler({ at: Date.now() });

      expect(get()).toEqual({ enabled: true, list: ['good'] });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error), key: 'test_setting' }),
        expect.stringContaining('re-read failed'),
      );
    });
  });

  describe('reconnect', () => {
    it('registers a reconnect handler at startup', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await makeCachedSetting<TestConfig>({
        key: 'test_setting',
        cacheBusChannel: 'ip_allowlist:changed',
        parse,
        defaultValue,
      });

      expect(mockOnReconnect).toHaveBeenCalledWith(expect.any(Function));
    });

    it('re-reads the DB after a cache-bus reconnect', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ setting_value: JSON.stringify({ enabled: false, list: [] }) }],
      });

      const get = await makeCachedSetting<TestConfig>({
        key: 'test_setting',
        cacheBusChannel: 'ip_allowlist:changed',
        parse,
        defaultValue,
      });

      mockQuery.mockResolvedValueOnce({
        rows: [{ setting_value: JSON.stringify({ enabled: true, list: ['reconnected'] }) }],
      });

      const onReconnectHandler = mockOnReconnect.mock.calls[0][0] as () => Promise<void>;
      await onReconnectHandler();

      expect(get()).toEqual({ enabled: true, list: ['reconnected'] });
    });
  });
});
