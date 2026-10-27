import type { LlmUsecase } from '@compendiq/contracts';
import type { PoolClient } from 'pg';
import { getPool } from '../../../core/db/postgres.js';
import { AI_POLICY_LOCK_NAMESPACE, isAiPolicy, type AiPolicy } from '../../../core/services/ai-policy-service.js';
import { randomUUID } from 'node:crypto';
import type { AiDecisionEvent, AiOperationContext } from '@compendiq/contracts';
import { emitAiDecision } from '../../../core/enterprise/ai-policy-hooks.js';
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
      /** The provider's EFFECTIVE locality (see `decodeProviderMetadata`). */
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

// ─── Provider metadata decoder ───────────────────────────────────────────────

/**
 * The `llm_providers` columns every locality consumer must read — the SELECT
 * list and the decoder are kept together so no caller can read a subset and
 * reach a different verdict.
 */
export const PROVIDER_METADATA_COLUMNS =
  'locality, locality_config_revision, config_revision, locality_declared_by, locality_declared_at';

export interface ProviderMetadataRow {
  locality: unknown;
  locality_config_revision: unknown;
  config_revision: unknown;
  locality_declared_by: unknown;
  locality_declared_at: unknown;
}

export interface ProviderMetadata {
  /** The provider's current configuration revision. */
  configRevision: number;
  /**
   * `local` ONLY when a `local` declaration is accountable (declarer still
   * exists — the FK is `ON DELETE SET NULL`), dated, and made against the
   * CURRENT configuration revision. Anything else is `external`.
   */
  effectiveLocality: 'local' | 'external';
  declaredBy: string | null;
  declaredAt: Date | null;
}

const MAX_SAFE_REVISION_TEXT = String(Number.MAX_SAFE_INTEGER);

/**
 * A revision is a non-negative SAFE integer, as PG returns it (bigint →
 * decimal string) or as a number. Anything else is unprovable (`null`):
 * `NaN`/`±Infinity`, negatives, fractions, numbers above
 * `Number.MAX_SAFE_INTEGER`, and digit strings that `Number()` could only
 * represent by ROUNDING (a 2^53+1 revision must never compare equal to
 * 2^53, and a 400-digit string must never read as `Infinity`). The string
 * comparison is exact — no float conversion happens before the bound check.
 */
export function asRevision(v: unknown): number | null {
  if (typeof v === 'number') {
    return Number.isSafeInteger(v) && v >= 0 ? v : null;
  }
  if (typeof v === 'string' && /^\d+$/.test(v)) {
    const digits = v.replace(/^0+(?=\d)/, '');
    if (digits.length > MAX_SAFE_REVISION_TEXT.length) return null;
    if (digits.length === MAX_SAFE_REVISION_TEXT.length && digits > MAX_SAFE_REVISION_TEXT) return null;
    const n = Number(digits);
    return Number.isSafeInteger(n) && String(n) === digits ? n : null;
  }
  return null;
}

/**
 * Decode one nullable column with THREE outcomes: `undefined` (the column was
 * not selected — unprovable), `null` (SQL NULL — a legitimate value), or the
 * decoded value. The `absent` sentinel keeps "omitted" apart from "NULL" so a
 * SELECT that forgot a column can never read as a NULL declaration.
 */
const ABSENT = Symbol('absent');
type Decoded<T> = T | null | typeof ABSENT | undefined;

