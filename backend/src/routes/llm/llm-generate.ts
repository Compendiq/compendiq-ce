import { FastifyInstance } from 'fastify';
import { SystemPromptKey, contentToText, type ChatContentPart, type ChatMessage } from '../../domains/llm/services/prompts.js';
import { resolveUsecase } from '../../domains/llm/services/llm-provider-resolver.js';
import { streamChat } from '../../domains/llm/services/openai-compatible-client.js';
import { queryArticleTransport } from '../../domains/llm/services/query-article-transport.js';
import { newAiOperation } from '../../core/enterprise/ai-policy-hooks.js';
import { LlmCache, buildLlmCacheKey } from '../../domains/llm/services/llm-cache.js';
import { directRefusalResponse, replayDirectOutput } from './_article-cache.js';
import { fetchWebSources, formatWebContext, type WebSource } from './_web-search-helper.js';
import { GenerateRequestSchema } from '@compendiq/contracts';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { logger } from '../../core/utils/logger.js';
import { emitLlmAudit, estimateTokens, fingerprintPrompt } from '../../domains/llm/services/llm-audit-hook.js';
import {
  resolveSystemPrompt,
  checkCacheWithLock,
  sendCachedSSE,
  streamSSE,
  sanitizeLlmInput,
  buildOutputPostProcessor,
  resolveImagePart,
  LLM_STREAM_RATE_LIMIT,
  MAX_INPUT_LENGTH,
  MAX_DOCUMENT_TEXT_FOR_LLM,
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
    const { prompt, model, template, documentText, imageHandle } = body;
    const userId = request.userId;

    if (prompt.length > MAX_INPUT_LENGTH) {
      throw fastify.httpErrors.badRequest(`Prompt too large (max ${MAX_INPUT_LENGTH} characters)`);
    }

    // Sanitize before sending to LLM
    const { sanitized, warnings } = sanitizeLlmInput(prompt);
    let promptInjectionDetected = warnings.length > 0;
    let wasSanitized = sanitized !== prompt;
    if (promptInjectionDetected) {
      await logAuditEvent(userId, 'PROMPT_INJECTION_DETECTED', 'llm', undefined, { warnings, route: '/llm/generate' }, request);
    }

    // When document text is provided, sanitize it and use the
    // generate_from_document prompt. Nothing below branches on the source
    // format: the extractor has already turned all six into plain prose (#1132).
    let userContent = sanitized;
    let systemPrompt: string;

    if (documentText) {
      const { sanitized: sanitizedDocument, warnings: documentWarnings } = sanitizeLlmInput(documentText);
      promptInjectionDetected = promptInjectionDetected || documentWarnings.length > 0;
      wasSanitized = wasSanitized || sanitizedDocument !== documentText;
      if (documentWarnings.length > 0) {
        await logAuditEvent(userId, 'PROMPT_INJECTION_DETECTED', 'llm', undefined, {
          warnings: documentWarnings, route: '/llm/generate', field: 'documentText',
        }, request);
      }

      // Truncate to fit within model context windows
      let documentForLlm = sanitizedDocument;
      if (sanitizedDocument.length > MAX_DOCUMENT_TEXT_FOR_LLM) {
        documentForLlm = sanitizedDocument.slice(0, MAX_DOCUMENT_TEXT_FOR_LLM) +
          '\n\n[Document truncated — only the first ~80,000 characters were included due to context window limits.]';
        logger.info({ original: sanitizedDocument.length, truncated: MAX_DOCUMENT_TEXT_FOR_LLM }, 'Document text truncated for LLM context window');
      }

      // Use template-specific prompt or generate_from_document (via
      // resolveSystemPrompt for guardrails)
      const templateKey = template && template !== 'custom' ? `generate_${template}` : undefined;
      const promptKey = templateKey ?? 'generate_from_document';
      systemPrompt = await resolveSystemPrompt(userId, promptKey as SystemPromptKey);

      userContent = `## Source Document\n${documentForLlm}\n\n## Instructions\n${sanitized}`;
    } else {
      const templateKey = template && template !== 'custom' ? `generate_${template}` : undefined;
      const promptKey = templateKey ?? 'generate';
      systemPrompt = await resolveSystemPrompt(userId, promptKey as SystemPromptKey);
    }

    // Web search for reference material (Phase 3 — #564)
    const genWebSources: WebSource[] = [];
    if (body.searchWeb) {
      const sq = body.searchQuery || sanitized.slice(0, 200);
      const { sources: fetchedSources, injectionWarnings } = await fetchWebSources(sq, userId);
      genWebSources.push(...fetchedSources);
      // One aggregated event per request (#835) — covers every offending web
      // source so audit volume stays bounded. logAuditEvent never throws.
      if (injectionWarnings.length > 0) {
        await logAuditEvent(userId, 'PROMPT_INJECTION_DETECTED', 'llm', undefined, {
          warnings: injectionWarnings.flatMap((w) => w.warnings),
          route: '/llm/generate',
          field: 'webSearch',
          urls: injectionWarnings.map((w) => w.url),
        }, request);
        // Roll web-search detections into the per-call attestation flags so
        // llm_audit_log (Report 5) stays consistent with audit_log — same
        // idiom as the documentText accumulator above. Detections always imply
        // [FILTERED] rewrites, so `sanitized` flips too.
        promptInjectionDetected = true;
        wasSanitized = true;
      }
    }

    if (genWebSources.length > 0) {
      userContent += formatWebContext(genWebSources, {
        sourceLabel: 'Web Source',
        sectionHeader: 'Verified reference material from web search',
      });
    }

    // `url` marks these as links rather than knowledge-base pages; without it
    // the frontend routed them to `/pages/<url>` and showed "page not found"
    // (#1125). `pageId: 0` matches the shape /llm/ask already emits.
    const genExtras = genWebSources.length > 0 ? {
      sources: genWebSources.map((s) => ({
        pageId: 0, pageTitle: s.title, spaceKey: 'Web', confluenceId: s.url, url: s.url, score: 1,
      })),
    } : undefined;

    // Resolve the `chat` use-case up-front so the cache key includes the
    // resolved provider+model. Queue + per-provider breakers wrap streamChat().
    const { config: chatConfig, model: resolvedModel } = await resolveUsecase('chat');
    const generateTransport = await queryArticleTransport({ pages: [],
      operation: newAiOperation('generate', { kind: 'user', id: userId }) }, userId, chatConfig, 'chat');
    logger.debug(
      { userId, bodyModel: model, providerId: chatConfig.providerId, resolvedModel },
      'Resolved chat usecase assignment',
    );

    // #1154: gate and load before the cache lookup, so the key can include
    // the image and a refusal never costs a provider round-trip.
    let imagePart: ChatContentPart | undefined;
    let imageHash: string | undefined;
    if (imageHandle) {
      const resolved = await resolveImagePart(
        fastify, userId, imageHandle, chatConfig.providerId, resolvedModel,
      );
      imagePart = resolved.part;
      imageHash = resolved.hash;
    }

    let finalSystemPrompt = systemPrompt;
    let finalUserText = userContent;
    if (imagePart) {
      finalSystemPrompt += ' An image is attached to the user request as source material. Analyze the visual content, text, diagrams, and details in the attached image and use them to generate the requested content.';
      finalUserText = `[Attached Image]\n\n${userContent}`;
    }

    // Check LLM cache with stampede protection
    const cacheKey = buildLlmCacheKey(resolvedModel, finalSystemPrompt, finalUserText, chatConfig.providerId, { thinking: body.thinking, imageHash });
    const { cached, lockToken } = await checkCacheWithLock(llmCache, cacheKey);
    if (cached) {
      // Explicit empty provenance and provider revision must both revalidate.
      // Legacy absence is unknown, never evidence of independent input.
      let replayed: string;
      try {
        replayed = await replayDirectOutput(cached, {
          transport: chatConfig, transportContext: generateTransport, userId, usecase: 'chat', model: resolvedModel,
        });
      } catch (err) {
        const refusal = directRefusalResponse(err, 'chat');
        if (!refusal) throw err;
        return reply.code(refusal.statusCode).send(refusal.body);
      }
      sendCachedSSE(reply, replayed);
      return;
    }

    const generateMessages: ChatMessage[] = [
      { role: 'system', content: finalSystemPrompt },
      {
        role: 'user',
        content: imagePart
          ? [{ type: 'text', text: finalUserText }, imagePart]
          : finalUserText,
      },
    ];

    try {
      const postProcess = await buildOutputPostProcessor(genWebSources.map((s) => s.url));

      const generator = streamChat(chatConfig, resolvedModel, generateMessages, undefined, { thinking: body.thinking, transportContext: generateTransport });

      // The audit entry is written by streamSSE from the stream's REAL
      // outcome — `success` only when the provider finished with `[DONE]`,
      // `error` for a thrown stream, a truncated one or a client that went
      // away — exactly as Improve/Summarize/Quality/Diagram already do. An
      // unconditional `success` emit after the helper returned recorded a
      // completed generation for every failed stream.
      await streamSSE(request, reply, generator, genExtras, {
        llmCache, cacheKey, postProcess,
        cacheProvenance: generateTransport.kind === 'article' ? generateTransport.stage.provenance : undefined,
        audit: {
          userId, action: 'generate', model: resolvedModel, provider: chatConfig.providerId,
          inputTokens: estimateTokens(generateMessages.map(m => contentToText(m.content)).join('')),
          inputMessages: generateMessages.map(m => ({ role: m.role, contentLength: contentToText(m.content).length })),
          promptHash: fingerprintPrompt(generateMessages),
          retrievedChunkIds: [],
          promptInjectionDetected,
          sanitized: wasSanitized,
        },
      });
    } catch (err) {
      // Only a failure BEFORE the stream was dispatched reaches here —
      // streamSSE reports its own outcome and never throws after dispatch.
      emitLlmAudit({
        userId,
        action: 'generate',
        model: resolvedModel,
        provider: chatConfig.providerId,
        inputTokens: estimateTokens(generateMessages.map(m => contentToText(m.content)).join('')),
        outputTokens: 0,
        inputMessages: generateMessages.map(m => ({ role: m.role, contentLength: contentToText(m.content).length })),
        promptHash: fingerprintPrompt(generateMessages),
        retrievedChunkIds: [],
        durationMs: Date.now() - auditStart,
        status: 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
        promptInjectionDetected,
        sanitized: wasSanitized,
      });
      throw err;
    } finally {
      if (lockToken) await llmCache.releaseLock(cacheKey, lockToken);
    }
    } catch (err) {
      const refusal = reply.sent ? null : directRefusalResponse(err, 'chat');
      if (!refusal) throw err;
      return reply.code(refusal.statusCode).send(refusal.body);
    } finally {
      await slot.release();
    }
  });
}
