export const MAX_TAG_LENGTH = 100;

/**
 * Normalizes a tag input: trims whitespace, lowercases, replaces
 * spaces with hyphens, and strips characters invalid for labels.
 */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_\-:.]/g, '')
    .slice(0, MAX_TAG_LENGTH);
}
