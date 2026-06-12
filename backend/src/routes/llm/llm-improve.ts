import { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { SystemPromptKey, STRUCTURE_PRESERVATION_INSTRUCTION } from '../../domains/llm/services/prompts.js';
import { resolveUsecase } from '../../domains/llm/services/llm-provider-resolver.js';
import { streamChat } from '../../domains/llm/services/openai-compatible-client.js';
import { LlmCache, buildLlmCacheKey } from '../../domains/llm/services/llm-cache.js';
import { fetchWebSources, formatWebContext, type WebSource } from './_web-search-helper.js';
import { ImproveRequestSchema } from '@compendiq/contracts';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { logger } from '../../core/utils/logger.js';
import { emitLlmAudit, estimateTokens } from '../../domains/llm/services/llm-audit-hook.js';
import { hasRecoverableLayoutTokens } from '../../core/services/content-converter.js';
import {
  assembleContextIfNeeded,
  resolvePageRef,
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

    // #765: layoutTokens applies only to the main-page conversion — the
    // sub-page branch inside assembleContextIfNeeded never emits tokens.
    const { markdown, multiPageSuffix } = await assembleContextIfNeeded(userId, body.pageId, content, includeSubPages, { protectMedia: true, layoutTokens: true });

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
    // #765: when the markdown carries layout boundary tokens or media
    // placeholders, instruct the model to keep them verbatim. (Deterministic
    // per content, so it composes safely with the cache key below.)
    const inputHasLayoutTokens = /\[\[\[/.test(markdown);
    if (inputHasLayoutTokens || /CQ\\?_MEDIA\\?_PLACEHOLDER/.test(markdown)) {
      systemPrompt += `\n\n${STRUCTURE_PRESERVATION_INSTRUCTION}`;
    }
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
    const cacheKey = buildLlmCacheKey(resolvedModel, systemPrompt, improveContent, chatConfig.providerId, { thinking: body.thinking });
    const { cached, lockAcquired } = await checkCacheWithLock(llmCache, cacheKey);
    if (cached) {
      // Echo back the markdown the model was given (#704) so the frontend can
      // diff like-for-like (original markdown vs improved markdown) instead of
      // comparing formatting-stripped bodyText against the markdown output.
      sendCachedSSE(reply, cached.content, { originalMarkdown: markdown });
      return;
    }

    // Pre-insert improvement record so we have the row to update after
    // streaming. resolvePageRef accepts both id forms — the frontend passes
    // the INTERNAL pages.id, which the old confluence_id-only subquery never
    // matched, so UI-driven improvements silently skipped this record.
    let improvementId: string | undefined;
    if (body.pageId) {
      const page = await resolvePageRef(body.pageId);
      if (page) {
        const insertResult = await query<{ id: string }>(
          `INSERT INTO llm_improvements (user_id, page_id, improvement_type, model, original_content, improved_content, status)
           VALUES ($1, $2, $3, $4, $5, '', 'streaming') RETURNING id`,
          [userId, page.id, type, resolvedModel, content.slice(0, 10000)],
        );
        improvementId = insertResult.rows[0]?.id;
      }
    }

    // Always echo the markdown the model was given (#704) so the frontend can
    // diff like-for-like (original markdown vs improved markdown). Web sources,
    // when present, ride along in the same final SSE event.
    const improveExtras: Record<string, unknown> = { originalMarkdown: markdown };
    if (webSources.length > 0) {
      improveExtras.sources = webSources.map((s) => ({
        pageTitle: s.title, spaceKey: 'Web', confluenceId: s.url, score: 1,
      }));
    }

    const improveMessages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: improveContent },
    ];

    try {
      const postProcess = await buildOutputPostProcessor(webSources.map((s) => s.url));

      const generator = streamChat(chatConfig, resolvedModel, improveMessages, undefined, { thinking: body.thinking });

      const accumulated = await streamSSE(request, reply, generator, improveExtras, {
        llmCache,
        cacheKey,
        postProcess,
        // Never cache a response that lost the layout tokens: the apply will
        // 422 with "run AI Improve again", and a cached token-less response
        // would replay on every retry until the TTL expires.
        shouldCache: (out) => !inputHasLayoutTokens || hasRecoverableLayoutTokens(out),
      });

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
        provider: chatConfig.providerId,
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
        provider: chatConfig.providerId,
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
