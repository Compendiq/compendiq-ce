import { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import {
  getSystemPrompt, ChatMessage, SystemPromptKey,
} from '../../domains/llm/services/ollama-service.js';
import { providerStreamChat } from '../../domains/llm/services/llm-provider.js';
import { hybridSearch, buildRagContext } from '../../domains/llm/services/rag-service.js';
import { htmlToMarkdown } from '../../core/services/content-converter.js';
import { LlmCache, buildLlmCacheKey, buildRagCacheKey } from '../../domains/llm/services/llm-cache.js';
import {
  ImproveRequestSchema,
  GenerateRequestSchema,
  SummarizeRequestSchema,
  AskRequestSchema,
  GenerateDiagramRequestSchema,
  AnalyzeQualityRequestSchema,
} from '@kb-creator/contracts';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { logger } from '../../core/utils/logger.js';
import { assembleSubPageContext, getMultiPagePromptSuffix } from '../../domains/confluence/services/subpage-context.js';
import {
  assembleContextIfNeeded,
  resolveSystemPrompt,
  checkCacheWithLock,
  sendCachedSSE,
  streamSSE,
  sanitizeLlmInput,
  LLM_STREAM_RATE_LIMIT,
  MAX_INPUT_LENGTH,
} from './_helpers.js';

export async function llmChatRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // Create LLM cache instance
  const llmCache = new LlmCache(fastify.redis);

  // POST /api/llm/improve - stream improved content
  fastify.post('/llm/improve', LLM_STREAM_RATE_LIMIT, async (request, reply) => {
    const body = ImproveRequestSchema.parse(request.body);
    const { content, type, model, includeSubPages, instruction } = body;
    const userId = request.userId;

    if (content.length > MAX_INPUT_LENGTH) {
      throw fastify.httpErrors.badRequest(`Content too large (max ${MAX_INPUT_LENGTH} characters)`);
    }

    const { markdown, multiPageSuffix } = await assembleContextIfNeeded(userId, body.pageId, content, includeSubPages);

    // Sanitize before sending to LLM
    const { sanitized, warnings } = sanitizeLlmInput(markdown);
    if (warnings.length > 0) {
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

    let systemPrompt = await resolveSystemPrompt(userId, `improve_${type}` as SystemPromptKey) + multiPageSuffix;
    if (sanitizedInstruction) {
      systemPrompt += `\n\nADDITIONAL USER INSTRUCTIONS:\n${sanitizedInstruction}`;
    }

    // Check LLM cache with stampede protection
    const cacheKey = buildLlmCacheKey(model, systemPrompt, sanitized);
    const { cached, lockAcquired } = await checkCacheWithLock(llmCache, cacheKey);
    if (cached) {
      sendCachedSSE(reply, cached.content);
      return;
    }

    // Pre-insert improvement record so we have the row to update after streaming
    let improvementId: string | undefined;
    if (body.pageId) {
      const insertResult = await query<{ id: string }>(
        `INSERT INTO llm_improvements (user_id, confluence_id, improvement_type, model, original_content, improved_content, status)
         VALUES ($1, $2, $3, $4, $5, '', 'streaming') RETURNING id`,
        [userId, body.pageId, type, model, content.slice(0, 10000)],
      );
      improvementId = insertResult.rows[0]?.id;
    }

    try {
      // Resolve per-user LLM provider and stream
      const generator = providerStreamChat(userId, model, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: sanitized },
      ]);

      const accumulated = await streamSSE(request, reply, generator, undefined, { llmCache, cacheKey });

      // Persist the full improved content now that streaming is done
      if (improvementId && accumulated) {
        await query(
          `UPDATE llm_improvements SET improved_content = $1, status = 'completed' WHERE id = $2`,
          [accumulated.slice(0, 50000), improvementId],
        );
      }
    } finally {
      if (lockAcquired) await llmCache.releaseLock(cacheKey);
    }
  });

  // POST /api/llm/generate - stream generated article
  fastify.post('/llm/generate', LLM_STREAM_RATE_LIMIT, async (request, reply) => {
    const body = GenerateRequestSchema.parse(request.body);
    const { prompt, model, template } = body;
    const userId = request.userId;

    if (prompt.length > MAX_INPUT_LENGTH) {
      throw fastify.httpErrors.badRequest(`Prompt too large (max ${MAX_INPUT_LENGTH} characters)`);
    }

    // Sanitize before sending to LLM
    const { sanitized, warnings } = sanitizeLlmInput(prompt);
    if (warnings.length > 0) {
      await logAuditEvent(userId, 'PROMPT_INJECTION_DETECTED', 'llm', undefined, { warnings, route: '/llm/generate' }, request);
    }

    const systemPrompt = template
      ? getSystemPrompt(`generate_${template}` as SystemPromptKey)
      : getSystemPrompt('generate');

    // Check LLM cache with stampede protection
    const cacheKey = buildLlmCacheKey(model, systemPrompt, sanitized);
    const { cached, lockAcquired } = await checkCacheWithLock(llmCache, cacheKey);
    if (cached) {
      sendCachedSSE(reply, cached.content);
      return;
    }

    try {
      // Resolve per-user LLM provider and stream
      const generator = providerStreamChat(userId, model, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: sanitized },
      ]);

      await streamSSE(request, reply, generator, undefined, { llmCache, cacheKey });
    } finally {
      if (lockAcquired) await llmCache.releaseLock(cacheKey);
    }
  });

  // POST /api/llm/summarize - stream summary
  fastify.post('/llm/summarize', LLM_STREAM_RATE_LIMIT, async (request, reply) => {
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

    const systemPrompt = `${getSystemPrompt('summarize')} ${lengthInstructions[length]}${multiPageSuffix}`;

    // Check LLM cache with stampede protection
    const cacheKey = buildLlmCacheKey(model, systemPrompt, sanitizedMarkdown);
    const { cached, lockAcquired } = await checkCacheWithLock(llmCache, cacheKey);
    if (cached) {
      sendCachedSSE(reply, cached.content);
      return;
    }

    try {
      // Resolve per-user LLM provider and stream
      const generator = providerStreamChat(userId, model, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: sanitizedMarkdown },
      ]);

      await streamSSE(request, reply, generator, undefined, { llmCache, cacheKey });
    } finally {
      if (lockAcquired) await llmCache.releaseLock(cacheKey);
    }
  });

  // POST /api/llm/generate-diagram - stream Mermaid diagram from article content
  fastify.post('/llm/generate-diagram', LLM_STREAM_RATE_LIMIT, async (request, reply) => {
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

    // Check LLM cache with stampede protection
    const cacheKey = buildLlmCacheKey(model, systemPrompt, sanitized);
    const { cached, lockAcquired } = await checkCacheWithLock(llmCache, cacheKey);
    if (cached) {
      sendCachedSSE(reply, cached.content);
      return;
    }

    try {
      const generator = providerStreamChat(request.userId, model, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: sanitized },
      ]);

      await streamSSE(request, reply, generator, undefined, { llmCache, cacheKey });
    } finally {
      if (lockAcquired) await llmCache.releaseLock(cacheKey);
    }
  });

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
      // Resolve per-user LLM provider and stream
      const generator = providerStreamChat(userId, model, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: sanitized },
      ]);

      await streamSSE(request, reply, generator, undefined, { llmCache, cacheKey });
    } finally {
      if (lockAcquired) await llmCache.releaseLock(cacheKey);
    }
  });

  // POST /api/llm/ask - RAG-powered Q&A with streaming
  fastify.post('/llm/ask', LLM_STREAM_RATE_LIMIT, async (request, reply) => {
    const body = AskRequestSchema.parse(request.body);
    const { question, model, conversationId, includeSubPages } = body;
    const userId = request.userId;

    if (question.length > MAX_INPUT_LENGTH) {
      throw fastify.httpErrors.badRequest(`Question too large (max ${MAX_INPUT_LENGTH} characters)`);
    }

    // Sanitize question before sending to LLM
    const { sanitized: sanitizedQuestion, warnings } = sanitizeLlmInput(question);
    if (warnings.length > 0) {
      await logAuditEvent(request.userId, 'PROMPT_INJECTION_DETECTED', 'llm', undefined, { warnings, route: '/llm/ask' }, request);
    }

    // Load conversation history if continuing
    let conversationHistory: ChatMessage[] = [];
    let convId = conversationId;

    if (convId) {
      const conv = await query<{ messages: ChatMessage[] }>(
        'SELECT messages FROM llm_conversations WHERE id = $1 AND user_id = $2',
        [convId, userId],
      );
      if (conv.rows.length > 0) {
        conversationHistory = conv.rows[0].messages;
      }
    }

    // Perform hybrid RAG search
    const searchResults = await hybridSearch(userId, question);
    let ragContext = buildRagContext(searchResults);

    // If includeSubPages is enabled and a pageId is provided, augment the RAG context
    // with the sub-page tree content
    let multiPageSuffix = '';
    if (includeSubPages && body.pageId) {
      const pageResult = await query<{ title: string; body_html: string }>(
        'SELECT title, body_html FROM cached_pages WHERE confluence_id = $1',
        [body.pageId],
      );
      if (pageResult.rows.length > 0) {
        const { title, body_html } = pageResult.rows[0];
        const assembled = await assembleSubPageContext(userId, body.pageId, body_html || '', title);
        // Prepend the page tree context before the RAG context
        ragContext = `Page tree context:\n\n${assembled.markdown}\n\n---\n\nAdditional knowledge base context:\n\n${ragContext}`;
        multiPageSuffix = getMultiPagePromptSuffix(assembled.pageCount);
      }
    }

    // Check RAG cache with stampede protection (only for new conversations without history)
    const docIds = searchResults.map((r) => r.confluenceId);
    const ragCacheKey = buildRagCacheKey(model, question, docIds, {
      includeSubPages,
      pageId: body.pageId,
    });

    const sources = searchResults.map((r) => ({
      pageTitle: r.pageTitle,
      spaceKey: r.spaceKey,
      confluenceId: r.confluenceId,
      sectionTitle: r.sectionTitle,
      score: r.score,
    }));

    // Helper to save/create conversation from a cached answer
    const saveConversation = async (answer: string) => {
      const newMessages: ChatMessage[] = [
        ...conversationHistory,
        { role: 'user', content: question },
        { role: 'assistant', content: answer },
      ];

      if (convId) {
        await query(
          'UPDATE llm_conversations SET messages = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2',
          [convId, userId, JSON.stringify(newMessages)],
        );
      } else {
        const insertResult = await query<{ id: string }>(
          `INSERT INTO llm_conversations (user_id, model, title, messages)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [userId, model, question.slice(0, 100), JSON.stringify(newMessages)],
        );
        convId = insertResult.rows[0].id;
      }
    };

    let ragLockAcquired = false;
    if (conversationHistory.length === 0) {
      const { cached, lockAcquired } = await checkCacheWithLock(llmCache, ragCacheKey);
      ragLockAcquired = lockAcquired;

      if (cached) {
        await saveConversation(cached.content);

        sendCachedSSE(reply, cached.content, {
          conversationId: convId,
          sources,
        });
        return;
      }
    }

    try {
      // Build messages
      const messages: ChatMessage[] = [
        { role: 'system', content: getSystemPrompt('ask') + multiPageSuffix },
        ...conversationHistory,
        {
          role: 'user',
          content: `Context from knowledge base:\n\n${ragContext}\n\n---\n\nQuestion: ${sanitizedQuestion}`,
        },
      ];

      // Stream the response and collect full answer
      const controller = new AbortController();
      const onClose = () => controller.abort();
      request.raw.on('close', onClose);

      // Resolve per-user LLM provider and stream
      const generator = providerStreamChat(userId, model, messages, controller.signal);
      let fullAnswer = '';

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      try {
        for await (const chunk of generator) {
          if (controller.signal.aborted) {
            logger.debug('RAG SSE stream aborted by client disconnect');
            break;
          }
          fullAnswer += chunk.content;
          reply.raw.write(`data: ${JSON.stringify({ content: chunk.content, done: chunk.done })}\n\n`);
        }

        if (!controller.signal.aborted) {
          // Cache the response
          if (fullAnswer) {
            await llmCache.setCachedResponse(ragCacheKey, fullAnswer);
          }

          await saveConversation(fullAnswer);

          reply.raw.write(`data: ${JSON.stringify({
            done: true,
            final: true,
            conversationId: convId,
            sources,
          })}\n\n`);
        }
      } catch (err) {
        if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
          logger.debug('RAG stream aborted by client disconnect');
        } else {
          logger.error({ err }, 'RAG stream error');
          reply.raw.write(`data: ${JSON.stringify({ error: 'Stream error', done: true })}\n\n`);
        }
      } finally {
        request.raw.removeListener('close', onClose);
        reply.raw.end();
      }
    } finally {
      if (ragLockAcquired) await llmCache.releaseLock(ragCacheKey);
    }
  });
}
