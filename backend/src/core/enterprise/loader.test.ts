import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

    describe('when @compendiq/enterprise is present but fails to load', () => {
      afterEach(() => {
        vi.doUnmock('@compendiq/enterprise');
        vi.resetModules();
      });

      it('falls back to noop when the package fails during evaluation', async () => {
        // Simulate a broken/misconfigured EE package: the module resolves but
        // its top-level evaluation throws (e.g. a missing transitive dep or a
        // boot error) — NOT a genuine "package not installed" case.
        vi.doMock('@compendiq/enterprise', () => {
          throw new Error('top-level EE boot failure');
        });

        _resetForTesting();
        const plugin = await loadEnterprisePlugin();

        expect(plugin).toBe(noopPlugin);
        expect(getEnterprisePlugin()).toBe(noopPlugin);
      });
    });

    describe('when @compendiq/enterprise is present (production shim shape)', () => {
      afterEach(() => {
        vi.doUnmock('@compendiq/enterprise');
        vi.resetModules();
      });

      it('uses the DEFAULT export as the plugin so the optional #280 hooks are reachable', async () => {
        const resolveAiPolicyCreationDefault = vi.fn(async () => 'local_only');
        const plugin = {
          version: 'ee-test',
          validateLicense: vi.fn(() => null),
          isFeatureEnabled: vi.fn(() => true),
          requireFeature: vi.fn(),
          registerRoutes: vi.fn(async () => undefined),
          resolveAiPolicyCreationDefault,
          aiPolicyEnforcementAvailable: () => true,
        };
        // The shim re-exports the required members by name but NOT the
        // optional hooks; only `default` carries the whole plugin.
        vi.doMock('@compendiq/enterprise', () => ({
          default: plugin,
          validateLicense: plugin.validateLicense,
          isFeatureEnabled: plugin.isFeatureEnabled,
          requireFeature: plugin.requireFeature,
          registerRoutes: plugin.registerRoutes,
          version: plugin.version,
        }));

        _resetForTesting();
        const loaded = await loadEnterprisePlugin();

        expect(loaded).toBe(plugin);
        expect(loaded.resolveAiPolicyCreationDefault).toBe(resolveAiPolicyCreationDefault);
        expect(loaded.aiPolicyEnforcementAvailable?.()).toBe(true);
        expect(getEnterprisePlugin()).toBe(plugin);
      });

      it('falls back to noop when only named exports exist (no default plugin object)', async () => {
        vi.doMock('@compendiq/enterprise', () => ({
          // Explicitly model an absent default; Vitest otherwise throws on
          // property access before the loader can validate the module shape.
          default: undefined,
          validateLicense: () => null,
          isFeatureEnabled: () => true,
          version: 'named-only',
        }));

        _resetForTesting();
        const loaded = await loadEnterprisePlugin();

        expect(loaded).toBe(noopPlugin);
        expect(getEnterprisePlugin()).toBe(noopPlugin);
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