function decodeDeclaredBy(v: unknown): Decoded<string> {
  if (v === undefined) return ABSENT;
  if (v === null) return null;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function decodeDeclaredAt(v: unknown): Decoded<Date> {
  if (v === undefined) return ABSENT;
  if (v === null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v;
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

function decodeLocalityRevision(v: unknown): Decoded<number> {
  if (v === undefined) return ABSENT;
  if (v === null) return null;
  return asRevision(v) ?? undefined;
}

/**
 * THE one effective-locality decoder. Admission, the admitted binding's
 * `locality`, the provider DTO's `localConfirmed`, the sub-page traversal and
 * the shadow-migration straggler count all go through here, so no two of
 * them can disagree about what "local" means.
 *
 * Returns `null` when the row is UNPROVABLE — not a row at all, a revision
 * that is not a non-negative safe integer, a locality outside the declared
 * set, a declaration column that was NOT SELECTED (`undefined` is "unknown",
 * never "NULL"), an invalid date, or a `local` declaration whose supporting
 * columns contradict the schema invariant
 * (`llm_providers_local_declared_check`). An unprovable row never admits and
 * never reads as external by default: callers map it to the retryable
 * unavailable reason of their boundary.
 *
 * SQL NULL is a legitimate value: an undeclared `external` row carries NULL
 * in all three declaration columns, and a `local` row whose declarer was
 * deleted (`ON DELETE SET NULL`) decodes as effective `external` — the
 * declaration is no longer accountable — rather than as unprovable.
 */
export function decodeProviderMetadata(row: ProviderMetadataRow | null | undefined): ProviderMetadata | null {
  if (!row) return null;
  const configRevision = asRevision(row.config_revision);
  if (configRevision === null) return null;
  const locality = row.locality;
  if (locality !== 'local' && locality !== 'external') return null;
  const declaredBy = decodeDeclaredBy(row.locality_declared_by);
  const declaredAt = decodeDeclaredAt(row.locality_declared_at);
  const localityRevision = decodeLocalityRevision(row.locality_config_revision);
  if (declaredBy === undefined || declaredBy === ABSENT) return null;
  if (declaredAt === undefined || declaredAt === ABSENT) return null;
  if (localityRevision === undefined || localityRevision === ABSENT) return null;

  if (locality === 'local') {
    // The schema requires a dated declaration at a revision for `local`; a
    // `local` row without them is corrupt, not external.
    if (declaredAt === null || localityRevision === null) return null;
  }
  const effectiveLocality: 'local' | 'external' =
    locality === 'local'
      && declaredBy !== null
      && declaredAt !== null
      && localityRevision !== null
      && localityRevision === configRevision
      ? 'local'
      : 'external';
  return { configRevision, effectiveLocality, declaredBy, declaredAt };
}

/**
 * Read and decode one provider's metadata through a given query runner.
 * `id::text`: the column is a uuid and an unknown or test-shaped id must
 * read as "no such provider" (`null`) rather than as a cast error.
 */
export async function loadProviderMetadata(
  runner: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  providerId: string,
): Promise<ProviderMetadata | null> {
  const r = await runner.query(
    `SELECT ${PROVIDER_METADATA_COLUMNS} FROM llm_providers WHERE id::text = $1`,
    [providerId],
  );
  return decodeProviderMetadata(r.rows[0] as ProviderMetadataRow | undefined);
}

/**
 * Pure decision over the DECODED metadata. `local_only` is satisfied only by
 * an effective locality of `local`.
 */
export function decideAiPolicyAdmission(
  policy: AiPolicy,
  provider: Pick<ProviderMetadata, 'effectiveLocality'>,
): 'admit' | 'policy_none' | 'provider_not_local' {
  if (policy === 'none') return 'policy_none';
  if (policy === 'local_only') {
    return provider.effectiveLocality === 'local' ? 'admit' : 'provider_not_local';
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
 *
 * A resolver that THROWS (no provider configured, assignment pointing at a
 * deleted row, undecryptable key, DB failure) leaves the provider unknown:
 * refused as the retryable `policy_unavailable`, with its `blocked` event,
 * and no provider is ever called.
 */
export interface PolicyAdmissionContext {
  operation: AiOperationContext;
  stage: string;
  attempt: number;
  /** Preliminary allowed checks are not dispatch decisions. Refusals still emit. */
  preliminary?: boolean;
}

type RefusalContext = Omit<PolicyAdmissionContext, 'attempt'> & { attempt: number | null };

function decisionSnapshot(pageId: number, usecase: string, context: RefusalContext): AiDecisionEvent {
  return { ...context.operation, eventId: randomUUID(), occurredAt: new Date().toISOString(),
    type: 'decision', usecase, stage: context.stage, attempt: context.attempt,
    articles: [{ pageId, policy: null, policyRevision: null, contentRevision: null }],
    provider: null, decision: 'blocked', reason: 'policy_unavailable' };
}

export async function emitUnresolvedDecision(pageId: number, usecase: LlmUsecase, context: RefusalContext,
  reason: 'policy_unavailable' | 'stage_disabled',
  destination?: { providerId: string; model: string }): Promise<void> {
  const snapshot = decisionSnapshot(pageId, usecase, context);
  if (destination) {
    snapshot.provider = { providerId: destination.providerId, model: destination.model,
      configRevision: null, declaredLocality: null, effectiveLocality: null };
    try {
      const result = await getPool().query(`SELECT ${PROVIDER_METADATA_COLUMNS} FROM llm_providers WHERE id::text = $1`, [destination.providerId]);
      const row = result.rows[0];
      const metadata = decodeProviderMetadata(row);
      snapshot.provider.configRevision = asRevision(row?.config_revision);
      snapshot.provider.declaredLocality = row?.locality === 'local' || row?.locality === 'external' ? row.locality : null;
      snapshot.provider.effectiveLocality = metadata?.effectiveLocality ?? null;
    } catch {
      // Destination identity is known, but its current configuration is not.
    }
  }
  try {
    const result = await getPool().query('SELECT ai_policy, ai_policy_revision, content_revision FROM pages WHERE id = $1 AND deleted_at IS NULL', [pageId]);
    const row = result.rows[0];
    snapshot.articles = [{ pageId, policy: isAiPolicy(row?.ai_policy) ? row.ai_policy : null,
      policyRevision: asRevision(row?.ai_policy_revision), contentRevision: asRevision(row?.content_revision) }];
  } catch {
    // Unreadable authority remains explicitly unknown, never copied from input.
  }
  emitAiDecision({ ...snapshot, occurredAt: new Date().toISOString(), reason });
}

export async function admitPageForUsecase(pageId: number, usecase: LlmUsecase, context: PolicyAdmissionContext): Promise<AiPolicyAdmission> {
  let resolved: { config: { providerId: string }; model: string } | null;
  try {
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
  } catch (err) {
    logger.warn({ err, pageId, usecase }, 'AI policy admission could not resolve the provider; refusing');
    await emitUnresolvedDecision(pageId, usecase, context, 'policy_unavailable');
    return refuse(pageId, null, 'policy_unavailable', null);
  }
  if (!resolved) {
    await emitUnresolvedDecision(pageId, usecase, context, 'stage_disabled');
    return refuse(pageId, null, 'stage_disabled', null);
  }
  return admitPageForProvider(pageId, usecase, resolved.config.providerId, resolved.model, context);
}

/**
 * Admit one article against an EXPLICIT provider — the vision worker's
 * retained identity and the shadow migration's candidate pair, neither of
 * which the use-case resolver answers for. Same lock, same decision, same
 * events as `admitPageForUsecase`; a worker that holds a provider id must
 * never admit through the resolver, which could name a different one.
 *
 * FAIL CLOSED: any failure to connect/read the policy or provider state, a
 * provider id with NO row (deleted between resolution and admission), or a
 * row whose metadata does not decode (`decodeProviderMetadata` → null)
 * refuses with the retryable `policy_unavailable` — under EVERY policy,
 * `all` included: nothing is admitted against a provider the system cannot
 * describe. Precedence: unreadable state → `policy_unavailable`; page gone →
 * `not_found`; `none` → `policy_none`; then the provider metadata. Every
 * refusal emits exactly one `blocked` event.
 */
export async function admitPageForProvider(
  pageId: number,
  usecase: LlmUsecase,
  providerId: string,
  model: string,
  context: PolicyAdmissionContext,
): Promise<AiPolicyAdmission> {
  let snapshot = decisionSnapshot(pageId, usecase, context);
  snapshot.provider = { providerId, model: null, configRevision: null, declaredLocality: null, effectiveLocality: null };
  const blocked = (reason: AiPolicyAdmissionBlockReason) => emitAiDecision({ ...snapshot, reason });
  let client: PoolClient | null = null;
  let p: { ai_policy: AiPolicy; ai_policy_revision: string; content_revision: string } | undefined;
  let row: ProviderMetadataRow | undefined;
  try {
    client = await getPool().connect();
    await client.query('BEGIN READ ONLY');
    await client.query('SELECT pg_advisory_xact_lock_shared($1, $2)', [AI_POLICY_LOCK_NAMESPACE, pageId]);
    const page = await client.query<{ ai_policy: AiPolicy; ai_policy_revision: string; content_revision: string }>(
      `SELECT ai_policy, ai_policy_revision, content_revision FROM pages WHERE id = $1 AND deleted_at IS NULL`,
      [pageId],
    );
    const prov = await client.query<ProviderMetadataRow>(
      `SELECT ${PROVIDER_METADATA_COLUMNS} FROM llm_providers WHERE id::text = $1`,
      [providerId],
    );
    await client.query('COMMIT');
    p = page.rows[0];
    row = prov.rows[0];
    const metadata = decodeProviderMetadata(row);
    snapshot = { ...snapshot,
      articles: [{ pageId, policy: isAiPolicy(p?.ai_policy) ? p.ai_policy : null,
        policyRevision: asRevision(p?.ai_policy_revision), contentRevision: asRevision(p?.content_revision) }],
      provider: { providerId, model: metadata ? model : null, configRevision: asRevision(row?.config_revision),
        declaredLocality: row?.locality === 'local' || row?.locality === 'external' ? row.locality : null,
        effectiveLocality: metadata?.effectiveLocality ?? null },
    };
  } catch (err) {
    // Connection refused, missing columns, cancelled statement, …: the
    // policy state is UNKNOWN, so nothing is admitted. Retryable.
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    logger.warn({ err, pageId, usecase, providerId }, 'AI policy admission could not read policy state; refusing');
    blocked('policy_unavailable');
    return refuse(pageId, null, 'policy_unavailable', providerId);
  } finally {
    client?.release();
  }
  if (!p) {
    blocked('not_found');
    return refuse(pageId, null, 'not_found', providerId);
  }
  // The page row is decoded with the same rigour as the provider row: a
  // policy outside the closed set or a revision that is not a non-negative
  // integer is UNPROVABLE state, refused as retryable — never coerced.
  const policyRevision = asRevision(p.ai_policy_revision);
  if (!isAiPolicy(p.ai_policy) || policyRevision === null) {
    logger.warn(
      { pageId, usecase, providerId, policy: p.ai_policy, revision: p.ai_policy_revision },
      'AI policy admission: page policy state does not decode; refusing',
    );
    blocked('policy_unavailable');
    return refuse(pageId, null, 'policy_unavailable', providerId);
  }
  if (p.ai_policy === 'none') {
    // A fact about the article, not the provider: persistable, never retried
    // against a different provider state.
    blocked('policy_none');
    return refuse(pageId, p.ai_policy, 'policy_none', providerId);
  }
  const provider = decodeProviderMetadata(row);
  if (!provider) {
    logger.warn(
      { pageId, usecase, providerId, present: row !== undefined },
      'AI policy admission: provider metadata missing or invalid; refusing',
    );
    blocked('policy_unavailable');
    return refuse(pageId, p.ai_policy, 'policy_unavailable', providerId);
  }
  const decision = decideAiPolicyAdmission(p.ai_policy, provider);
  if (decision !== 'admit') {
    blocked(decision);
    return refuse(pageId, p.ai_policy, decision, providerId);
  }
  if (!context.preliminary) emitAiDecision({ ...snapshot, decision: 'admitted', reason: 'allowed' });
  return {
    admitted: true,
    pageId,
    policy: p.ai_policy,
    policyRevision,
    providerId,
    configRevision: provider.configRevision,
    locality: provider.effectiveLocality,
    model,
  };
}

/**
 * An early denial is not a publication permit. Re-read the article and exact
 * provider under the mutation/admission locks before parking work. A content
 * edit, relaxation or endpoint/declaration change may have overtaken the
 * preflight. The callback runs on this held client, never across inference.
 */
export async function publishCurrentAiPolicyBlock(
  input: { pageId: number; providerId: string; contentRevision: string; reason: AiPolicyBlockReason },
  publish: (client: PoolClient) => Promise<boolean>,
): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared($1, $2)', [AI_POLICY_LOCK_NAMESPACE, input.pageId]);
    const pages = await client.query<{ ai_policy: unknown; content_revision: string }>(
      `SELECT ai_policy, content_revision::text FROM pages
        WHERE id = $1 AND deleted_at IS NULL FOR SHARE`, [input.pageId],
    );
    const providers = await client.query<ProviderMetadataRow>(
      `SELECT ${PROVIDER_METADATA_COLUMNS} FROM llm_providers WHERE id::text = $1 FOR SHARE`, [input.providerId],
    );
    const page = pages.rows[0];
    const provider = decodeProviderMetadata(providers.rows[0]);
    let published = false;
    if (page && isAiPolicy(page.ai_policy) && page.content_revision === input.contentRevision
      && provider && decideAiPolicyAdmission(page.ai_policy, provider) === input.reason) {
      published = await publish(client);
    }
    await client.query('COMMIT');
    return published;
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
