import { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { ChatMessage } from '../../domains/llm/services/ollama-service.js';
import { providerStreamChat } from '../../domains/llm/services/llm-provider.js';
import { hybridSearch, buildRagContext } from '../../domains/llm/services/rag-service.js';
import { LlmCache, buildRagCacheKey } from '../../domains/llm/services/llm-cache.js';
import { CircuitBreakerOpenError } from '../../core/services/circuit-breaker.js';
import { isEnabled as isMcpDocsEnabled, fetchDocumentation } from '../../core/services/mcp-docs-client.js';
import { fetchWebSources, formatWebContext, type WebSource } from './_web-search-helper.js';
import { AskRequestSchema } from '@compendiq/contracts';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { logger } from '../../core/utils/logger.js';
import { assembleSubPageContext, getMultiPagePromptSuffix } from '../../domains/confluence/services/subpage-context.js';
import {
  resolveSystemPrompt,
  checkCacheWithLock,
  sendCachedSSE,
  sanitizeLlmInput,
  LLM_STREAM_RATE_LIMIT,
  MAX_INPUT_LENGTH,
} from './_helpers.js';

export async function llmAskRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  const llmCache = new LlmCache(fastify.redis);

  // GET /api/mcp-docs/status - public (authenticated) check for MCP docs availability
  // Non-admin users need this to show/hide the external URL attachment button in AskMode.
  fastify.get('/mcp-docs/status', async () => {
    const enabled = await isMcpDocsEnabled();
    return { enabled };
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
