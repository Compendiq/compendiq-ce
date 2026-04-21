import { FastifyInstance } from 'fastify';
import { getSystemPrompt, SystemPromptKey } from '../../domains/llm/services/prompts.js';
import { resolveUsecase } from '../../domains/llm/services/llm-provider-resolver.js';
import { streamChat } from '../../domains/llm/services/openai-compatible-client.js';
import { htmlToMarkdown } from '../../core/services/content-converter.js';
import { LlmCache, buildLlmCacheKey } from '../../domains/llm/services/llm-cache.js';
import { GenerateDiagramRequestSchema } from '@compendiq/contracts';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { logger } from '../../core/utils/logger.js';
import {
  checkCacheWithLock,
  sendCachedSSE,
  streamSSE,
  sanitizeLlmInput,
  LLM_STREAM_RATE_LIMIT,
  MAX_INPUT_LENGTH,
} from './_helpers.js';
import { acquireStreamSlot } from '../../core/services/sse-stream-limiter.js';

export async function llmDiagramRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  const llmCache = new LlmCache(fastify.redis);

  // POST /api/llm/generate-diagram - stream Mermaid diagram from article content
  fastify.post('/llm/generate-diagram', LLM_STREAM_RATE_LIMIT, async (request, reply) => {
    // Per-user concurrent SSE-stream cap (#268). Must fire BEFORE reply.hijack()
    // so rejections can be returned as a normal JSON 429.
    const slot = await acquireStreamSlot(request.userId);
    if (!slot.acquired) {
      return reply.code(429).send({
        error: 'too_many_concurrent_streams',
        message: 'You have reached the per-user concurrent AI-stream limit. Close an existing stream and try again.',
      });
    }

    try {
    const body = GenerateDiagramRequestSchema.parse(request.body);
    const { content, model, diagramType = 'flowchart' } = body;

    if (content.length > MAX_INPUT_LENGTH) {
      throw fastify.httpErrors.badRequest(`Content too large (max ${MAX_INPUT_LENGTH} characters)`);
    }

    const markdown = htmlToMarkdown(content);

    // Sanitize before sending to LLM
    const { sanitized, warnings } = sanitizeLlmInput(markdown);
    if (warnings.length > 0) {
      await logAuditEvent(request.userId, 'PROMPT_INJECTION_DETECTED', 'llm', undefined, { warnings, route: '/llm/generate-diagram' }, request);
    }

    const systemPrompt = getSystemPrompt(`generate_diagram_${diagramType}` as SystemPromptKey);

    // Resolve the `chat` use-case up-front so the cache key includes the
    // resolved provider+model. Queue + per-provider breakers wrap streamChat().
    const { config: chatConfig, model: resolvedModel } = await resolveUsecase('chat');
    logger.debug(
      { userId: request.userId, bodyModel: model, providerId: chatConfig.providerId, resolvedModel },
      'Resolved chat usecase assignment',
    );

    // Check LLM cache with stampede protection
    const cacheKey = buildLlmCacheKey(resolvedModel, systemPrompt, sanitized, chatConfig.providerId);
    const { cached, lockAcquired } = await checkCacheWithLock(llmCache, cacheKey);
    if (cached) {
      sendCachedSSE(reply, cached.content);
      return;
    }

    try {
      const diagramMessages = [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: sanitized },
      ];
      const generator = streamChat(chatConfig, resolvedModel, diagramMessages);

      await streamSSE(request, reply, generator, undefined, { llmCache, cacheKey });
    } finally {
      if (lockAcquired) await llmCache.releaseLock(cacheKey);
    }
    } finally {
      await slot.release();
    }
  });
}
