import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import {
  InlineCompletionRequestSchema,
  InlineCompletionResponseSchema,
} from '@compendiq/contracts';
import { BrowserInlineAuthorizationRequestSchema, BrowserInlineAuthorizationResponseSchema } from '@compendiq/contracts';
import { getPool } from '../../core/db/postgres.js';
import { userCanAccessPage } from '../../core/services/rbac-service.js';
import { isAiPolicy, lockAiPolicyForPages } from '../../core/services/ai-policy-service.js';
import { safeAiPolicyRevision } from '../../core/services/ai-policy-revision.js';
import { requireGlobalPermission } from '../../core/utils/rbac-guards.js';
import { sanitizeLlmInput } from '../../core/utils/sanitize-llm-input.js';
import { logger } from '../../core/utils/logger.js';
import { resolveInlineCompletionUsecase } from '../../domains/llm/services/llm-provider-resolver.js';
import { requestInlineCompletion } from '../../domains/llm/services/inline-completion-client.js';
import { directArticleTransport } from './_article-transport.js';
import { newAiOperation } from '../../core/enterprise/ai-policy-hooks.js';
import { emitUnresolvedDecision } from '../../domains/llm/services/ai-policy-admission.js';
import { ArticleStageRefusedError } from '../../domains/llm/services/article-stage-admission.js';

const INLINE_COMPLETION_RATE_LIMIT = {
  config: { rateLimit: { max: 180, timeWindow: '1 minute' } },
};

function sanitized(value: string | undefined): string | undefined {
  return value == null ? undefined : sanitizeLlmInput(value).sanitized;
}

/**
 * Cancel upstream work only when the response connection disappears before we
 * can finish it. `IncomingMessage` emits `close` after a normal request body
 * is consumed too, which would abort every non-streaming completion as soon
 * as Fastify has parsed it.
 */
export function abortOnPrematureResponseClose(
  response: ServerResponse,
  controller: AbortController,
): () => void {
  const onClose = () => {
    if (!response.writableEnded) controller.abort();
  };
  response.once('close', onClose);
  if (response.destroyed && !response.writableEnded) controller.abort();
  return () => response.removeListener('close', onClose);
}

export function rethrowUnlessClientDisconnect(
  error: unknown,
  controller: AbortController,
): void {
  if (
    controller.signal.aborted &&
    error instanceof Error &&
    error.name === 'AbortError'
  ) {
    return;
  }
  throw error;
}

async function recordAggregateUsage(
  fastify: FastifyInstance,
  usage: { promptTokens?: number; completionTokens?: number } | undefined,
): Promise<void> {
  try {
    const increments: Array<Promise<number>> = [
      fastify.redis.hIncrBy('metrics:llm:inline_completion', 'requests', 1),
    ];
    if (usage?.promptTokens) {
      increments.push(
        fastify.redis.hIncrBy(
          'metrics:llm:inline_completion',
          'prompt_tokens',
          usage.promptTokens,
        ),
      );
    }
    if (usage?.completionTokens) {
      increments.push(
        fastify.redis.hIncrBy(
          'metrics:llm:inline_completion',
          'completion_tokens',
          usage.completionTokens,
        ),
      );
    }
    await Promise.all(increments);
  } catch (err) {
    // Metrics are aggregate observability, never a reason to hide a valid
    // suggestion. Fixed hash fields mean no page/user/content enters Redis.
    logger.debug({ err }, 'Could not record inline-completion aggregate metrics');
  }
}

export async function llmInlineCompletionRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.post('/llm/inline-completion/browser-authorization', {
    preHandler: requireGlobalPermission('llm:query'),
    onRequest: async (_request, reply) => { reply.header('Cache-Control', 'no-store'); },
  }, async (request, reply) => {
    const { pageId } = BrowserInlineAuthorizationRequestSchema.parse(request.body);
    // No prompt bytes and no provider dispatch or usage accounting on this path.
    try {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        await lockAiPolicyForPages(client, [pageId]);
        if (!(await userCanAccessPage(request.userId, pageId, client))) {
          return reply.code(404).send({ error: 'Page not found' });
        }
        const { rows } = await client.query(
          'SELECT ai_policy, ai_policy_revision FROM pages WHERE id = $1 AND deleted_at IS NULL', [pageId]);
        const row = rows[0];
        if (!row) return reply.code(404).send({ error: 'Page not found' });
        const revision = safeAiPolicyRevision(row.ai_policy_revision);
        if (!isAiPolicy(row.ai_policy) || revision === null) {
          return reply.code(503).send({ error: 'ai_policy_unavailable' });
        }
        if (row.ai_policy === 'none') return reply.code(403).send({ error: 'ai_policy_denied' });
        return BrowserInlineAuthorizationResponseSchema.parse({ pageId, authorized: true,
          aiPolicy: row.ai_policy, aiPolicyRevision: revision });
      } finally {
        try { await client.query('ROLLBACK'); } finally { client.release(); }
      }
    } catch {
      return reply.code(503).send({ error: 'ai_policy_unavailable' });
    }
  });

  fastify.post(
    '/llm/inline-completion',
    {
      ...INLINE_COMPLETION_RATE_LIMIT,
      preHandler: requireGlobalPermission('llm:query'),
    },
    async (request, reply) => {
      const parsed = InlineCompletionRequestSchema.parse(request.body);
      if (!parsed.pageId) return reply.code(422).send({ error: 'article_identity_required' });
      const operation = newAiOperation('inline_completion', { kind: 'user', id: request.userId });
      const context = { operation, stage: 'inline_completion', attempt: 1 };
      let resolved;
      try {
        resolved = await resolveInlineCompletionUsecase();
      } catch {
        await emitUnresolvedDecision(parsed.pageId, 'inline_completion', context, 'policy_unavailable');
        return reply.code(503).send({ error: 'ai_policy_unavailable' });
      }
      if (!resolved) {
        await emitUnresolvedDecision(parsed.pageId, 'inline_completion', context, 'stage_disabled');
        return reply.code(204).send();
      }

      const input = {
        ...parsed,
        prefix: sanitized(parsed.prefix) ?? '',
        suffix: sanitized(parsed.suffix),
        title: sanitized(parsed.title),
        spaceKey: sanitized(parsed.spaceKey),
        language: sanitized(parsed.language),
      };

      // A suggestion is useful only for the cursor that requested it. The
      // signal goes straight into undici in inline-completion-client.ts — no
      // queue or abandoned provider request remains after a disconnect.
      const controller = new AbortController();
      const removeDisconnectListener = abortOnPrematureResponseClose(reply.raw, controller);
      try {
        const transport = await directArticleTransport(request.userId, String(parsed.pageId), false,
          resolved.config, 'inline_completion', operation);
        if (transport.kind !== 'article') throw new ArticleStageRefusedError();
        const result = await requestInlineCompletion(
          resolved.config,
          resolved.model,
          input,
          controller.signal,
          { auditUserId: request.userId, stage: transport.stage },
        );
        // Usage is deliberately best-effort and off the response path. A slow
        // or unavailable Redis must not add latency to editor keystrokes.
        void recordAggregateUsage(fastify, result.usage);
        return InlineCompletionResponseSchema.parse({
          completion: result.completion,
          model: resolved.model,
          provider: resolved.config.name,
          usage: result.usage,
        });
      } catch (error) {
        if (error instanceof ArticleStageRefusedError) {
          return reply.code(503).send({ error: 'ai_policy_unavailable' });
        }
        rethrowUnlessClientDisconnect(error, controller);
        return;
      } finally {
        removeDisconnectListener();
      }
    },
  );
}
