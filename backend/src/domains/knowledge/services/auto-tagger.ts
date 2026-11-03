import type { PoolClient } from 'pg';
import { resolveUsecase } from '../../llm/services/llm-provider-resolver.js';
import { chat, type ArticleTransportStage } from '../../llm/services/openai-compatible-client.js';
import { AI_POLICY_PROVENANCE_VERSION } from '@compendiq/contracts';
import { newAiOperation } from '../../../core/enterprise/ai-policy-hooks.js';
import { admitPageForProvider, asRevision, loadProviderMetadata } from '../../llm/services/ai-policy-admission.js';
import { admitArticleStage, ArticleStageRefusedError } from '../../llm/services/article-stage-admission.js';
import { validateAutoTagPublicationOnClient, type AutoTagPublicationStage } from '../../llm/services/auto-tag-publication.js';
import { AiPolicyRefusalError, isAiPolicy, isAiPolicyRefusal } from '../../../core/services/ai-policy-service.js';
import { htmlToMarkdown } from '../../../core/services/content-converter.js';
import { sanitizeLlmInput } from '../../../core/utils/sanitize-llm-input.js';
import { query } from '../../../core/db/postgres.js';
import { getUserAccessibleSpaces, userCanAccessPage, userCanEditPage } from '../../../core/services/rbac-service.js';
import { logger } from '../../../core/utils/logger.js';
import { getClientForUser } from '../../confluence/services/sync-service.js';
import type { ConfluenceClient } from '../../confluence/services/confluence-client.js';
import { pageWriteStaysLocal } from '../../confluence/services/standalone-mode.js';
import {
  cancelPageWriteIntentBeforeEffect,
  completePageWriteIntent,
  PageWriteError,
  reservePageWriteIntent,
  runPageWriteIntentEffect,
  runGeneratedLabelRequest,
  withPageWriteTransaction,
} from '../../../core/services/page-write-admission.js';
import { enqueuePageWriteInvalidation } from '../../../core/services/page-write-invalidation.js';
import {
  applyPageLabelsOnClient,
  assertLabelPolicyChangeOnClient,
  planLabelPolicyChange,
  reservedAiPolicyLabel,
  type AiPolicy,
} from '../../../core/services/ai-policy-service.js';

export const ALLOWED_TAGS = [
  'architecture',
  'deployment',
  'troubleshooting',
  'how-to',
  'api',
  'security',
  'database',
  'monitoring',
  'configuration',
  'onboarding',
  'policy',
  'runbook',
] as const;

export type AllowedTag = typeof ALLOWED_TAGS[number];

const SYSTEM_PROMPT = `You are a document classifier. Given the following article, select 1-5 tags from this list that best describe the content: ${JSON.stringify(ALLOWED_TAGS)}. Return ONLY a JSON array of selected tags, nothing else. Example: ["architecture", "deployment"]`;

/**
 * Auto-tag a page's content using LLM zero-shot classification.
 * Returns an array of suggested tags from the allowed set.
 *
 * Resolves the `auto_tag` use-case to a concrete provider+model via the
 * use-case resolver. An optional `modelOverride` lets callers (e.g. routes)
 * substitute the model while still honoring the resolved provider. `userId`
 * is kept in the signature for future audit/logging hooks but is not used
 * for provider resolution.
 */
