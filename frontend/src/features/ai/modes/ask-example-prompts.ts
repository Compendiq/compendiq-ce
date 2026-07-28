// #350: clickable example prompts shown on the empty state of the Ask mode.
// Extracted from AskMode.tsx so the file only exports React components, which
// keeps `react-refresh/only-export-components` happy (the rule's
// `allowConstantExport` option only whitelists primitives, not arrays).
//
// Each prompt fills the input rather than auto-submits — auto-submit would
// surprise the user.

/**
 * The four prompts shipped before the July-2026 design critique. They named a
 * tag ("onboarding") and a space ("engineering") that do not exist in a fresh
 * install, so the first thing the AI surface did was invent facts about the
 * user's own knowledge base. Kept only as the last-resort fallback for an
 * empty instance, with the fabricated specifics removed.
 *
 * Deliberately excludes the duplicate-hunting prompt: it is only meaningful
 * once there is more than one page to compare, so it lives in its own guarded
 * slot below rather than in the top-up pool.
 */
export const ASK_FALLBACK_PROMPTS: readonly string[] = [
  'What topics does my knowledge base cover?',
  'Which pages look out of date and worth reviewing?',
  'Summarize what changed in the last 7 days',
  'What should I read first to get oriented?',
];

/** Minimal shape this module needs from a page list entry. */
export interface PromptSourcePage {
  title: string;
  spaceKey: string | null;
  labels: string[];
}

export interface PromptSources {
  /** Pages, most-recently-modified first. */
  recentPages: readonly PromptSourcePage[];
  /** Labels that actually exist in this instance. */
  labels: readonly string[];
  /** Space keys that actually exist in this instance. */
  spaceKeys: readonly string[];
}

/** Titles longer than this get truncated so a prompt stays one readable line. */
const MAX_TITLE_LENGTH = 60;

function quoteTitle(title: string): string {
  const trimmed = title.trim();
  const clipped =
    trimmed.length > MAX_TITLE_LENGTH
      ? `${trimmed.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
      : trimmed;
  return `"${clipped}"`;
}

/**
 * Builds up to four example prompts out of what is actually in this instance.
 *
 * Every returned prompt names only real pages, labels, and spaces, so clicking
 * one produces an answerable question instead of a confident answer about
 * content that was never there. Slots fill in priority order and any slot with
 * no real data behind it is skipped rather than invented; if nothing at all is
 * available the caller gets ASK_FALLBACK_PROMPTS, which reference nothing
 * specific.
 */
export function buildAskPrompts(sources: PromptSources): readonly string[] {
  const { recentPages, labels, spaceKeys } = sources;
  const prompts: string[] = [];

  const mostRecent = recentPages.find((p) => p.title.trim().length > 0);
  if (mostRecent) {
    prompts.push(`Summarize ${quoteTitle(mostRecent.title)}`);
  }

  // Prefer a label that is actually attached to something recent — a label
  // that exists only on a stale page makes for a thin demonstration.
  const labelOnRecentPage = recentPages
    .flatMap((p) => p.labels)
    .find((l) => l.trim().length > 0);
  const label = labelOnRecentPage ?? labels.find((l) => l.trim().length > 0);
  if (label) {
    prompts.push(`Draft a how-to from pages tagged "${label}"`);
  }

  const space = spaceKeys.find((k) => k.trim().length > 0);
  if (space) {
    prompts.push(`What changed in the ${space} space in the last 7 days?`);
  }

  // Needs no instance data to be truthful, so it always earns its slot once
  // there is more than one page to compare.
  if (recentPages.length > 1) {
    prompts.push('Find pages that look like duplicates of each other');
  }

  if (prompts.length === 0) return ASK_FALLBACK_PROMPTS;

  // Top up from the fallbacks so the grid stays balanced at four, skipping
  // any that duplicate what the instance already produced.
  for (const filler of ASK_FALLBACK_PROMPTS) {
    if (prompts.length >= 4) break;
    if (!prompts.includes(filler)) prompts.push(filler);
  }

  return prompts.slice(0, 4);
}
