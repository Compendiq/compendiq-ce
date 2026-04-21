import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { listProviders, getProviderById, createProvider, updateProvider, deleteProvider, setDefaultProvider } from './llm-provider-service.js';
import { resolveUsecase } from './llm-provider-resolver.js';
import { bumpProviderCacheVersion, onProviderCacheBump, onProviderDeleted } from './cache-bus.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('llm-provider-service — read', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  it('listProviders returns [] when table empty', async () => {
    expect(await listProviders()).toEqual([]);
  });

  it('listProviders masks api_key', async () => {
    await query(
      `INSERT INTO llm_providers (name, base_url, api_key, auth_type, verify_ssl, default_model, is_default)
       VALUES ('X','http://x/v1','enc-sekret-abcd','bearer',true,'m1',true)`,
    );
    const rows = await listProviders();
    expect(rows[0]).toMatchObject({ name: 'X', hasApiKey: true });
    expect((rows[0] as unknown as { apiKey?: string }).apiKey).toBeUndefined();
  });

  it('getProviderById returns decrypted config including apiKey (server-side)', async () => {
    const { encryptPat } = await import('../../../core/utils/crypto.js');
    const encrypted = encryptPat('secret-value');
    const { rows } = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, api_key, auth_type, verify_ssl, default_model, is_default)
       VALUES ('X','http://x/v1',$1,'bearer',true,'m1',true) RETURNING id`,
      [encrypted],
    );
    const cfg = await getProviderById(rows[0]!.id);
    expect(cfg).toMatchObject({ name: 'X', apiKey: 'secret-value' });
  });
});

describe.skipIf(!dbAvailable)('llm-provider-service — write', () => {
  beforeEach(async () => { await truncateAllTables(); });

  it('create normalizes baseUrl and encrypts apiKey', async () => {
    const p = await createProvider({
      name: 'Box', baseUrl: 'http://gpu:11434', apiKey: 'topsecret',
      authType: 'bearer', verifySsl: true, defaultModel: 'm1',
    });
    expect(p.baseUrl).toBe('http://gpu:11434/v1');
    const raw = await query<{ api_key: string }>(`SELECT api_key FROM llm_providers WHERE id=$1`, [p.id]);
    expect(raw.rows[0]!.api_key).not.toBe('topsecret');  // encrypted
  });

  it('update with omitted apiKey keeps the stored key', async () => {
    const p = await createProvider({ name: 'A', baseUrl: 'http://a/v1', apiKey: 'orig', authType: 'bearer', verifySsl: true });
    await updateProvider(p.id, { defaultModel: 'm2' });
    const cfg = await getProviderById(p.id);
    expect(cfg!.apiKey).toBe('orig');
    expect(cfg!.defaultModel).toBe('m2');
  });

  it('setDefaultProvider flips is_default atomically', async () => {
    const a = await createProvider({ name: 'A', baseUrl: 'http://a/v1', authType: 'none', verifySsl: true });
    const b = await createProvider({ name: 'B', baseUrl: 'http://b/v1', authType: 'none', verifySsl: true });
    await setDefaultProvider(a.id);
    await setDefaultProvider(b.id);
    const list = await listProviders();
    expect(list.find(p => p.id === a.id)!.isDefault).toBe(false);
    expect(list.find(p => p.id === b.id)!.isDefault).toBe(true);
  });

  it('deleteProvider throws when provider is default', async () => {
    const a = await createProvider({ name: 'A', baseUrl: 'http://a/v1', authType: 'none', verifySsl: true });
    await setDefaultProvider(a.id);
    await expect(deleteProvider(a.id)).rejects.toThrow(/default/i);
  });

  it('deleteProvider throws with referenced-by info when in use', async () => {
    const a = await createProvider({ name: 'A', baseUrl: 'http://a/v1', authType: 'none', verifySsl: true });
    await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('chat',$1,'m')`, [a.id]);
    await expect(deleteProvider(a.id)).rejects.toThrow(/referenced/i);
  });
});

describe.skipIf(!dbAvailable)('cache invalidation on writes', () => {
  beforeEach(async () => { await truncateAllTables(); bumpProviderCacheVersion(); });
  it('updateProvider flips the cached baseUrl on the next resolve', async () => {
    const p = await createProvider({ name: 'A', baseUrl: 'http://a/v1', authType: 'none', verifySsl: true, defaultModel: 'm' });
    await setDefaultProvider(p.id);
    expect((await resolveUsecase('chat')).config.baseUrl).toBe('http://a/v1');
    await updateProvider(p.id, { baseUrl: 'http://aa/v1' });
    expect((await resolveUsecase('chat')).config.baseUrl).toBe('http://aa/v1');
  });
});

// Issue #267 — `deleteProvider` must emit a `providerDeleted(id)` signal on the
// cache-bus so per-provider resources (circuit breakers, undici dispatchers)
// can be dropped. Without this, `providerBreakers` leaks entries forever.
// Ordering matters: the delete event must fire *before* the cache-version bump
// so subscribers see the id before the generic invalidation sweep runs.
describe.skipIf(!dbAvailable)('deleteProvider emits providerDeleted event', () => {
  beforeEach(async () => { await truncateAllTables(); });

  it('deleteProvider emits providerDeleted before bumping cache version', async () => {
    const events: Array<{ kind: 'deleted'; id: string } | { kind: 'bump' }> = [];
    const offDel = onProviderDeleted((id) => events.push({ kind: 'deleted', id }));
    const offBump = onProviderCacheBump(() => events.push({ kind: 'bump' }));

    try {
      const p = await createProvider({
        name: 'to-delete', baseUrl: 'http://x', apiKey: null,
        authType: 'none', verifySsl: true, defaultModel: null,
      });
      // Creation itself bumps the cache version — clear the log before the act.
      events.length = 0;
      await deleteProvider(p.id);

      expect(events).toEqual([{ kind: 'deleted', id: p.id }, { kind: 'bump' }]);
    } finally {
      offDel();
      offBump();
    }
  });
});
