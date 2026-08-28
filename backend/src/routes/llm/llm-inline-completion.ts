import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import {
  InlineCompletionRequestSchema,
  InlineCompletionResponseSchema,
} from '@compendiq/contracts';
import { requireGlobalPermission } from '../../core/utils/rbac-guards.js';
import { sanitizeLlmInput } from '../../core/utils/sanitize-llm-input.js';
import { logger } from '../../core/utils/logger.js';
import { resolveInlineCompletionUsecase } from '../../domains/llm/services/llm-provider-resolver.js';
import { requestInlineCompletion } from '../../domains/llm/services/inline-completion-client.js';

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

  fastify.post(
    '/llm/inline-completion',
    {
      ...INLINE_COMPLETION_RATE_LIMIT,
      preHandler: requireGlobalPermission('llm:query'),
    },
    async (request, reply) => {
      const parsed = InlineCompletionRequestSchema.parse(request.body);
      const resolved = await resolveInlineCompletionUsecase();
      if (!resolved) return reply.code(204).send();

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
        const result = await requestInlineCompletion(
          resolved.config,
          resolved.model,
          input,
          controller.signal,
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
        rethrowUnlessClientDisconnect(error, controller);
        return;
      } finally {
        removeDisconnectListener();
      }
    },
  );
}
