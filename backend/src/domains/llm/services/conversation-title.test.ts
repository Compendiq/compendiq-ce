import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockResolveUsecase = vi.fn();
const mockChat = vi.fn();
const mockQuery = vi.fn();
const mockSanitize = vi.fn((input: string) => ({ sanitized: input, wasModified: false, warnings: [] }));

vi.mock('./llm-provider-resolver.js', () => ({
  resolveUsecase: (...args: unknown[]) => mockResolveUsecase(...args),
}));
vi.mock('./openai-compatible-client.js', () => ({
  chat: (...args: unknown[]) => mockChat(...args),
}));
vi.mock('../../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));
vi.mock('../../../core/utils/sanitize-llm-input.js', () => ({
  sanitizeLlmInput: (input: string) => mockSanitize(input),
}));

import {
  CONVERSATION_TITLE_MAX,
  generateConversationTitle,
  initialTitleFromQuestion,
  normalizeGeneratedTitle,
} from './conversation-title.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveUsecase.mockResolvedValue({
    config: { providerId: 'p1', baseUrl: 'http://llm/v1', apiKey: null, authType: 'none', verifySsl: true },
    model: 'chat-model',
  });
  mockChat.mockResolvedValue('Rotate Confluence Access Tokens');
  mockQuery.mockResolvedValue({ rows: [] });
});

describe('initialTitleFromQuestion', () => {
  it('passes a short question through, whitespace collapsed', () => {
    expect(initialTitleFromQuestion('  how do we\n\n rotate   the PAT? ')).toBe('how do we rotate the PAT?');
  });

  it('cuts a long question at a word boundary, strips trailing punctuation, appends an ellipsis', () => {
    const q = 'What is the recommended procedure for rotating the Confluence personal access token, and who owns it?';
    const t = initialTitleFromQuestion(q);
    expect(t.length).toBeLessThanOrEqual(CONVERSATION_TITLE_MAX + 1);
    expect(t.endsWith('…')).toBe(true);
    // never mid-word: the char before the ellipsis is a word char, and the
    // title without the ellipsis is a prefix of the question ending at a space
    const stem = t.slice(0, -1);
    expect(q.startsWith(stem)).toBe(true);
    expect(q[stem.length]).toBe(' ');
    expect(stem).not.toMatch(/[,;:.!?…-]$/u);
  });

  it('hard-cuts at the maximum when no word boundary sits past the minimum', () => {
    const t = initialTitleFromQuestion('a'.repeat(120));
    expect(t).toBe('a'.repeat(CONVERSATION_TITLE_MAX) + '…');
  });

  it('returns an empty string for a whitespace-only question (the read side COALESCEs it)', () => {
    expect(initialTitleFromQuestion('   \n ')).toBe('');
  });

  it('returns an empty string when the cut is only punctuation (the read side COALESCEs it)', () => {
    expect(initialTitleFromQuestion('?'.repeat(100))).toBe('');
  });
});

describe('normalizeGeneratedTitle', () => {
  it.each([
    ['"Rotate the Confluence PAT."', 'Rotate the Confluence PAT'],
    ['**Title:** Rotate access tokens!', 'Rotate access tokens'],
    ['**Title:** "Rotate access tokens."', 'Rotate access tokens'],
    ['# German title\nignored second line', 'German title'],
    ['\n\n  __A concise title__  \nAnother line', 'A concise title'],
    ['アクセストークンの更新。', 'アクセストークンの更新'],
  ])('normalizes %j', (raw, expected) => {
    expect(normalizeGeneratedTitle(raw)).toBe(expected);
  });

  it('caps a long reply at a word boundary without adding punctuation', () => {
    const raw = 'A deliberately long generated conversation title that keeps going beyond the configured maximum length for display';
    const title = normalizeGeneratedTitle(raw);
    expect(title).not.toBeNull();
    expect(title!.length).toBeLessThanOrEqual(CONVERSATION_TITLE_MAX);
    expect(raw.startsWith(title!)).toBe(true);
    expect(raw[title!.length]).toBe(' ');
    expect(title).not.toMatch(/[\s,;:.!?…-]$/u);
  });

  it.each(['', ' \n ', '***', 'Title: ...'])('rejects an empty or presentation-only reply %j', (raw) => {
    expect(normalizeGeneratedTitle(raw)).toBeNull();
  });
});

describe('generateConversationTitle', () => {
  const base = {
    conversationId: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    question: 'How do we rotate the PAT?',
    answer: 'Use the security settings page.',
    refused: false,
  };

  it('uses the chat assignment, sanitizes bounded inputs, and compare-and-sets the generated title', async () => {
    await generateConversationTitle({
      ...base,
      question: `Q${'x'.repeat(1_200)}`,
      answer: `A${'y'.repeat(1_700)}`,
    });

    expect(mockResolveUsecase).toHaveBeenCalledWith('chat');
    expect(mockSanitize).toHaveBeenCalledTimes(2);
    expect((mockSanitize.mock.calls[0]![0] as string)).toHaveLength(1_000);
    expect((mockSanitize.mock.calls[1]![0] as string)).toHaveLength(1_500);
    expect(mockChat).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'p1' }),
      'chat-model',
      [
        expect.objectContaining({ role: 'system', content: expect.stringContaining('at most eight words') }),
        expect.objectContaining({ role: 'user', content: expect.stringContaining('Question:\n') }),
      ],
      { maxTokens: 32, timeoutMs: 20_000 },
    );
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("title_source = 'generated'");
    expect(sql).toContain("title_source = 'question'");
    expect(sql).toContain('RETURNING id');
    expect(sql).not.toContain('updated_at');
    expect(params).toEqual([base.conversationId, base.userId, 'Rotate Confluence Access Tokens']);
  });

  it('omits a refused answer from the model prompt and sanitizes only the question', async () => {
    await generateConversationTitle({ ...base, refused: true, answer: 'Internal refusal detail' });

    expect(mockSanitize).toHaveBeenCalledTimes(1);
    const messages = mockChat.mock.calls[0]![2] as Array<{ role: string; content: string }>;
    expect(messages[1]!.content).toBe(`Question:\n${base.question}`);
    expect(messages[1]!.content).not.toContain(base.answer);
  });

  it.each([
    ['provider failure', () => mockResolveUsecase.mockRejectedValue(new Error('unassigned'))],
    ['model failure', () => mockChat.mockRejectedValue(new Error('timeout'))],
    ['empty output', () => mockChat.mockResolvedValue('***')],
    ['database failure', () => mockQuery.mockRejectedValue(new Error('db down'))],
  ])('soft-fails on %s and leaves the fallback title in place', async (_name, arrange) => {
    arrange();
    await expect(generateConversationTitle(base)).resolves.toBeUndefined();
    if (_name !== 'database failure') expect(mockQuery).not.toHaveBeenCalled();
  });
});
