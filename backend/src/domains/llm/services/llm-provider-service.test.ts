import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { listProviders, getProviderById } from './llm-provider-service.js';

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
