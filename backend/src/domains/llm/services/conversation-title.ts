import { query } from '../../../core/db/postgres.js';
import { logger } from '../../../core/utils/logger.js';
import { sanitizeLlmInput } from '../../../core/utils/sanitize-llm-input.js';
import { resolveUsecase } from './llm-provider-resolver.js';
import { chat, type ChatMessage } from './openai-compatible-client.js';

/** Generated-title cap; the fallback may add `…`, while manual rename allows 200 chars. */
export const CONVERSATION_TITLE_MAX = 80;
/** A word boundary this far back is preferred over a hard cut. */
const MIN_WORD_BOUNDARY = 40;

const TITLE_QUESTION_MAX_CHARS = 1_000;
const TITLE_ANSWER_MAX_CHARS = 1_500;
const TITLE_MAX_TOKENS = 32;
const TITLE_TIMEOUT_MS = 20_000;

const TITLE_SYSTEM_PROMPT =
  'You write titles for chat conversations. Reply with only the title: at most eight words, one line, no quotes, no markdown, no trailing punctuation, in the language of the question.';

/**
 * The initial title of a new conversation: the first question, whitespace
 * collapsed, cut on a word boundary at ≤ 80 chars with an ellipsis (#1361).
 * Replaces the mid-word `question.slice(0, 100)`. The async auto-title
 * overwrites it only while `title_source = 'question'`.
 */
export function initialTitleFromQuestion(question: string): string {
  const collapsed = question.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= CONVERSATION_TITLE_MAX) return collapsed;
  let cut = collapsed.slice(0, CONVERSATION_TITLE_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace >= MIN_WORD_BOUNDARY) cut = cut.slice(0, lastSpace);
  cut = cut.replace(/[\s,;:.!?…-]+$/u, '');
  if (cut === '') return '';
  return `${cut}…`;
}

/**
 * Turn a model reply into the single-line title stored on a conversation.
 * The model is instructed to provide this shape, but the boundary is still
 * defensive: provider preambles and presentation markup never reach the UI.
 */
export function normalizeGeneratedTitle(raw: string): string | null {
  let title = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!title) return null;

  // Providers commonly add a heading, label, emphasis, or quotes despite the
  // prompt. Peel those wrappers in a stable order, then repeat the label pass
  // for replies such as `**Title:** "Rotate the PAT"`.
  title = title
    .replace(/^#{1,6}\s+/u, '')
    .replace(/^(?:\*\*|__|\*|_|~~|`)+|(?:\*\*|__|\*|_|~~|`)+$/gu, '')
    .trim()
    .replace(/^title\s*:\s*/iu, '')
    .trim()
    .replace(/^(?:["'“‘]+)|(?:["'”’]+)$/gu, '')
    .trim()
    .replace(/^(?:\*\*|__|\*|_|~~|`)+|(?:\*\*|__|\*|_|~~|`)+$/gu, '')
    .trim()
    .replace(/^title\s*:\s*/iu, '')
    .replace(/^(?:["'“‘]+)|(?:["'”’]+)$/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/[\s\p{P}]+$/u, '')
    .trim();

  if (title.length === 0) return null;
  if (title.length <= CONVERSATION_TITLE_MAX) return title;

  let cut = title.slice(0, CONVERSATION_TITLE_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace >= MIN_WORD_BOUNDARY) cut = cut.slice(0, lastSpace);
  cut = cut.replace(/[\s\p{P}]+$/u, '').trim();
  return cut.length > 0 ? cut : null;
}

export interface GenerateConversationTitleOptions {
  conversationId: string;
  userId: string;
  question: string;
  answer: string;
  refused: boolean;
}

/** Compare-and-set the generated title without moving the conversation row. */
export async function persistGeneratedConversationTitle(
  conversationId: string,
  userId: string,
  title: string,
): Promise<boolean> {
  const result = await query<{ id: string }>(
    `UPDATE llm_conversations
        SET title = $3, title_source = 'generated'
      WHERE id = $1 AND user_id = $2 AND title_source = 'question'
      RETURNING id`,
    [conversationId, userId, title],
  );
  return result.rows.length > 0;
}

/**
 * Generate and persist the title of a newly-created conversation (#1361).
 *
 * This function is deliberately total: it owns its try/catch so callers can
 * fire-and-forget it after the terminal SSE frame. Every failure leaves the
 * initial question-derived title in place. The write is a compare-and-set on
 * `title_source = 'question'`, so a manual rename that wins the race is never
 * overwritten by a late model response.
 */
export async function generateConversationTitle({
  conversationId,
  userId,
  question,
  answer,
  refused,
}: GenerateConversationTitleOptions): Promise<void> {
  try {
    const { config, model } = await resolveUsecase('chat');
    const safeQuestion = sanitizeLlmInput(question.slice(0, TITLE_QUESTION_MAX_CHARS)).sanitized;
    const safeAnswer = refused
      ? null
      : sanitizeLlmInput(answer.slice(0, TITLE_ANSWER_MAX_CHARS)).sanitized;

    const userContent = safeAnswer === null
      ? `Question:\n${safeQuestion}`
      : `Question:\n${safeQuestion}\n\nAnswer:\n${safeAnswer}`;
    const messages: ChatMessage[] = [
      { role: 'system', content: TITLE_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ];

    const rawTitle = await chat(config, model, messages, {
      maxTokens: TITLE_MAX_TOKENS,
      timeoutMs: TITLE_TIMEOUT_MS,
    });
    const title = normalizeGeneratedTitle(rawTitle);
    if (!title) {
      logger.warn(
        { conversationId },
        'Conversation auto-title produced no usable title; keeping the question-derived title',
      );
      return;
    }

    await persistGeneratedConversationTitle(conversationId, userId, title);
  } catch (err) {
    logger.warn(
      { err, conversationId },
      'Conversation auto-title failed; keeping the question-derived title',
    );
  }
}
