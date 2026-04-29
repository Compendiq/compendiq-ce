import { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { SystemPromptKey } from '../../domains/llm/services/prompts.js';
import { resolveUsecase } from '../../domains/llm/services/llm-provider-resolver.js';
import { streamChat } from '../../domains/llm/services/openai-compatible-client.js';
import { LlmCache, buildLlmCacheKey } from '../../domains/llm/services/llm-cache.js';
import { fetchWebSources, formatWebContext, type WebSource } from './_web-search-helper.js';
import { ImproveRequestSchema } from '@compendiq/contracts';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { logger } from '../../core/utils/logger.js';
import { emitLlmAudit, estimateTokens } from '../../domains/llm/services/llm-audit-hook.js';
import {
  assembleContextIfNeeded,
  resolveSystemPrompt,
  checkCacheWithLock,
  sendCachedSSE,
  streamSSE,
  sanitizeLlmInput,
  buildOutputPostProcessor,
  LLM_STREAM_RATE_LIMIT,
  MAX_INPUT_LENGTH,
} from './_helpers.js';
import { requireGlobalPermission } from '../../core/utils/rbac-guards.js';
import { acquireStreamSlot } from '../../core/services/sse-stream-limiter.js';

export async function llmImproveRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  const llmCache = new LlmCache(fastify.redis);

  // POST /api/llm/improve - stream improved content
  fastify.post('/llm/improve', { ...LLM_STREAM_RATE_LIMIT, preHandler: requireGlobalPermission('llm:improve') }, async (request, reply) => {
    // Per-user concurrent SSE-stream cap (#268).
    const slot = await acquireStreamSlot(request.userId);
    if (!slot.acquired) {
      return reply.code(429).send({
        error: 'too_many_concurrent_streams',
        message: 'You have reached the per-user concurrent AI-stream limit. Close an existing stream and try again.',
      });
    }

    try {
    const auditStart = Date.now();
    const body = ImproveRequestSchema.parse(request.body);
    const { content, type, model, includeSubPages, instruction } = body;
    const userId = request.userId;

    if (content.length > MAX_INPUT_LENGTH) {
      throw fastify.httpErrors.badRequest(`Content too large (max ${MAX_INPUT_LENGTH} characters)`);
    }

    const { markdown, multiPageSuffix } = await assembleContextIfNeeded(userId, body.pageId, content, includeSubPages);

    // Sanitize before sending to LLM
    const { sanitized, warnings } = sanitizeLlmInput(markdown);
    const promptInjectionDetected = warnings.length > 0;
    const wasSanitized = sanitized !== markdown;
    if (promptInjectionDetected) {
      await logAuditEvent(userId, 'PROMPT_INJECTION_DETECTED', 'llm', undefined, { warnings, route: '/llm/improve' }, request);
    }

    // Sanitize optional user instruction (strip HTML tags, limit length)
    let sanitizedInstruction: string | undefined;
    if (instruction) {
      const stripped = instruction.replace(/<[^>]*>/g, '').slice(0, 10000);
      const { sanitized: instrSanitized, warnings: instrWarnings } = sanitizeLlmInput(stripped);
      sanitizedInstruction = instrSanitized;
      if (instrWarnings.length > 0) {
        await logAuditEvent(userId, 'PROMPT_INJECTION_DETECTED', 'llm', undefined, { warnings: instrWarnings, route: '/llm/improve', field: 'instruction' }, request);
      }
    }

    // Web search for reference material (Phase 3 — #564)
    const webSources: WebSource[] = [];
    if (body.searchWeb) {
      const sq = body.searchQuery || sanitizedInstruction?.slice(0, 200) || `improve ${type} technical documentation`;
      webSources.push(...await fetchWebSources(sq, userId));
    }

    let improveContent = sanitized;
    if (webSources.length > 0) {
      improveContent += formatWebContext(webSources, {
        sourceLabel: 'Reference',
        sectionHeader: 'Verified reference material from web search',
      });
    }

    let systemPrompt = await resolveSystemPrompt(userId, `improve_${type}` as SystemPromptKey) + multiPageSuffix;
    if (sanitizedInstruction) {
      systemPrompt += `\n\nADDITIONAL USER INSTRUCTIONS:\n${sanitizedInstruction}`;
    }

    // Resolve the `chat` use-case up-front so the cache key includes the
    // resolved provider+model. Queue + per-provider breakers wrap streamChat().
    const { config: chatConfig, model: resolvedModel } = await resolveUsecase('chat');
    logger.debug(
      { userId, bodyModel: model, providerId: chatConfig.providerId, resolvedModel },
      'Resolved chat usecase assignment',
    );

    // Check LLM cache with stampede protection
    const cacheKey = buildLlmCacheKey(resolvedModel, systemPrompt, improveContent, chatConfig.providerId);
    const { cached, lockAcquired } = await checkCacheWithLock(llmCache, cacheKey);
    if (cached) {
      sendCachedSSE(reply, cached.content);
      return;
    }

    // Pre-insert improvement record so we have the row to update after streaming
    let improvementId: string | undefined;
    if (body.pageId) {
      const insertResult = await query<{ id: string }>(
        `INSERT INTO llm_improvements (user_id, page_id, improvement_type, model, original_content, improved_content, status)
         SELECT $1, p.id, $3, $4, $5, '', 'streaming' FROM pages p WHERE p.confluence_id = $2 RETURNING id`,
        [userId, body.pageId, type, model, content.slice(0, 10000)],
      );
      improvementId = insertResult.rows[0]?.id;
    }

    const improveExtras = webSources.length > 0 ? {
      sources: webSources.map((s) => ({
        pageTitle: s.title, spaceKey: 'Web', confluenceId: s.url, score: 1,
      })),
    } : undefined;

    const improveMessages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: improveContent },
    ];

    try {
      const postProcess = await buildOutputPostProcessor(webSources.map((s) => s.url));

      const generator = streamChat(chatConfig, resolvedModel, improveMessages);

      const accumulated = await streamSSE(request, reply, generator, improveExtras, { llmCache, cacheKey, postProcess });

      // Persist the full improved content now that streaming is done
      if (improvementId && accumulated) {
        await query(
          `UPDATE llm_improvements SET improved_content = $1, status = 'completed' WHERE id = $2`,
          [accumulated.slice(0, 50000), improvementId],
        );
      }

      emitLlmAudit({
        userId,
        action: 'improve',
        model: resolvedModel,
        provider: 'openai',
        inputTokens: estimateTokens(improveMessages.map(m => m.content).join('')),
        outputTokens: estimateTokens(accumulated),
        inputMessages: improveMessages.map(m => ({ role: m.role, contentLength: m.content.length })),
        retrievedChunkIds: [],
        durationMs: Date.now() - auditStart,
        status: 'success',
        promptInjectionDetected,
        sanitized: wasSanitized,
      });
    } catch (err) {
      emitLlmAudit({
        userId,
        action: 'improve',
        model: resolvedModel,
        provider: 'openai',
        inputTokens: estimateTokens(improveMessages.map(m => m.content).join('')),
        outputTokens: 0,
        inputMessages: improveMessages.map(m => ({ role: m.role, contentLength: m.content.length })),
        retrievedChunkIds: [],
        durationMs: Date.now() - auditStart,
        status: 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
        promptInjectionDetected,
        sanitized: wasSanitized,
      });
      throw err;
    } finally {
      if (lockAcquired) await llmCache.releaseLock(cacheKey);
    }
    } finally {
      await slot.release();
    }
  });
}
