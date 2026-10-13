import type { LlmUsecase } from '@compendiq/contracts';
import { getPool } from '../../../core/db/postgres.js';
import { AI_POLICY_LOCK_NAMESPACE, type AiPolicy } from '../../../core/services/ai-policy-service.js';
import { emitAiPolicyEvent } from '../../../core/enterprise/ai-policy-hooks.js';
import {
  resolveImageAnalysisUsecase,
  resolveInlineCompletionUsecase,
  resolveRerankUsecase,
  resolveUsecase,
} from './llm-provider-resolver.js';

/**
 * Why an admission refused. `policy_none`/`provider_not_local` are policy
 * decisions proper. The rest are FAIL-CLOSED outcomes: a missing page, a
 * stage with no assignment, or a policy/provider row that could not be read
 * never admits. `stage_disabled` and `policy_unavailable` are retryable —
 * they describe the deployment, not the article — and are never persisted
 * as a `*.ai_policy_block_reason` (see `AiPolicyBlockReason`).
 */
export type AiPolicyAdmissionBlockReason =
  | 'policy_none' | 'provider_not_local' | 'not_found' | 'stage_disabled' | 'policy_unavailable';

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
      reason: AiPolicyAdmissionBlockReason;
      providerId: string | null;
      /** True when the refusal is about the deployment, not the article. */
      retryable: boolean;
    };

/** The block reasons a worker may persist in `*.ai_policy_block_reason`. */
export type AiPolicyBlockReason = 'policy_none' | 'provider_not_local';

export function isPersistableBlockReason(reason: AiPolicyAdmissionBlockReason): reason is AiPolicyBlockReason {
  return reason === 'policy_none' || reason === 'provider_not_local';
}

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

function refuse(
  pageId: number,
  policy: AiPolicy | null,
  reason: AiPolicyAdmissionBlockReason,
  providerId: string | null,
): Extract<AiPolicyAdmission, { admitted: false }> {
  return {
    admitted: false,
    pageId,
    policy,
    reason,
    providerId,
    retryable: reason === 'stage_disabled' || reason === 'policy_unavailable',
  };
}

/**
 * Admit one article for one use case. The provider is the one the existing
 * resolver chooses (EE department/organization overrides included), so the
 * admission never authorizes a different provider than dispatch would use.
 *
 * `rerank`, `inline_completion` and `image_analysis` NEVER inherit the
 * default provider (ADR-021/027): their dedicated resolvers answer `null`
 * for an unassigned stage, which is a fail-closed `stage_disabled` here —
 * never an admission against a provider nobody chose for that traffic.
 */
export async function admitPageForUsecase(pageId: number, usecase: LlmUsecase): Promise<AiPolicyAdmission> {
  let resolved: { config: { providerId: string }; model: string } | null;
  switch (usecase) {
    case 'rerank':
      resolved = await resolveRerankUsecase();
      break;
    case 'inline_completion':
      resolved = await resolveInlineCompletionUsecase();
      break;
    case 'image_analysis':
      resolved = await resolveImageAnalysisUsecase();
      break;
    default:
      resolved = await resolveUsecase(usecase);
  }
  if (!resolved) return refuse(pageId, null, 'stage_disabled', null);
  return admitPageForProvider(pageId, usecase, resolved.config.providerId, resolved.model);
}

/**
 * Admit one article against an EXPLICIT provider — the vision worker's
 * retained identity and the shadow migration's candidate pair, neither of
 * which the use-case resolver answers for. Same lock, same decision, same
 * events as `admitPageForUsecase`; a worker that holds a provider id must
 * never admit through the resolver, which could name a different one.
 *
 * A provider with no locality declaration (no row, or no locality columns)
 * is external at configuration revision 0: `provider_not_local` under
 * `local_only`, admitted under `all` — never read as local.
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
    // read as "no such provider" rather than as a cast error that fails the
    // worker's whole batch.
    // No readable locality declaration — a provider table without migration
    // 135's columns (42703) or no row for this id — IS a fact: the provider
    // is undeclared, hence external at revision 0 (SPEC-WORK-001: an
    // undeclared provider is `provider_not_local` under `local_only`, lifted
    // by the per-pass re-check once a declaration exists). It is never read
    // as local and never given a made-up revision.
    await client.query('SAVEPOINT ai_policy_provider');
    let prov: { rows: Array<{ locality: string; locality_config_revision: string | null; config_revision: string }> } | null;
    try {
      prov = await client.query<{ locality: string; locality_config_revision: string | null; config_revision: string }>(
        `SELECT locality, locality_config_revision, config_revision FROM llm_providers WHERE id::text = $1`,
        [providerId],
      );
    } catch (err) {
      if ((err as { code?: string }).code !== '42703') throw err;
      await client.query('ROLLBACK TO SAVEPOINT ai_policy_provider');
      prov = null;
    }
    await client.query('COMMIT');
    const p = page.rows[0];
    if (!p) return refuse(pageId, null, 'not_found', providerId);
    const row = prov?.rows[0];
    const provider = row
      ? {
          locality: row.locality,
          localityConfigRevision: row.locality_config_revision === null ? null : Number(row.locality_config_revision),
          configRevision: Number(row.config_revision),
        }
      : { locality: 'external', localityConfigRevision: null, configRevision: 0 };
    const decision = decideAiPolicyAdmission(p.ai_policy, provider);
    if (decision !== 'admit') {
      emitAiPolicyEvent({ type: 'blocked', pageId, usecase, providerId, reason: decision, policy: p.ai_policy });
      return refuse(pageId, p.ai_policy, decision, providerId);
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
