import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { bootstrapLlmProviders } from './llm-provider-bootstrap.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('llm-provider-bootstrap', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => {
    await truncateAllTables();
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
  });

  it('seeds Ollama row from OLLAMA_BASE_URL on fresh install', async () => {
    process.env.OLLAMA_BASE_URL = 'http://gpu:11434';
    await bootstrapLlmProviders();
    const r = await query<{ name: string; base_url: string; is_default: boolean }>(`SELECT * FROM llm_providers`);
    expect(r.rows).toEqual([expect.objectContaining({ name: 'Ollama', base_url: 'http://gpu:11434/v1', is_default: true })]);
  });

  it('rewrites Ollama sentinel when OLLAMA_BASE_URL differs', async () => {
    await query(`INSERT INTO llm_providers (name, base_url, auth_type, is_default) VALUES ('Ollama','http://localhost:11434/v1','none',true)`);
    process.env.OLLAMA_BASE_URL = 'http://real:11434';
    await bootstrapLlmProviders();
    const r = await query<{ base_url: string }>(`SELECT base_url FROM llm_providers WHERE name='Ollama'`);
    expect(r.rows[0]!.base_url).toBe('http://real:11434/v1');
  });

  it('promotes oldest provider to default when none is flagged', async () => {
    await query(`INSERT INTO llm_providers (name, base_url, auth_type) VALUES ('X','http://x/v1','none')`);
    await bootstrapLlmProviders();
    const r = await query<{ is_default: boolean }>(`SELECT is_default FROM llm_providers WHERE name='X'`);
    expect(r.rows[0]!.is_default).toBe(true);
  });
});
