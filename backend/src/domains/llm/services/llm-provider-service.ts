import { query, getPool } from '../../../core/db/postgres.js';
import { decryptPat, encryptPat } from '../../../core/utils/crypto.js';
import { bumpProviderCacheVersion, emitProviderDeleted } from './cache-bus.js';
import { invalidateProviderCapabilities } from './model-capabilities.js';
import { PROVIDER_RESOURCE_SUFFIXES } from './provider-url.js';
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
  /** #280 — locality columns (migration 135). */
  locality: 'local' | 'external';
  config_revision: string;
  locality_config_revision: string | null;
  locality_declared_by: string | null;
  locality_declared_at: Date | null;
}

/** Server-side config — decrypted. NEVER returned from HTTP routes. */
interface ProviderConfigRow {
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
    // A schema without migration 135's columns reads as undeclared/external:
    // unknown locality never confirms local.
    locality: r.locality === 'local' ? 'local' : 'external',
    configRevision: r.config_revision === undefined || r.config_revision === null ? 0 : Number(r.config_revision),
    localityDeclaredAt: r.locality_declared_at ? r.locality_declared_at.toISOString() : null,
    localityDeclaredBy: r.locality_declared_by ?? null,
    localConfirmed: r.locality === 'local'
      && r.locality_declared_by !== null && r.locality_declared_by !== undefined
      && r.locality_config_revision !== null && r.locality_config_revision !== undefined
      && Number(r.locality_config_revision) === Number(r.config_revision),
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

/**
 * Drop a trailing `/v1` that the old "does not end with /v1" normalizer
 * appended onto a pasted resource (`…/embeddings/v1`). Keep the resource.
 */
function healStrayVersionOnResource(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  if (!trimmed.endsWith('/v1')) return trimmed;
  const withoutVersion = trimmed.slice(0, -'/v1'.length);
  if (PROVIDER_RESOURCE_SUFFIXES.some((suffix) => withoutVersion.endsWith(suffix))) {
    return withoutVersion;
  }
  return trimmed;
}

/**
 * Store the operator's URL. Trailing slashes are trimmed. Bare hosts get `/v1`.
 * `/embeddings` and `/rerank` are kept — the client must not be given a
 * rewritten root when the operator pasted the endpoint they want called.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const u = new URL(trimmed);
    let path = healStrayVersionOnResource(u.pathname);
    const segments = path.split('/').filter(Boolean);
    if (segments.length === 0) path = '/v1';
    u.pathname = path || '/v1';
    u.search = '';
    u.hash = '';
    return u.href.replace(/\/+$/, '');
  } catch {
    let s = healStrayVersionOnResource(trimmed.replace(/\/+$/, ''));
    if (!s.includes('://')) return s;
    const afterProto = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    if (!afterProto.includes('/')) s += '/v1';
    return s;
  }
}

/**
 * A locality declaration without an identified administrator is refused
 * (#280 review): `locality_declared_by` is the accountability record every
 * `local_only` admission ultimately rests on.
 */
export class LocalityActorRequiredError extends Error {
  readonly statusCode = 401;
  readonly reason = 'locality_actor_required';
  constructor() {
    super('A provider locality declaration must be made by an identified administrator');
    this.name = 'LocalityActorRequiredError';
  }
}

function requireDeclaringActor(locality: 'local' | 'external' | undefined, actorId: string | undefined): string | null {
  if (locality === undefined) return null;
  if (typeof actorId !== 'string' || actorId.length === 0) throw new LocalityActorRequiredError();
  return actorId;
}

/**
 * `actorId` is the administrator declaring `input.locality` (#280) and is
 * REQUIRED whenever a locality is declared — `local` or `external` alike:
 * both are recorded with declarer, time and the configuration revision they
 * were made against. Omitted locality means the column default `external`
 * with no declaration. A `local` declaration is bound to the revision the
 * insert produces, so the row satisfies `llm_providers_local_declared_check`
 * from the first commit.
 */
export async function createProvider(input: LlmProviderInput, actorId?: string): Promise<LlmProvider> {
  const declaringActor = requireDeclaringActor(input.locality, actorId);
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const apiKey = input.apiKey ? encryptPat(input.apiKey) : null;
  const base = [input.name.trim(), baseUrl, apiKey, input.authType, input.verifySsl, input.defaultModel ?? null];
  // The locality columns are named only when a locality was declared, so the
  // column default (`external`) answers for every other create.
  const r = input.locality === undefined
    ? await query<ProviderRow>(
        `INSERT INTO llm_providers (name, base_url, api_key, auth_type, verify_ssl, default_model)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        base,
      )
    : await query<ProviderRow>(
        `INSERT INTO llm_providers
           (name, base_url, api_key, auth_type, verify_ssl, default_model,
            locality, locality_declared_by, locality_declared_at, locality_config_revision)
         VALUES ($1,$2,$3,$4,$5,$6, $7, $8::uuid, clock_timestamp(), 1)
         RETURNING *`,
        [...base, input.locality, declaringActor],
      );
  await bumpProviderCacheVersion();
  return rowToDto(r.rows[0]!);
}

/**
 * A `locality` in the patch is declared in the SAME UPDATE as any endpoint
 * edit, so the migration-135 trigger sees a fresh `locality_declared_at` and
 * binds the declaration to the new configuration revision rather than
 * resetting it to `external`. The declaring administrator is required.
 */
export async function updateProvider(id: string, patch: LlmProviderUpdate, actorId?: string): Promise<LlmProvider | null> {
  const declaringActor = requireDeclaringActor(patch.locality, actorId);
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
  if (patch.locality !== undefined) {
    push('locality', patch.locality);
    push('locality_declared_by', declaringActor);
    sets.push('locality_declared_at = clock_timestamp()');
    sets.push('locality_config_revision = config_revision');
  }
  if (sets.length === 0) {
    const row = await query<ProviderRow>(`SELECT * FROM llm_providers WHERE id=$1`, [id]);
    return row.rows[0] ? rowToDto(row.rows[0]) : null;
  }
  sets.push(`updated_at=NOW()`);
  vals.push(id);
  const r = await query<ProviderRow>(
    `UPDATE llm_providers SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals,
  );
  await bumpProviderCacheVersion();
  // #1154: a changed base_url or api_key can put an entirely different model
  // behind the same name, so the cached capability verdicts for this provider
  // are no longer trustworthy. Drop them and let the read path re-probe.
  await invalidateProviderCapabilities(id);
  return r.rows[0] ? rowToDto(r.rows[0]) : null;
}

export interface ProviderLocalityState {
  providerId: string;
  locality: 'local' | 'external';
  configRevision: number;
  /** True only when `local` was declared against the current configuration. */
  localConfirmed: boolean;
  declaredBy: string | null;
  declaredAt: string | null;
}

interface LocalityRow {
  id: string;
  locality: 'local' | 'external';
  config_revision: string;
  locality_config_revision: string | null;
  locality_declared_by: string | null;
  locality_declared_at: Date | null;
}

function localityRowToState(r: LocalityRow): ProviderLocalityState {
  const configRevision = Number(r.config_revision);
  return {
    providerId: r.id,
    locality: r.locality,
    configRevision,
    localConfirmed: r.locality === 'local'
      && r.locality_declared_by !== null
      && r.locality_config_revision !== null
      && Number(r.locality_config_revision) === configRevision,
    declaredBy: r.locality_declared_by,
    declaredAt: r.locality_declared_at ? r.locality_declared_at.toISOString() : null,
  };
}

export async function getProviderLocality(id: string): Promise<ProviderLocalityState | null> {
  const r = await query<LocalityRow>(
    `SELECT id, locality, config_revision, locality_config_revision, locality_declared_by, locality_declared_at
       FROM llm_providers WHERE id = $1`,
    [id],
  );
  return r.rows[0] ? localityRowToState(r.rows[0]) : null;
}

/**
 * Declare (or reconfirm) a provider's locality against the configuration
 * revision the administrator inspected. A stale revision — the endpoint was
 * edited meanwhile — is refused, so a declaration can never attach to an
 * endpoint nobody looked at. Endpoint edits reset locality to `external` in
 * the database trigger installed by migration 135.
 */
export async function declareProviderLocality(
  id: string,
  locality: 'local' | 'external',
  expectedConfigRevision: number,
  actorId: string,
): Promise<{ ok: true; state: ProviderLocalityState } | { ok: false; reason: 'not_found' | 'stale_config_revision' }> {
  const r = await query<LocalityRow>(
    `UPDATE llm_providers
        SET locality = $2,
            locality_declared_by = $4,
            locality_declared_at = clock_timestamp(),
            locality_config_revision = config_revision,
            updated_at = NOW()
      WHERE id = $1 AND config_revision = $3
      RETURNING id, locality, config_revision, locality_config_revision, locality_declared_by, locality_declared_at`,
    [id, locality, expectedConfigRevision, actorId],
  );
  if (!r.rows[0]) {
    const exists = await query(`SELECT 1 FROM llm_providers WHERE id = $1`, [id]);
    return { ok: false, reason: exists.rowCount ? 'stale_config_revision' : 'not_found' };
  }
  await bumpProviderCacheVersion();
  return { ok: true, state: localityRowToState(r.rows[0]) };
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
  // Emit the deletion event *before* the cache-version bump so subscribers
  // see the id before the generic cache sweep runs (issue #267). The bump
  // listener only iterates the resolver's configCache and would otherwise
  // miss providers that were contacted (e.g. "Test connection") but never
  // bound to a use-case.
  await emitProviderDeleted(id);
  await bumpProviderCacheVersion();
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
  await bumpProviderCacheVersion();
}
