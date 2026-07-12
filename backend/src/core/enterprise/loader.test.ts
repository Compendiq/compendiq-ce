import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadEnterprisePlugin, getEnterprisePlugin, _resetForTesting } from './loader.js';
import { noopPlugin } from './noop.js';
import { logger } from '../utils/logger.js';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('Enterprise loader', () => {
  beforeEach(() => {
    _resetForTesting();
    vi.mocked(logger.error).mockClear();
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

    it('should stay silent when the package is genuinely absent (community mode)', async () => {
      const plugin = await loadEnterprisePlugin();

      expect(plugin).toBe(noopPlugin);
      expect(logger.error).not.toHaveBeenCalled();
    });

    describe('when @compendiq/enterprise is present but fails to load', () => {
      afterEach(() => {
        vi.doUnmock('@compendiq/enterprise');
        vi.resetModules();
      });

      it('should log an error and fall back to noop instead of swallowing the failure', async () => {
        // Simulate a broken/misconfigured EE package: the module resolves but
        // its top-level evaluation throws (e.g. a missing transitive dep or a
        // boot error) — NOT a genuine "package not installed" case.
        vi.doMock('@compendiq/enterprise', () => {
          throw new Error('top-level EE boot failure');
        });

        _resetForTesting();
        const plugin = await loadEnterprisePlugin();

        expect(plugin).toBe(noopPlugin);
        expect(logger.error).toHaveBeenCalledTimes(1);
        const [, message] = vi.mocked(logger.error).mock.calls[0];
        expect(String(message)).toContain('failed to load');
      });
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
