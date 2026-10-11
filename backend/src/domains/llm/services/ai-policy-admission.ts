import type { LlmUsecase } from '@compendiq/contracts';
import { getPool } from '../../../core/db/postgres.js';
import { AI_POLICY_LOCK_NAMESPACE, type AiPolicy } from '../../../core/services/ai-policy-service.js';
import { emitAiPolicyEvent } from '../../../core/enterprise/ai-policy-hooks.js';
import { resolveUsecase } from './llm-provider-resolver.js';

export type AiPolicyAdmission =
  | {
      admitted: true;
      pageId: number;
      policy: AiPolicy;
      policyRevision: number;
      /** Binding: dispatch must use exactly this provider at this revision. */
      providerId: string;
      configRevision: number;
      locality: 'local' | 'external';
      model: string;
    }
  | {
      admitted: false;
      pageId: number;
      policy: AiPolicy | null;
      reason: 'policy_none' | 'provider_not_local' | 'not_found';
      providerId: string | null;
    };

/** The block reasons a worker may persist in `*.ai_policy_block_reason`. */
export type AiPolicyBlockReason = 'policy_none' | 'provider_not_local';

/**
 * Pure decision. Unknown/undeclared/stale locality never satisfies
 * `local_only`: only `locality = 'local'` declared against the provider's
 * CURRENT configuration revision does.
 */
export function decideAiPolicyAdmission(
  policy: AiPolicy,
  provider: { locality: string; localityConfigRevision: number | null; configRevision: number },
): 'admit' | 'policy_none' | 'provider_not_local' {
  if (policy === 'none') return 'policy_none';
  if (policy === 'local_only') {
    const local = provider.locality === 'local'
      && provider.localityConfigRevision !== null
      && provider.localityConfigRevision === provider.configRevision;
    return local ? 'admit' : 'provider_not_local';
  }
  return 'admit';
}

/**
 * Admit one article for one use case. The provider is the one the existing
 * resolver chooses (EE department/organization overrides included), so the
 * admission never authorizes a different provider than dispatch would use.
 * The policy and locality are read under a shared advisory lock in the same
 * namespace policy mutations take exclusively.
 */
export async function admitPageForUsecase(pageId: number, usecase: LlmUsecase): Promise<AiPolicyAdmission> {
  const resolved = await resolveUsecase(usecase);
  return admitPageForProvider(pageId, usecase, resolved.config.providerId, resolved.model);
}

/**
 * Admit one article against an EXPLICIT provider — the vision worker's
 * retained identity and the shadow migration's candidate pair, neither of
 * which the use-case resolver answers for. Same lock, same decision, same
 * events as `admitPageForUsecase`; a worker that holds a provider id must
 * never admit through the resolver, which could name a different one.
 */
export async function admitPageForProvider(
  pageId: number,
  usecase: LlmUsecase,
  providerId: string,
  model: string,
): Promise<AiPolicyAdmission> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query('SELECT pg_advisory_xact_lock_shared($1, $2)', [AI_POLICY_LOCK_NAMESPACE, pageId]);
    const page = await client.query<{ ai_policy: AiPolicy; ai_policy_revision: string }>(
      `SELECT ai_policy, ai_policy_revision FROM pages WHERE id = $1 AND deleted_at IS NULL`,
      [pageId],
    );
    // `id::text`: the column is a uuid and an unknown or test-shaped id must
    // read as "no such provider" (external), never as a cast error that
    // fails the worker's whole batch.
    // Unknown locality never authorizes local_only: a provider table that
    // carries no locality columns (fixtures, partial schemas) reads as an
    // external provider rather than aborting the worker's batch.
    await client.query('SAVEPOINT ai_policy_provider');
    let prov: { rows: Array<{ locality: string; locality_config_revision: string | null; config_revision: string }> };
    try {
      prov = await client.query<{ locality: string; locality_config_revision: string | null; config_revision: string }>(
        `SELECT locality, locality_config_revision, config_revision FROM llm_providers WHERE id::text = $1`,
        [providerId],
      );
    } catch (err) {
      if ((err as { code?: string }).code !== '42703') throw err;
      await client.query('ROLLBACK TO SAVEPOINT ai_policy_provider');
      prov = { rows: [] };
    }
    await client.query('COMMIT');
    const p = page.rows[0];
    if (!p) return { admitted: false, pageId, policy: null, reason: 'not_found', providerId };
    const row = prov.rows[0];
    const provider = row
      ? {
          locality: row.locality,
          localityConfigRevision: row.locality_config_revision === null ? null : Number(row.locality_config_revision),
          configRevision: Number(row.config_revision),
        }
      : { locality: 'external', localityConfigRevision: null, configRevision: -1 };
    const decision = decideAiPolicyAdmission(p.ai_policy, provider);
    if (decision !== 'admit') {
      emitAiPolicyEvent({ type: 'blocked', pageId, usecase, providerId, reason: decision, policy: p.ai_policy });
      return { admitted: false, pageId, policy: p.ai_policy, reason: decision, providerId };
    }
    const policyRevision = Number(p.ai_policy_revision);
    emitAiPolicyEvent({
      type: 'admitted', pageId, usecase, providerId,
      configRevision: provider.configRevision, policy: p.ai_policy, policyRevision,
    });
    return {
      admitted: true,
      pageId,
      policy: p.ai_policy,
      policyRevision,
      providerId,
      configRevision: provider.configRevision,
      locality: provider.locality === 'local' ? 'local' : 'external',
      model,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * SQL predicate (no parameters) selecting pages whose `provider_not_local`
 * block deserves a re-check: the block was a fact about the provider, and a
 * locality declaration or assignment change may since have lifted it. A
 * `policy_none` block is lifted only by a policy mutation (`updatePageAiPolicies`).
 */
export const RECHECKABLE_BLOCK_SQL = `ai_policy_block_reason = 'provider_not_local' AND ai_policy <> 'none'`;
