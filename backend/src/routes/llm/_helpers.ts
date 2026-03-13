import { FastifyReply } from 'fastify';
import { z } from 'zod';
import { query } from '../../core/db/postgres.js';
import { logger } from '../../core/utils/logger.js';
import { sanitizeLlmInput } from '../../core/utils/sanitize-llm-input.js';
import {
  getSystemPrompt, SystemPromptKey,
  LANGUAGE_PRESERVATION_INSTRUCTION,
} from '../../domains/llm/services/ollama-service.js';
import { LlmCache, type CachedLlmResponse } from '../../domains/llm/services/llm-cache.js';
import { assembleSubPageContext, getMultiPagePromptSuffix } from '../../domains/confluence/services/subpage-context.js';
import { htmlToMarkdown } from '../../core/services/content-converter.js';

export { sanitizeLlmInput };

export const IdParamSchema = z.object({ id: z.string().min(1) });
export const ImprovementsQuerySchema = z.object({ pageId: z.string().optional() });

// Rate limit configs for LLM endpoints
export const LLM_STREAM_RATE_LIMIT = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
export const EMBEDDING_RATE_LIMIT = { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } };

// Maximum input size to prevent abuse (100KB)
export const MAX_INPUT_LENGTH = 100_000;

// Maximum PDF text length sent to LLM (~20K tokens, safe for most model context windows)
export const MAX_PDF_TEXT_FOR_LLM = 80_000;

/**
 * Assemble page context for LLM consumption, optionally including sub-pages.
 *
 * When `includeSubPages` is true and a `pageId` is provided, fetches the parent
 * page title and assembles it with its sub-page tree. Otherwise, converts the
 * HTML content directly to markdown.
 *
 * Returns the markdown content and an optional multi-page prompt suffix.
 */
export async function assembleContextIfNeeded(
  userId: string,
  pageId: string | undefined,
  content: string,
  includeSubPages?: boolean,
): Promise<{ markdown: string; multiPageSuffix: string }> {
  if (includeSubPages && pageId) {
    const pageResult = await query<{ title: string }>(
      'SELECT title FROM cached_pages WHERE confluence_id = $1',
      [pageId],
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

/**
 * Fetch user's custom prompt for a given key, or fall back to the built-in default.
 */
export async function resolveSystemPrompt(userId: string, key: SystemPromptKey): Promise<string> {
  const result = await query<{ custom_prompts: Record<string, string> }>(
    'SELECT custom_prompts FROM user_settings WHERE user_id = $1',
    [userId],
  );
  const custom = result.rows[0]?.custom_prompts?.[key];
  if (custom && custom.trim()) {
    // Always append language preservation instruction to custom prompts
    return `${custom} ${LANGUAGE_PRESERVATION_INSTRUCTION}`;
  }
  return getSystemPrompt(key);
}

/**
 * Check the LLM cache with stampede protection.
 *
 * 1. Return cached response immediately if present.
 * 2. Try to acquire a Redis lock so only one request generates.
 * 3. If the lock is already held by another request, poll until the cached
 *    result appears (or timeout, in which case we return null so the caller
 *    can generate anyway).
 *
 * The caller MUST call `releaseLock()` in a finally block when `lockAcquired`
 * is true, after writing the generated result to the cache.
 */
export async function checkCacheWithLock(
  llmCache: LlmCache,
  cacheKey: string,
): Promise<{ cached: CachedLlmResponse | null; lockAcquired: boolean }> {
  // Fast path — already in cache
  const cached = await llmCache.getCachedResponse(cacheKey);
  if (cached) return { cached, lockAcquired: false };

  // Try to become the single generator for this key
  const lockAcquired = await llmCache.acquireLock(cacheKey);
  if (lockAcquired) {
    return { cached: null, lockAcquired: true };
  }

  // Another request holds the lock — wait for it to populate the cache
  const waited = await llmCache.waitForCachedResponse(cacheKey);
  return { cached: waited, lockAcquired: false };
}

/**
 * Send a cached SSE response as a single chunk and end the stream.
 */
export function sendCachedSSE(
  reply: FastifyReply,
  content: string,
  extras?: Record<string, unknown>,
): void {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.raw.write(`data: ${JSON.stringify({ content, done: true, cached: true })}\n\n`);
  if (extras) {
    reply.raw.write(`data: ${JSON.stringify({ ...extras, done: true, final: true })}\n\n`);
  }
  reply.raw.end();
}

/**
 * Helper to stream SSE response from an async generator with abort support.
 * Creates an AbortController and aborts on client disconnect.
 */
export async function streamSSE(
  request: { raw: import('http').IncomingMessage },
  reply: FastifyReply,
  generator: AsyncGenerator<{ content: string; done: boolean }>,
  extras?: Record<string, unknown>,
  options?: {
    llmCache?: LlmCache;
    cacheKey?: string;
  },
): Promise<string> {
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

  return fullContent;
}
