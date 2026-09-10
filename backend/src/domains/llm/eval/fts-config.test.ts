import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EVAL_FTS_LANGUAGE,
  parseFtsLanguageArg,
  assertComparableFtsLanguage,
} from './fts-config.js';

// #1114 — the eval never wrote admin_settings.fts_language, so every run so
// far scored its lexical leg under 'simple' whatever --lang said, and no
// report recorded which configuration produced its numbers. These tests pin
// the two halves of the fix: the flag, and the refusal that keeps two
// configurations from being compared as if they were one.

describe('parseFtsLanguageArg (#1114)', () => {
  it('defaults to simple, which is what every recorded baseline was measured under', () => {
    expect(parseFtsLanguageArg([])).toBe('simple');
    expect(DEFAULT_EVAL_FTS_LANGUAGE).toBe('simple');
  });

  it('is NOT derived from --lang: a German corpus run still defaults to simple', () => {
    // The corpus language and the Postgres text-search configuration are
    // separate choices. Deriving one from the other would silently re-measure
    // every German baseline recorded so far under a different lexical index
    // and report the difference as a retrieval change.
    expect(parseFtsLanguageArg(['--lang', 'de'])).toBe('simple');
    expect(parseFtsLanguageArg(['--lang=de'])).toBe('simple');
  });

  it('reads both --fts-language X and --fts-language=X', () => {
    expect(parseFtsLanguageArg(['--fts-language', 'german'])).toBe('german');
    expect(parseFtsLanguageArg(['--fts-language=german'])).toBe('german');
    expect(parseFtsLanguageArg(['--lang', 'de', '--fts-language', 'german', '--rerank'])).toBe('german');
  });

  it('refuses a configuration Postgres does not carry, rather than silently falling back', () => {
    // getFtsLanguage() returns 'simple' for an unknown value. A run that asked
    // for 'klingon' and got 'simple' would publish a report labelled klingon.
    expect(() => parseFtsLanguageArg(['--fts-language', 'klingon'])).toThrow(/klingon/);
    expect(() => parseFtsLanguageArg(['--fts-language', 'klingon'])).toThrow(/german/);
  });

  it('refuses an empty or missing value instead of reading the next flag as one', () => {
    expect(() => parseFtsLanguageArg(['--fts-language'])).toThrow(/--fts-language/);
    expect(() => parseFtsLanguageArg(['--fts-language', '--rerank'])).toThrow(/--fts-language/);
    expect(() => parseFtsLanguageArg(['--fts-language='])).toThrow(/--fts-language/);
  });
});

describe('assertComparableFtsLanguage (#1114)', () => {
  it('accepts a matching pair', () => {
    expect(() => assertComparableFtsLanguage('german', 'german')).not.toThrow();
    expect(() => assertComparableFtsLanguage('simple', 'simple')).not.toThrow();
  });

  it('accepts a pre-#1114 baseline against a simple run — absent IS simple', () => {
    expect(() => assertComparableFtsLanguage(undefined, 'simple')).not.toThrow();
  });

  it('refuses a mismatched pair, naming both configurations', () => {
    expect(() => assertComparableFtsLanguage('simple', 'german')).toThrow(/simple/);
    expect(() => assertComparableFtsLanguage('simple', 'german')).toThrow(/german/);
    expect(() => assertComparableFtsLanguage('simple', 'german')).toThrow(/--fts-language/);
  });

  it('tells the reader that a baseline without the field was measured under simple', () => {
    // Otherwise the refusal reads as a missing-field bug rather than as the
    // fact it is: every report written before this change was fts=simple.
    expect(() => assertComparableFtsLanguage(undefined, 'german')).toThrow(/records no ftsLanguage/i);
    expect(() => assertComparableFtsLanguage(undefined, 'german')).toThrow(/simple/);
  });
});
