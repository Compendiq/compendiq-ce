import { query } from '../../../core/db/postgres.js';
import { decryptPat } from '../../../core/utils/crypto.js';
import type { LlmProvider } from '@compendiq/contracts';

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
