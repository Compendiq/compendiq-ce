import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadEnterprisePlugin, getEnterprisePlugin, _resetForTesting } from './loader.js';
import { noopPlugin } from './noop.js';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('Enterprise loader', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  describe('loadEnterprisePlugin', () => {
    it('should return noop plugin when @compendiq/enterprise is not installed', async () => {
      const plugin = await loadEnterprisePlugin();

      expect(plugin).toBe(noopPlugin);
      expect(plugin.version).toBe('community');
    });

    it('should cache the result after first call', async () => {
      const first = await loadEnterprisePlugin();
      const second = await loadEnterprisePlugin();

      expect(first).toBe(second);
      expect(first).toBe(noopPlugin);
    });
  });

  describe('getEnterprisePlugin', () => {
    it('should return noop plugin before loadEnterprisePlugin is called', () => {
      const plugin = getEnterprisePlugin();
      expect(plugin).toBe(noopPlugin);
    });

    it('should return noop plugin after loadEnterprisePlugin runs (no enterprise package)', async () => {
      await loadEnterprisePlugin();
      const plugin = getEnterprisePlugin();
      expect(plugin).toBe(noopPlugin);
    });
  });

  describe('community mode behavior', () => {
    it('validateLicense should return null in community mode', async () => {
      const plugin = await loadEnterprisePlugin();
      expect(plugin.validateLicense('any-key')).toBeNull();
      expect(plugin.validateLicense(undefined)).toBeNull();
    });

    it('isFeatureEnabled should return false for all features in community mode', async () => {
      const plugin = await loadEnterprisePlugin();
      expect(plugin.isFeatureEnabled('oidc_sso', null)).toBe(false);
      expect(plugin.isFeatureEnabled('audit_log_export', null)).toBe(false);
      expect(plugin.isFeatureEnabled('seat_enforcement', null)).toBe(false);
    });
  });
});
