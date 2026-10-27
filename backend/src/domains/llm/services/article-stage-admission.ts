import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../../core/db/postgres.js';
import { decryptPat } from '../../../core/utils/crypto.js';
import { AI_POLICY_LOCK_NAMESPACE } from '../../../core/services/ai-policy-service.js';
import { userCanAccessPage } from '../../../core/services/rbac-service.js';
import { emitAiDecision, newAiOperation } from '../../../core/enterprise/ai-policy-hooks.js';
import { ConversationTurnAiProvenanceSchema, type ConversationTurnAiProvenance, type AiOperationContext, type AiDecisionEvent } from '@compendiq/contracts';
import { asRevision, decodeProviderMetadata, PROVIDER_METADATA_COLUMNS, type ProviderMetadataRow, decideAiPolicyAdmission } from './ai-policy-admission.js';
import type { ProviderConfig } from './openai-compatible-client.js';

/** A refusal is not a provider failure or a completed inference. */
export class ArticleStageRefusedError extends Error {
  readonly reason = 'ai_policy_unavailable';
  constructor() {
    super('Article grounding or destination changed or unavailable');
    this.name = 'ArticleStageRefusedError';
  }
}

/** Validate on the caller's transaction immediately before publishing results.
 * Lock order matches mutation: sorted policy locks, page rows, provider row.
 * Never call inference while holding these locks. */
export async function validateArticleStageOnClient(
  client: PoolClient,
  provenance: ConversationTurnAiProvenance,
  userId: string | null,
): Promise<void> {
  ConversationTurnAiProvenanceSchema.parse(provenance);
  for (const page of [...provenance.pages].sort((a, b) => a.pageId - b.pageId)) {
    await client.query('SELECT pg_advisory_xact_lock_shared($1, $2)', [AI_POLICY_LOCK_NAMESPACE, page.pageId]);
  }
  const pages = await client.query('SELECT id, ai_policy, ai_policy_revision, content_revision FROM pages WHERE id = ANY($1::int[]) AND deleted_at IS NULL ORDER BY id FOR SHARE', [provenance.pages.map((p) => p.pageId)]);
  const result = await client.query<ProviderMetadataRow>(`SELECT ${PROVIDER_METADATA_COLUMNS} FROM llm_providers WHERE id::text = $1 FOR SHARE`, [provenance.providerId]);
  const provider = decodeProviderMetadata(result.rows[0]);
  if (!provider || provider.configRevision !== provenance.configRevision || provider.effectiveLocality !== provenance.locality) {
    throw new ArticleStageRefusedError();
  }
  for (const page of provenance.pages) {
    const current = pages.rows.find((r) => r.id === page.pageId);
    if (!current || current.ai_policy !== page.policy
      || asRevision(current.ai_policy_revision) !== page.policyRevision
      || asRevision(current.content_revision) !== page.contentRevision
      || decideAiPolicyAdmission(page.policy, provider) !== 'admit'
      || (userId !== null && !(await userCanAccessPage(userId, page.pageId, client)))) {
      throw new ArticleStageRefusedError();
    }
  }
}

export function historicalVersionDigest(title: string, bodyHtml: string | null, bodyText: string | null): string {
  return createHash('sha256').update(JSON.stringify([title, bodyHtml, bodyText])).digest('hex');
}

export interface ArticleStageContext {
  /** Server-captured worker row/derived-source versions, never client input. */
  embeddingSources?: { pageId: number; rowVersion: string; imageRevision: string }[];
  /** Caller intent only; the held-client resolver validates saved authority. */
  modelSelection?: import('./llm-provider-resolver.js').ArticleModelSelection;
  /** Server-read historical inputs, never a client-supplied source list. */
  historicalVersions?: { pageId: number; versionId: string; versionNumber: number; digest: string }[];
  operation: AiOperationContext;
  stage: string;
  attempt: number;
}

