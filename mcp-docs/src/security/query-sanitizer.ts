/**
 * Query sanitizer: prevents article content from leaking via search queries.
 * Enforces keyword-style queries only.
 */

export class QuerySanitizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuerySanitizationError';
  }
}

// Mirrored by WEB_SEARCH_QUERY_MAX_CHARS / WEB_SEARCH_QUERY_MAX_WORDS in
// @compendiq/contracts (which this package cannot import); both sides are
// pinned by literal tests — never widen one side alone (#1767).
export const MAX_QUERY_LENGTH = 200;
export const MAX_WORD_COUNT = 30;

export function sanitizeSearchQuery(query: string): string {
  let clean = query
    // Strip code blocks
    .replace(/```[\s\S]*?```/g, '')
    // Strip inline code
    .replace(/`[^`]+`/g, '')
    // Strip URLs
    .replace(/https?:\/\/\S+/g, '')
    // Strip JSON blobs
    .replace(/\{[\s\S]*\}/g, '')
    // Strip base64 patterns (40+ chars of base64 alphabet)
    .replace(/[A-Za-z0-9+/=]{40,}/g, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();

  if (!clean) {
    throw new QuerySanitizationError('Query is empty after sanitization');
  }

  if (clean.length > MAX_QUERY_LENGTH) {
    clean = clean.slice(0, MAX_QUERY_LENGTH).trim();
  }

  const wordCount = clean.split(/\s+/).length;
  if (wordCount > MAX_WORD_COUNT) {
    throw new QuerySanitizationError(`Query too complex (${wordCount} words) — use keywords only`);
  }

  return clean;
}
