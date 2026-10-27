import { newAiOperation, emitAiDecision } from '../../core/enterprise/ai-policy-hooks.js';
import { randomUUID } from 'node:crypto';
import { emitUnresolvedDecision } from '../../domains/llm/services/ai-policy-admission.js';
import { resolveReadablePageRef } from './_helpers.js';
import { assembleDirectArticleContext } from './_article-transport.js';
import { authorizeArticleDispatch } from '../../domains/llm/services/article-stage-admission.js';
import { FastifyInstance } from 'fastify';
import { resolveUsecase } from '../../domains/llm/services/llm-provider-resolver.js';
import { streamChat } from '../../domains/llm/services/openai-compatible-client.js';
import { LlmCache, buildLlmCacheKey } from '../../domains/llm/services/llm-cache.js';
import { fetchWebSources, formatWebContext, type WebSource } from './_web-search-helper.js';
import { SummarizeRequestSchema } from '@compendiq/contracts';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { logger } from '../../core/utils/logger.js';
import { estimateTokens } from '../../domains/llm/services/llm-audit-hook.js';
import {
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

export async function llmSummarizeRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  const llmCache = new LlmCache(fastify.redis);

  // POST /api/llm/summarize - stream summary
  fastify.post('/llm/summarize', { ...LLM_STREAM_RATE_LIMIT, preHandler: requireGlobalPermission('llm:summarize') }, async (request, reply) => {
    // Per-user concurrent SSE-stream cap (#268).
    const slot = await acquireStreamSlot(request.userId);
    if (!slot.acquired) {
      return reply.code(429).send({
        error: 'too_many_concurrent_streams',
        message: 'You have reached the per-user concurrent AI-stream limit. Close an existing stream and try again.',
      });
    }

    try {
    const body = SummarizeRequestSchema.parse(request.body);
    const { content, model, length = 'medium', includeSubPages } = body;
    const userId = request.userId;

    if (content.length > MAX_INPUT_LENGTH) {
      throw fastify.httpErrors.badRequest(`Content too large (max ${MAX_INPUT_LENGTH} characters)`);
    }

    const operation = newAiOperation('direct_article', { kind: 'user', id: userId });
    const assignment = await resolveUsecase('summary').catch(async (error: unknown) => {
      const page = body.pageId ? await resolveReadablePageRef(userId, body.pageId).catch(() => null) : null;
      if (page) {
        await emitUnresolvedDecision(page.id, 'summary', { operation, stage: 'summary', attempt: 1 }, 'policy_unavailable');
      } else {
        emitAiDecision({ ...operation, eventId: randomUUID(), occurredAt: new Date().toISOString(),
          type: 'decision', usecase: 'summary', stage: 'summary', attempt: 1,
          articles: [], provider: null, decision: 'blocked', reason: 'policy_unavailable' });
      }
      throw error;
    });
    const { config: summaryConfig, model: resolvedModel } = assignment;
    const { markdown, multiPageSuffix, transportContext } = await assembleDirectArticleContext(
      userId, body.pageId, content, includeSubPages, summaryConfig, 'summary', resolvedModel, { operation },
    );

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
      const { sources: fetchedSources, injectionWarnings } = await fetchWebSources(sq, userId);
      sumWebSources.push(...fetchedSources);
      // One aggregated event per request (#835) — covers every offending web
      // source so audit volume stays bounded. logAuditEvent never throws.
      if (injectionWarnings.length > 0) {
        await logAuditEvent(userId, 'PROMPT_INJECTION_DETECTED', 'llm', undefined, {
          warnings: injectionWarnings.flatMap((w) => w.warnings),
          route: '/llm/summarize',
          field: 'webSearch',
          urls: injectionWarnings.map((w) => w.url),
        }, request);
      }
    }

    let summarizeContent = sanitizedMarkdown;
    if (sumWebSources.length > 0) {
      summarizeContent += formatWebContext(sumWebSources, {
        sourceLabel: 'Reference',
        sectionHeader: 'Reference material',
      });
    }

    // `url` marks these as links, not pages — see #1125 / llm-generate.ts.
    const sumExtras = sumWebSources.length > 0 ? {
      sources: sumWebSources.map((s) => ({
        pageId: 0, pageTitle: s.title, spaceKey: 'Web', confluenceId: s.url, url: s.url, score: 1,
      })),
    } : undefined;

    const basePrompt = await resolveSystemPrompt(userId, 'summarize');
    const systemPrompt = `${basePrompt} ${lengthInstructions[length]}${multiPageSuffix}`;

    // Keep the saved summary assignment used for composition.
    logger.debug(
      { userId, bodyModel: model, providerId: summaryConfig.providerId, resolvedModel },
      'Resolved summary usecase assignment',
    );

    const effectiveModel = resolvedModel;
    if (transportContext.kind === 'article') {
      transportContext.stage.context.modelSelection = { kind: 'assigned' };
    }

    // Check LLM cache with stampede protection
    const cacheKey = buildLlmCacheKey(effectiveModel, systemPrompt, summarizeContent, summaryConfig.providerId, { thinking: body.thinking });
    const { cached, lockToken } = await checkCacheWithLock(llmCache, cacheKey);
    if (cached) {
      // Cache reuse is not an inference attempt. Still revalidate after the
      // potentially waiting cache lookup; a denial emits its typed refusal.
      if (transportContext.kind === 'article') {
        await authorizeArticleDispatch(summaryConfig, transportContext.stage.provenance, userId, 'summary', transportContext.stage.context, effectiveModel, true);
      }
      sendCachedSSE(reply, cached.content);
      return;
    }

    try {
      const postProcess = await buildOutputPostProcessor(sumWebSources.map((s) => s.url));

      const summarizeMessages = [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: summarizeContent },
      ];
      await streamSSE(request, reply,
        (signal) => streamChat(summaryConfig, effectiveModel, summarizeMessages, signal, { thinking: body.thinking, transportContext }),
        sumExtras, {
          llmCache, cacheKey, postProcess,
          audit: {
            userId, action: 'summarize', model: effectiveModel, provider: summaryConfig.providerId,
            inputTokens: estimateTokens(summarizeMessages.map((m) => m.content).join('')),
            inputMessages: summarizeMessages.map((m) => ({ role: m.role, contentLength: m.content.length })),
            retrievedChunkIds: [],
          },
        });
    } finally {
      if (lockToken) await llmCache.releaseLock(cacheKey, lockToken);
    }
    } finally {
      await slot.release();
    }
  });
}
