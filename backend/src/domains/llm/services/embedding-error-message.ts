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

import { LlmHttpError } from './llm-http-error.js';

/**
 * The `embedding` use case resolved to a model whose vectors do not fit the
 * live `page_embeddings.embedding` column (#1114).
 *
 * Its own type because the two audiences need different text. The `message`
 * here is the OPERATOR/log form and names the model and both widths; the
 * user-facing string comes from `toUserFacingEmbeddingError` below, which — as
 * this module's header says — never lets raw text through.
 *
 * It lives in this module rather than in `embedding-service.ts` so the mapper
 * can recognise it by type instead of by string sniffing: `embedding-service`
 * already imports this file, so the reverse import would close a cycle, and
 * matching on `err.name` would silently stop working under a rename.
 */
export class EmbeddingDimensionMismatchError extends Error {
  constructor(
    readonly model: string,
    readonly expected: number,
    readonly received: number,
  ) {
    super(
      `Embedding model "${model}" returned ${received}-dimensional vectors but the ` +
      `page_embeddings.embedding column holds ${expected}. Nothing was written.`,
    );
    this.name = 'EmbeddingDimensionMismatchError';
  }
}

/**
 * The `image_embedding` leg answered a width the image index is not typed for
 * (#1115 P2, review r1).
 *
 * Reachable and PERMANENT rather than transient, which is why it is a named
 * type and not a generic provider failure: `ensureImageEmbeddingColumn`
 * retypes the column and records the identity in one transaction, and that DDL
 * is *guarded* — a failed `ALTER` answers 200 with a warning naming Re-check
 * (ADR-025). The assignment is then live at the new pair while the column and
 * the recorded width are still the old one's, so every page with an image
 * would otherwise raise a raw pgvector dimension error out of the INSERT,
 * abort the whole scan, and record nothing on the card.
 *
 * Caught before the write instead, so the page is a counted failure and the
 * remedy — Re-check on the Image embedding row — reaches the operator.
 */
export class ImageEmbeddingDimensionMismatchError extends Error {
  constructor(
    readonly model: string,
    readonly expected: number,
    readonly received: number,
  ) {
    super(
      `Image embedding model "${model}" returned ${received}-dimensional vectors but the ` +
      `page_image_embeddings.embedding column is typed to ${expected}. Nothing was written.`,
    );
    this.name = 'ImageEmbeddingDimensionMismatchError';
  }
}

/**
 * Convert any thrown embedding error into a short, safe, user-facing message.
 * Never returns the raw upstream text — every branch, including the fallback,
 * yields a fixed constant string.
 *
 * #1185 moved the provider's body off `generateEmbedding`'s thrown `.message`
 * (`generateEmbedding HTTP 400: <body>`) onto `LlmHttpError.detail`, leaving
 * `.message` a bare `generateEmbedding HTTP 400`. Every needle below that
 * comes from the *body* (LM Studio's "no models loaded", "too long",
 * "context length", body-worded rate-limit/auth text) was going dead for the
 * production error type because this function only ever read `.message`.
 * Folding `.detail` in alongside `.message` for `LlmHttpError` restores that
 * without duplicating the needle lists — a plain `Error` (e.g. a raw network
 * failure from undici, thrown before `generateEmbedding` ever sees a
 * response) still only has `.message`, so that fallback stays.
 */
export function toUserFacingEmbeddingError(err: unknown): string {
  // #1114 — checked FIRST, and by type. This is the one embedding failure that
  // is not the provider's fault: the provider answered perfectly well, with a
  // vector the configured column cannot store. It matches none of the needles
  // below, so without this branch it fell to the generic tail and told the
  // operator "provider error, see server logs" — wrong about the cause and
  // pointing away from the fix, which is in Settings, not the provider.
  //
  // Fixed constant, like every other branch: the widths and the model name
  // stay in the log-side `message`.
  if (err instanceof EmbeddingDimensionMismatchError) {
    return 'The embedding model produces vectors of a different size than the stored index. '
      + 'Change the model back, or run a zero-downtime re-embed from Settings → AI Models.';
  }

  // #1115 P2 — a different index, and therefore a different remedy. The image
  // index rebuilds itself from Re-check on the Image embedding row; there is
  // no shadow-migration path for it (ADR-025 D7: it truncates and re-scans).
  if (err instanceof ImageEmbeddingDimensionMismatchError) {
    return 'The image embedding model produces vectors of a different size than the image index. '
      + 'Press Re-check on the Image embedding row in Settings → AI Models to rebuild it.';
  }

  const raw = err instanceof LlmHttpError
    ? `${err.message} ${err.detail}`
    : err instanceof Error ? err.message : String(err);
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
