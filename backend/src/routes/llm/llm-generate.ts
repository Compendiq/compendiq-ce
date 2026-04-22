import { FastifyInstance } from 'fastify';
import { SystemPromptKey } from '../../domains/llm/services/prompts.js';
import { resolveUsecase } from '../../domains/llm/services/llm-provider-resolver.js';
import { streamChat } from '../../domains/llm/services/openai-compatible-client.js';
import { LlmCache, buildLlmCacheKey } from '../../domains/llm/services/llm-cache.js';
import { fetchWebSources, formatWebContext, type WebSource } from './_web-search-helper.js';
import { GenerateRequestSchema } from '@compendiq/contracts';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { logger } from '../../core/utils/logger.js';
import { emitLlmAudit, estimateTokens } from '../../domains/llm/services/llm-audit-hook.js';
import {
  resolveSystemPrompt,
  checkCacheWithLock,
  sendCachedSSE,
  streamSSE,
  sanitizeLlmInput,
  buildOutputPostProcessor,
  LLM_STREAM_RATE_LIMIT,
  MAX_INPUT_LENGTH,
  MAX_PDF_TEXT_FOR_LLM,
} from './_helpers.js';
import { requireGlobalPermission } from '../../core/utils/rbac-guards.js';
import { acquireStreamSlot } from '../../core/services/sse-stream-limiter.js';

export async function llmGenerateRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  const llmCache = new LlmCache(fastify.redis);

  // POST /api/llm/generate - stream generated article
  fastify.post('/llm/generate', { ...LLM_STREAM_RATE_LIMIT, preHandler: requireGlobalPermission('llm:generate') }, async (request, reply) => {
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
    const body = GenerateRequestSchema.parse(request.body);
    const { prompt, model, template, pdfText } = body;
    const userId = request.userId;

    if (prompt.length > MAX_INPUT_LENGTH) {
      throw fastify.httpErrors.badRequest(`Prompt too large (max ${MAX_INPUT_LENGTH} characters)`);
    }

    // Sanitize before sending to LLM
    const { sanitized, warnings } = sanitizeLlmInput(prompt);
    if (warnings.length > 0) {
      await logAuditEvent(userId, 'PROMPT_INJECTION_DETECTED', 'llm', undefined, { warnings, route: '/llm/generate' }, request);
    }

    // When PDF text is provided, sanitize it and use the generate_from_pdf prompt
    let userContent = sanitized;
    let systemPrompt: string;

    if (pdfText) {
      const { sanitized: sanitizedPdf, warnings: pdfWarnings } = sanitizeLlmInput(pdfText);
      if (pdfWarnings.length > 0) {
        await logAuditEvent(userId, 'PROMPT_INJECTION_DETECTED', 'llm', undefined, {
          warnings: pdfWarnings, route: '/llm/generate', field: 'pdfText',
        }, request);
      }

      // Truncate to fit within model context windows
      let pdfForLlm = sanitizedPdf;
      if (sanitizedPdf.length > MAX_PDF_TEXT_FOR_LLM) {
        pdfForLlm = sanitizedPdf.slice(0, MAX_PDF_TEXT_FOR_LLM) +
          '\n\n[Document truncated — only the first ~80,000 characters were included due to context window limits.]';
        logger.info({ original: sanitizedPdf.length, truncated: MAX_PDF_TEXT_FOR_LLM }, 'PDF text truncated for LLM context window');
      }

      // Use template-specific prompt or generate_from_pdf (via resolveSystemPrompt for guardrails)
      const promptKey = template ? `generate_${template}` : 'generate_from_pdf';
      systemPrompt = await resolveSystemPrompt(userId, promptKey as SystemPromptKey);

      userContent = `## Source Document\n${pdfForLlm}\n\n## Instructions\n${sanitized}`;
    } else {
      const promptKey = template ? `generate_${template}` : 'generate';
      systemPrompt = await resolveSystemPrompt(userId, promptKey as SystemPromptKey);
    }

    // Web search for reference material (Phase 3 — #564)
    const genWebSources: WebSource[] = [];
    if (body.searchWeb) {
      const sq = body.searchQuery || sanitized.slice(0, 200);
      genWebSources.push(...await fetchWebSources(sq, userId));
    }

    if (genWebSources.length > 0) {
      userContent += formatWebContext(genWebSources, {
        sourceLabel: 'Web Source',
        sectionHeader: 'Verified reference material from web search',
      });
    }

    const genExtras = genWebSources.length > 0 ? {
      sources: genWebSources.map((s) => ({
        pageTitle: s.title, spaceKey: 'Web', confluenceId: s.url, score: 1,
      })),
    } : undefined;

    // Resolve the `chat` use-case up-front so the cache key includes the
    // resolved provider+model. Queue + per-provider breakers wrap streamChat().
    const { config: chatConfig, model: resolvedModel } = await resolveUsecase('chat');
    logger.debug(
      { userId, bodyModel: model, providerId: chatConfig.providerId, resolvedModel },
      'Resolved chat usecase assignment',
    );

    // Check LLM cache with stampede protection
    const cacheKey = buildLlmCacheKey(resolvedModel, systemPrompt, userContent, chatConfig.providerId);
    const { cached, lockAcquired } = await checkCacheWithLock(llmCache, cacheKey);
    if (cached) {
      sendCachedSSE(reply, cached.content);
      return;
    }

    const generateMessages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: userContent },
    ];

    try {
      const postProcess = await buildOutputPostProcessor(genWebSources.map((s) => s.url));

      const generator = streamChat(chatConfig, resolvedModel, generateMessages);

      const accumulated = await streamSSE(request, reply, generator, genExtras, { llmCache, cacheKey, postProcess });

      emitLlmAudit({
        userId,
        action: 'generate',
        model: resolvedModel,
        provider: 'openai',
        inputTokens: estimateTokens(generateMessages.map(m => m.content).join('')),
        outputTokens: estimateTokens(accumulated),
        inputMessages: generateMessages.map(m => ({ role: m.role, contentLength: m.content.length })),
        retrievedChunkIds: [],
        durationMs: Date.now() - auditStart,
        status: 'success',
      });
    } catch (err) {
      emitLlmAudit({
        userId,
        action: 'generate',
        model: resolvedModel,
        provider: 'openai',
        inputTokens: estimateTokens(generateMessages.map(m => m.content).join('')),
        outputTokens: 0,
        inputMessages: generateMessages.map(m => ({ role: m.role, contentLength: m.content.length })),
        retrievedChunkIds: [],
        durationMs: Date.now() - auditStart,
        status: 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
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