/** Final receiving-stage check against the exact resolved transport. */
export async function authorizeArticleDispatch(
  transport: ProviderConfig,
  provenance: ConversationTurnAiProvenance,
  userId: string | null,
  usecase: string,
  context: ArticleStageContext,
  model: string,
  preliminary = false,
): Promise<void> {
  ConversationTurnAiProvenanceSchema.parse(provenance);
  if (!context?.operation || !Number.isSafeInteger(context.attempt) || context.attempt < 1
    || typeof context.stage !== 'string' || !context.stage
    || typeof model !== 'string' || !model) throw new ArticleStageRefusedError();
  const revision = asRevision(transport.configRevision);
  if (revision === null || transport.providerId !== provenance.providerId || revision !== provenance.configRevision) {
    emitAiDecision({
      ...context.operation, eventId: randomUUID(), occurredAt: new Date().toISOString(), type: 'decision',
      usecase, stage: context.stage, attempt: context.attempt, decision: 'blocked', reason: 'transport_binding_unavailable',
      articles: provenance.pages.map((page) => ({ pageId: page.pageId, policy: null, policyRevision: null, contentRevision: null })),
      provider: { providerId: transport.providerId, model: null, configRevision: revision, declaredLocality: null, effectiveLocality: null },
    });
    throw new ArticleStageRefusedError();
  }
  await admitArticleStage(provenance, userId, usecase, undefined, context, transport, model, preliminary);
}

/** Short admission/publication only. Each queued dispatch, retry and later
 * batch requires a new admission. Null userId is reserved for server work. */
