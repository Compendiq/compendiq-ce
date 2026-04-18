import { FastifyInstance } from 'fastify';
import {
  providerStreamChat,
  providerStreamChatForUsecase,
} from '../../domains/llm/services/llm-provider.js';
import { LlmCache, buildLlmCacheKey } from '../../domains/llm/services/llm-cache.js';
import { fetchWebSources, formatWebContext, type WebSource } from './_web-search-helper.js';
import { SummarizeRequestSchema } from '@compendiq/contracts';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { logger } from '../../core/utils/logger.js';
import {
  assembleContextIfNeeded,
  resolveSystemPrompt,
  checkCacheWithLock,
  sendCachedSSE,
  streamSSE,
  sanitizeLlmInput,
  buildOutputPostProcessor,
  resolveChatAssignment,
  LLM_STREAM_RATE_LIMIT,
  MAX_INPUT_LENGTH,
} from './_helpers.js';
import { requireGlobalPermission } from '../../core/utils/rbac-guards.js';

export async function llmSummarizeRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  const llmCache = new LlmCache(fastify.redis);

  // POST /api/llm/summarize - stream summary
  fastify.post('/llm/summarize', { ...LLM_STREAM_RATE_LIMIT, preHandler: requireGlobalPermission('llm:summarize') }, async (request, reply) => {
    const body = SummarizeRequestSchema.parse(request.body);
    const { content, model, length = 'medium', includeSubPages } = body;
    const userId = request.userId;

    if (content.length > MAX_INPUT_LENGTH) {
      throw fastify.httpErrors.badRequest(`Content too large (max ${MAX_INPUT_LENGTH} characters)`);
    }

    const { markdown, multiPageSuffix } = await assembleContextIfNeeded(userId, body.pageId, content, includeSubPages);

    // Sanitize before sending to LLM
    const { sanitized: sanitizedMarkdown, warnings } = sanitizeLlmInput(markdown);
    if (warnings.length > 0) {
      await logAuditEvent(userId, 'PROMPT_INJECTION_DETECTED', 'llm', undefined, { warnings, route: '/llm/summarize' }, request);
    }

    const lengthInstructions: Record<string, string> = {
      short: 'Provide a brief 2-3 sentence summary.',
      medium: 'Provide a summary of 1-2 paragraphs covering the main points.',
      detailed: 'Provide a detailed summary covering all important points, decisions, and action items.',
    };

    // Web search for reference material
    const sumWebSources: WebSource[] = [];
    if (body.searchWeb) {
      const sq = body.searchQuery || sanitizedMarkdown.slice(0, 200);
      sumWebSources.push(...await fetchWebSources(sq, userId));
    }

    let summarizeContent = sanitizedMarkdown;
    if (sumWebSources.length > 0) {
      summarizeContent += formatWebContext(sumWebSources, {
        sourceLabel: 'Reference',
        sectionHeader: 'Reference material',
      });
    }

    const sumExtras = sumWebSources.length > 0 ? {
      sources: sumWebSources.map((s) => ({ pageTitle: s.title, spaceKey: 'Web', confluenceId: s.url, score: 1 })),
    } : undefined;

    const basePrompt = await resolveSystemPrompt(userId, 'summarize');
    const systemPrompt = `${basePrompt} ${lengthInstructions[length]}${multiPageSuffix}`;

    // Check LLM cache with stampede protection
    const cacheKey = buildLlmCacheKey(model, systemPrompt, summarizeContent);
    const { cached, lockAcquired } = await checkCacheWithLock(llmCache, cacheKey);
    if (cached) {
      sendCachedSSE(reply, cached.content);
      return;
    }

    try {
      const postProcess = await buildOutputPostProcessor(sumWebSources.map((s) => s.url));

      // Issue #217: honor the per-use-case `chat` provider/model override when
      // the admin has set one. Fall back to per-user routing otherwise.
      const chat = await resolveChatAssignment(model);
      logger.debug(
        { userId, bodyModel: model, resolved: chat.assignment, usedOverride: chat.hasUsecaseOverride },
        'Resolved chat usecase assignment',
      );
      const summarizeMessages = [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: summarizeContent },
      ];
      const generator = chat.hasUsecaseOverride
        ? providerStreamChatForUsecase(chat.provider, chat.model, summarizeMessages)
        : providerStreamChat(userId, model, summarizeMessages);

      await streamSSE(request, reply, generator, sumExtras, { llmCache, cacheKey, postProcess });
    } finally {
      if (lockAcquired) await llmCache.releaseLock(cacheKey);
    }
  });
}
