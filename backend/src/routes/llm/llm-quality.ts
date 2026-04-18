import { FastifyInstance } from 'fastify';
import { getSystemPrompt } from '../../domains/llm/services/ollama-service.js';
import {
  providerStreamChat,
  providerStreamChatForUsecase,
} from '../../domains/llm/services/llm-provider.js';
import { LlmCache, buildLlmCacheKey } from '../../domains/llm/services/llm-cache.js';
import { AnalyzeQualityRequestSchema } from '@compendiq/contracts';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { logger } from '../../core/utils/logger.js';
import {
  assembleContextIfNeeded,
  checkCacheWithLock,
  sendCachedSSE,
  streamSSE,
  sanitizeLlmInput,
  resolveChatAssignment,
  LLM_STREAM_RATE_LIMIT,
  MAX_INPUT_LENGTH,
} from './_helpers.js';

export async function llmQualityRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  const llmCache = new LlmCache(fastify.redis);

  // POST /api/llm/analyze-quality - stream article quality analysis
  fastify.post('/llm/analyze-quality', LLM_STREAM_RATE_LIMIT, async (request, reply) => {
    const body = AnalyzeQualityRequestSchema.parse(request.body);
    const { content, model, includeSubPages } = body;
    const userId = request.userId;

    if (content.length > MAX_INPUT_LENGTH) {
      throw fastify.httpErrors.badRequest(`Content too large (max ${MAX_INPUT_LENGTH} characters)`);
    }

    const { markdown, multiPageSuffix } = await assembleContextIfNeeded(userId, body.pageId, content, includeSubPages);

    // Sanitize before sending to LLM
    const { sanitized, warnings } = sanitizeLlmInput(markdown);
    if (warnings.length > 0) {
      await logAuditEvent(userId, 'PROMPT_INJECTION_DETECTED', 'llm', undefined, { warnings, route: '/llm/analyze-quality' }, request);
    }

    const systemPrompt = getSystemPrompt('analyze_quality') + multiPageSuffix;

    // Check LLM cache with stampede protection
    const cacheKey = buildLlmCacheKey(model, systemPrompt, sanitized);
    const { cached, lockAcquired } = await checkCacheWithLock(llmCache, cacheKey);
    if (cached) {
      sendCachedSSE(reply, cached.content);
      return;
    }

    try {
      // Issue #217: routes through the `chat` usecase, not `quality` — this is
      // the interactive analyze-quality endpoint. The `quality` usecase governs
      // the background quality worker (see domains/knowledge/services/quality-worker.ts).
      const chat = await resolveChatAssignment(model);
      logger.debug(
        { userId, bodyModel: model, resolved: chat.assignment, usedOverride: chat.hasUsecaseOverride },
        'Resolved chat usecase assignment',
      );
      const qualityMessages = [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: sanitized },
      ];
      const generator = chat.hasUsecaseOverride
        ? providerStreamChatForUsecase(chat.provider, chat.model, qualityMessages)
        : providerStreamChat(userId, model, qualityMessages);

      await streamSSE(request, reply, generator, undefined, { llmCache, cacheKey });
    } finally {
      if (lockAcquired) await llmCache.releaseLock(cacheKey);
    }
  });
}
