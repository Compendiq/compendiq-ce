import { randomUUID } from 'node:crypto';
import { emitAiDecision, newAiOperation } from '../../core/enterprise/ai-policy-hooks.js';
import { emitUnresolvedDecision } from '../../domains/llm/services/ai-policy-admission.js';
import { resolveUsecase } from '../../domains/llm/services/llm-provider-resolver.js';
import { resolveReadablePageRef } from './_helpers.js';

/** Allocate at the request boundary, before resolution can fail. Successful
 * resolution is not an admission: the same operation reaches final transport. */
export async function resolveDirectArticleChat(userId: string, pageId: string | undefined) {
  const operation = newAiOperation('direct_article', { kind: 'user', id: userId });
  try {
    return { ...await resolveUsecase('chat'), operation };
  } catch (error) {
    const page = pageId ? await resolveReadablePageRef(userId, pageId).catch(() => null) : null;
    if (page) {
      await emitUnresolvedDecision(page.id, 'chat', { operation, stage: 'chat', attempt: 1 }, 'policy_unavailable');
    } else {
      // An unresolved or inaccessible client reference is not a certified ID.
      emitAiDecision({ ...operation, eventId: randomUUID(), occurredAt: new Date().toISOString(),
        type: 'decision', usecase: 'chat', stage: 'chat', attempt: 1,
        articles: [], provider: null, decision: 'blocked', reason: 'policy_unavailable' });
    }
    throw error;
  }
}
