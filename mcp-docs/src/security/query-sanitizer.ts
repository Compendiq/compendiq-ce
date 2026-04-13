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

const MAX_QUERY_LENGTH = 200;
const MAX_WORD_COUNT = 30;

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
