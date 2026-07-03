/**
 * Shared web search helper — eliminates 4x duplication of the web search
 * pattern across /llm/improve, /llm/generate, /llm/summarize, and /llm/ask.
 *
 * Each endpoint preserves its own formatting via the `WebSearchFormat` config.
 */

import { isEnabled as isMcpDocsEnabled, fetchDocumentation, searchDocumentation } from '../../core/services/mcp-docs-client.js';
import { sanitizeLlmInput } from '../../core/utils/sanitize-llm-input.js';
import { getSearxngMaxResults } from './_helpers.js';
import { logger } from '../../core/utils/logger.js';

export interface WebSource {
  url: string;
  title: string;
  snippet: string;
}

/** Sanitizer detections for one web source, aggregated across its fields (#835). */
export interface WebInjectionWarning {
  url: string;
  warnings: string[];
}

export interface WebSearchResult {
  sources: WebSource[];
  /** One entry per source whose title, body, or snippet tripped the sanitizer. */
  injectionWarnings: WebInjectionWarning[];
}

interface WebSearchFormat {
  /** Label prefix for each source, e.g. 'Reference' or 'Web Source' */
  sourceLabel: string;
  /** Header text for the web context section, e.g. 'Verified reference material from web search' */
  sectionHeader: string;
}

/**
 * Fetch web sources via MCP docs sidecar (SearXNG search + page fetch).
 *
 * Returns empty sources if MCP docs is disabled, or if the search fails.
 * Individual fetch failures fall back to the search snippet.
 *
 * Sanitizer detections are collected per source into `injectionWarnings`
 * (#835) so callers can emit a PROMPT_INJECTION_DETECTED audit event —
 * the sanitizer itself only neutralizes and logs.
 */
export async function fetchWebSources(
  searchQuery: string,
  userId: string,
  options?: { maxResults?: number; maxLength?: number },
): Promise<WebSearchResult> {
  if (!await isMcpDocsEnabled()) return { sources: [], injectionWarnings: [] };

  const maxResults = options?.maxResults ?? await getSearxngMaxResults();
  const maxLength = options?.maxLength ?? 5000;

  try {
    const results = await searchDocumentation(searchQuery, userId, maxResults);
    const sources: WebSource[] = [];
    const injectionWarnings: WebInjectionWarning[] = [];

    for (const result of results.slice(0, 2)) {
      const warnings: string[] = [];
      // Title and snippet are attacker-controlled page metadata surfaced by
      // SearXNG — sanitize them like the fetched body (#820).
      const titleResult = sanitizeLlmInput(result.title);
      warnings.push(...titleResult.warnings);
      try {
        const doc = await fetchDocumentation(result.url, userId, maxLength);
        const bodyResult = sanitizeLlmInput(doc.markdown);
        warnings.push(...bodyResult.warnings);
        sources.push({ url: result.url, title: titleResult.sanitized, snippet: bodyResult.sanitized });
      } catch (fetchErr) {
        logger.warn({ err: fetchErr, url: result.url }, 'Web search: fetch failed, using snippet');
        const snippetResult = sanitizeLlmInput(result.snippet);
        warnings.push(...snippetResult.warnings);
        sources.push({ url: result.url, title: titleResult.sanitized, snippet: snippetResult.sanitized });
      }
      if (warnings.length > 0) {
        injectionWarnings.push({ url: result.url, warnings });
      }
    }

    return { sources, injectionWarnings };
  } catch (err) {
    logger.warn({ err }, 'Web search failed, continuing without');
    return { sources: [], injectionWarnings: [] };
  }
}

/**
 * Format web sources into a context string that can be appended to LLM content.
 *
 * Returns an empty string when there are no sources, so callers can safely
 * concatenate without conditional checks.
 */
export function formatWebContext(
  sources: WebSource[],
  format: WebSearchFormat,
): string {
  if (sources.length === 0) return '';

  const formatted = sources.map((s, i) =>
    `[${format.sourceLabel} ${i + 1}: "${s.title}" (${s.url})]\n${s.snippet}`
  ).join('\n\n---\n\n');

  return `\n\n---\n\n${format.sectionHeader}:\n\n${formatted}`;
}
