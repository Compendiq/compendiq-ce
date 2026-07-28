// Extracted from ConfluenceTab.tsx so that file only exports React components,
// which keeps `react-refresh/only-export-components` happy (same reason as
// features/ai/modes/ask-example-prompts.ts).

/**
 * Builds the deep link to Confluence's own personal-access-token screen.
 *
 * Returns null unless the user has typed something that parses as an http(s)
 * origin — a half-typed host would otherwise render a link that 404s, which is
 * worse than no link at all. Only the origin is used, so a URL pasted with a
 * path (`.../wiki/spaces/DEV`) still resolves to the right token page.
 */
export function confluenceTokenUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.origin}/plugins/personalaccesstokens/usertokens.action`;
  } catch {
    return null;
  }
}
