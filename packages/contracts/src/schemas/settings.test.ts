import { describe, expect, it } from 'vitest';
import {
  ClientSpellcheckLanguageSchema,
  InlineCompletionModeSchema,
  SettingsResponseSchema,
  UpdateSettingsSchema,
} from './settings.js';

describe('inline completion settings', () => {
  it('accepts word and full as completion modes', () => {
    expect(InlineCompletionModeSchema.parse('word')).toBe('word');
    expect(InlineCompletionModeSchema.parse('full')).toBe('full');
  });

  it('rejects an unknown completion mode on settings updates', () => {
    expect(() => UpdateSettingsSchema.parse({ inlineCompletionMode: 'paragraph' })).toThrow();
  });
});

describe('client inference / spellcheck settings (#1418)', () => {
  it('does not default omitted client flags on a patch (siblings must survive)', () => {
    const parsed = UpdateSettingsSchema.parse({ inlineCompletionEnabled: false });
    expect(parsed).toEqual({ inlineCompletionEnabled: false });
    expect('clientInferenceEnabled' in parsed).toBe(false);
    expect('clientInferenceWithoutServer' in parsed).toBe(false);
    expect('clientSpellcheckEnabled' in parsed).toBe(false);
    expect('clientSpellcheckLanguages' in parsed).toBe(false);
  });

  it('accepts the closed spellcheck language pair and rejects others', () => {
    expect(ClientSpellcheckLanguageSchema.parse('en_US')).toBe('en_US');
    expect(ClientSpellcheckLanguageSchema.parse('de_DE')).toBe('de_DE');
    expect(() => ClientSpellcheckLanguageSchema.parse('fr_FR')).toThrow();
    expect(UpdateSettingsSchema.parse({
      clientSpellcheckLanguages: ['de_DE'],
    }).clientSpellcheckLanguages).toEqual(['de_DE']);
  });

  it('requires the dual-opt-in and spellcheck fields on the read schema', () => {
    const base = {
      confluenceUrl: null,
      hasConfluencePat: false,
      selectedSpaces: [],
      theme: 'graphite',
      syncIntervalMin: 15,
      confluenceConnected: false,
      showSpaceHomeContent: true,
      customPrompts: {},
      confluencePatPromptDismissed: false,
      inlineCompletionEnabled: true,
      inlineCompletionDelay: 'balanced',
      inlineCompletionMode: 'full',
      inlineCompletionCodeOnly: false,
      clientInferenceEnabled: false,
      clientInferenceWithoutServer: true,
      clientInferenceAdminEnabled: false,
      clientSpellcheckEnabled: false,
      clientSpellcheckLanguages: ['en_US', 'de_DE'],
      onboardingState: {},
    };
    expect(SettingsResponseSchema.parse(base).clientInferenceWithoutServer).toBe(true);
    const { clientInferenceEnabled: _drop, ...without } = base;
    expect(() => SettingsResponseSchema.parse(without)).toThrow();
  });
});
