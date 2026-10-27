import { randomUUID } from 'node:crypto';
import type { AiDecisionEvent, AiOperationContext } from '@compendiq/contracts';
import { query } from '../../core/db/postgres.js';
import { emitAiDecision, newAiOperation } from '../../core/enterprise/ai-policy-hooks.js';
import { isAiPolicy } from '../../core/services/ai-policy-service.js';
import { asRevision, loadProviderMetadata, decodeProviderMetadata, PROVIDER_METADATA_COLUMNS } from '../../domains/llm/services/ai-policy-admission.js';
import { SubPagePolicyError } from '../../domains/confluence/services/subpage-context.js';
import { admitArticleStage, authorizeArticleDispatch, ArticleStageRefusedError } from '../../domains/llm/services/article-stage-admission.js';
import type { ProviderConfig, TransportContext } from '../../domains/llm/services/openai-compatible-client.js';
import { assembleContextIfNeeded, resolveReadablePageRef } from './_helpers.js';

async function captureRoot(userId: string, pageId: string | undefined, config: ProviderConfig, usecase: string,
  operation = newAiOperation('direct_article', { kind: 'user', id: userId })) {
  // Allocate before the first authority read: a failed capture is still one
  // refused attempt. Never certify a client reference as a resolved article ID.
  const context = { operation, stage: usecase, attempt: 1 };
  const snapshot: AiDecisionEvent = {
    ...context.operation, eventId: randomUUID(), occurredAt: new Date().toISOString(),
    type: 'decision', usecase, stage: context.stage, attempt: context.attempt,
    articles: [], provider: null, decision: 'blocked', reason: 'policy_unavailable',
  };
  const captured = await (async () => {
    if (!pageId) throw new ArticleStageRefusedError();
    const page = await resolveReadablePageRef(userId, pageId);
    if (!page) {
      snapshot.reason = 'not_found';
      throw Object.assign(new Error('Page not found'), { statusCode: 404 });
    }
    snapshot.articles = [{ pageId: page.id, policy: null, policyRevision: null, contentRevision: null }];
    // Title and revisions belong to one snapshot, including when the body is a draft.
    const result = await query('SELECT title, confluence_id, ai_policy, ai_policy_revision, content_revision FROM pages WHERE id = $1 AND deleted_at IS NULL', [page.id]);
    const row = result.rows[0];
    const policyRevision = asRevision(row?.ai_policy_revision);
    const contentRevision = asRevision(row?.content_revision);
    snapshot.articles = [{ pageId: page.id, policy: isAiPolicy(row?.ai_policy) ? row.ai_policy : null, policyRevision, contentRevision }];
    const provider = await loadProviderMetadata({ query }, config.providerId);
    // Effective locality is not a declaration. Leave the declaration and model
    // unknown here; final transport admission establishes those independently.
    snapshot.provider = { providerId: config.providerId, model: null,
      configRevision: provider?.configRevision ?? null, declaredLocality: null,
      effectiveLocality: provider?.effectiveLocality ?? null };
    if (!row || !isAiPolicy(row.ai_policy) || policyRevision === null || contentRevision === null
      || !provider || provider.configRevision !== config.configRevision) throw new ArticleStageRefusedError();
    return { stage: {
      provenance: { version: 1 as const, providerId: config.providerId, configRevision: provider.configRevision,
        locality: provider.effectiveLocality, pages: [{ pageId: page.id, policy: row.ai_policy, policyRevision, contentRevision }] },
      userId, usecase, context,
    }, parentRef: { id: page.id, title: row.title as string, confluenceId: row.confluence_id as string | null } };
  })().catch((error: unknown) => {
    emitAiDecision({ ...snapshot, occurredAt: new Date().toISOString() });
    throw error;
  });
  // This boundary owns its own refusal event. Keep it outside the capture catch
  // so a denying admission is never counted twice.
  const { stage } = captured;
  await admitArticleStage(stage.provenance, userId, usecase, undefined, stage.context, undefined, undefined, true);
  return captured;
}

/** Root-only callers cannot certify an assembled descendant prompt. */
export async function directArticleTransport(
  userId: string, pageId: string | undefined, includeSubPages: boolean | undefined,
  config: ProviderConfig, usecase: string, operation?: AiOperationContext,
): Promise<TransportContext> {
  if (includeSubPages) throw new ArticleStageRefusedError();
  const { stage } = await captureRoot(userId, pageId, config, usecase, operation);
  return { kind: 'article', stage };
}

