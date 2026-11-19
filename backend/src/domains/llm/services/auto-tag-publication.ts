import type { PoolClient } from 'pg';
import type { ArticleTransportStage } from './openai-compatible-client.js';
import { ArticleStageRefusedError, validateArticleStageOnClient } from './article-stage-admission.js';
import { resolveArticleUsecaseOnClient } from './llm-provider-resolver.js';

/** Server-only retained result authority. Contains no transport credentials. */
export interface AutoTagPublicationStage extends ArticleTransportStage {
  model: string;
}

/** Used by live publication and durable recovery on their held transaction. */
export async function validateAutoTagPublicationOnClient(
  client: PoolClient,
  stage: ArticleTransportStage,
  userId: string,
  pageId: number,
): Promise<void> {
  const model = (stage as Partial<AutoTagPublicationStage>).model;
  if (stage.userId !== userId || stage.usecase !== 'auto_tag'
    || !stage.context?.operation || !stage.provenance?.pages?.some((page) => page.pageId === pageId)
    || typeof model !== 'string' || !model) throw new ArticleStageRefusedError();
  const target = await resolveArticleUsecaseOnClient(client, 'auto_tag', stage.context.modelSelection);
  if (!target || target.model !== model || target.config.providerId !== stage.provenance.providerId
    || target.config.configRevision !== stage.provenance.configRevision) throw new ArticleStageRefusedError();
  await validateArticleStageOnClient(client, stage.provenance, userId);
}
