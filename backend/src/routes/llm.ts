import { FastifyInstance, FastifyReply } from 'fastify';
import { query } from '../db/postgres.js';
import {
  streamChat, getSystemPrompt, ChatMessage, SystemPromptKey,
  listModels, checkHealth,
} from '../services/ollama-service.js';
import { hybridSearch, buildRagContext } from '../services/rag-service.js';
import { htmlToMarkdown } from '../services/content-converter.js';
import { getEmbeddingStatus, processDirtyPages, reEmbedAll } from '../services/embedding-service.js';
import { getOllamaCircuitBreakerStatus } from '../services/circuit-breaker.js';
import { LlmCache, buildLlmCacheKey, buildRagCacheKey } from '../services/llm-cache.js';
import {
  ImproveRequestSchema,
  GenerateRequestSchema,
  SummarizeRequestSchema,
  AskRequestSchema,
} from '@kb-creator/contracts';
import { z } from 'zod';
import { sanitizeLlmInput } from '../utils/sanitize-llm-input.js';
import { logAuditEvent } from '../services/audit-service.js';
import { logger } from '../utils/logger.js';

const IdParamSchema = z.object({ id: z.string().min(1) });
const ImprovementsQuerySchema = z.object({ pageId: z.string().optional() });

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

  // GET /api/ollama/models - list available models
  fastify.get('/ollama/models', async () => {
    try {
      return await listModels();
    } catch (err) {
      logger.error({ err }, 'Failed to list models');
      throw fastify.httpErrors.serviceUnavailable('Ollama server unavailable');
    }
  });

  // GET /api/ollama/status
  fastify.get('/ollama/status', async () => {
    const health = await checkHealth();
    return {
      connected: health.connected,
      error: health.error,
      embeddingModel: process.env.EMBEDDING_MODEL ?? 'nomic-embed-text',
    };
  });

  // GET /api/ollama/circuit-breaker-status
  fastify.get('/ollama/circuit-breaker-status', async () => {
    return getOllamaCircuitBreakerStatus();
  });

  // Maximum input size to prevent abuse (100KB)
  const MAX_INPUT_LENGTH = 100_000;

  // POST /api/llm/improve - stream improved content
  fastify.post('/llm/improve', LLM_STREAM_RATE_LIMIT, async (request, reply) => {
    const body = ImproveRequestSchema.parse(request.body);
    const { content, type, model } = body;

    if (content.length > MAX_INPUT_LENGTH) {
      throw fastify.httpErrors.badRequest(`Content too large (max ${MAX_INPUT_LENGTH} characters)`);
    }

    // Convert HTML to markdown for LLM consumption
    const markdown = htmlToMarkdown(content);

    // Sanitize before sending to LLM
    const { sanitized, warnings } = sanitizeLlmInput(markdown);
    if (warnings.length > 0) {
      await logAuditEvent(request.userId, 'PROMPT_INJECTION_DETECTED', 'llm', undefined, { warnings, route: '/llm/improve' }, request);
    }

    const systemPrompt = getSystemPrompt(`improve_${type}` as SystemPromptKey);

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

    const generator = streamChat(model, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: sanitized },
    ]);

    // Store improvement record
    if (body.pageId) {
      await query(
        `INSERT INTO llm_improvements (user_id, confluence_id, improvement_type, model, original_content, improved_content, status)
         VALUES ($1, $2, $3, $4, $5, '', 'streaming')`,
        [request.userId, body.pageId, type, model, content.slice(0, 10000)],
      );
    }

    await streamSSE(request, reply, generator, undefined, { llmCache, cacheKey });
  });

  // POST /api/llm/generate - stream generated article
  fastify.post('/llm/generate', LLM_STREAM_RATE_LIMIT, async (request, reply) => {
    const body = GenerateRequestSchema.parse(request.body);
    const { prompt, model, template } = body;

    if (prompt.length > MAX_INPUT_LENGTH) {
      throw fastify.httpErrors.badRequest(`Prompt too large (max ${MAX_INPUT_LENGTH} characters)`);
    }

    // Sanitize before sending to LLM
    const { sanitized, warnings } = sanitizeLlmInput(prompt);
    if (warnings.length > 0) {
      await logAuditEvent(request.userId, 'PROMPT_INJECTION_DETECTED', 'llm', undefined, { warnings, route: '/llm/generate' }, request);
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

    const generator = streamChat(model, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: sanitized },
    ]);

    await streamSSE(request, reply, generator, undefined, { llmCache, cacheKey });
  });

  // POST /api/llm/summarize - stream summary
  fastify.post('/llm/summarize', LLM_STREAM_RATE_LIMIT, async (request, reply) => {
    const body = SummarizeRequestSchema.parse(request.body);
    const { content, model, length = 'medium' } = body;

    if (content.length > MAX_INPUT_LENGTH) {
      throw fastify.httpErrors.badRequest(`Content too large (max ${MAX_INPUT_LENGTH} characters)`);
    }

    const markdown = htmlToMarkdown(content);

    // Sanitize before sending to LLM
    const { sanitized: sanitizedMarkdown, warnings } = sanitizeLlmInput(markdown);
    if (warnings.length > 0) {
      await logAuditEvent(request.userId, 'PROMPT_INJECTION_DETECTED', 'llm', undefined, { warnings, route: '/llm/summarize' }, request);
    }

    const lengthInstructions: Record<string, string> = {
      short: 'Provide a brief 2-3 sentence summary.',
      medium: 'Provide a summary of 1-2 paragraphs covering the main points.',
      detailed: 'Provide a detailed summary covering all important points, decisions, and action items.',
    };

    const systemPrompt = `${getSystemPrompt('summarize')} ${lengthInstructions[length]}`;

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

    const generator = streamChat(model, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: sanitizedMarkdown },
    ]);

    await streamSSE(request, reply, generator, undefined, { llmCache, cacheKey });
  });

  // POST /api/llm/ask - RAG-powered Q&A with streaming
  fastify.post('/llm/ask', LLM_STREAM_RATE_LIMIT, async (request, reply) => {
    const body = AskRequestSchema.parse(request.body);
    const { question, model, conversationId } = body;
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
    const ragContext = buildRagContext(searchResults);

    // Check RAG cache (only for new conversations without history)
    const docIds = searchResults.map((r) => r.confluenceId);
    const ragCacheKey = buildRagCacheKey(model, question, docIds);

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
      { role: 'system', content: getSystemPrompt('ask') },
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

    const generator = streamChat(model, messages, controller.signal);
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

    // Run in background
    processDirtyPages(userId).catch((err) => {
      logger.error({ err, userId }, 'Embedding processing failed');
    });

    return { message: 'Embedding processing started' };
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
