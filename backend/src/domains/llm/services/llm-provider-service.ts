import { query, getPool } from '../../../core/db/postgres.js';
import { decryptPat, encryptPat } from '../../../core/utils/crypto.js';
import type { LlmProvider, LlmProviderInput, LlmProviderUpdate } from '@compendiq/contracts';

/** Internal row shape returned from PG — includes the encrypted api_key. */
interface ProviderRow {
  id: string;
  name: string;
  base_url: string;
  api_key: string | null;
  auth_type: 'bearer' | 'none';
  verify_ssl: boolean;
  default_model: string | null;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

/** Server-side config — decrypted. NEVER returned from HTTP routes. */
export interface ProviderConfigRow {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string | null;
  authType: 'bearer' | 'none';
  verifySsl: boolean;
  defaultModel: string | null;
  isDefault: boolean;
}

function rowToDto(r: ProviderRow): LlmProvider {
  const preview = r.api_key ? ('…' + (decryptSafe(r.api_key)?.slice(-4) ?? '')) : null;
  return {
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    authType: r.auth_type,
    verifySsl: r.verify_ssl,
    defaultModel: r.default_model,
    isDefault: r.is_default,
    hasApiKey: r.api_key !== null,
    keyPreview: preview,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

function rowToConfig(r: ProviderRow): ProviderConfigRow {
  return {
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    apiKey: r.api_key ? decryptSafe(r.api_key) : null,
    authType: r.auth_type,
    verifySsl: r.verify_ssl,
    defaultModel: r.default_model,
    isDefault: r.is_default,
  };
}

function decryptSafe(enc: string): string | null {
  try { return decryptPat(enc); } catch { return null; }
}

export async function listProviders(): Promise<LlmProvider[]> {
  const r = await query<ProviderRow>(`SELECT * FROM llm_providers ORDER BY is_default DESC, name ASC`);
  return r.rows.map(rowToDto);
}

export async function getProviderById(id: string): Promise<ProviderConfigRow | null> {
  const r = await query<ProviderRow>(`SELECT * FROM llm_providers WHERE id=$1`, [id]);
  return r.rows[0] ? rowToConfig(r.rows[0]) : null;
}

export async function getDefaultProvider(): Promise<ProviderConfigRow | null> {
  const r = await query<ProviderRow>(`SELECT * FROM llm_providers WHERE is_default=TRUE LIMIT 1`);
  return r.rows[0] ? rowToConfig(r.rows[0]) : null;
}

export function normalizeBaseUrl(raw: string): string {
  let s = raw.trim().replace(/\/+$/, '');
  if (!/\/v1$/.test(s)) s += '/v1';
  return s;
}

export async function createProvider(input: LlmProviderInput): Promise<LlmProvider> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const apiKey = input.apiKey ? encryptPat(input.apiKey) : null;
  const r = await query<ProviderRow>(
    `INSERT INTO llm_providers (name, base_url, api_key, auth_type, verify_ssl, default_model)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [input.name.trim(), baseUrl, apiKey, input.authType, input.verifySsl, input.defaultModel ?? null],
  );
  return rowToDto(r.rows[0]!);
}

export async function updateProvider(id: string, patch: LlmProviderUpdate): Promise<LlmProvider | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  const push = (col: string, val: unknown) => { sets.push(`${col}=$${i++}`); vals.push(val); };
  if (patch.name !== undefined)         push('name', patch.name.trim());
  if (patch.baseUrl !== undefined)      push('base_url', normalizeBaseUrl(patch.baseUrl));
  if (patch.apiKey !== undefined)       push('api_key', patch.apiKey ? encryptPat(patch.apiKey) : null);
  if (patch.authType !== undefined)     push('auth_type', patch.authType);
  if (patch.verifySsl !== undefined)    push('verify_ssl', patch.verifySsl);
  if (patch.defaultModel !== undefined) push('default_model', patch.defaultModel);
  if (sets.length === 0) {
    const row = await query<ProviderRow>(`SELECT * FROM llm_providers WHERE id=$1`, [id]);
    return row.rows[0] ? rowToDto(row.rows[0]) : null;
  }
  sets.push(`updated_at=NOW()`);
  vals.push(id);
  const r = await query<ProviderRow>(
    `UPDATE llm_providers SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals,
  );
  return r.rows[0] ? rowToDto(r.rows[0]) : null;
}

export async function deleteProvider(id: string): Promise<void> {
  const row = await query<{ is_default: boolean }>(`SELECT is_default FROM llm_providers WHERE id=$1`, [id]);
  if (!row.rows[0]) return;
  if (row.rows[0].is_default) {
    throw new Error('Cannot delete the default provider — set another provider as default first.');
  }
  const refs = await query<{ usecase: string }>(
    `SELECT usecase FROM llm_usecase_assignments WHERE provider_id=$1`, [id],
  );
  if (refs.rows.length > 0) {
    throw new Error(`Provider is referenced by: ${refs.rows.map(r => r.usecase).join(', ')}`);
  }
  await query(`DELETE FROM llm_providers WHERE id=$1`, [id]);
}

export async function setDefaultProvider(id: string): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE llm_providers SET is_default=FALSE WHERE is_default=TRUE`);
    const r = await client.query(`UPDATE llm_providers SET is_default=TRUE, updated_at=NOW() WHERE id=$1`, [id]);
    if (r.rowCount === 0) throw new Error('Provider not found');
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}
