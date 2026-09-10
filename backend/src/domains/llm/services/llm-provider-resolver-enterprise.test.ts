import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import {
  dbAvailable,
  setupTestDb,
  resetLlmTables,
  seedProvider,
  setUsecaseAssignment,
} from './llm-provider-resolver.test-helpers.js';
import { teardownTestDb } from '../../../test-db-helper.js';
import { noopPlugin } from '../../../core/enterprise/noop.js';

describe.skipIf(!dbAvailable)('resolveUsecase — enterprise override', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => {
    vi.resetModules();
    await resetLlmTables();
  });
  afterEach(() => {
    vi.doUnmock('../../../core/enterprise/loader.js');
  });

  it('returns override provider+model when enterprise hook resolves a value', async () => {
    const a = await seedProvider({ name: 'A', baseUrl: 'http://a/v1', defaultModel: 'a-default' });
    const b = await seedProvider({ name: 'B', baseUrl: 'http://b/v1', defaultModel: 'b-default', isDefault: true });
    await setUsecaseAssignment('chat', { providerId: b, model: 'b-assigned' });

    vi.doMock('../../../core/enterprise/loader.js', () => {
      const overridePlugin = {
        ...noopPlugin,
        resolveUsecaseOverride: async () => ({ providerId: a, model: 'override-model' }),
      };
      return {
        loadEnterprisePlugin: async () => overridePlugin,
        getEnterprisePlugin: () => overridePlugin,
        setCurrentLicense: () => {},
        isFeatureEnabled: () => false,
        _resetForTesting: () => {},
      };
    });

    const { resolveUsecase } = await import('./llm-provider-resolver.js');
    const result = await resolveUsecase('chat');
    expect(result.config.id).toBe(a);
    expect(result.model).toBe('override-model');
  });

  it('falls through to assignment row when override returns null', async () => {
    const a = await seedProvider({ name: 'A', baseUrl: 'http://a/v1', defaultModel: 'a-default', isDefault: true });
    await setUsecaseAssignment('chat', { providerId: a, model: 'a-assigned' });

    vi.doMock('../../../core/enterprise/loader.js', () => {
      const overridePlugin = {
        ...noopPlugin,
        resolveUsecaseOverride: async () => null,
      };
      return {
        loadEnterprisePlugin: async () => overridePlugin,
        getEnterprisePlugin: () => overridePlugin,
        setCurrentLicense: () => {},
        isFeatureEnabled: () => false,
        _resetForTesting: () => {},
      };
    });

    const { resolveUsecase } = await import('./llm-provider-resolver.js');
    const result = await resolveUsecase('chat');
    expect(result.config.id).toBe(a);
    expect(result.model).toBe('a-assigned');
  });

  it('throws when override providerId no longer exists', async () => {
    const a = await seedProvider({ name: 'A', baseUrl: 'http://a/v1', defaultModel: 'a-default', isDefault: true });
    await setUsecaseAssignment('chat', { providerId: a, model: 'a-assigned' });

    vi.doMock('../../../core/enterprise/loader.js', () => {
      const overridePlugin = {
        ...noopPlugin,
        resolveUsecaseOverride: async () => ({
          providerId: '00000000-0000-0000-0000-000000000000',
          model: 'm',
        }),
      };
      return {
        loadEnterprisePlugin: async () => overridePlugin,
        getEnterprisePlugin: () => overridePlugin,
        setCurrentLicense: () => {},
        isFeatureEnabled: () => false,
        _resetForTesting: () => {},
      };
    });

    const { resolveUsecase } = await import('./llm-provider-resolver.js');
    await expect(resolveUsecase('chat')).rejects.toThrow(
      /Org LLM policy refers to provider .* which no longer exists/,
    );
  });

  it('reports a confidence basis as UNRESOLVED when the override throws (#1114, review r2)', async () => {
    // The one real, reachable failure of `resolveUsecase` that is not "nothing
    // is configured": an org policy pinning a provider that has since been
    // deleted. `resolveConfidenceBasisPair` must say it could not tell, so the
    // settings PUT leaves the calibration record alone instead of writing down
    // "tuned against no model at all" for an instance whose embedder never
    // moved.
    const a = await seedProvider({ name: 'A', baseUrl: 'http://a/v1', defaultModel: 'a-default', isDefault: true });
    await setUsecaseAssignment('embedding', { providerId: a, model: 'bge-m3' });

    vi.doMock('../../../core/enterprise/loader.js', () => {
      const overridePlugin = {
        ...noopPlugin,
        resolveUsecaseOverride: async () => ({
          providerId: '00000000-0000-0000-0000-000000000000',
          model: 'm',
        }),
      };
      return {
        loadEnterprisePlugin: async () => overridePlugin,
        getEnterprisePlugin: () => overridePlugin,
        setCurrentLicense: () => {},
        isFeatureEnabled: () => false,
        _resetForTesting: () => {},
      };
    });

    const { resolveConfidenceBasisPair } = await import('./llm-provider-resolver.js');
    expect(await resolveConfidenceBasisPair('similarity')).toEqual({ resolved: false, pair: null });
  });

  it('falls back to provider default_model when override.model is empty', async () => {
    const a = await seedProvider({
      name: 'A',
      baseUrl: 'http://a/v1',
      defaultModel: 'a-default',
      isDefault: true,
    });

    vi.doMock('../../../core/enterprise/loader.js', () => {
      const overridePlugin = {
        ...noopPlugin,
        resolveUsecaseOverride: async () => ({ providerId: a, model: '' }),
      };
      return {
        loadEnterprisePlugin: async () => overridePlugin,
        getEnterprisePlugin: () => overridePlugin,
        setCurrentLicense: () => {},
        isFeatureEnabled: () => false,
        _resetForTesting: () => {},
      };
    });

    const { resolveUsecase } = await import('./llm-provider-resolver.js');
    const result = await resolveUsecase('chat');
    expect(result.config.id).toBe(a);
    expect(result.model).toBe('a-default');
  });
});
