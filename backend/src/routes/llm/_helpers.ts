import { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { query } from '../../core/db/postgres.js';
import { visiblePagesPredicate } from '../../core/services/page-visibility.js';
import { getUserAccessibleSpacesMemoized } from '../../core/services/rbac-service.js';
import { logger } from '../../core/utils/logger.js';
import { sanitizeLlmInput } from '../../core/utils/sanitize-llm-input.js';
import {
  getSystemPrompt, SystemPromptKey,
  LANGUAGE_PRESERVATION_INSTRUCTION,
  type ChatContentPart,
} from '../../domains/llm/services/prompts.js';
import { LlmCache, type CachedLlmResponse } from '../../domains/llm/services/llm-cache.js';
import { getAiGuardrails, getAiOutputRules, SWISS_SPELLING_INSTRUCTION } from '../../core/services/ai-safety-service.js';
import { sanitizeLlmOutput, type OutputSanitizeResult } from '../../core/utils/sanitize-llm-output.js';
import { assembleSubPageContext, getMultiPagePromptSuffix, type IncludedPageRef, type SubPagePolicyContext } from '../../domains/confluence/services/subpage-context.js';
import { htmlToMarkdown, protectMedia } from '../../core/services/content-converter.js';
import { getVisionCapability } from '../../domains/llm/services/model-capabilities.js';
import {
  loadStagedImage,
  ImageStagingUnavailableError,
} from '../../core/services/image-staging.js';
import { emitLlmAudit, type LlmAuditEntry } from '../../domains/llm/services/llm-audit-hook.js';
import { StreamIncompleteError, type StreamChunk } from '../../domains/llm/services/openai-compatible-client.js';
import { admitArticleStage, ArticleStageRefusedError } from '../../domains/llm/services/article-stage-admission.js';
import {
  SEARXNG_CATEGORIES_DEFAULT,
  SEARXNG_MAX_RESULTS_DEFAULT,
  SEARXNG_MAX_RESULTS_MAX,
  SEARXNG_MAX_RESULTS_MIN,
  SearxngCategoriesSchema,
  type ConversationTurnAiProvenance,
  type SearxngSettings,
} from '@compendiq/contracts';

export { sanitizeLlmInput };

export const IdParamSchema = z.object({ id: z.string().min(1) });
export const ImprovementsQuerySchema = z.object({ pageId: z.string().optional() });

// Rate limit configs for LLM endpoints (dynamic via admin settings, 60s cache)
import { getRateLimits } from '../../core/services/rate-limit-service.js';

export const LLM_STREAM_RATE_LIMIT = { config: { rateLimit: { max: async () => (await getRateLimits()).llmStream.max, timeWindow: '1 minute' } } };
export const EMBEDDING_RATE_LIMIT = { config: { rateLimit: { max: async () => (await getRateLimits()).llmEmbedding.max, timeWindow: '1 minute' } } };

// Maximum input size to prevent abuse (100KB)
export const MAX_INPUT_LENGTH = 100_000;

/**
 * Ceiling on any single uploaded-document body folded into a prompt (~20K
 * tokens, safe for most model context windows). Applies to Generate's
 * `documentText` and Improve's `referenceText` alike — both are "a document the
 * user attached", and neither may crowd out the page being worked on.
 */
export const MAX_DOCUMENT_TEXT_FOR_LLM = 80_000;

/**
 * Assemble page context for LLM consumption, optionally including sub-pages.
 *
 * When `includeSubPages` is true and a `pageId` is provided, fetches the parent
 * page title and assembles it with its sub-page tree. Otherwise, converts the
 * HTML content directly to markdown.
 *
 * Returns the markdown content and an optional multi-page prompt suffix.
 */
export interface ResolvedPageRef {
  id: number;
  confluenceId: string | null;
  source: string;
  title: string;
}

export function subPageParentKey(page: ResolvedPageRef): string {
  return page.source === 'confluence' && page.confluenceId ? page.confluenceId : String(page.id);
}

// pages.id is int4 — only strings that safely fit are tried as internal ids
// (long numeric strings are Confluence ids and would overflow the cast).
const SAFE_INT4_DIGITS = 9;

/** Optional caller gate for {@link lookupPageRef}: the visibility predicate's bound values. */
interface PageRefReader {
  spaces: string[];
  userId: string;
}

async function lookupPageRef(pageId: string, reader?: PageRefReader): Promise<ResolvedPageRef | undefined> {
  type Row = { id: number; confluence_id: string | null; source: string; title: string };
  // Both lookups carry the gate, so a restricted internal id falls through to
  // the Confluence-id lookup exactly as a missing one does (no oracle).
  const gate = reader ? ` AND ${visiblePagesPredicate(2, 3, 'pages')}` : '';
  const gateValues = reader ? [reader.spaces, reader.userId] : [];
  if (/^\d+$/.test(pageId) && pageId.length <= SAFE_INT4_DIGITS) {
    const byId = await query<Row>(
      `SELECT id, confluence_id, title, source FROM pages WHERE id = $1 AND deleted_at IS NULL${gate}`,
      [parseInt(pageId, 10), ...gateValues],
    );
    const row = byId.rows[0];
    if (row) return { id: row.id, confluenceId: row.confluence_id, source: row.source, title: row.title };
  }
  const byConfluenceId = await query<Row>(
    `SELECT id, confluence_id, title, source FROM pages WHERE confluence_id = $1 AND deleted_at IS NULL${gate}`,
    [pageId, ...gateValues],
  );
  const row = byConfluenceId.rows[0];
  return row ? { id: row.id, confluenceId: row.confluence_id, source: row.source, title: row.title } : undefined;
}

/**
 * Resolve a route-level `pageId` to the page row. The frontend passes the
 * INTERNAL `pages.id` (its /pages/:id route param) while API callers may
 * pass the Confluence id — both are numeric strings, so the internal id is
 * tried first, mirroring the precedence of /llm/improvements/apply.
 * Unauthorized: callers gate the result themselves.
 */
export async function resolvePageRef(pageId: string): Promise<ResolvedPageRef | undefined> {
  return lookupPageRef(pageId);
}

/**
 * {@link resolvePageRef} restricted to pages the caller may read under
 * `visiblePagesPredicate` (space access, standalone visibility and page
 * restrictions). A page the caller cannot read resolves exactly like one
 * that does not exist, so its title never reaches a prompt or a row.
 */
export async function resolveReadablePageRef(userId: string, pageId: string): Promise<ResolvedPageRef | undefined> {
  const spaces = await getUserAccessibleSpacesMemoized(userId);
  return lookupPageRef(pageId, { spaces, userId });
}

export async function assembleContextIfNeeded(
  userId: string,
  pageId: string | undefined,
  content: string,
  includeSubPages?: boolean,
  opts?: { protectMedia?: boolean; layoutTokens?: boolean; policyContext?: SubPagePolicyContext; parentRef?: ResolvedPageRef },
): Promise<{ markdown: string; multiPageSuffix: string; includedPageRefs: IncludedPageRef[] }> {
  // Resolve internal-vs-Confluence id: sub-page traversal is keyed on the
  // Confluence id (pages.parent_id; the DB id for standalone pages). A page
  // the caller cannot read, or that does not exist, contributes neither its
  // title nor its sub-page tree: the request falls back to the caller's own
  // content alone, so both cases produce the same prompt.
  const resolved = includeSubPages && pageId ? opts?.parentRef ?? await resolveReadablePageRef(userId, pageId) : undefined;
  if (resolved) {
    const parentHtml = opts?.protectMedia ? protectMedia(content).html : content;
    const assembled = await assembleSubPageContext(
      userId,
      subPageParentKey(resolved),
      parentHtml,
      resolved.title,
      undefined,
      // #765: tokens for the PARENT page only — apply-time skeleton
      // alignment runs against the parent, and without its tokens any
      // Improve of a multi-cell layout page is guaranteed unrecoverable.
      // Sub-page conversions stay token-free (see assembleSubPageContext).
      { parentLayoutTokens: opts?.layoutTokens === true, policyContext: opts?.policyContext },
    );
    return {
      markdown: assembled.markdown,
      multiPageSuffix: getMultiPagePromptSuffix(assembled.pageCount),
      includedPageRefs: assembled.includedPageRefs,
    };
  }

  const html = opts?.protectMedia ? protectMedia(content).html : content;
  return {
    // #765: layout boundary tokens are opt-in — only the Improve route
    // requests them.
    markdown: htmlToMarkdown(html, { layoutTokens: opts?.layoutTokens === true }),
    multiPageSuffix: '',
    includedPageRefs: [],
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

  // Issue #705 — supplementary Swiss-spelling hint. The deterministic post-
  // processor still enforces ß→ss; this just reduces churn before that pass.
  const outputRules = await getAiOutputRules();
  if (outputRules.swissSpelling) {
    prompt += ` ${SWISS_SPELLING_INSTRUCTION}`;
  }

  return prompt;
}

/**
 * Check the LLM cache with stampede protection.
 *
 * 1. Return cached response immediately if present.
 * 2. Try to acquire a Redis lock so only one request generates.
 * 3. If the lock is already held, wait for the cached result. Generate can
 *    provide its response so the waiter stays connected and retries ownership
 *    after the current holder releases the lock.
 *
 * The caller MUST pass `lockToken` to `releaseLock()` in a finally block
 * when it is non-null, after writing the generated result to the cache.
 */
export async function checkCacheWithLock(
  llmCache: LlmCache,
  cacheKey: string,
  response?: {
    request: { raw: import('http').IncomingMessage };
    reply: FastifyReply;
  },
): Promise<{ cached: CachedLlmResponse | null; lockToken: string | null; aborted: boolean }> {
  // Fast path — already in cache
  const cached = await llmCache.getCachedResponse(cacheKey);
  if (cached) return { cached, lockToken: null, aborted: false };

  // Try to become the single generator for this key
  const lockToken = await llmCache.acquireLock(cacheKey);
  if (lockToken) {
    return { cached: null, lockToken, aborted: false };
  }

  if (!response) {
    const waited = await llmCache.waitForCachedResponse(cacheKey);
    return { cached: waited, lockToken: null, aborted: false };
  }

  const { request, reply } = response;
  if (request.raw.aborted || reply.raw.destroyed) {
    return { cached: null, lockToken: null, aborted: true };
  }

  const controller = new AbortController();
  const onClose = () => controller.abort();
  reply.raw.on('close', onClose);
  let keepAliveTimer: NodeJS.Timeout | undefined;

  const writeKeepAlive = () => {
    if (controller.signal.aborted || reply.raw.destroyed || reply.raw.writableEnded) {
      controller.abort();
      return;
    }
    try {
      reply.raw.write(': keep-alive\n\n');
    } catch {
      controller.abort();
    }
  };

  try {
    startSseResponse(reply);
    writeKeepAlive();
    keepAliveTimer = setInterval(writeKeepAlive, 1_000);
    keepAliveTimer.unref?.();

    while (!controller.signal.aborted) {
      const waited = await llmCache.waitForCachedResponse(
        cacheKey,
        undefined,
        undefined,
        controller.signal,
      );
      if (controller.signal.aborted || reply.raw.destroyed) {
        return { cached: null, lockToken: null, aborted: true };
      }
      if (waited) return { cached: waited, lockToken: null, aborted: false };

      const nextLockToken = await llmCache.acquireLock(cacheKey);
      if (controller.signal.aborted || reply.raw.destroyed) {
        if (nextLockToken) await llmCache.releaseLock(cacheKey, nextLockToken);
        return { cached: null, lockToken: null, aborted: true };
      }
      if (!nextLockToken) continue;

      const cachedAfterAcquire = await llmCache.getCachedResponse(cacheKey);
      if (controller.signal.aborted || reply.raw.destroyed) {
        await llmCache.releaseLock(cacheKey, nextLockToken);
        return { cached: null, lockToken: null, aborted: true };
      }
      if (cachedAfterAcquire) {
        await llmCache.releaseLock(cacheKey, nextLockToken);
        return { cached: cachedAfterAcquire, lockToken: null, aborted: false };
      }
      return { cached: null, lockToken: nextLockToken, aborted: false };
    }

    return { cached: null, lockToken: null, aborted: true };
  } finally {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    reply.raw.removeListener('close', onClose);
  }
}

export function startSseResponse(reply: FastifyReply): void {
  if (reply.raw.headersSent) return;
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

/**
 * Send a terminal SSE turn — one content chunk, an optional final frame, end
 * of stream. Every "answer without an LLM call" path shares this shape: the
 * cache hits (the original callers, hence the name and the `cached: true`
 * default) and the #1105 confidence refusal (`{ cached: false }` — nothing
 * was cached, and the flag would be a lie a future consumer might read).
 * Keep the copies OUT of route files: a cross-cutting SSE change applied
 * here and missed in a hand-rolled twin turns the least-exercised branch
 * into the one differently-framed response (#1268 review).
 */
export function sendCachedSSE(
  reply: FastifyReply,
  content: string,
  extras?: Record<string, unknown>,
  opts?: { cached?: boolean },
): void {
  startSseResponse(reply);
  const contentFrame: Record<string, unknown> = { content, done: true };
  if (opts?.cached !== false) contentFrame.cached = true;
  reply.raw.write(`data: ${JSON.stringify(contentFrame)}\n\n`);
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
  generator: AsyncGenerator<StreamChunk> | ((signal: AbortSignal) => AsyncGenerator<StreamChunk>),
  extras?: Record<string, unknown>,
  options?: {
    llmCache?: LlmCache;
    cacheKey?: string;
    lockToken?: string | null;
    postProcess?: (content: string) => OutputSanitizeResult;
    /** Only provider-dispatched calls pass audit metadata; cache hits bypass this helper. */
    audit?: Omit<LlmAuditEntry, 'outputTokens' | 'durationMs' | 'status' | 'errorMessage' | 'outputText'>;
    /**
     * Gate on the cache write (runs on the post-processed content). Return
     * false to skip caching — e.g. the Improve route's layout-token guard,
     * which refuses to cache a response that lost the page's [[[…]]] tokens
     * so a retry regenerates instead of replaying the unusable output.
     */
    shouldCache?: (content: string) => boolean;
    /**
     * Extra fields for the final SSE event that depend on the FULL streamed
     * content (the static `extras` parameter is built before streaming).
     * E.g. the Improve route's `layoutTokensLost` flag for the frontend's
     * pre-Accept warning.
     */
    finalExtras?: (content: string) => Record<string, unknown>;
    /**
     * #282: the article binding the streamed text was generated under —
     * written beside the cached output so a later hit can be re-admitted
     * against the SAME provider revision, locality and page revisions
     * rather than against whatever the request's current context says.
     * Independent input records an explicitly empty page set. Missing
     * provenance is unknown: it cannot be published or replayed as safe.
     * Publication holds the shared revision guard through the cache write.
     */
    cacheProvenance?: ConversationTurnAiProvenance;
    /** Lets callers avoid persisting a partial response after a stream failure. */
    onStreamError?: (error: unknown) => void;
    /** Report whether the stream completed normally or was interrupted. */
    onFinished?: (result: { status: 'success' | 'error' | 'aborted'; error?: unknown }) => void;
  },
): Promise<string> {
  const controller = new AbortController();

  // Abort the generator when the client disconnects
  const onClose = () => {
    controller.abort();
  };
  reply.raw.on('close', onClose);
  if (reply.raw.destroyed || request.raw.aborted) controller.abort();

  startSseResponse(reply);

  let fullContent = '';
  let outputCharacters = 0;
  let usage: StreamChunk['usage'];
  let streamFailed = false;
  let streamError: unknown;
  const auditStart = Date.now();
  let dispatched = false;
  const reportStreamError = (error: unknown): void => {
    streamFailed = true;
    streamError = error;
    try {
      options?.onStreamError?.(error);
    } catch (callbackError) {
      logger.error({ err: callbackError }, 'SSE stream error callback failed');
    }
  };
  const stopLockHeartbeat = options?.llmCache && options.cacheKey && options.lockToken
    ? options.llmCache.startLockHeartbeat(options.cacheKey, options.lockToken)
    : undefined;

  try {
    if (controller.signal.aborted) throw new DOMException('Client disconnected', 'AbortError');
    const chunks = typeof generator === 'function' ? generator(controller.signal) : generator;
    dispatched = true;
    for await (const chunk of chunks) {
      outputCharacters += chunk.content.length;
      if (chunk.usage) usage = { ...usage, ...chunk.usage };
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
    if (
      options?.llmCache && options?.cacheKey && fullContent && !controller.signal.aborted &&
      (options.shouldCache?.(fullContent) ?? true)
    ) {
      const { llmCache, cacheKey, cacheProvenance } = options;
      if (cacheProvenance && options.audit?.userId) {
        try {
          // The short publication transaction serializes the SET with policy
          // mutation. A check followed by an unlocked SET could repopulate
          // purged output. Replay still revalidates if invalidation fails.
          await admitArticleStage(cacheProvenance, options.audit.userId, 'chat', async () => {
            await llmCache.setCachedResponse(cacheKey, fullContent, undefined, cacheProvenance);
          });
        } catch {
          // Inference already completed: keep its usage accounting, but never
          // publish reusable state when authority changed or is unreadable.
          logger.info('Direct output cache publication refused');
        }
      }
      // Missing provenance is unknown, including for independent input.
      // Such output may be displayed, but must not become a reusable entry.
    }

    if ((extras || options?.finalExtras) && !controller.signal.aborted) {
      reply.raw.write(
        `data: ${JSON.stringify({ ...extras, ...options?.finalExtras?.(fullContent), done: true, final: true })}\n\n`,
      );
    }
  } catch (err) {
    reportStreamError(err);
    if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      logger.debug('SSE stream aborted by client disconnect');
    } else if (err instanceof StreamIncompleteError) {
      // The provider closed the socket before `[DONE]`: the text the client
      // already saw is a prefix. Say so on the wire rather than letting the
      // stream merely stop, so the client never renders it as finished.
      logger.warn({ receivedCharacters: err.receivedCharacters }, 'SSE stream ended before completion');
      reply.raw.write(`data: ${JSON.stringify({ error: 'Stream ended before completion', done: true })}\n\n`);
    } else {
      logger.error({ err }, 'SSE stream error');
      reply.raw.write(`data: ${JSON.stringify({ error: 'Stream error', done: true })}\n\n`);
    }
  } finally {
    stopLockHeartbeat?.();
    if (controller.signal.aborted && !streamFailed) {
      reportStreamError(new DOMException('Client disconnected', 'AbortError'));
    }
    if (options?.audit && dispatched && !(streamError instanceof ArticleStageRefusedError)) {
      emitLlmAudit({
        ...options.audit,
        inputTokens: usage?.promptTokens ?? options.audit.inputTokens,
        outputTokens: usage?.completionTokens ?? Math.ceil(outputCharacters / 4),
        durationMs: Date.now() - auditStart,
        status: streamFailed ? 'error' : 'success',
        ...(streamFailed
          ? {
              errorMessage: controller.signal.aborted
                ? 'Client disconnected'
                : streamError instanceof StreamIncompleteError ? 'Stream ended before completion' : 'Stream error',
            }
          : {}),
      });
    }
    options?.onFinished?.({
      status: controller.signal.aborted ? 'aborted' : streamFailed ? 'error' : 'success',
      ...(streamError !== undefined ? { error: streamError } : {}),
    });
    reply.raw.removeListener('close', onClose);
    reply.raw.end();
  }

  // Only a COMPLETED stream is a result. A failed or truncated stream, or
  // one the client abandoned, resolves to '' so no caller can persist the
  // prefix as the finished output (the cache write above is gated the same
  // way); callers that need the partial text for diagnostics have the
  // audit entry's output-token count.
  return streamError || controller.signal.aborted ? '' : fullContent;
}

/**
 * Effective SearXNG result width for a stored `searxng_max_results` value.
 * Rows written before #1768 can hold 11–20 (the old admin range); the sidecar's
 * `search_web` schema rejects anything above SEARXNG_MAX_RESULTS_MAX with
 * -32602, which fetchWebSources swallows into "no sources". Non-numeric →
 * default; out of range → clamped; both logged so the operator re-saves.
 */
export function normalizeSearxngMaxResults(stored: string | undefined): number {
  if (stored === undefined) return SEARXNG_MAX_RESULTS_DEFAULT;
  const parsed = parseInt(stored, 10);
  if (!Number.isFinite(parsed)) {
    logger.warn({ stored }, 'searxng_max_results is not a number — using the default; re-save SearXNG settings');
    return SEARXNG_MAX_RESULTS_DEFAULT;
  }
  const effective = Math.min(SEARXNG_MAX_RESULTS_MAX, Math.max(SEARXNG_MAX_RESULTS_MIN, parsed));
  if (effective !== parsed) {
    logger.warn(
      { stored, effective },
      'searxng_max_results is outside the sidecar range — clamped; re-save SearXNG settings',
    );
  }
  return effective;
}

/**
 * Effective SearXNG categories for a stored `searxng_categories` value. Rows
 * written before #1769 were only length-checked, so one can hold a value the
 * sidecar's `search_web` schema rejects with -32602 (e.g. "general, it"),
 * which fetchWebSources swallows into "no sources". Such a row falls back to
 * the default — what the sidecar searched before #1769 — and is logged so the
 * operator re-saves.
 */
function normalizeSearxngCategories(stored: string | undefined): string {
  if (stored === undefined) return SEARXNG_CATEGORIES_DEFAULT;
  if (SearxngCategoriesSchema.safeParse(stored).success) return stored;
  logger.warn(
    { stored, effective: SEARXNG_CATEGORIES_DEFAULT },
    'searxng_categories is not a comma-separated category list — using the default; re-save SearXNG settings',
  );
  return SEARXNG_CATEGORIES_DEFAULT;
}

/** Admin-configured SearXNG search settings (admin_settings), normalized into the sidecar's ranges. */
export async function getSearxngSettings(): Promise<SearxngSettings> {
  const result = await query<{ setting_key: string; setting_value: string }>(
    `SELECT setting_key, setting_value FROM admin_settings
     WHERE setting_key IN ('searxng_max_results', 'searxng_categories')`,
  );
  const stored = new Map(result.rows.map((row) => [row.setting_key, row.setting_value]));
  return {
    maxResults: normalizeSearxngMaxResults(stored.get('searxng_max_results')),
    categories: normalizeSearxngCategories(stored.get('searxng_categories')),
  };
}

/**
 * Build an output post-processor using the current admin AI output rules.
 * Returns undefined if output processing is disabled, so callers can pass it
 * directly to `streamSSE` options.
 */
export async function buildOutputPostProcessor(
  verifiedSources?: string[],
): Promise<((content: string) => OutputSanitizeResult) | undefined> {
  const rules = await getAiOutputRules();

  // Reference detection and Swiss spelling (#705) are independent output rules.
  // Skip the post-processor only when BOTH are inactive — otherwise Swiss
  // spelling would never run while reference detection is off.
  const referenceActive = rules.stripReferences && rules.referenceAction !== 'off';
  if (!referenceActive && !rules.swissSpelling) return undefined;

  return (content: string) =>
    sanitizeLlmOutput(content, {
      ...rules,
      verifiedSources,
    });
}

/**
 * #1154: gate on vision capability, then load the staged image as a content
 * part.
 *
 * Shared by /llm/generate and /llm/improve so the 422 and 410 semantics exist
 * in exactly one place — an earlier draft inlined this in both routes, which
 * would have let the two drift apart.
 *
 * Order matters: the capability check runs before the Redis lookup, so a
 * refusal costs neither a load nor a provider round-trip.
 */
export async function resolveImagePart(
  fastify: FastifyInstance,
  userId: string,
  imageHandle: string,
  providerId: string,
  model: string,
): Promise<{ part: ChatContentPart; hash: string }> {
  const vision = await getVisionCapability(providerId, model);
  if (vision === false) {
    throw fastify.httpErrors.unprocessableEntity(
      `The model assigned to chat (${model}) cannot accept images. ` +
      'Assign a vision-capable model in Settings → AI Models.',
    );
  }
  if (vision !== true) {
    // `null` is "not established yet", not "established as no" — saying it
    // cannot accept images would assert something the server has not checked.
    // Still refused: fail closed, but tell the truth about why.
    throw fastify.httpErrors.unprocessableEntity(
      `Image support for the model assigned to chat (${model}) has not been ` +
      'confirmed yet. Try again shortly, or assign a known vision-capable ' +
      'model in Settings → AI Models.',
    );
  }

  let staged;
  try {
    staged = await loadStagedImage(userId, imageHandle);
  } catch (err) {
    // A read against an unreachable Redis is not an expiry. "Attach it again"
    // would send the user into a re-upload that also fails — the staging route
    // already answers 503 for the same condition on the write side.
    if (err instanceof ImageStagingUnavailableError) {
      throw fastify.httpErrors.serviceUnavailable(
        'Image staging is temporarily unavailable. Try again in a moment.',
      );
    }
    throw err;
  }
  if (!staged) {
    throw fastify.httpErrors.gone('The staged image has expired. Attach it again.');
  }

  return {
    part: {
      type: 'image_url',
      image_url: {
        url: `data:image/${staged.format};base64,${staged.bytes.toString('base64')}`,
      },
    },
    // The handle *is* the sha256 of the bytes, so it doubles as the cache
    // input. If handles ever stop being content-addressed, hash the bytes here.
    hash: imageHandle,
  };
}
