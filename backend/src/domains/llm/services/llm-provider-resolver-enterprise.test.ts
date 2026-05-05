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