export async function autoTagContent(
  _userId: string,
  content: string,
  options: { isHtml?: boolean; modelOverride?: string; articleStage: ArticleTransportStage;
    resolved?: Awaited<ReturnType<typeof resolveUsecase>> },
): Promise<AllowedTag[]> {
  // This API classifies article content, never unrelated free-form input.
  // Check before resolving a destination as well as at the transport boundary:
  // JavaScript callers and stale clients must not turn missing provenance into
  // an unrestricted call (nor certify an empty article set).
  const stage = options?.articleStage;
  if (!stage || !Array.isArray(stage.provenance?.pages) || stage.provenance.pages.length === 0
    || stage.userId !== _userId || stage.usecase !== 'auto_tag') {
    throw new ArticleStageRefusedError();
  }
  // Convert HTML to markdown if needed
  let text = options.isHtml ? htmlToMarkdown(content) : content;

  // Truncate to avoid excessive LLM input (first 5000 chars should be enough for classification)
  if (text.length > 5000) {
    text = text.slice(0, 5000) + '\n\n[Content truncated for classification]';
  }

  const { sanitized } = sanitizeLlmInput(text);

  const { config, model: resolvedModel } = options.resolved ?? await resolveUsecase('auto_tag');
  const effectiveModel = options.modelOverride || resolvedModel;
  if (!effectiveModel) {
    throw new Error('Auto-tag failed: no model configured for auto_tag use case');
  }

  let response: string;
  try {
    response = await chat(config, effectiveModel, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: sanitized },
    ], { transportContext: { kind: 'article', stage: { ...stage, context: {
      ...stage.context,
      modelSelection: options.modelOverride ? { kind: 'explicit', model: options.modelOverride } : { kind: 'assigned' },
    } } } });
  } catch (err) {
    if (isAiPolicyRefusal(err) || err instanceof ArticleStageRefusedError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Auto-tag failed: ${message}`, { cause: err });
  }

  return parseTagResponse(response);
}

/**
 * Parse the LLM response and validate tags against allowed set.
 */
export function parseTagResponse(response: string): AllowedTag[] {
  // Try to extract JSON array from the response
  const trimmed = response.trim();

  // Try direct JSON parse first
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Try to find a JSON array within the response
    const match = trimmed.match(/\[([^\]]*)\]/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        logger.warn({ response: trimmed.slice(0, 200) }, 'Failed to parse auto-tag response');
        return [];
      }
    } else {
      logger.warn({ response: trimmed.slice(0, 200) }, 'No JSON array found in auto-tag response');
      return [];
    }
  }

  // Resolve to an array for tag extraction
  let tagArray: unknown[];

  if (Array.isArray(parsed)) {
    tagArray = parsed;
  } else if (typeof parsed === 'object' && parsed !== null) {
    // If the LLM returned an object with an array property, try to extract it
    const obj = parsed as Record<string, unknown>;
    const arrayValue = obj.tags ?? obj.labels ?? obj.categories ?? obj.result;
    if (Array.isArray(arrayValue)) {
      tagArray = arrayValue;
    } else {
      return [];
    }
  } else {
    return [];
  }

  // Filter to only allowed tags and deduplicate
  const allowedSet = new Set<string>(ALLOWED_TAGS);
  const validTags = new Set<AllowedTag>();

  for (const tag of tagArray) {
    if (typeof tag === 'string') {
      const normalized = tag.toLowerCase().trim();
      if (allowedSet.has(normalized)) {
        validTags.add(normalized as AllowedTag);
      }
    }
  }

  // Limit to 5 tags
  return Array.from(validTags).slice(0, 5);
}

/**
 * Auto-tag a page from the database by its ID.
 * Accepts integer PK (numeric string) or confluence_id (backward compat).
 */
export async function autoTagPage(
  userId: string,
  pageId: string,
  modelOverride?: string,
  publish?: (tags: AllowedTag[], stage: ArticleTransportStage) => Promise<void>,
): Promise<{ suggestedTags: AllowedTag[]; existingLabels: string[] }> {
  const isNumericId = /^\d+$/.test(pageId);
  const result = await query<{
    id: number;
    ai_policy: unknown;
    ai_policy_revision: unknown;
    content_revision: unknown;
    body_html: string;
    labels: string[];
  }>(
    `SELECT id, ai_policy, ai_policy_revision, content_revision, body_html, labels FROM pages WHERE ${isNumericId ? 'id = $1' : 'confluence_id = $1'} AND deleted_at IS NULL`,
    [isNumericId ? parseInt(pageId, 10) : pageId],
  );

  if (result.rows.length === 0) {
    throw new Error(`Page not found: ${pageId}`);
  }

  const { body_html, labels } = result.rows[0]!;
  if (!body_html) {
    return { suggestedTags: [], existingLabels: labels ?? [] };
  }

  const row = result.rows[0]!;
  const policyRevision = asRevision(row.ai_policy_revision);
  const contentRevision = asRevision(row.content_revision);
  if (!isAiPolicy(row.ai_policy) || policyRevision === null || contentRevision === null) {
    throw new AiPolicyRefusalError(503, { error: 'ai_policy_unavailable', pageIds: [row.id] }, 'Policy unavailable');
  }
  const resolved = await resolveUsecase('auto_tag');
  const { config } = resolved;
  const context = { operation: newAiOperation('auto_tag', { kind: 'user', id: userId }),
    stage: 'auto_tag', attempt: 1,
    modelSelection: modelOverride ? { kind: 'explicit' as const, model: modelOverride } : { kind: 'assigned' as const } };
  const admission = await admitPageForProvider(row.id, 'auto_tag', config.providerId, modelOverride || resolved.model,
    { ...context, preliminary: true });
  if (!admission.admitted) {
    if (admission.reason === 'policy_none' || admission.reason === 'provider_not_local') {
      throw new AiPolicyRefusalError(403, { error: 'ai_policy_denied', pageIds: [row.id] }, 'Article policy forbids auto-tagging');
    }
    throw new ArticleStageRefusedError();
  }
  const provider = await loadProviderMetadata({ query }, config.providerId);
  if (!provider || provider.configRevision !== config.configRevision) throw new ArticleStageRefusedError();
  const stage: AutoTagPublicationStage = {
    model: modelOverride || resolved.model,
    provenance: { version: AI_POLICY_PROVENANCE_VERSION, providerId: config.providerId,
      configRevision: provider.configRevision, locality: provider.effectiveLocality,
      pages: [{ pageId: row.id, policy: row.ai_policy, policyRevision, contentRevision }] },
    userId, usecase: 'auto_tag',
    context,
  };
  const suggestedTags = await autoTagContent(userId, body_html, { isHtml: true, modelOverride, articleStage: stage, resolved });
  // Returning suggestions is publication, not another provider dispatch. Keep
  // the full revision/model check without recording a second inference decision.
  await admitArticleStage(stage.provenance, userId, 'auto_tag', async () => {}, stage.context, config, stage.model);
  await publish?.(suggestedTags, stage);

  return {
    suggestedTags,
    existingLabels: labels ?? [],
  };
}

interface TagPage {
  id: number;
  confluence_id: string | null;
  source: string;
  space_key: string | null;
  labels: string[];
  ai_policy: AiPolicy;
  content_revision: string;
  lifecycle_revision: string;
}

const TAG_PAGE_COLUMNS = `id, confluence_id, source, space_key, labels, ai_policy,
                          content_revision::text, lifecycle_revision::text`;

function mergeLabels(current: readonly string[], add: readonly string[], remove: readonly string[]): string[] {
  const removed = new Set(remove);
  return Array.from(new Set([...current.filter((label) => !removed.has(label)), ...add]));
}

function sameLabelSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = [...new Set(a)].sort();
  const sb = [...new Set(b)].sort();
  return sa.length === sb.length && sa.every((label, i) => label === sb[i]);
}

/**
 * The remote delta that realises `target` from `current` on Confluence. The
 * planned set (not the caller's raw add/remove lists) is what is published:
 * a restored canonical label is re-added, a collapsed synonym removed, so
 * the mirror and the authority never disagree.
 */
function remoteLabelDelta(current: readonly string[], target: readonly string[]): { add: string[]; remove: string[] } {
  const currentSet = new Set(current);
  const targetSet = new Set(target);
  return {
    add: target.filter((label) => !currentSet.has(label)),
    remove: current.filter((label) => !targetSet.has(label)),
  };
}

/**
 * Authority for a label write that stays local (#1623). A synced page gets the
 * PUT /pages/:id rule, page access AND edit rights (a role on its space, plus
 * an ACE when restricted), because the caller's own integration toggle must
 * not skip what the Confluence branch re-checks under admission. A standalone
 * article keeps the routes' existing page-access rule. With `client` the
 * check reads inside the write transaction and bypasses the RBAC caches.
 */
async function canWriteLabelsLocally(
  userId: string,
  page: { id: number; source: string },
  client?: PoolClient,
): Promise<boolean> {
  if (!(await userCanAccessPage(userId, page.id, client))) return false;
  return page.source === 'standalone' || userCanEditPage(userId, page.id, client);
}

/** Reason of a denied local label write; routes answer it with their ordinary 404. */
export const LABEL_WRITE_DENIED_REASON = 'page_not_found';

/**
 * Apply an authored label mutation through the lifecycle fence. Confluence
 * mutations reserve a durable intent before the first remote call and settle
 * only after the matching local row commits.
 */
export async function applyLabelChanges(
  userId: string,
  pageId: string,
  changes: { add: readonly string[]; remove?: readonly string[]; articleStage?: ArticleTransportStage },
): Promise<string[]> {
  const isNumericId = /^\d+$/.test(pageId);
  const params = [isNumericId ? parseInt(pageId, 10) : pageId];
  const lookup = `SELECT ${TAG_PAGE_COLUMNS}
                    FROM pages
                   WHERE ${isNumericId ? 'id = $1' : 'confluence_id = $1'}
                     AND deleted_at IS NULL`;
  const existing = await query<TagPage>(lookup, params);
  const initial = existing.rows[0];
  if (!initial) throw new Error(`Page not found: ${pageId}`);

  // A contradictory request (two reserved labels naming different policies)
  // is refused here, before any lock, intent or provider call. The plan is
  // re-made from the locked row below; this pass only rejects nonsense early.
  const initialPlan = planLabelPolicyChange({
    currentPolicy: initial.ai_policy,
    currentLabels: initial.labels ?? [],
    targetLabels: mergeLabels(initial.labels ?? [], changes.add, changes.remove ?? []),
  });

  if (await pageWriteStaysLocal(userId, initial.source)) {
    // Checked before the fence so a denied caller learns nothing about the
    // page's lifecycle (e.g. a 423 for a frozen page), then again under it.
    if (!(await canWriteLabelsLocally(userId, initial))) {
      throw new PageWriteError(404, LABEL_WRITE_DENIED_REASON, 'Page not found');
    }
    const committed = await withPageWriteTransaction([initial.id], async (client) => {
      const fresh = await client.query<TagPage>(
        `SELECT ${TAG_PAGE_COLUMNS} FROM pages WHERE id = $1 AND deleted_at IS NULL`,
        [initial.id],
      );
      const page = fresh.rows[0];
      if (!page) throw new Error(`Page not found: ${pageId}`);
      const actor = await client.query(
        'SELECT 1 FROM users WHERE id = $1 AND deactivated_at IS NULL',
        [userId],
      );
      if (actor.rowCount !== 1 || !(await canWriteLabelsLocally(userId, page, client))) {
        throw new PageWriteError(404, LABEL_WRITE_DENIED_REASON, 'Page not found');
      }
      if (changes.articleStage) {
        await validateAutoTagPublicationOnClient(client, changes.articleStage, userId, initial.id);
      }
      // Policy authority (an explicit relaxation) and the policy/label write
      // itself are decided by the primitive on this same transaction.
      return applyPageLabelsOnClient(client, {
        userId,
        pageId: page.id,
        targetLabels: mergeLabels(page.labels ?? [], changes.add, changes.remove ?? []),
      });
    });
        return committed.labels;
  }

  if (!initial.confluence_id) throw new Error(`Page is missing confluence_id: ${pageId}`);

  const intent = await reservePageWriteIntent({
    pageIds: [initial.id],
    kind: 'page.labels',
    actorId: userId,
    expectedRevisions: {
      [initial.id]: {
        contentRevision: initial.content_revision,
        lifecycleRevision: initial.lifecycle_revision,
      },
    },
    effect: {
      effectClass: 'remote',
      pageId: initial.id,
      confluenceId: initial.confluence_id,
      add: [...changes.add],
      remove: [...(changes.remove ?? [])],
      priorLabels: initial.labels ?? [],
      targetLabels: initialPlan.labels,
      ...(changes.articleStage ? { autoTagStage: changes.articleStage } : {}),
    },
  });

  let admitted: { page: TagPage; confluence: ConfluenceClient; labels: string[] };
  try {
    admitted = await withPageWriteTransaction(
      [initial.id],
      async (client) => {
        const actor = await client.query(
          'SELECT 1 FROM users WHERE id = $1 AND deactivated_at IS NULL',
          [userId],
        );
        if (actor.rowCount !== 1) {
          throw new PageWriteError(403, 'intent_actor_inactive', 'The original actor is no longer active');
        }

        // Read-only admission: no row lock here (the policy lock is taken
        // by the primitive at completion, ahead of its own FOR UPDATE).
        const fresh = await client.query<TagPage>(
          `SELECT ${TAG_PAGE_COLUMNS}
             FROM pages
            WHERE id = $1
              AND deleted_at IS NULL`,
          [initial.id],
        );
        const page = fresh.rows[0];
        const expected = intent.revisions[initial.id]!;
        if (
          !page
          || page.source !== 'confluence'
          || page.confluence_id !== initial.confluence_id
          || page.space_key !== initial.space_key
        ) {
          throw new PageWriteError(
            409,
            'intent_page_identity_changed',
            `Page changed before labels could be applied: ${pageId}`,
          );
        }
        if (page.lifecycle_revision !== expected.lifecycleRevision) {
          throw new PageWriteError(409, 'stale_lifecycle', 'The page lifecycle changed after label admission');
        }
        if (page.content_revision !== expected.contentRevision) {
          throw new PageWriteError(409, 'stale_content_revision', 'The page content changed after label admission');
        }
        const spaces = await getUserAccessibleSpaces(userId, client);
        if (
          !page.space_key
          || !spaces.includes(page.space_key)
          || !(await userCanAccessPage(userId, page.id, client))
        ) {
          throw new PageWriteError(
            403,
            'intent_access_changed',
            'The original actor no longer has authority to change this page',
          );
        }

        // The policy consequence is decided from the admitted row BEFORE any
        // provider call: a contradiction never reaches Confluence, and a
        // relaxation the actor may not perform is refused before egress.
        const plan = planLabelPolicyChange({
          currentPolicy: page.ai_policy,
          currentLabels: page.labels ?? [],
          targetLabels: mergeLabels(page.labels ?? [], changes.add, changes.remove ?? []),
        });
        if (!sameLabelSet(plan.labels, initialPlan.labels)) {
          throw new PageWriteError(
            409,
            'stale_content_revision',
            'The page labels changed after label admission',
          );
        }
        if (changes.articleStage) {
          await validateAutoTagPublicationOnClient(client, changes.articleStage, userId, initial.id);
        }
        await assertLabelPolicyChangeOnClient(client, { userId, pageId: page.id, plan });

        const confluence = await getClientForUser(userId, client);
        if (!confluence) {
          throw new PageWriteError(
            403,
            'intent_connection_changed',
            'The original actor no longer has an active Confluence connection',
          );
        }
        return { page, confluence, labels: plan.labels };
      },
      { intent },
    );
  } catch (error) {
    await cancelPageWriteIntentBeforeEffect(intent);
    throw error;
  }

  let current = admitted.page.labels ?? [];
  if (changes.articleStage) {
    // A public policy change is local and may leave an older canonical label
    // upstream. Reconcile that slot, but never overwrite independent human
    // labels discovered since admission.
    let observed: string[];
    try {
      observed = await admitted.confluence.getLabels(admitted.page.confluence_id!);
    } catch (error) {
      await cancelPageWriteIntentBeforeEffect(intent);
      throw error;
    }
    const ordinary = (labels: readonly string[]) => labels.filter((label) => reservedAiPolicyLabel(label) === null);
    if (!sameLabelSet(ordinary(observed), ordinary(current))) {
      await cancelPageWriteIntentBeforeEffect(intent);
      throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'Remote human labels changed before generated publication');
    }
    current = observed;
  }
  const { add, remove } = remoteLabelDelta(current, admitted.labels);

  // Every call below is idempotent at the provider boundary. A rejection or
  // timeout after a call begins leaves the intent unresolved; reconciliation
  // must read the remote label set before it may settle the operation.
  await runPageWriteIntentEffect(intent, { kind: 'remote', completesRemoteWork: true }, async () => {
    let requestIndex = 0;
    let before = [...new Set(current)].sort();
    const request = async (after: string[], dispatch: () => Promise<void>) => {
      after = [...new Set(after)].sort();
      if (changes.articleStage) {
        await runGeneratedLabelRequest(intent, requestIndex, { before, after }, (client) =>
          validateAutoTagPublicationOnClient(client, changes.articleStage!, userId, initial.id), dispatch);
      } else {
        await dispatch();
      }
      requestIndex++;
      before = after;
    };
    if (add.length > 0) {
      await request([...before, ...add], () => admitted.confluence.addLabels(admitted.page.confluence_id!, add));
    }
    for (const label of remove) {
      await request(before.filter((item) => item !== label), () => admitted.confluence.removeLabel(admitted.page.confluence_id!, label));
    }
  });

  const committed = await completePageWriteIntent(intent, async (client) => {
    if (changes.articleStage) {
      await validateAutoTagPublicationOnClient(client, changes.articleStage, userId, initial.id);
    }
    const applied = await applyPageLabelsOnClient(client, {
      userId,
      pageId: initial.id,
      targetLabels: admitted.labels,
    });
    // Confluence now holds `admitted.labels`. If the locked row's policy
    // changed meanwhile (an authoritative policy write between admission and
    // completion) the local plan diverges from the published set; the later
    // policy stands and this write is NOT claimed as a mirror (#281 review).
    if (!sameLabelSet(applied.labels, admitted.labels)) {
      throw new PageWriteError(
        409,
        'ai_policy_label_diverged',
        'The page AI policy changed while its labels were being published; the label write was not mirrored',
      );
    }
    await enqueuePageWriteInvalidation(client, intent.id);
    return applied;
  });
    return committed.labels;
}

/**
 * Add auto-tags to a page's labels column.
 * Accepts integer PK (numeric string) or confluence_id (backward compatibility).
 */
export async function applyTags(
  userId: string,
  pageId: string,
  tags: AllowedTag[],
): Promise<string[]> {
  return applyLabelChanges(userId, pageId, { add: tags });
}

/**
 * Auto-tag all pages without labels for a user (admin background job).
 */
export async function autoTagAllPages(
  userId: string,
  modelOverride?: string,
): Promise<{ tagged: number; errors: number; policyBlocked?: number }> {
  // Include both Confluence pages (filtered by RBAC space access) and
  // standalone/local pages (space_key IS NULL) so locally-created pages
  // also get auto-tagged.
  const pages = await query<{
    id: number;
    body_html: string;
  }>(
    `SELECT cp.id, cp.body_html
     FROM pages cp
     WHERE (cp.space_key = ANY($1::text[]) OR cp.space_key IS NULL)
       AND cp.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM unnest(cp.labels) AS label
          WHERE ai_policy_label_value(label) IS NULL
       )
       AND cp.body_html IS NOT NULL`,
    [await getUserAccessibleSpaces(userId)],
  );

  let tagged = 0;
  let errors = 0;
  let policyBlocked = 0;

  for (const page of pages.rows) {
    try {
      await autoTagPage(userId, String(page.id), modelOverride, async (tags, articleStage) => {
        if (tags.length > 0) {
          await applyLabelChanges(userId, String(page.id), { add: tags, articleStage });
          tagged++;
        }
      });
    } catch (err) {
      if (isAiPolicyRefusal(err) || err instanceof ArticleStageRefusedError) {
        policyBlocked++;
        continue;
      }
      logger.error({ err, pageId: page.id }, 'Failed to auto-tag page');
      errors++;
    }
  }

  return { tagged, errors, ...(policyBlocked > 0 ? { policyBlocked } : {}) };
}
