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

/**
 * Label for the edit bar's tag chip (`TagPopover`).
 *
 * State-first, the way a property chip reads: name the action when there is
 * nothing to report, report the value when there is.
 */
export function tagChipLabel(count: number): string {
  if (count === 0) return 'Add tags';
  if (count === 1) return '1 tag';
  return `${count} tags`;
}
