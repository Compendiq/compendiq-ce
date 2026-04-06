/**
 * Sub-page context assembly service.
 *
 * Fetches a parent page and all its recursive sub-pages from pages,
 * then concatenates them with clear page boundary markers for LLM consumption.
 *
 * Content length limits prevent exceeding LLM context windows.
 */

import { query } from '../../../core/db/postgres.js';
import { htmlToMarkdown } from '../../../core/services/content-converter.js';
import { logger } from '../../../core/utils/logger.js';

/** Maximum combined context size in characters (approx 60K tokens for most LLMs). */
export const MAX_COMBINED_CONTEXT_CHARS = 200_000;

/** Maximum depth for recursive sub-page fetching (prevent runaway recursion). */
const MAX_DEPTH = 5;

/** Maximum number of sub-pages to include (prevent huge page trees). */
const MAX_SUB_PAGES = 50;

export interface PageContent {
  confluenceId: string;
  title: string;
  bodyHtml: string;
  depth: number;
}

export interface AssembledContext {
  /** The combined markdown text with page boundary markers. */
  markdown: string;
  /** Total number of pages included (parent + sub-pages). */
  pageCount: number;
  /** Whether content was truncated due to length limits. */
  wasTruncated: boolean;
  /** List of page titles included, for reference. */
  includedPages: string[];
}

/**
 * Fetch all sub-pages recursively for a given parent page.
 * Returns pages in breadth-first order.
 */
export async function fetchSubPages(
  userId: string,
  parentId: string,
): Promise<PageContent[]> {
  const subPages: PageContent[] = [];
  const queue: Array<{ id: string; depth: number }> = [{ id: parentId, depth: 1 }];
  const visited = new Set<string>();

  while (queue.length > 0 && subPages.length < MAX_SUB_PAGES) {
    const current = queue.shift()!;
    if (current.depth > MAX_DEPTH || visited.has(current.id)) continue;
    visited.add(current.id);

    const result = await query<{
      confluence_id: string;
      title: string;
      body_html: string;
    }>(
      `SELECT confluence_id, title, body_html
       FROM pages
       WHERE parent_id = $1`,
      [current.id],
    );

    for (const row of result.rows) {
      if (subPages.length >= MAX_SUB_PAGES) break;

      subPages.push({
        confluenceId: row.confluence_id,
        title: row.title,
        bodyHtml: row.body_html || '',
        depth: current.depth,
      });

      // Queue children for next depth level
      queue.push({ id: row.confluence_id, depth: current.depth + 1 });
    }
  }

  return subPages;
}

/**
 * Check if a page has any sub-pages.
 */
export async function hasSubPages(
  userId: string,
  pageId: string,
): Promise<boolean> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM pages WHERE parent_id = $1`,
    [pageId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Expected a row from COUNT query');
  return parseInt(row.count, 10) > 0;
}

/**
 * Assemble combined context from a parent page and its sub-pages.
 *
 * Returns markdown content with clear page boundary markers:
 *
 *   --- Page: "Parent Title" (Main Page) ---
 *   [parent content]
 *
 *   --- Page: "Sub-page Title" ---
 *   [sub-page content]
 *
 * Content is truncated if it exceeds MAX_COMBINED_CONTEXT_CHARS.
 */
export async function assembleSubPageContext(
  userId: string,
  parentPageId: string,
  parentHtml: string,
  parentTitle: string,
  maxChars: number = MAX_COMBINED_CONTEXT_CHARS,
): Promise<AssembledContext> {
  // Convert parent page to markdown
  const parentMarkdown = htmlToMarkdown(parentHtml);
  const includedPages: string[] = [parentTitle];
  let wasTruncated = false;

  // Start with the parent page
  let combined = `--- Page: "${parentTitle}" (Main Page) ---\n\n${parentMarkdown}`;

  // Fetch sub-pages
  const subPages = await fetchSubPages(userId, parentPageId);

  if (subPages.length === 0) {
    return {
      markdown: combined,
      pageCount: 1,
      wasTruncated: false,
      includedPages,
    };
  }

  logger.debug(
    { parentPageId, subPageCount: subPages.length },
    'Assembling sub-page context',
  );

  for (const subPage of subPages) {
    const subMarkdown = htmlToMarkdown(subPage.bodyHtml);
    const separator = `\n\n--- Page: "${subPage.title}" (Sub-page, depth ${subPage.depth}) ---\n\n`;
    const section = separator + subMarkdown;

    // Check if adding this page would exceed the limit
    if (combined.length + section.length > maxChars) {
      // Try to add a truncated version
      const remaining = maxChars - combined.length - separator.length - 100; // 100 chars for truncation notice
      if (remaining > 200) {
        combined += separator + subMarkdown.slice(0, remaining) + '\n\n[Content truncated due to length limits]';
        includedPages.push(subPage.title + ' (truncated)');
      }
      wasTruncated = true;
      logger.debug(
        { parentPageId, includedCount: includedPages.length, totalSubPages: subPages.length },
        'Sub-page context truncated due to length limits',
      );
      break;
    }

    combined += section;
    includedPages.push(subPage.title);
  }

  return {
    markdown: combined,
    pageCount: includedPages.length,
    wasTruncated,
    includedPages,
  };
}

/**
 * Get a multi-page system prompt suffix that instructs the LLM
 * to reference specific sub-pages in its response.
 */
export function getMultiPagePromptSuffix(pageCount: number): string {
  if (pageCount <= 1) return '';
  return `\n\nIMPORTANT: This content spans multiple pages (${pageCount} total). When making suggestions or references, always specify which page you are referring to by using the page title shown in the "--- Page: ... ---" markers. For example, say "In the page 'Getting Started'..." rather than generic references.`;
}
