import { describe, it, expect } from 'vitest';
import { initialTitleFromQuestion, CONVERSATION_TITLE_MAX } from './conversation-title.js';

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
});
