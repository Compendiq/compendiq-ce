import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closePool, getPool, query, runMigrations } from '../../../core/db/postgres.js';
import { getProviderBreaker } from '../../../core/services/circuit-breaker.js';
import type { QueryResult } from 'pg';
import { noopPlugin } from '../../../core/enterprise/noop.js';

const bus = vi.hoisted(() => ({ reconnect: undefined as (() => void) | undefined }));
vi.mock('../../../core/services/redis-cache-bus.js', () => ({
  isCacheBusActive: () => true,
  publish: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
  onReconnect: (handler: () => void) => { bus.reconnect = handler; return () => undefined; },
}));

import { getProviderCacheVersion, initProviderCacheBus } from './cache-bus.js';
import { loadProviderConfig, resolveRerankUsecase, resolveUsecase } from './llm-provider-resolver.js';
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

  it.each(['direct', 'explicit', 'inherited', 'override'] as const)(
    're-reads a real PostgreSQL %s result that crossed invalidation',
    async (path) => {
      const { rows } = await query<{ id: string }>(
        `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, default_model)
         VALUES ($1, 'http://old/v1', 'none', true, 'old') RETURNING id`,
        [`reconnect-race-${crypto.randomUUID()}`],
      );
      const id = rows[0]!.id;
      await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model)
        VALUES ('chat', $1, NULL), ('rerank', $1, NULL)
        ON CONFLICT (usecase) DO UPDATE SET provider_id = EXCLUDED.provider_id, model = NULL`, [id]);
      if (path === 'override') {
        vi.spyOn(noopPlugin, 'resolveUsecaseOverride').mockResolvedValue({ providerId: id, model: '' });
      }
      const resolve = async () => {
        if (path === 'direct') return loadProviderConfig(id);
        if (path === 'explicit') return (await resolveRerankUsecase())!.config;
        return (await resolveUsecase('chat')).config;
      };
      const held = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      const pool = getPool();
      const original = pool.query.bind(pool) as (sql: string, params?: unknown[]) => Promise<QueryResult>;
      let armed = true;
      const spy = vi.spyOn(pool, 'query').mockImplementation(((
        sql: string, params?: unknown[],
      ) => {
        const result = original(sql, params);
        if (armed && typeof sql === 'string' && sql.includes('provider_base_url')) {
          armed = false;
          return result.then(async (value) => { held.resolve(); await gate.promise; return value; });
        }
        return result;
      }) as typeof pool.query);
      try {
        const pending = resolve();
        await held.promise;
        await query(`UPDATE llm_providers SET base_url = 'http://new/v1', default_model = 'new' WHERE id = $1`, [id]);
        bus.reconnect!();
        gate.resolve();
        expect(await pending).toMatchObject({ baseUrl: 'http://new/v1', defaultModel: 'new' });
        expect(await resolve()).toMatchObject({ baseUrl: 'http://new/v1', defaultModel: 'new' });
      } finally {
        gate.resolve();
        spy.mockRestore();
        vi.restoreAllMocks();
        await query('DELETE FROM llm_usecase_assignments WHERE provider_id = $1', [id]);
        await query('DELETE FROM llm_providers WHERE id = $1', [id]);
      }
    },
  );
});
