import { FastifyInstance, FastifyReply } from 'fastify';
import { query } from '../db/postgres.js';
import {
  getSystemPrompt, ChatMessage, SystemPromptKey,
  listModels, checkHealth,
  isLlmVerifySslEnabled, getLlmAuthType,
  getActiveProviderType, getProvider,
} from '../services/ollama-service.js';
import { providerStreamChat } from '../services/llm-provider.js';
import { hybridSearch, buildRagContext } from '../services/rag-service.js';
import { htmlToMarkdown, confluenceToHtml } from '../services/content-converter.js';
import { getEmbeddingStatus, processDirtyPages, reEmbedAll, isProcessingUser, embedPage } from '../services/embedding-service.js';
import { getClientForUser } from '../services/sync-service.js';
import { getOllamaCircuitBreakerStatus, getOpenaiCircuitBreakerStatus } from '../services/circuit-breaker.js';
import { LlmCache, buildLlmCacheKey, buildRagCacheKey } from '../services/llm-cache.js';
import {
  ImproveRequestSchema,
  GenerateRequestSchema,
  SummarizeRequestSchema,
  AskRequestSchema,
  GenerateDiagramRequestSchema,
  AnalyzeQualityRequestSchema,
  ForceEmbedTreeRequestSchema,
} from '@kb-creator/contracts';
import { z } from 'zod';
import { sanitizeLlmInput } from '../utils/sanitize-llm-input.js';
import { logAuditEvent } from '../services/audit-service.js';
import { logger } from '../utils/logger.js';
import type { LlmProviderType } from '../services/llm-provider.js';
import { assembleSubPageContext, getMultiPagePromptSuffix } from '../services/subpage-context.js';

const IdParamSchema = z.object({ id: z.string().min(1) });
const ImprovementsQuerySchema = z.object({ pageId: z.string().optional() });

/**
 * Assemble page context for LLM consumption, optionally including sub-pages.
 *
 * When `includeSubPages` is true and a `pageId` is provided, fetches the parent
 * page title and assembles it with its sub-page tree. Otherwise, converts the
 * HTML content directly to markdown.
 *
 * Returns the markdown content and an optional multi-page prompt suffix.
 */
async function assembleContextIfNeeded(
  userId: string,
  pageId: string | undefined,
  content: string,
  includeSubPages?: boolean,
): Promise<{ markdown: string; multiPageSuffix: string }> {
  if (includeSubPages && pageId) {
    const pageResult = await query<{ title: string }>(
      'SELECT title FROM cached_pages WHERE user_id = $1 AND confluence_id = $2',
      [userId, pageId],
    );
    const parentTitle = pageResult.rows[0]?.title ?? 'Untitled';

    const assembled = await assembleSubPageContext(userId, pageId, content, parentTitle);
    return {
      markdown: assembled.markdown,
      multiPageSuffix: getMultiPagePromptSuffix(assembled.pageCount),
    };
  }

  return {
    markdown: htmlToMarkdown(content),
    multiPageSuffix: '',
  };
}

// Rate limit configs for LLM endpoints
const LLM_STREAM_RATE_LIMIT = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
const EMBEDDING_RATE_LIMIT = { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } };

/**
 * Helper to stream SSE response from an async generator with abort support.
 * Creates an AbortController and aborts on client disconnect.
 */
