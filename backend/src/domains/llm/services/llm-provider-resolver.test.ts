import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { createProvider, setDefaultProvider } from './llm-provider-service.js';
import { resolveUsecase } from './llm-provider-resolver.js';
import { bumpProviderCacheVersion } from './cache-bus.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('resolveUsecase — truth table', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => {
    await truncateAllTables();
    bumpProviderCacheVersion();
  });

  async function seed() {
    const a = await createProvider({ name: 'A', baseUrl: 'http://a/v1', authType: 'none', verifySsl: true, defaultModel: 'mA' });
    const b = await createProvider({ name: 'B', baseUrl: 'http://b/v1', authType: 'none', verifySsl: true, defaultModel: 'mB' });
    await setDefaultProvider(a.id);
    return { aId: a.id, bId: b.id };
  }

  it('inherit (null,null) -> default provider + default_model', async () => {
    const { aId } = await seed();
    const r = await resolveUsecase('chat');
    expect(r.config.id).toBe(aId);
    expect(r.model).toBe('mA');
  });

  it('provider-only (B, null) -> B + B.default_model', async () => {
    const { bId } = await seed();
    await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('summary',$1,NULL)`, [bId]);
    const r = await resolveUsecase('summary');
    expect(r.config.id).toBe(bId);
    expect(r.model).toBe('mB');
  });

  it('full override (B, "gpt-4o") -> B + "gpt-4o"', async () => {
    const { bId } = await seed();
    await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('quality',$1,$2)`, [bId, 'gpt-4o']);
    const r = await resolveUsecase('quality');
    expect(r.config.id).toBe(bId);
    expect(r.model).toBe('gpt-4o');
  });

  it('model-only (null, "gpt-4o") -> default provider + "gpt-4o"', async () => {
    const { aId } = await seed();
    await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('auto_tag',NULL,$1)`, ['gpt-4o']);
    const r = await resolveUsecase('auto_tag');
    expect(r.config.id).toBe(aId);
    expect(r.model).toBe('gpt-4o');
  });

  it('throws when no default provider exists', async () => {
    await expect(resolveUsecase('chat')).rejects.toThrow(/no default/i);
  });

  it('changes take effect without restart (no caching on assignment)', async () => {
    const { aId, bId } = await seed();
    await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('chat',$1,NULL)`, [aId]);
    expect((await resolveUsecase('chat')).config.id).toBe(aId);
    await query(`UPDATE llm_usecase_assignments SET provider_id=$1 WHERE usecase='chat'`, [bId]);
    expect((await resolveUsecase('chat')).config.id).toBe(bId);
  });
});