export async function admitArticleStage(
  provenance: ConversationTurnAiProvenance,
  userId: string | null,
  usecase: string,
  publish?: (client: PoolClient) => Promise<void>,
  context: ArticleStageContext = {
    operation: newAiOperation('article_stage', userId ? { kind: 'user', id: userId } : { kind: 'unknown', id: null }),
    stage: usecase, attempt: 1,
  },
  transport?: ProviderConfig,
  model?: string,
  preliminary = false,
): Promise<void> {
  // Unknown evidence is initialized before checkout. A transaction-aborting
  // error must not certify the supplied stale provenance as current state.
  let snapshot: AiDecisionEvent = {
    ...context.operation, eventId: randomUUID(), occurredAt: new Date().toISOString(), type: 'decision',
    usecase, stage: context.stage, attempt: context.attempt, decision: 'blocked', reason: 'policy_unavailable',
    articles: provenance.pages.map((page) => ({ pageId: page.pageId, policy: null, policyRevision: null, contentRevision: null })),
    provider: { providerId: provenance.providerId, model: null, configRevision: null, declaredLocality: null, effectiveLocality: null },
  };
  let resolvedModel: string | null = null;
  let client: PoolClient | undefined;
  try {
    ConversationTurnAiProvenanceSchema.parse(provenance);
    client = await getPool().connect();
    await client.query('BEGIN');
    try {
      if (transport && context.stage !== 'shadow_embedding') {
        const { resolveArticleUsecaseOnClient } = await import('./llm-provider-resolver.js');
        const { LlmUsecaseSchema } = await import('@compendiq/contracts');
        const target = await resolveArticleUsecaseOnClient(client, LlmUsecaseSchema.parse(usecase), context.modelSelection)
          .catch(() => { throw new ArticleStageRefusedError(); });
        if (target?.config.providerId === provenance.providerId) resolvedModel = target.model;
        if (!target || target.config.providerId !== transport.providerId || target.model !== model) {
          throw new ArticleStageRefusedError();
        }
      }
      await validateArticleStageOnClient(client, provenance, userId);
      for (const source of context.embeddingSources ?? []) {
        if (!provenance.pages.some((page) => page.pageId === source.pageId)) throw new ArticleStageRefusedError();
        const saved = await client.query(`SELECT xmin::text AS row_version, image_analysis_revision::text AS image_revision
          FROM pages WHERE id = $1`, [source.pageId]);
        if (saved.rows[0]?.row_version !== source.rowVersion || saved.rows[0]?.image_revision !== source.imageRevision) {
          throw new ArticleStageRefusedError();
        }
      }
      for (const version of context.historicalVersions ?? []) {
        if (!provenance.pages.some((page) => page.pageId === version.pageId)
          || !Number.isSafeInteger(version.versionNumber) || version.versionNumber < 1
          || !/^[a-f0-9]{64}$/.test(version.digest)) throw new ArticleStageRefusedError();
        const saved = await client.query<{ title: string; body_html: string | null; body_text: string | null }>(
          'SELECT title, body_html, body_text FROM page_versions WHERE id::text = $1 AND page_id = $2 AND version_number = $3 FOR SHARE',
          [version.versionId, version.pageId, version.versionNumber],
        );
        const row = saved.rows[0];
        if (!row || historicalVersionDigest(row.title, row.body_html, row.body_text) !== version.digest) {
          throw new ArticleStageRefusedError();
        }
      }
      if (transport) {
        if (context.stage === 'shadow_embedding') {
          const state = await client.query<{ setting_value: string }>(
            "SELECT setting_value FROM admin_settings WHERE setting_key = 'embedding_shadow_migration' FOR SHARE",
          );
          const target = JSON.parse(state.rows[0]?.setting_value ?? 'null');
          if (target?.status === 'active' && target.providerId === provenance.providerId
            && typeof target.model === 'string' && target.model) resolvedModel = target.model;
          if (!target || target.status !== 'active' || target.providerId !== transport.providerId || target.model !== model) {
            throw new ArticleStageRefusedError();
          }
        }
        // validateArticleStageOnClient holds this provider row FOR SHARE.
        // IDs/revisions supplied by a caller do not certify the actual URL,
        // credential or TLS policy that the HTTP client is about to use.
        const saved = await client.query<{
          base_url: string; api_key: string | null; auth_type: string; verify_ssl: boolean;
        }>('SELECT base_url, api_key, auth_type, verify_ssl FROM llm_providers WHERE id::text = $1', [provenance.providerId]);
        const row = saved.rows[0];
        if (!row || transport.baseUrl !== row.base_url
          || transport.authType !== row.auth_type || transport.verifySsl !== row.verify_ssl
          || transport.apiKey !== (row.api_key === null ? null : decryptPat(row.api_key))) {
          throw new ArticleStageRefusedError();
        }
      }
    } finally {
      const pages = await client.query('SELECT id, ai_policy, ai_policy_revision, content_revision FROM pages WHERE id = ANY($1::int[]) AND deleted_at IS NULL', [provenance.pages.map((p) => p.pageId)]);
      const result = await client.query<ProviderMetadataRow>(`SELECT ${PROVIDER_METADATA_COLUMNS} FROM llm_providers WHERE id::text = $1`, [provenance.providerId]);
      const metadata = decodeProviderMetadata(result.rows[0]);
      snapshot = {
        ...snapshot, reason: 'grounding_changed',
        articles: provenance.pages.map((page) => {
          const row = pages.rows.find((r) => r.id === page.pageId);
          return { pageId: page.pageId, policy: row?.ai_policy ?? null,
            policyRevision: asRevision(row?.ai_policy_revision), contentRevision: asRevision(row?.content_revision) };
        }),
        provider: { providerId: provenance.providerId, model: metadata ? resolvedModel : null, configRevision: metadata?.configRevision ?? null,
          declaredLocality: result.rows[0]?.locality === 'local' ? 'local' : result.rows[0]?.locality === 'external' ? 'external' : null,
          effectiveLocality: metadata?.effectiveLocality ?? null },
      };
    }
    await publish?.(client);
    await client.query('COMMIT');
    if (!publish && !preliminary) emitAiDecision({ ...snapshot, decision: 'admitted', reason: 'allowed' });
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => undefined);
    if (!publish) emitAiDecision(snapshot);
    throw err;
  } finally {
    client?.release();
  }
}