async function streamSSE(
  request: { raw: import('http').IncomingMessage },
  reply: FastifyReply,
  generator: AsyncGenerator<{ content: string; done: boolean }>,
  extras?: Record<string, unknown>,
  options?: {
    llmCache?: LlmCache;
    cacheKey?: string;
  },
): Promise<void> {
  const controller = new AbortController();

  // Abort the generator when the client disconnects
  const onClose = () => {
    controller.abort();
  };
  request.raw.on('close', onClose);

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let fullContent = '';

  try {
    for await (const chunk of generator) {
      if (controller.signal.aborted) {
        logger.debug('SSE stream aborted by client disconnect');
        break;
      }
      fullContent += chunk.content;
      reply.raw.write(`data: ${JSON.stringify({ content: chunk.content, done: chunk.done })}\n\n`);
    }

    // Cache the full response if caching is configured
    if (options?.llmCache && options?.cacheKey && fullContent && !controller.signal.aborted) {
      await options.llmCache.setCachedResponse(options.cacheKey, fullContent);
    }

    if (extras && !controller.signal.aborted) {
      reply.raw.write(`data: ${JSON.stringify({ ...extras, done: true, final: true })}\n\n`);
    }
  } catch (err) {
    if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      logger.debug('SSE stream aborted by client disconnect');
    } else {
      logger.error({ err }, 'SSE stream error');
      reply.raw.write(`data: ${JSON.stringify({ error: 'Stream error', done: true })}\n\n`);
    }
  } finally {
    request.raw.removeListener('close', onClose);
    reply.raw.end();
  }
}

