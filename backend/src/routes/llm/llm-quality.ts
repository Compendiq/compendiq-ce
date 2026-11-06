import { assembleDirectArticleContext } from './_article-transport.js';
import { randomUUID } from 'node:crypto';
import { newAiOperation, emitAiDecision } from '../../core/enterprise/ai-policy-hooks.js';
import { emitUnresolvedDecision } from '../../domains/llm/services/ai-policy-admission.js';
import { resolveReadablePageRef } from './_helpers.js';
import { directRefusalResponse, replayDirectOutput } from './_article-cache.js';
import { FastifyInstance } from 'fastify';
import { getSystemPrompt } from '../../domains/llm/services/prompts.js';
import { resolveUsecase } from '../../domains/llm/services/llm-provider-resolver.js';
import { streamChat } from '../../domains/llm/services/openai-compatible-client.js';
import { LlmCache, buildLlmCacheKey } from '../../domains/llm/services/llm-cache.js';
import { AnalyzeQualityRequestSchema } from '@compendiq/contracts';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { logger } from '../../core/utils/logger.js';
import { estimateTokens, fingerprintPrompt } from '../../domains/llm/services/llm-audit-hook.js';
import {
  checkCacheWithLock,
  sendCachedSSE,
  streamSSE,
  sanitizeLlmInput,
  LLM_STREAM_RATE_LIMIT,
  MAX_INPUT_LENGTH,
} from './_helpers.js';
import { acquireStreamSlot } from '../../core/services/sse-stream-limiter.js';
import { requireGlobalPermission } from '../../core/utils/rbac-guards.js';

export async function llmQualityRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  const llmCache = new LlmCache(fastify.redis);

  // POST /api/llm/analyze-quality - stream article quality analysis
  fastify.post('/llm/analyze-quality', { ...LLM_STREAM_RATE_LIMIT, preHandler: requireGlobalPermission('llm:query') }, async (request, reply) => {
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
    const body = AnalyzeQualityRequestSchema.parse(request.body);
    const { content, model, includeSubPages } = body;
    const userId = request.userId;

    if (content.length > MAX_INPUT_LENGTH) {
      throw fastify.httpErrors.badRequest(`Content too large (max ${MAX_INPUT_LENGTH} characters)`);
    }

    const operation = newAiOperation('direct_article', { kind: 'user', id: userId });
    const { config: qualityConfig, model: resolvedModel } = await resolveUsecase('quality').catch(async (error: unknown) => {
      const page = body.pageId ? await resolveReadablePageRef(userId, body.pageId).catch(() => null) : null;
      if (page) {
        await emitUnresolvedDecision(page.id, 'quality', { operation, stage: 'quality', attempt: 1 }, 'policy_unavailable');
      } else {
        emitAiDecision({ ...operation, eventId: randomUUID(), occurredAt: new Date().toISOString(),
          type: 'decision', usecase: 'quality', stage: 'quality', attempt: 1,
          articles: [], provider: null, decision: 'blocked', reason: 'policy_unavailable' });
      }
      throw error;
    });
    const { markdown, multiPageSuffix, transportContext } = await assembleDirectArticleContext(
      userId, body.pageId, content, includeSubPages, qualityConfig, 'quality', resolvedModel, { operation },
    );

    // Sanitize before sending to LLM
    const { sanitized, warnings } = sanitizeLlmInput(markdown);
    if (warnings.length > 0) {
      await logAuditEvent(userId, 'PROMPT_INJECTION_DETECTED', 'llm', undefined, { warnings, route: '/llm/analyze-quality' }, request);
    }

    const systemPrompt = getSystemPrompt('analyze_quality') + multiPageSuffix;

    // Cache and transport use the same destination as the composition.
    logger.debug(
      { userId, bodyModel: model, providerId: qualityConfig.providerId, resolvedModel },
      'Resolved quality usecase assignment',
    );

    // Check LLM cache with stampede protection
    const cacheKey = buildLlmCacheKey(resolvedModel, systemPrompt, sanitized, qualityConfig.providerId, { thinking: body.thinking });
    const { cached, lockToken } = await checkCacheWithLock(llmCache, cacheKey);
    if (cached) {
      // #282: re-admitted under the RECORDED provenance (replayDirectOutput);
      // a refusal is a status code before any SSE header.
      const replayed = await replayDirectOutput(cached, {
        transport: qualityConfig, transportContext, userId, usecase: 'quality', model: resolvedModel,
      });
      sendCachedSSE(reply, replayed);
      return;
    }

    try {
      const qualityMessages = [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: sanitized },
      ];
      await streamSSE(request, reply,
        (signal) => streamChat(qualityConfig, resolvedModel, qualityMessages, signal, { thinking: body.thinking, transportContext }),
        undefined, {
          llmCache, cacheKey,
          audit: {
            userId, action: 'quality', model: resolvedModel, provider: qualityConfig.providerId,
            inputTokens: estimateTokens(qualityMessages.map((m) => m.content).join('')),
            inputMessages: qualityMessages.map((m) => ({ role: m.role, contentLength: m.content.length })),
            promptHash: fingerprintPrompt(qualityMessages),
            retrievedChunkIds: [],
          },
          cacheProvenance: transportContext.kind === 'article' ? transportContext.stage.provenance : undefined,
        });
    } finally {
      if (lockToken) await llmCache.releaseLock(cacheKey, lockToken);
    }
    } catch (err) {
      // #282: a pre-hijack refusal is a 409/503 with the contract body, never a 500.
      const refusal = reply.sent ? null : directRefusalResponse(err, 'quality');
      if (!refusal) throw err;
      return reply.code(refusal.statusCode).send(refusal.body);
    } finally {
      await slot.release();
    }
  });
}
