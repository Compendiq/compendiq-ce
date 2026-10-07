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
  const providerId = resolved.config.providerId;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query('SELECT pg_advisory_xact_lock_shared($1, $2)', [AI_POLICY_LOCK_NAMESPACE, pageId]);
    const page = await client.query<{ ai_policy: AiPolicy; ai_policy_revision: string }>(
      `SELECT ai_policy, ai_policy_revision FROM pages WHERE id = $1 AND deleted_at IS NULL`,
      [pageId],
    );
    const prov = await client.query<{ locality: string; locality_config_revision: string | null; config_revision: string }>(
      `SELECT locality, locality_config_revision, config_revision FROM llm_providers WHERE id = $1`,
      [providerId],
    );
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
      model: resolved.model,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
