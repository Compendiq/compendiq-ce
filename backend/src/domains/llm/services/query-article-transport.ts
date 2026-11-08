import type { ConversationTurnAiProvenancePage, AiOperationContext } from '@compendiq/contracts';
import { query } from '../../../core/db/postgres.js';
import { loadProviderMetadata } from './ai-policy-admission.js';
import { ArticleStageRefusedError } from './article-stage-admission.js';
import type { ProviderConfig, TransportContext } from './openai-compatible-client.js';

/** Server-captured provenance of a query/draft, inherited by its paraphrases.
 * This is not a caller-supplied source list or the provenance of search hits. */
export interface QueryArticleInput {
  pages: ConversationTurnAiProvenancePage[];
  operation: AiOperationContext;
}

/** Each receiving stage binds the same input revisions to its OWN destination.
 * The HTTP client's queued admission checks policy, ACL and transport again. */
export async function queryArticleTransport(
  input: QueryArticleInput | undefined,
  userId: string,
  config: ProviderConfig,
  usecase: 'embedding' | 'chat',
): Promise<TransportContext> {
  if (!input) return { kind: 'non_article', purpose: 'user_query' };
  const provider = await loadProviderMetadata({ query }, config.providerId)
    .catch(() => { throw new ArticleStageRefusedError(); });
  if (!provider) throw new ArticleStageRefusedError();
  if (provider.configRevision !== config.configRevision) throw new ArticleStageRefusedError('grounding_changed');
  return { kind: 'article', stage: {
    provenance: { version: 1, providerId: config.providerId, configRevision: provider.configRevision,
      locality: provider.effectiveLocality, pages: input.pages },
    userId, usecase, context: { operation: input.operation, stage: usecase, attempt: 1 },
  } };
}
