import { providerChat } from '../../llm/services/llm-provider.js';
import { htmlToMarkdown } from '../../../core/services/content-converter.js';
import { sanitizeLlmInput } from '../../../core/utils/sanitize-llm-input.js';
import { query } from '../../../core/db/postgres.js';
import { logger } from '../../../core/utils/logger.js';
import { getClientForUser } from '../../confluence/services/sync-service.js';

export const ALLOWED_TAGS = [
  'architecture',
  'deployment',
  'troubleshooting',
  'how-to',
  'api',
  'security',
  'database',
  'monitoring',
  'configuration',
  'onboarding',
  'policy',
  'runbook',
] as const;

export type AllowedTag = typeof ALLOWED_TAGS[number];

const SYSTEM_PROMPT = `You are a document classifier. Given the following article, select 1-5 tags from this list that best describe the content: ${JSON.stringify(ALLOWED_TAGS)}. Return ONLY a JSON array of selected tags, nothing else. Example: ["architecture", "deployment"]`;

/**
 * Auto-tag a page's content using LLM zero-shot classification.
 * Returns an array of suggested tags from the allowed set.
 * Uses providerChat for provider-aware model resolution (Ollama or OpenAI).
 */
export async function autoTagContent(
  userId: string,
  model: string,
  content: string,
  options: { isHtml?: boolean } = {},
): Promise<AllowedTag[]> {
  // Convert HTML to markdown if needed
  let text = options.isHtml ? htmlToMarkdown(content) : content;

  // Truncate to avoid excessive LLM input (first 5000 chars should be enough for classification)
  if (text.length > 5000) {
    text = text.slice(0, 5000) + '\n\n[Content truncated for classification]';
  }

  const { sanitized } = sanitizeLlmInput(text);

  let response: string;
  try {
    response = await providerChat(userId, model, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: sanitized },
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Auto-tag failed: ${message}`, { cause: err });
  }

  return parseTagResponse(response);
}

/**
 * Parse the LLM response and validate tags against allowed set.
 */
export function parseTagResponse(response: string): AllowedTag[] {
  // Try to extract JSON array from the response
  const trimmed = response.trim();

  // Try direct JSON parse first
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Try to find a JSON array within the response
    const match = trimmed.match(/\[([^\]]*)\]/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        logger.warn({ response: trimmed.slice(0, 200) }, 'Failed to parse auto-tag response');
        return [];
      }
    } else {
      logger.warn({ response: trimmed.slice(0, 200) }, 'No JSON array found in auto-tag response');
      return [];
    }
  }

  // Resolve to an array for tag extraction
  let tagArray: unknown[];

  if (Array.isArray(parsed)) {
    tagArray = parsed;
  } else if (typeof parsed === 'object' && parsed !== null) {
    // If the LLM returned an object with an array property, try to extract it
    const obj = parsed as Record<string, unknown>;
    const arrayValue = obj.tags ?? obj.labels ?? obj.categories ?? obj.result;
    if (Array.isArray(arrayValue)) {
      tagArray = arrayValue;
    } else {
      return [];
    }
  } else {
    return [];
  }

  // Filter to only allowed tags and deduplicate
  const allowedSet = new Set<string>(ALLOWED_TAGS);
  const validTags = new Set<AllowedTag>();

  for (const tag of tagArray) {
    if (typeof tag === 'string') {
      const normalized = tag.toLowerCase().trim();
      if (allowedSet.has(normalized)) {
        validTags.add(normalized as AllowedTag);
      }
    }
  }

  // Limit to 5 tags
  return Array.from(validTags).slice(0, 5);
}

/**
 * Auto-tag a page from the database by its confluence ID.
 */
export async function autoTagPage(
  userId: string,
  confluenceId: string,
  model: string,
): Promise<{ suggestedTags: AllowedTag[]; existingLabels: string[] }> {
  const result = await query<{
    body_html: string;
    labels: string[];
  }>(
<<<<<<< HEAD
    'SELECT body_html, labels FROM cached_pages WHERE confluence_id = $1 AND deleted_at IS NULL',
=======
    'SELECT body_html, labels FROM pages WHERE confluence_id = $1',
>>>>>>> 46f8d99 (fix: restore missing worktree files + fix cached_pages references (#353))
    [confluenceId],
  );

  if (result.rows.length === 0) {
    throw new Error(`Page not found: ${confluenceId}`);
  }

  const { body_html, labels } = result.rows[0];
  if (!body_html) {
    return { suggestedTags: [], existingLabels: labels ?? [] };
  }

  const suggestedTags = await autoTagContent(userId, model, body_html, { isHtml: true });

  return {
    suggestedTags,
    existingLabels: labels ?? [],
  };
}

/**
 * Apply tags to a page's pages labels column.
 */
export async function applyTags(
  userId: string,
  confluenceId: string,
  tags: AllowedTag[],
): Promise<string[]> {
  // Merge with existing labels (avoid duplicates)
  const existing = await query<{ labels: string[] }>(
    'SELECT labels FROM pages WHERE confluence_id = $1',
    [confluenceId],
  );

  if (existing.rows.length === 0) {
    throw new Error(`Page not found: ${confluenceId}`);
  }

  const existingLabels = existing.rows[0].labels ?? [];
  const mergedLabels = Array.from(new Set([...existingLabels, ...tags]));

  await query(
    'UPDATE pages SET labels = $2 WHERE confluence_id = $1',
    [confluenceId, mergedLabels],
  );

  // Sync labels to Confluence
  try {
    const client = await getClientForUser(userId);
    if (client) {
      const newTags = tags.filter((t) => !existingLabels.includes(t));
      if (newTags.length > 0) {
        await client.addLabels(confluenceId, newTags);
      }
    }
  } catch (err) {
    logger.error({ err, confluenceId, userId }, 'Failed to sync labels to Confluence');
  }

  return mergedLabels;
}

/**
 * Auto-tag all pages without labels for a user (admin background job).
 */
export async function autoTagAllPages(
  userId: string,
  model: string,
): Promise<{ tagged: number; errors: number }> {
  const pages = await query<{
    confluence_id: string;
    body_html: string;
  }>(
    `SELECT cp.confluence_id, cp.body_html
     FROM pages cp
     JOIN user_space_selections uss ON cp.space_key = uss.space_key AND uss.user_id = $1
     WHERE cp.deleted_at IS NULL
       AND (cp.labels IS NULL OR array_length(cp.labels, 1) IS NULL)
       AND cp.body_html IS NOT NULL`,
    [userId],
  );

  let tagged = 0;
  let errors = 0;

  for (const page of pages.rows) {
    try {
      const suggestedTags = await autoTagContent(userId, model, page.body_html, { isHtml: true });
      if (suggestedTags.length > 0) {
        await applyTags(userId, page.confluence_id, suggestedTags);
        tagged++;
      }
    } catch (err) {
      logger.error({ err, confluenceId: page.confluence_id }, 'Failed to auto-tag page');
      errors++;
    }
  }

  return { tagged, errors };
}
