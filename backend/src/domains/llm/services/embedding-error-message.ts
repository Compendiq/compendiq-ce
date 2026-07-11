/**
 * Maps raw embedding/provider errors to short, category-based, user-safe messages.
 *
 * Raw upstream provider strings (e.g. LM Studio's "No models loaded ... use the
 * lms load command", stack traces, host:port details) must NEVER reach end
 * users: they leak infrastructure internals and are meaningless to non-operators.
 * Those raw strings stay in the server logs only (callers keep their existing
 * `logger.error({ err })` calls). This helper is the single place that decides
 * what a user is allowed to see for a failed embedding.
 */

/**
 * Convert any thrown embedding error into a short, safe, user-facing message.
 * Never returns the raw upstream text — every branch, including the fallback,
 * yields a fixed constant string.
 */
export function toUserFacingEmbeddingError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const m = raw.toLowerCase();

  // Connectivity / circuit-breaker: the provider is unreachable.
  if (
    ['econnrefused', 'enotfound', 'econnreset', 'etimedout', 'fetch failed', 'network', 'timeout', 'timed out', 'circuit breaker', 'socket'].some(
      (needle) => m.includes(needle),
    )
  ) {
    return 'Could not reach the embedding service. Check the provider connection and try again.';
  }

  // Auth: credentials rejected.
  if (['http 401', 'http 403', 'unauthorized', 'forbidden'].some((needle) => m.includes(needle))) {
    return 'The embedding service rejected the request. Check the provider credentials.';
  }

  // Rate limit: provider is busy.
  if (['http 429', 'rate limit', 'too many requests'].some((needle) => m.includes(needle))) {
    return 'The embedding service is busy (rate limited). Try again shortly.';
  }

  // Model unavailable: model not loaded / not found.
  if (
    ['http 404', 'not found', 'no models loaded', 'model not loaded', 'lms load'].some((needle) =>
      m.includes(needle),
    )
  ) {
    return 'The embedding model is not available. Check the model configuration and try again.';
  }

  // Content too long: input exceeds the model's context window.
  if (
    ['context length', 'input length', 'too long', 'maximum context'].some((needle) => m.includes(needle))
  ) {
    return 'Content was too long to index. It will be retried automatically.';
  }

  // Generic fallback: something else went wrong on the provider side.
  return 'Embedding failed due to a provider error. See server logs for details.';
}
