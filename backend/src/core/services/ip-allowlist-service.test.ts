/**
 * Unit tests for ip-allowlist-service.ts (EE #111).
 *
 * The service wraps an `admin_settings.ip_allowlist` JSONB singleton behind
 * an in-process cache that invalidates cluster-wide via the cache-bus. This
 * file tests the domain logic (isAllowed / isTrustedProxy / isExemptPath)
 * plus the update path (DB write + cache-bus publish + audit).
 *
 * makeCachedSetting + redis-cache-bus are covered separately. Here we mock
 * them so we can exercise the service in isolation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../db/postgres.js', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
}));

const mockPublish = vi.fn();
const mockSubscribe = vi.fn();
const mockOnReconnect = vi.fn();
vi.mock('./redis-cache-bus.js', () => ({
  publish: (channel: string, payload: unknown) => mockPublish(channel, payload),
  subscribe: (channel: string, handler: (payload: unknown) => void) =>
    mockSubscribe(channel, handler),
  onReconnect: (handler: () => void | Promise<void>) => mockOnReconnect(handler),
}));

const mockLogAuditEvent = vi.fn();
vi.mock('./audit-service.js', () => ({
  logAuditEvent: (
    userId: string | null,
    action: string,
    resourceType?: string,
    resourceId?: string,
    metadata?: Record<string, unknown>,
    request?: unknown,
  ) => mockLogAuditEvent(userId, action, resourceType, resourceId, metadata, request),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  initIpAllowlistService,
  isAllowed,
  isTrustedProxy,
  isExemptPath,
  updateConfig,
  loadTrustedProxiesFromAdminSettings,
  DEFAULT_IP_ALLOWLIST_CONFIG,
  _resetForTests,
  type IpAllowlistConfig,
} from './ip-allowlist-service.js';

async function mockDbRow(raw: string | null): Promise<void> {
  mockSubscribe.mockReturnValue(() => {});
  mockOnReconnect.mockReturnValue(() => {});
  if (raw === null) {
    mockQuery.mockResolvedValueOnce({ rows: [] });
  } else {
    mockQuery.mockResolvedValueOnce({ rows: [{ setting_value: raw }] });
  }
  await initIpAllowlistService();
}

describe('ip-allowlist-service', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockPublish.mockReset();
    mockSubscribe.mockReset();
    mockOnReconnect.mockReset();
    mockLogAuditEvent.mockReset();
    _resetForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('default config shape', () => {
    it('exposes DEFAULT with enabled=false, loopback trusted, conservative exceptions', () => {
      expect(DEFAULT_IP_ALLOWLIST_CONFIG.enabled).toBe(false);
      expect(DEFAULT_IP_ALLOWLIST_CONFIG.cidrs).toEqual([]);
      expect(DEFAULT_IP_ALLOWLIST_CONFIG.trustedProxies).toEqual(['127.0.0.1/32', '::1/128']);
      expect(DEFAULT_IP_ALLOWLIST_CONFIG.exceptions).toContain('/api/health');
      expect(DEFAULT_IP_ALLOWLIST_CONFIG.exceptions).toContain('/api/admin/license');
      expect(DEFAULT_IP_ALLOWLIST_CONFIG.exceptions).toContain('/api/auth/');
      // Compendiq/compendiq-ee#113 Part A — mgmt poller path.
      expect(DEFAULT_IP_ALLOWLIST_CONFIG.exceptions).toContain('/api/internal/health');
    });
  });

  describe('isAllowed', () => {
    it('returns true when the feature is disabled (allow-all bypass)', async () => {
      await mockDbRow(JSON.stringify({ enabled: false, cidrs: [], trustedProxies: [], exceptions: [] }));
      expect(isAllowed('1.2.3.4')).toBe(true);
      expect(isAllowed('some-garbage')).toBe(true);
    });

    it('returns true when the IP is inside a configured CIDR', async () => {
      await mockDbRow(
        JSON.stringify({ enabled: true, cidrs: ['10.0.0.0/8'], trustedProxies: [], exceptions: [] }),
      );
      expect(isAllowed('10.1.2.3')).toBe(true);
    });

    it('returns false when the IP is outside every configured CIDR', async () => {
      await mockDbRow(
        JSON.stringify({ enabled: true, cidrs: ['10.0.0.0/8'], trustedProxies: [], exceptions: [] }),
      );
      expect(isAllowed('192.168.1.1')).toBe(false);
    });

    it('normalises IPv4-mapped-IPv6 and matches the IPv4 CIDR (canonical bypass guard)', async () => {
      await mockDbRow(
        JSON.stringify({ enabled: true, cidrs: ['10.0.0.0/8'], trustedProxies: [], exceptions: [] }),
      );
      expect(isAllowed('::ffff:10.1.2.3')).toBe(true);
    });

    it('matches IPv6 CIDRs', async () => {
      await mockDbRow(
        JSON.stringify({
          enabled: true,
          cidrs: ['2001:db8::/32'],
          trustedProxies: [],
          exceptions: [],
        }),
      );
      expect(isAllowed('2001:db8:1234::1')).toBe(true);
      expect(isAllowed('2001:4860::1')).toBe(false);
    });

    it('skips invalid CIDRs in config rather than throwing', async () => {
      await mockDbRow(
        JSON.stringify({
          enabled: true,
          cidrs: ['10.0.0.0/8', 'garbage', '999.999.999.999/8'],
          trustedProxies: [],
          exceptions: [],
        }),
      );
      expect(isAllowed('10.1.2.3')).toBe(true);
      expect(isAllowed('8.8.8.8')).toBe(false);
    });

    it('returns false for a malformed address even when feature is enabled', async () => {
      await mockDbRow(
        JSON.stringify({ enabled: true, cidrs: ['10.0.0.0/8'], trustedProxies: [], exceptions: [] }),
      );
      expect(isAllowed('not-an-ip')).toBe(false);
      expect(isAllowed('')).toBe(false);
    });
  });

  describe('isTrustedProxy', () => {
    it('returns true for an IP inside the trusted_proxies list regardless of feature-enabled', async () => {
      // Feature OFF: trusted-proxy list still applies (used by Fastify at startup
      // + by the hook's own XFF walk even when the allowlist check is bypassed).
      await mockDbRow(
        JSON.stringify({
          enabled: false,
          cidrs: [],
          trustedProxies: ['172.16.0.0/12'],
          exceptions: [],
        }),
      );
      expect(isTrustedProxy('172.16.5.5')).toBe(true);
      expect(isTrustedProxy('8.8.8.8')).toBe(false);
    });

    it('handles IPv4-mapped-IPv6 and the loopback defaults', async () => {
      await mockDbRow(
        JSON.stringify({
          enabled: true,
          cidrs: [],
          trustedProxies: ['127.0.0.1/32', '::1/128', '10.0.0.0/8'],
          exceptions: [],
        }),
      );
      expect(isTrustedProxy('127.0.0.1')).toBe(true);
      expect(isTrustedProxy('::1')).toBe(true);
      expect(isTrustedProxy('::ffff:10.1.2.3')).toBe(true);
      expect(isTrustedProxy('8.8.8.8')).toBe(false);
    });
  });

  describe('isExemptPath', () => {
    beforeEach(async () => {
      await mockDbRow(
        JSON.stringify({
          enabled: true,
          cidrs: ['10.0.0.0/8'],
          trustedProxies: [],
          exceptions: ['/api/health', '/api/admin/license', '/api/auth/'],
        }),
      );
    });

    it('returns true for an exact match', () => {
      expect(isExemptPath('/api/health')).toBe(true);
      expect(isExemptPath('/api/admin/license')).toBe(true);
    });

    it('returns true for a prefix match with trailing slash', () => {
      expect(isExemptPath('/api/auth/login')).toBe(true);
      expect(isExemptPath('/api/auth/oidc/callback')).toBe(true);
    });

    it('returns false for an unrelated path', () => {
      expect(isExemptPath('/api/pages')).toBe(false);
      expect(isExemptPath('/api/admin/users')).toBe(false);
    });

    it('does not match a path that happens to contain an exempt prefix elsewhere', () => {
      // Defensive: /api/admin/health-report must not short-circuit because
      // /api/health is in the list.
      expect(isExemptPath('/api/admin/health-report')).toBe(false);
    });
  });

  describe('updateConfig', () => {
    it('writes to admin_settings, publishes cache-bus, and records an audit', async () => {
      await mockDbRow(JSON.stringify(DEFAULT_IP_ALLOWLIST_CONFIG));

      mockQuery.mockResolvedValueOnce({ rows: [] }); // the UPSERT for updateConfig
      mockPublish.mockResolvedValueOnce(undefined);

      const next: IpAllowlistConfig = {
        enabled: true,
        cidrs: ['10.0.0.0/8'],
        trustedProxies: ['172.16.0.0/12'],
        exceptions: ['/api/health', '/api/admin/license', '/api/auth/'],
      };

      await updateConfig(next, 'user-42');

      // INSERT / UPDATE into admin_settings
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('admin_settings'),
        expect.arrayContaining([JSON.stringify(next)]),
      );

      // Cache-bus publish on the ip_allowlist:changed channel
      expect(mockPublish).toHaveBeenCalledWith(
        'ip_allowlist:changed',
        expect.objectContaining({ at: expect.any(Number) }),
      );

      // Audit entry with previous + next in metadata
      expect(mockLogAuditEvent).toHaveBeenCalledWith(
        'user-42',
        'IP_ALLOWLIST_CHANGED',
        'admin_settings',
        'ip_allowlist',
        expect.objectContaining({ previous: expect.any(Object), next }),
        undefined,
      );
    });
  });

  describe('loadTrustedProxiesFromAdminSettings (pre-init bootstrap)', () => {
    it('reads the row directly and returns trustedProxies', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            setting_value: JSON.stringify({
              enabled: false,
              cidrs: [],
              trustedProxies: ['172.16.0.0/12'],
              exceptions: [],
            }),
          },
        ],
      });

      await expect(loadTrustedProxiesFromAdminSettings()).resolves.toEqual([
        '172.16.0.0/12',
      ]);
    });

    it('returns the loopback default when the row is absent', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await expect(loadTrustedProxiesFromAdminSettings()).resolves.toEqual([
        '127.0.0.1/32',
        '::1/128',
      ]);
    });

    it('returns the loopback default on DB error (never throws, startup must not fail)', async () => {
      mockQuery.mockRejectedValueOnce(new Error('pool exhausted'));
      await expect(loadTrustedProxiesFromAdminSettings()).resolves.toEqual([
        '127.0.0.1/32',
        '::1/128',
      ]);
    });
  });

  describe('cache-bus wiring', () => {
    it('subscribes to ip_allowlist:changed at init', async () => {
      await mockDbRow(JSON.stringify(DEFAULT_IP_ALLOWLIST_CONFIG));
      expect(mockSubscribe).toHaveBeenCalledWith(
        'ip_allowlist:changed',
        expect.any(Function),
      );
    });

    it('registers a reconnect handler at init', async () => {
      await mockDbRow(JSON.stringify(DEFAULT_IP_ALLOWLIST_CONFIG));
      expect(mockOnReconnect).toHaveBeenCalled();
    });
  });
});
