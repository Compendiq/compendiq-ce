/** Longest title the row carries (initial, generated or renamed all respect it). */
export const CONVERSATION_TITLE_MAX = 80;
/** A word boundary this far back is preferred over a hard cut. */
const MIN_WORD_BOUNDARY = 40;

/**
 * The initial title of a new conversation: the first question, whitespace
 * collapsed, cut on a word boundary at ≤ 80 chars with an ellipsis (#1361).
 * Replaces the mid-word `question.slice(0, 100)`. PR 3's auto-title
 * overwrites it only while `title_source = 'question'`.
 */
export function initialTitleFromQuestion(question: string): string {
  const collapsed = question.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= CONVERSATION_TITLE_MAX) return collapsed;
  let cut = collapsed.slice(0, CONVERSATION_TITLE_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace >= MIN_WORD_BOUNDARY) cut = cut.slice(0, lastSpace);
  cut = cut.replace(/[\s,;:.!?…-]+$/u, '');
  return `${cut}…`;
}
