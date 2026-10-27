import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closePool, query } from '../../../core/db/postgres.js';
import { getProviderBreaker } from '../../../core/services/circuit-breaker.js';
import { runMigrations } from '../../../core/db/postgres.js';

const bus = vi.hoisted(() => ({ reconnect: undefined as (() => void) | undefined }));
vi.mock('../../../core/services/redis-cache-bus.js', () => ({
  isCacheBusActive: () => true,
  publish: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
  onReconnect: (handler: () => void) => { bus.reconnect = handler; return () => undefined; },
}));

import { getProviderCacheVersion, initProviderCacheBus } from './cache-bus.js';
import { loadProviderConfig } from './llm-provider-resolver.js';
import { providerRequestInfra } from './openai-compatible-client.js';

describe('provider cache reconnect', () => {
  beforeAll(async () => { await runMigrations(); initProviderCacheBus(); });
  afterAll(async () => { await closePool(); });

  it('invalidates cached configuration and resources, including unassigned providers', async () => {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, default_model)
       VALUES ($1, 'http://old/v1', 'none', false, 'old') RETURNING id`,
      [`reconnect-test-${crypto.randomUUID()}`],
    );
    const id = rows[0]!.id;
    const unassignedId = crypto.randomUUID();
    try {
      const config = await loadProviderConfig(id);
      const cachedDispatcher = providerRequestInfra.dispatcherFor(config);
      const cachedBreaker = getProviderBreaker(id);
      const unassigned = { ...config, providerId: unassignedId };
      const unassignedDispatcher = providerRequestInfra.dispatcherFor(unassigned);
      const unassignedBreaker = getProviderBreaker(unassignedId);
      await query(`UPDATE llm_providers SET base_url = 'http://new/v1', default_model = 'new' WHERE id = $1`, [id]);
      expect((await loadProviderConfig(id)).baseUrl).toBe('http://old/v1');
      const version = getProviderCacheVersion();
      expect(bus.reconnect).toBeTypeOf('function');
      bus.reconnect!();
      expect(getProviderCacheVersion()).toBe(version + 1);
      const refreshed = await loadProviderConfig(id);
      expect(refreshed).toMatchObject({ baseUrl: 'http://new/v1', defaultModel: 'new' });
      expect(providerRequestInfra.dispatcherFor(refreshed)).not.toBe(cachedDispatcher);
      expect(getProviderBreaker(id)).not.toBe(cachedBreaker);
      expect(providerRequestInfra.dispatcherFor(unassigned)).not.toBe(unassignedDispatcher);
      expect(getProviderBreaker(unassignedId)).not.toBe(unassignedBreaker);
    } finally {
      await query('DELETE FROM llm_providers WHERE id = $1', [id]);
    }
  });
});