export async function llmRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // Create LLM cache instance
  const llmCache = new LlmCache(fastify.redis);

  // GET /api/ollama/models - list available models (supports ?provider=ollama|openai)
  fastify.get('/ollama/models', async (request) => {
    const { provider: providerParam } = z.object({ provider: z.enum(['ollama', 'openai']).optional() }).parse(request.query);
    const providerType: LlmProviderType = providerParam ?? getActiveProviderType();
    const provider = getProvider(providerType);

    try {
      return await provider.listModels();
    } catch (err) {
      logger.warn({ err, provider: providerType }, 'Failed to list models — returning empty list');
      // Return empty list instead of 503 so the UI stays functional
      // and the circuit breaker isn't tripped by repeated polling
      return [];
    }
  });

  // GET /api/ollama/status - (supports ?provider=ollama|openai)
  fastify.get('/ollama/status', async (request) => {
    const { provider: providerParam } = z.object({ provider: z.enum(['ollama', 'openai']).optional() }).parse(request.query);
    const providerType: LlmProviderType = providerParam ?? getActiveProviderType();
    const provider = getProvider(providerType);

    const health = await provider.checkHealth();
    return {
      connected: health.connected,
      error: health.error,
      provider: providerType,
      ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
      openaiBaseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      embeddingModel: process.env.EMBEDDING_MODEL ?? 'nomic-embed-text',
      authConfigured: providerType === 'ollama'
        ? !!process.env.LLM_BEARER_TOKEN
        : !!(process.env.LLM_BEARER_TOKEN || process.env.OPENAI_API_KEY),
      authType: getLlmAuthType(),
      verifySsl: isLlmVerifySslEnabled(),
    };
  });

  // GET /api/ollama/circuit-breaker-status
  fastify.get('/ollama/circuit-breaker-status', async () => {
    return {
      ollama: getOllamaCircuitBreakerStatus(),
      openai: getOpenaiCircuitBreakerStatus(),
    };
  });

  // Maximum input size to prevent abuse (100KB)
  const MAX_INPUT_LENGTH = 100_000;

  // POST /api/llm/improve - stream improved content
  fastify.post('/llm/improve', LLM_STREAM_RATE_LIMIT, async (request, reply) => {
    const body = ImproveRequestSchema.parse(request.body);
    const { content, type, model, includeSubPages } = body;
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

    const systemPrompt = getSystemPrompt(`improve_${type}` as SystemPromptKey) + multiPageSuffix;

    // Check LLM cache
    const cacheKey = buildLlmCacheKey(model, systemPrompt, sanitized);
    const cached = await llmCache.getCachedResponse(cacheKey);
    if (cached) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.write(`data: ${JSON.stringify({ content: cached.content, done: true, cached: true })}\n\n`);
      reply.raw.end();
      return;
    }

    // Resolve per-user LLM provider and stream
    const generator = providerStreamChat(userId, model, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: sanitized },
    ]);

    // Store improvement record
    if (body.pageId) {
      await query(
        `INSERT INTO llm_improvements (user_id, confluence_id, improvement_type, model, original_content, improved_content, status)
         VALUES ($1, $2, $3, $4, $5, '', 'streaming')`,
        [userId, body.pageId, type, model, content.slice(0, 10000)],
      );
    }

    await streamSSE(request, reply, generator, undefined, { llmCache, cacheKey });
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

    // Check LLM cache
    const cacheKey = buildLlmCacheKey(model, systemPrompt, sanitized);
    const cached = await llmCache.getCachedResponse(cacheKey);
    if (cached) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.write(`data: ${JSON.stringify({ content: cached.content, done: true, cached: true })}\n\n`);
      reply.raw.end();
      return;
    }

    // Resolve per-user LLM provider and stream
    const generator = providerStreamChat(userId, model, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: sanitized },
    ]);

    await streamSSE(request, reply, generator, undefined, { llmCache, cacheKey });
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

    // Check LLM cache
    const cacheKey = buildLlmCacheKey(model, systemPrompt, sanitizedMarkdown);
    const cached = await llmCache.getCachedResponse(cacheKey);
    if (cached) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.write(`data: ${JSON.stringify({ content: cached.content, done: true, cached: true })}\n\n`);
      reply.raw.end();
      return;
    }

    // Resolve per-user LLM provider and stream
    const generator = providerStreamChat(userId, model, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: sanitizedMarkdown },
    ]);

    await streamSSE(request, reply, generator, undefined, { llmCache, cacheKey });
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

    // Check LLM cache
    const cacheKey = buildLlmCacheKey(model, systemPrompt, sanitized);
    const cached = await llmCache.getCachedResponse(cacheKey);
    if (cached) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.write(`data: ${JSON.stringify({ content: cached.content, done: true, cached: true })}\n\n`);
      reply.raw.end();
      return;
    }

    const generator = providerStreamChat(request.userId, model, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: sanitized },
    ]);

    await streamSSE(request, reply, generator, undefined, { llmCache, cacheKey });
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

    // Check LLM cache
    const cacheKey = buildLlmCacheKey(model, systemPrompt, sanitized);
    const cached = await llmCache.getCachedResponse(cacheKey);
    if (cached) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.write(`data: ${JSON.stringify({ content: cached.content, done: true, cached: true })}\n\n`);
      reply.raw.end();
      return;
    }

    // Resolve per-user LLM provider and stream
    const generator = providerStreamChat(userId, model, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: sanitized },
    ]);

    await streamSSE(request, reply, generator, undefined, { llmCache, cacheKey });
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
        'SELECT title, body_html FROM cached_pages WHERE user_id = $1 AND confluence_id = $2',
        [userId, body.pageId],
      );
      if (pageResult.rows.length > 0) {
        const { title, body_html } = pageResult.rows[0];
        const assembled = await assembleSubPageContext(userId, body.pageId, body_html || '', title);
        // Prepend the page tree context before the RAG context
        ragContext = `Page tree context:\n\n${assembled.markdown}\n\n---\n\nAdditional knowledge base context:\n\n${ragContext}`;
        multiPageSuffix = getMultiPagePromptSuffix(assembled.pageCount);
      }
    }

    // Check RAG cache (only for new conversations without history)
    const docIds = searchResults.map((r) => r.confluenceId);
    const ragCacheKey = buildRagCacheKey(model, question, docIds, {
      includeSubPages,
      pageId: body.pageId,
    });

    if (conversationHistory.length === 0) {
      const cached = await llmCache.getCachedResponse(ragCacheKey);
      if (cached) {
        // Save/create conversation even for cached responses
        const newMessages: ChatMessage[] = [
          { role: 'user', content: question },
          { role: 'assistant', content: cached.content },
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

        const sources = searchResults.map((r) => ({
          pageTitle: r.pageTitle,
          spaceKey: r.spaceKey,
          confluenceId: r.confluenceId,
          sectionTitle: r.sectionTitle,
        }));

        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        reply.raw.write(`data: ${JSON.stringify({ content: cached.content, done: true, cached: true })}\n\n`);
        reply.raw.write(`data: ${JSON.stringify({
          done: true,
          final: true,
          conversationId: convId,
          sources,
        })}\n\n`);
        reply.raw.end();
        return;
      }
    }

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

        // Save/update conversation
        const newMessages: ChatMessage[] = [
          ...conversationHistory,
          { role: 'user', content: question },
          { role: 'assistant', content: fullAnswer },
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

        // Send final event with metadata
        const sources = searchResults.map((r) => ({
          pageTitle: r.pageTitle,
          spaceKey: r.spaceKey,
          confluenceId: r.confluenceId,
          sectionTitle: r.sectionTitle,
        }));

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
  });

  // GET /api/llm/conversations - list conversations
  fastify.get('/llm/conversations', async (request) => {
    const result = await query<{
      id: string;
      model: string;
      title: string;
      created_at: Date;
      updated_at: Date;
    }>(
      'SELECT id, model, title, created_at, updated_at FROM llm_conversations WHERE user_id = $1 ORDER BY updated_at DESC',
      [request.userId],
    );
    return result.rows.map((r) => ({
      id: r.id,
      model: r.model,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  });

  // GET /api/llm/conversations/:id
  fastify.get('/llm/conversations/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const result = await query<{
      id: string;
      model: string;
      title: string;
      messages: ChatMessage[];
      created_at: Date;
    }>(
      'SELECT id, model, title, messages, created_at FROM llm_conversations WHERE id = $1 AND user_id = $2',
      [id, request.userId],
    );

    if (result.rows.length === 0) {
      throw fastify.httpErrors.notFound('Conversation not found');
    }

    const row = result.rows[0];
    return {
      id: row.id,
      model: row.model,
      title: row.title,
      messages: row.messages,
      createdAt: row.created_at,
    };
  });

  // DELETE /api/llm/conversations/:id
  fastify.delete('/llm/conversations/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    await query('DELETE FROM llm_conversations WHERE id = $1 AND user_id = $2', [id, request.userId]);
    return { message: 'Conversation deleted' };
  });

  // GET /api/llm/improvements - improvement history for a page
  fastify.get('/llm/improvements', async (request) => {
    const { pageId } = ImprovementsQuerySchema.parse(request.query);
    const userId = request.userId;

    let sql = 'SELECT id, confluence_id, improvement_type, model, status, created_at FROM llm_improvements WHERE user_id = $1';
    const values: unknown[] = [userId];

    if (pageId) {
      sql += ' AND confluence_id = $2';
      values.push(pageId);
    }

    sql += ' ORDER BY created_at DESC LIMIT 50';

    const result = await query<{
      id: string;
      confluence_id: string;
      improvement_type: string;
      model: string;
      status: string;
      created_at: Date;
    }>(sql, values);

    return result.rows.map((r) => ({
      id: r.id,
      confluenceId: r.confluence_id,
      type: r.improvement_type,
      model: r.model,
      status: r.status,
      createdAt: r.created_at,
    }));
  });

  // GET /api/embeddings/status
  fastify.get('/embeddings/status', async (request) => {
    return getEmbeddingStatus(request.userId);
  });

  // POST /api/embeddings/process - trigger embedding processing
  fastify.post('/embeddings/process', EMBEDDING_RATE_LIMIT, async (request, _reply) => {
    const userId = request.userId;

    // Return 409 if embedding is already in progress for this user
    if (isProcessingUser(userId)) {
      throw fastify.httpErrors.conflict('Embedding processing is already in progress for this user');
    }

    // Run in background
    processDirtyPages(userId).catch((err) => {
      logger.error({ err, userId }, 'Embedding processing failed');
    });

    return { message: 'Embedding processing started' };
  });

  // POST /api/embeddings/force-embed-tree - force-embed a page and all its sub-pages via SSE
  fastify.post('/embeddings/force-embed-tree', EMBEDDING_RATE_LIMIT, async (request, reply) => {
    const { pageId } = ForceEmbedTreeRequestSchema.parse(request.body);
    const userId = request.userId;

    const client = await getClientForUser(userId);
    if (!client) {
      throw fastify.httpErrors.badRequest('Confluence credentials not configured');
    }

    // Set up SSE response
    const controller = new AbortController();
    const onClose = () => controller.abort();
    request.raw.on('close', onClose);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    try {
      // Phase 1: Discover all pages in the tree
      reply.raw.write(`data: ${JSON.stringify({ phase: 'discovering', total: 0, completed: 0, done: false })}\n\n`);

      const rootPage = await client.getPage(pageId);
      const descendants = await client.getDescendantPages(pageId);
      const allPages = [rootPage, ...descendants];
      const total = allPages.length;

      reply.raw.write(`data: ${JSON.stringify({ phase: 'embedding', total, completed: 0, done: false })}\n\n`);

      // Phase 2: Embed each page, reporting progress
      let completed = 0;
      let errors = 0;

      for (const page of allPages) {
        if (controller.signal.aborted) break;

        try {
          // Fetch full page content if not already expanded
          const fullPage = page.body?.storage?.value ? page : await client.getPage(page.id);
          const storageXhtml = fullPage.body?.storage?.value ?? '';

          if (storageXhtml) {
            const bodyHtml = confluenceToHtml(storageXhtml, page.id);

            // Try to get space_key and cached HTML from local DB first
            const cachedRow = await query<{ space_key: string; body_html: string }>(
              'SELECT space_key, body_html FROM cached_pages WHERE user_id = $1 AND confluence_id = $2',
              [userId, page.id],
            );

            const resolvedSpaceKey = cachedRow.rows[0]?.space_key ?? '';
            const resolvedBodyHtml = cachedRow.rows[0]?.body_html ?? bodyHtml;

            await embedPage(userId, page.id, page.title, resolvedSpaceKey, resolvedBodyHtml);
          }

          completed++;
        } catch (err) {
          errors++;
          completed++;
          logger.error({ err, pageId: page.id, title: page.title }, 'Failed to embed page in tree');
        }

        reply.raw.write(`data: ${JSON.stringify({
          phase: 'embedding',
          total,
          completed,
          errors,
          currentPage: page.title,
          done: false,
        })}\n\n`);
      }

      // Final event
      if (!controller.signal.aborted) {
        reply.raw.write(`data: ${JSON.stringify({
          phase: 'complete',
          total,
          completed,
          errors,
          done: true,
        })}\n\n`);
      }
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        logger.debug('Force embed tree SSE aborted by client disconnect');
      } else {
        logger.error({ err, pageId }, 'Force embed tree failed');
        reply.raw.write(`data: ${JSON.stringify({ error: 'Failed to embed page tree', done: true })}\n\n`);
      }
    } finally {
      request.raw.removeListener('close', onClose);
      reply.raw.end();
    }
  });

  // POST /api/admin/re-embed - admin only: re-embed all pages
  fastify.post('/admin/re-embed', {
    preHandler: fastify.requireAdmin,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (_request, _reply) => {
    reEmbedAll().catch((err) => {
      logger.error({ err }, 'Re-embed all failed');
    });

    return { message: 'Re-embedding started for all users' };
  });

  // POST /api/admin/clear-llm-cache - admin only: clear all LLM response cache
  fastify.post('/admin/clear-llm-cache', {
    preHandler: fastify.requireAdmin,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async () => {
    const deleted = await llmCache.clearAll();
    return { message: `LLM cache cleared`, entriesDeleted: deleted };
  });
}
