import { ConversationTurnAiProvenanceSchema } from '@compendiq/contracts';
import { authorizeArticleDispatch, ArticleStageRefusedError } from '../../domains/llm/services/article-stage-admission.js';
import { policyRevisionsCacheComponent, type CachedLlmResponse } from '../../domains/llm/services/llm-cache.js';
import type { ProviderConfig, TransportContext } from '../../domains/llm/services/openai-compatible-client.js';
import { logger } from '../../core/utils/logger.js';

/**
 * A direct-route cache hit that must not be served. Carries the HTTP status
 * and body code the route answers with — both chosen BEFORE `reply.hijack()`,
 * which is why the replay check runs before any SSE header is written.
 *
 * - 409 `ai_history_not_replayable`: the entry is readable but is not a
 *   result this request may reuse — its recorded binding differs from the
 *   current one, a grounding page moved, the policy now denies, or the
 *   entry is malformed. Never regenerated silently: the caller re-asks and
 *   the miss path proves its own binding.
 * - 503 `ai_policy_unavailable`: the authority that would decide could not
 *   be read. Retryable; says nothing about the article.
 */
export class DirectCacheReplayError extends Error {
  constructor(
    public readonly statusCode: 409 | 503,
    public readonly code: 'ai_history_not_replayable' | 'ai_policy_unavailable',
  ) {
    super(`Cached output not replayable: ${code}`);
    this.name = 'DirectCacheReplayError';
  }
}

/**
 * Map a direct-route refusal raised BEFORE the SSE hijack to the status
 * body the `AiPolicyRefusal` contract names. A refusal that escapes a
 * direct route unhandled would be a 500, and a 500 says "the server
 * broke" — the caller retries, and a known policy denial becomes a retry
 * loop. Returns `null` for anything that is not a refusal so the caller
 * rethrows it unchanged.
 *
 * - `ai_policy_unavailable` → 503 `ai_policy_unavailable` (retryable).
 * - `ai_policy_denied` / `grounding_changed` → 409
 *   `ai_grounding_not_admissible` — a fact about the article as it is NOW.
 * - `DirectCacheReplayError` carries its own pair.
 */
export function directRefusalResponse(
  err: unknown, stage: string,
): { statusCode: 409 | 503; body: { error: string; stage: string } } | null {
  if (err instanceof DirectCacheReplayError) {
    return { statusCode: err.statusCode, body: { error: err.code, stage } };
  }
  if (err instanceof ArticleStageRefusedError) {
    return err.reason === 'ai_policy_unavailable'
      ? { statusCode: 503, body: { error: 'ai_policy_unavailable', stage } }
      : { statusCode: 409, body: { error: 'ai_grounding_not_admissible', stage } };
  }
  return null;
}

export interface ReplayDirectOutputOptions {
  transport: ProviderConfig;
  transportContext: TransportContext;
  userId: string;
  usecase: string;
  model: string;
}

/**
 * Is a value a well-formed cache entry? `getCachedResponse` hands back
 * whatever `JSON.parse` produced; a stale writer, a truncated SET or an
 * operator's hand edit can all leave something that is not a
 * `CachedLlmResponse`. Shape is checked here, not trusted from the type.
 */
function wellFormed(cached: unknown): cached is CachedLlmResponse {
  if (typeof cached !== 'object' || cached === null) return false;
  const entry = cached as Record<string, unknown>;
  return typeof entry.content === 'string' && entry.content.length > 0
    && typeof entry.cachedAt === 'number' && Number.isSafeInteger(entry.cachedAt) && entry.cachedAt > 0;
}

/**
 * #282: decide whether a direct-route (Improve / Summarize / Quality /
 * Diagram / Generate) cache hit may be replayed to THIS caller, and return
 * the text to send if so. The cache key already folds in model, prompt and
 * provider id; what it cannot see is whether the article binding the entry
 * was generated under still holds. So:
 *
 * 1. The entry must be well-formed (non-empty string content, sane
 *    timestamp). Malformed output is refused with 409 — never regenerated
 *    from the same prompt and never streamed as if it were a result,
 *    because its provenance is exactly what cannot be established.
 * 2. For an article transport, the entry must carry provenance, and that
 *    RECORDED provenance must name the same provider at the same
 *    configuration revision and effective locality as the current binding,
 *    over the same `(pageId, policyRevision, contentRevision)` set. An
 *    entry without provenance (written before #282, or by a non-article
 *    caller) is unknown provenance and is refused.
 * 3. The recorded provenance is then re-admitted through the shared
 *    article-stage admission — under the page lock, against the live
 *    page rows, the caller's current read access, the live provider
 *    endpoint/credentials and the live model assignment — exactly as a
 *    fresh dispatch would be. A known denial or a changed binding is 409;
 *    unreadable authority is 503.
 * 4. Independent input also requires an explicit empty provenance set bound
 *    to its provider revision. An unbound non-article transport cannot prove
 *    that missing metadata was safe and is never allowed to replay output.
 */
export async function replayDirectOutput(cached: unknown, opts: ReplayDirectOutputOptions): Promise<string> {
  if (!wellFormed(cached)) {
    logger.warn({ usecase: opts.usecase }, 'Malformed cached LLM output; refusing replay');
    throw new DirectCacheReplayError(409, 'ai_history_not_replayable');
  }
  const recorded = cached.aiProvenance === undefined
    ? null
    : ConversationTurnAiProvenanceSchema.safeParse(cached.aiProvenance);
  if (recorded !== null && !recorded.success) {
    throw new DirectCacheReplayError(409, 'ai_history_not_replayable');
  }

  if (opts.transportContext.kind !== 'article') {
    throw new DirectCacheReplayError(409, 'ai_history_not_replayable');
  }

  const current = opts.transportContext.stage;
  if (recorded === null
    || recorded.data.providerId !== current.provenance.providerId
    || recorded.data.configRevision !== current.provenance.configRevision
    || recorded.data.locality !== current.provenance.locality
    || policyRevisionsCacheComponent(recorded.data.pages) !== policyRevisionsCacheComponent(current.provenance.pages)) {
    throw new DirectCacheReplayError(409, 'ai_history_not_replayable');
  }

  try {
    await authorizeArticleDispatch(opts.transport, recorded.data, opts.userId, opts.usecase, current.context, opts.model, true);
  } catch (err) {
    if (err instanceof ArticleStageRefusedError) {
      throw new DirectCacheReplayError(
        err.reason === 'ai_policy_unavailable' ? 503 : 409,
        err.reason === 'ai_policy_unavailable' ? 'ai_policy_unavailable' : 'ai_history_not_replayable',
      );
    }
    logger.warn({ err, usecase: opts.usecase }, 'Cached output re-admission failed; refusing replay');
    throw new DirectCacheReplayError(503, 'ai_policy_unavailable');
  }
  return cached.content;
}
