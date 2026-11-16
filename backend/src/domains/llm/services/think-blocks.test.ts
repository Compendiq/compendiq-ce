import { describe, expect, it } from 'vitest';
import { stripClosedThinkBlocks, stripThinkBlocks } from './think-blocks.js';

describe('stripThinkBlocks', () => {
  it.each([
    ['no tags', 'Rotating a PAT', 'Rotating a PAT', false],
    ['one closed block', '<think>plan</think>\nAnswer', '\nAnswer', false],
    ['several closed blocks', '<think>a</think>One<think>b\nc</think> Two', 'One Two', false],
    ['mixed case tags', '<THINK>x</Think>Visible', 'Visible', false],
    ['closed block only', '<think>all reasoning</think>', '', false],
    ['orphan closer', 'planning aloud</think>\nThe title', '\nThe title', false],
    ['several orphan closers keep text after the last', 'a</think>b</think>c', 'c', false],
    ['unclosed opener alone', '<think>\nOkay, the user is asking…', '', true],
    ['unclosed opener after text', 'Partial title <think>hmm', 'Partial title ', true],
    ['closed block then unclosed one', '<think>a</think>Visible <think>b', 'Visible ', true],
  ])('%s', (_name, input, text, unclosed) => {
    expect(stripThinkBlocks(input)).toEqual({ text, unclosed });
  });
});

describe('stripClosedThinkBlocks', () => {
  it('removes closed blocks case-insensitively', () => {
    expect(stripClosedThinkBlocks('<think>a</think>x<THINK>b</THINK>y')).toBe('xy');
  });

  it.each(['orphan</think> closer', 'text <think>unclosed', 'plain'])(
    'leaves orphan or unclosed input untouched: %j',
    (input) => {
      expect(stripClosedThinkBlocks(input)).toBe(input);
    },
  );
});
