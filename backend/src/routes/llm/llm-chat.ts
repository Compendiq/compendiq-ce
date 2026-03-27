import { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import {
  getSystemPrompt, ChatMessage, SystemPromptKey,
} from '../../domains/llm/services/ollama-service.js';
import { providerStreamChat } from '../../domains/llm/services/llm-provider.js';
import { hybridSearch, buildRagContext } from '../../domains/llm/services/rag-service.js';
import { htmlToMarkdown } from '../../core/services/content-converter.js';
import { LlmCache, buildLlmCacheKey, buildRagCacheKey } from '../../domains/llm/services/llm-cache.js';
import { CircuitBreakerOpenError } from '../../core/services/circuit-breaker.js';
import { isEnabled as isMcpDocsEnabled, fetchDocumentation } from '../../core/services/mcp-docs-client.js';
import { fetchWebSources, formatWebContext, type WebSource } from './_web-search-helper.js';
import {
  ImproveRequestSchema,
  GenerateRequestSchema,
  SummarizeRequestSchema,
  AskRequestSchema,
  GenerateDiagramRequestSchema,
  AnalyzeQualityRequestSchema,
} from '@atlasmind/contracts';
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
  buildOutputPostProcessor,
  LLM_STREAM_RATE_LIMIT,
  MAX_INPUT_LENGTH,
  MAX_PDF_TEXT_FOR_LLM,
} from './_helpers.js';

export async function llmChatRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // Create LLM cache instance
  const llmCache = new LlmCache(fastify.redis);

  // GET /api/mcp-docs/status - public (authenticated) check for MCP docs availability
  // Non-admin users need this to show/hide the external URL attachment button in AskMode.
  fastify.get('/mcp-docs/status', async () => {
    const enabled = await isMcpDocsEnabled();
    return { enabled };
  });

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

    // Check LLM cache with stampede protection
    const cacheKey = buildLlmCacheKey(model, systemPrompt, improveContent);
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

    try {
      const postProcess = await buildOutputPostProcessor(webSources.map((s) => s.url));

      // Resolve per-user LLM provider and stream
      const generator = providerStreamChat(userId, model, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: improveContent },
      ]);

      const accumulated = await streamSSE(request, reply, generator, improveExtras, { llmCache, cacheKey, postProcess });

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

    // Check LLM cache with stampede protection
    const cacheKey = buildLlmCacheKey(model, systemPrompt, userContent);
    const { cached, lockAcquired } = await checkCacheWithLock(llmCache, cacheKey);
    if (cached) {
      sendCachedSSE(reply, cached.content);
      return;
    }

    try {
      const postProcess = await buildOutputPostProcessor(genWebSources.map((s) => s.url));

      // Resolve per-user LLM provider and stream
      const generator = providerStreamChat(userId, model, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ]);

      await streamSSE(request, reply, generator, genExtras, { llmCache, cacheKey, postProcess });
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

      const generator = providerStreamChat(userId, model, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: summarizeContent },
      ]);

      await streamSSE(request, reply, generator, sumExtras, { llmCache, cacheKey, postProcess });
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
    const { question, model, conversationId, includeSubPages, externalUrls } = body;
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

    // Perform hybrid RAG search — falls back to keyword-only if embedding fails
    let searchResults;
    try {
      searchResults = await hybridSearch(userId, question);
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) {
        reply.code(503);
        return { error: 'LLM service temporarily unavailable', message: 'The AI service circuit breaker is open. Please try again later.' };
      }
      throw err;
    }
    let ragContext = buildRagContext(searchResults);

    // If includeSubPages is enabled and a pageId is provided, augment the RAG context
    // with the sub-page tree content
    let multiPageSuffix = '';
    if (includeSubPages && body.pageId) {
      const pageResult = await query<{ title: string; body_html: string }>(
        'SELECT title, body_html FROM pages WHERE confluence_id = $1',
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

    // Fetch external documentation URLs via MCP sidecar (if provided and enabled)
    const externalDocs: Array<{ url: string; title: string; markdown: string }> = [];
    if (externalUrls && externalUrls.length > 0 && await isMcpDocsEnabled()) {
      for (const extUrl of externalUrls) {
        try {
          const doc = await fetchDocumentation(extUrl, userId);
          // Sanitize fetched content before injecting into LLM prompt
          const { sanitized: sanitizedDoc } = sanitizeLlmInput(doc.markdown);
          externalDocs.push({ url: doc.url, title: doc.title, markdown: sanitizedDoc });
        } catch (err) {
          logger.warn({ err, url: extUrl }, 'Failed to fetch external doc via MCP');
        }
      }

      if (externalDocs.length > 0) {
        const externalContext = externalDocs.map((d, i) =>
          `[External Source ${i + 1}: "${d.title}" (${d.url})]\n${d.markdown}`
        ).join('\n\n---\n\n');
        ragContext += `\n\n---\n\nExternal documentation:\n\n${externalContext}`;
      }
    }

    // Web search for reference material (consistent with generate/improve)
    const askWebSources: WebSource[] = [];
    if (body.searchWeb) {
      const wq = body.searchQuery || sanitizedQuestion.slice(0, 200);
      askWebSources.push(...await fetchWebSources(wq, userId));
    }

    if (askWebSources.length > 0) {
      ragContext += formatWebContext(askWebSources, {
        sourceLabel: 'Web Source',
        sectionHeader: 'Web search results',
      });
    }

    // Check RAG cache with stampede protection (only for new conversations without history)
    const docIds = searchResults.map((r) => r.confluenceId);
    const ragCacheKey = buildRagCacheKey(model, question, docIds, {
      includeSubPages,
      pageId: body.pageId,
      externalUrls,
      searchWeb: body.searchWeb,
    });

    const sources = [
      ...searchResults.map((r) => ({
        pageId: r.pageId,
        pageTitle: r.pageTitle,
        spaceKey: r.spaceKey,
        confluenceId: r.confluenceId,
        sectionTitle: r.sectionTitle,
        score: r.score,
      })),
      ...externalDocs.map((d) => ({
        pageId: 0,
        pageTitle: d.title,
        spaceKey: 'External',
        confluenceId: d.url,
        sectionTitle: d.title,
        score: 1,
      })),
      ...askWebSources.map((s) => ({
        pageId: 0,
        pageTitle: s.title,
        spaceKey: 'Web',
        confluenceId: s.url,
        sectionTitle: s.title,
        score: 1,
      })),
    ];

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
      // Build messages (use resolveSystemPrompt so guardrails are appended)
      const askPrompt = await resolveSystemPrompt(userId, 'ask');
      const messages: ChatMessage[] = [
        { role: 'system', content: askPrompt + multiPageSuffix },
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

      reply.hijack();
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
