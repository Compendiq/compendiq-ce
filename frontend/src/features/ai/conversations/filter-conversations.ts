import type { ConversationSummary } from '@compendiq/contracts';

/**
 * The one definition of what the conversations filter matches — `ConversationList`
 * reads it for the rows it renders, `AiConversationsSidebar`'s footer for the
 * count it states beside them. A second, independently-written copy is exactly
 * how the footer drifted from the list above it: it counted every LOADED row
 * while the filter above it was narrowing what was actually shown.
 */
export function filterConversations(
  rows: readonly ConversationSummary[],
  filter: string,
): ConversationSummary[] {
  const needle = filter.trim().toLowerCase();
  return needle ? rows.filter((row) => row.title.toLowerCase().includes(needle)) : [...rows];
}