/** Compose using the existing bounded collector, retaining every actual source
 * (including partially truncated descendants). No derived image payloads are
 * added by this authored-HTML collector. The same provenance reaches the queued
 * HTTP transport, which rechecks ACL, revisions and the live model assignment. */
export async function assembleDirectArticleContext(
  userId: string, pageId: string | undefined, content: string,
  includeSubPages: boolean | undefined, config: ProviderConfig, usecase: string, model: string,
  opts?: { protectMedia?: boolean; layoutTokens?: boolean; operation?: AiOperationContext },
) {
  const { stage, parentRef } = await captureRoot(userId, pageId, config, usecase, opts?.operation);
  await authorizeArticleDispatch(config, stage.provenance, userId, usecase, stage.context, model, true);
  // Only collection/merge is inside this catch. Preliminary and final
  // admissions own their events, so wrapping them would double-count refusal.
  const assembled = await (async () => {
    const result = await assembleContextIfNeeded(userId, pageId, content, includeSubPages, {
      ...opts, parentRef,
      policyContext: { providerId: config.providerId, usecase,
        expectedConfigRevision: stage.provenance.configRevision, expectedLocality: stage.provenance.locality },
    });
    for (const ref of result.includedPageRefs) {
      const existing = stage.provenance.pages.find((p) => p.pageId === ref.id);
      if (existing) {
        if (existing.policy !== ref.policy || existing.policyRevision !== ref.policyRevision
          || existing.contentRevision !== ref.contentRevision) throw new ArticleStageRefusedError();
      } else {
        stage.provenance.pages.push({ pageId: ref.id, policy: ref.policy,
          policyRevision: ref.policyRevision, contentRevision: ref.contentRevision });
      }
    }
    return result;
  })().catch(async (error: unknown) => {
    const ids = new Set(stage.provenance.pages.map((page) => page.pageId));
    if (error instanceof SubPagePolicyError && error.pageId !== undefined) ids.add(error.pageId);
    const snapshot: AiDecisionEvent = {
      ...stage.context.operation, eventId: randomUUID(), occurredAt: new Date().toISOString(),
      type: 'decision', usecase, stage: stage.context.stage, attempt: stage.context.attempt,
      decision: 'blocked', reason: error instanceof SubPagePolicyError ? error.reason : 'policy_unavailable',
      articles: [...ids].map((id) => ({ pageId: id, policy: null, policyRevision: null, contentRevision: null })),
      provider: { providerId: config.providerId, model, configRevision: null, declaredLocality: null, effectiveLocality: null },
    };
    // A collection failure is not permission to use the earlier snapshot as
    // current evidence. Best-effort fresh reads retain unknowns on read failure.
    try {
      const pages = await query('SELECT id, ai_policy, ai_policy_revision, content_revision FROM pages WHERE id = ANY($1::int[]) AND deleted_at IS NULL', [[...ids]]);
      snapshot.articles = snapshot.articles.map((page) => {
        const row = pages.rows.find((r) => r.id === page.pageId);
        return { pageId: page.pageId, policy: isAiPolicy(row?.ai_policy) ? row.ai_policy : null,
          policyRevision: asRevision(row?.ai_policy_revision), contentRevision: asRevision(row?.content_revision) };
      });
    } catch { /* Unreadable article authority stays unknown. */ }
    try {
      const result = await query<import('../../domains/llm/services/ai-policy-admission.js').ProviderMetadataRow>(`SELECT ${PROVIDER_METADATA_COLUMNS} FROM llm_providers WHERE id::text = $1`, [config.providerId]);
      const row = result.rows[0];
      const metadata = decodeProviderMetadata(row);
      snapshot.provider = { providerId: config.providerId, model, configRevision: asRevision(row?.config_revision),
        declaredLocality: row?.locality === 'local' || row?.locality === 'external' ? row.locality : null,
        effectiveLocality: metadata?.effectiveLocality ?? null };
    } catch { /* Known destination does not certify an unreadable configuration. */ }
    emitAiDecision({ ...snapshot, occurredAt: new Date().toISOString() });
    throw error;
  });
  await authorizeArticleDispatch(config, stage.provenance, userId, usecase, stage.context, model, true);
  const transportContext: TransportContext = { kind: 'article', stage };
  return { ...assembled, transportContext };
}
