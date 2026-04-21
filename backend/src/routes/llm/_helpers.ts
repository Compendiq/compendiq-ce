import { FastifyReply } from 'fastify';
import { z } from 'zod';
import { query } from '../../core/db/postgres.js';
import { logger } from '../../core/utils/logger.js';
import { sanitizeLlmInput } from '../../core/utils/sanitize-llm-input.js';
import {
  getSystemPrompt, SystemPromptKey,
  LANGUAGE_PRESERVATION_INSTRUCTION,
} from '../../domains/llm/services/prompts.js';
import { LlmCache, type CachedLlmResponse } from '../../domains/llm/services/llm-cache.js';
import { getAiGuardrails, getAiOutputRules } from '../../core/services/ai-safety-service.js';
import { sanitizeLlmOutput, type OutputSanitizeResult } from '../../core/utils/sanitize-llm-output.js';
import { assembleSubPageContext, getMultiPagePromptSuffix } from '../../domains/confluence/services/subpage-context.js';
import { htmlToMarkdown } from '../../core/services/content-converter.js';
import {
  getUsecaseLlmAssignment,
  type UsecaseLlmAssignment,
} from '../../core/services/admin-settings-service.js';

export { sanitizeLlmInput };

export const IdParamSchema = z.object({ id: z.string().min(1) });
export const ImprovementsQuerySchema = z.object({ pageId: z.string().optional() });

// Rate limit configs for LLM endpoints (dynamic via admin settings, 60s cache)
import { getRateLimits } from '../../core/services/rate-limit-service.js';

export const LLM_STREAM_RATE_LIMIT = { config: { rateLimit: { max: async () => (await getRateLimits()).llmStream.max, timeWindow: '1 minute' } } };
export const EMBEDDING_RATE_LIMIT = { config: { rateLimit: { max: async () => (await getRateLimits()).llmEmbedding.max, timeWindow: '1 minute' } } };

// Maximum input size to prevent abuse (100KB)
export const MAX_INPUT_LENGTH = 100_000;

// Maximum PDF text length sent to LLM (~20K tokens, safe for most model context windows)
export const MAX_PDF_TEXT_FOR_LLM = 80_000;

/**
 * Resolve the `{provider, model}` pair for the `chat` use case, applying the
 * issue #217 semantics:
 *
 *   - If the admin has set a model override (`source.model === 'usecase'`), both
 *     the provider and the model come from the resolver — the caller's `bodyModel`
 *     is ignored.
 *   - Otherwise, the provider still comes from the resolver (which itself
 *     inherits the shared default when no usecase override is set), and the
 *     model is the caller's `bodyModel` — only falling back to the resolver's
 *     model (shared/env/default) when the caller passed nothing.
 *
 * Semantics for the two product questions (see docs/plans/issue-217-…):
 *   Q1 — override vs. default: override.
 *   Q2 — body model + usecase provider: free (body wins), unless the admin also
 *        pinned the model (then locked).
 *
 * The returned `assignment.source` is preserved as-is so callers can audit
 * which tier produced the result (useful for the audit hook and debugging).
 *
 * Follow-up (out of scope for #217): when `source.provider === 'usecase'` and
 * `source.model !== 'usecase'`, a caller-supplied Ollama-shaped model may be
 * sent to OpenAI (or vice versa). Today this fails at the provider with a 4xx
 * — same failure mode as a shared-provider flip. Tracked as a follow-up.
 */
export async function resolveChatAssignment(bodyModel: string): Promise<{
  provider: UsecaseLlmAssignment['provider'];
  model: string;
  /** True when the resolver produced the provider (admin override exists). */
  hasUsecaseOverride: boolean;
  /** Full resolver result, for audit/logging. */
  assignment: UsecaseLlmAssignment;
}> {
  const assignment = await getUsecaseLlmAssignment('chat');
  const model =
    assignment.source.model === 'usecase'
      ? assignment.model
      : (bodyModel || assignment.model);
  const hasUsecaseOverride =
    assignment.source.provider === 'usecase' ||
    assignment.source.model === 'usecase';
  return { provider: assignment.provider, model, hasUsecaseOverride, assignment };
}

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
      'SELECT title FROM pages WHERE confluence_id = $1',
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
  let prompt: string;
  if (custom && custom.trim()) {
    // Always append language preservation instruction to custom prompts
    prompt = `${custom} ${LANGUAGE_PRESERVATION_INSTRUCTION}`;
  } else {
    prompt = getSystemPrompt(key);
  }

  // Append admin-configured guardrails (cached with 60s TTL)
  const guardrails = await getAiGuardrails();
  if (guardrails.noFabricationEnabled && guardrails.noFabricationInstruction) {
    prompt += ` ${guardrails.noFabricationInstruction}`;
  }

  return prompt;
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
  reply.hijack();
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
    postProcess?: (content: string) => OutputSanitizeResult;
  },
): Promise<string> {
  const controller = new AbortController();

  // Abort the generator when the client disconnects
  const onClose = () => {
    controller.abort();
  };
  request.raw.on('close', onClose);

  reply.hijack();
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

    // Post-process before caching (critic fix #1 + #2 — clean content before cache)
    if (options?.postProcess && fullContent && !controller.signal.aborted) {
      const result = options.postProcess(fullContent);
      if (result.wasModified) {
        fullContent = result.content;
        // Send final cleaned content so frontend can replace accumulated text
        reply.raw.write(`data: ${JSON.stringify({
          content: '', done: true,
          finalContent: result.content,
          referencesStripped: result.strippedSections,
        })}\n\n`);
      }
    }

    // Cache the (possibly cleaned) response
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

/**
 * Build an output post-processor using the current admin AI output rules.
 * Returns undefined if output processing is disabled, so callers can pass it
 * directly to `streamSSE` options.
 */
/**
 * Get admin-configured SearXNG max results (reads from admin_settings, defaults to 5).
 */
export async function getSearxngMaxResults(): Promise<number> {
  const result = await query<{ setting_value: string }>(
    `SELECT setting_value FROM admin_settings WHERE setting_key = 'searxng_max_results'`,
  );
  return parseInt(result.rows[0]?.setting_value ?? '5', 10);
}

export async function buildOutputPostProcessor(
  verifiedSources?: string[],
): Promise<((content: string) => OutputSanitizeResult) | undefined> {
  const rules = await getAiOutputRules();
  if (!rules.stripReferences || rules.referenceAction === 'off') return undefined;

  return (content: string) =>
    sanitizeLlmOutput(content, {
      ...rules,
      verifiedSources,
    });
}
