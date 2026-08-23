import { describe, expect, it } from 'vitest';
import { InlineCompletionModeSchema, UpdateSettingsSchema } from './settings.js';

describe('inline completion settings', () => {
  it('accepts word and full as completion modes', () => {
    expect(InlineCompletionModeSchema.parse('word')).toBe('word');
    expect(InlineCompletionModeSchema.parse('full')).toBe('full');
  });

  it('rejects an unknown completion mode on settings updates', () => {
    expect(() => UpdateSettingsSchema.parse({ inlineCompletionMode: 'paragraph' })).toThrow();
  });
});
