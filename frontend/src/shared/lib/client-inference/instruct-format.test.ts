import { describe, expect, it } from 'vitest';
import {
  buildContinuationPrompt,
  capMaxTokens,
  normalizeInlineCompletion,
  rewriteMaxNewTokens,
} from './instruct-format';

describe('normalizeInlineCompletion (#1418 SPEC-020)', () => {
  it('keeps one line and strips fences', () => {
    expect(normalizeInlineCompletion(' hello\nworld```')).toBe(' hello');
  });

  it('does not emit FIM markers', () => {
    expect(normalizeInlineCompletion('<PRE>keep<MID> x')).toBe('keep x');
  });
});

describe('buildContinuationPrompt', () => {
  it('is instruct, not FIM', () => {
    const prompt = buildContinuationPrompt('Rotate the', ' before expiry');
    expect(prompt).not.toMatch(/<PRE>|<SUF>|<MID>/);
    expect(prompt).toContain('Rotate the');
    expect(prompt).toContain('before expiry');
  });
});

describe('caps', () => {
  it('caps word mode at 8 and full at 48, never above 64', () => {
    expect(capMaxTokens(64, true)).toBe(8);
    expect(capMaxTokens(64, false)).toBe(48);
    expect(capMaxTokens(3, false)).toBe(3);
  });

  it('bounds rewrite tokens', () => {
    expect(rewriteMaxNewTokens(10)).toBe(64);
    expect(rewriteMaxNewTokens(10_000)).toBe(512);
  });
});
