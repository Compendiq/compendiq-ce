import type { LlmUsecase } from '@compendiq/contracts';
import type { PoolClient } from 'pg';
import { getPool } from '../../../core/db/postgres.js';
import { AI_POLICY_LOCK_NAMESPACE, type AiPolicy } from '../../../core/services/ai-policy-service.js';
import { emitAiPolicyEvent } from '../../../core/enterprise/ai-policy-hooks.js';
import { logger } from '../../../core/utils/logger.js';
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
  provider: { locality: string; localityConfigRevision: number | null; configRevision: number; localityDeclaredBy?: string | null },
): 'admit' | 'policy_none' | 'provider_not_local' {
  if (policy === 'none') return 'policy_none';
  if (policy === 'local_only') {
    // A declaration nobody is accountable for (declarer NULL) is no declaration.
    const local = provider.locality === 'local'
      && (provider.localityDeclaredBy === undefined || provider.localityDeclaredBy !== null)
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
  if (!resolved) {
    emitAiPolicyEvent({ type: 'blocked', pageId, usecase, providerId: null, reason: 'stage_disabled', policy: null });
    return refuse(pageId, null, 'stage_disabled', null);
  }
  return admitPageForProvider(pageId, usecase, resolved.config.providerId, resolved.model);
}

/**
 * Admit one article against an EXPLICIT provider — the vision worker's
 * retained identity and the shadow migration's candidate pair, neither of
 * which the use-case resolver answers for. Same lock, same decision, same
 * events as `admitPageForUsecase`; a worker that holds a provider id must
 * never admit through the resolver, which could name a different one.
 *
 * FAIL CLOSED (#280 review): a provider table without the locality columns
 * or any failure to connect/read the policy or provider state refuses with
 * the retryable `policy_unavailable`. A provider id with no row carries no
 * declaration and is treated as undeclared external: `provider_not_local`
 * under `local_only` (persistable, lifted by the per-pass re-check once a
 * declared-local provider is assigned), admitted under `all`. `none` is
 * decided before the provider is consulted. Every refusal emits exactly one
 * `blocked` event.
 */
export async function admitPageForProvider(
  pageId: number,
  usecase: LlmUsecase,
  providerId: string,
  model: string,
): Promise<AiPolicyAdmission> {
  let client: PoolClient | null = null;
  let p: { ai_policy: AiPolicy; ai_policy_revision: string } | undefined;
  let row: { locality: string; locality_config_revision: string | null; config_revision: string; locality_declared_by: string | null } | undefined;
  try {
    client = await getPool().connect();
    await client.query('BEGIN READ ONLY');
    await client.query('SELECT pg_advisory_xact_lock_shared($1, $2)', [AI_POLICY_LOCK_NAMESPACE, pageId]);
    const page = await client.query<{ ai_policy: AiPolicy; ai_policy_revision: string }>(
      `SELECT ai_policy, ai_policy_revision FROM pages WHERE id = $1 AND deleted_at IS NULL`,
      [pageId],
    );
    // `id::text`: the column is a uuid and an unknown or test-shaped id must
    // read as "no such provider" (refused below) rather than as a cast error.
    const prov = await client.query<{ locality: string; locality_config_revision: string | null; config_revision: string; locality_declared_by: string | null }>(
      `SELECT locality, locality_config_revision, config_revision, locality_declared_by
         FROM llm_providers WHERE id::text = $1`,
      [providerId],
    );
    await client.query('COMMIT');
    p = page.rows[0];
    row = prov.rows[0];
  } catch (err) {
    // Connection refused, missing columns, cancelled statement, …: the
    // policy state is UNKNOWN, so nothing is admitted. Retryable.
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    logger.warn({ err, pageId, usecase, providerId }, 'AI policy admission could not read policy state; refusing');
    emitAiPolicyEvent({ type: 'blocked', pageId, usecase, providerId, reason: 'policy_unavailable', policy: null });
    return refuse(pageId, null, 'policy_unavailable', providerId);
  } finally {
    client?.release();
  }
  if (!p) {
    emitAiPolicyEvent({ type: 'blocked', pageId, usecase, providerId, reason: 'not_found', policy: null });
    return refuse(pageId, null, 'not_found', providerId);
  }
  if (p.ai_policy === 'none') {
    // A fact about the article, not the provider: persistable, never retried
    // against a different provider state.
    emitAiPolicyEvent({ type: 'blocked', pageId, usecase, providerId, reason: 'policy_none', policy: p.ai_policy });
    return refuse(pageId, p.ai_policy, 'policy_none', providerId);
  }
  // A provider id with no row (deleted between resolution and admission, or
  // a resolver-level assignment that is not a persisted provider) carries NO
  // declaration, and an undeclared provider is external: `local_only`
  // refuses it as `provider_not_local` — a persistable block that the
  // per-pass re-check (`RECHECKABLE_BLOCK_SQL`) lifts once a declared-local
  // provider is assigned — and `all` admits it as undeclared external at
  // revision 0. Nothing is ever inferred local.
  const provider = row
    ? {
        locality: row.locality,
        localityConfigRevision: row.locality_config_revision === null ? null : Number(row.locality_config_revision),
        configRevision: Number(row.config_revision),
        localityDeclaredBy: row.locality_declared_by,
      }
    : { locality: 'external', localityConfigRevision: null, configRevision: 0, localityDeclaredBy: null };
  {
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
  }
}

/**
 * SQL predicate (no parameters) selecting pages whose `provider_not_local`
 * block deserves a re-check: the block was a fact about the provider, and a
 * locality declaration or assignment change may since have lifted it. A
 * `policy_none` block is lifted only by a policy mutation (`updatePageAiPolicies`).
 */
export const RECHECKABLE_BLOCK_SQL = `ai_policy_block_reason = 'provider_not_local' AND ai_policy <> 'none'`;
