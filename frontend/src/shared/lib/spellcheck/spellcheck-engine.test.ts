import { describe, expect, it } from 'vitest';
import { isMisspelling, tokenize } from './spellcheck-engine';

describe('bilingual spell verdict (#1418 SPEC-029)', () => {
  const en = (w: string) => ['the', 'house'].includes(w.toLowerCase());
  const de = (w: string) => ['straße', 'haus'].includes(w.toLowerCase());

  it('does not flag a German word when de_DE accepts it', () => {
    expect(isMisspelling('Straße', [en, de])).toBe(false);
  });

  it('flags a token only when every enabled dict rejects it', () => {
    expect(isMisspelling('xyzzy', [en, de])).toBe(true);
    expect(isMisspelling('house', [en, de])).toBe(false);
  });

  it('consults only installed dictionaries', () => {
    expect(isMisspelling('Straße', [en])).toBe(true);
  });
});

describe('tokenize', () => {
  it('returns word ranges', () => {
    expect(tokenize('Hello, Straße.')).toEqual([
      { word: 'Hello', from: 0, to: 5 },
      { word: 'Straße', from: 7, to: 13 },
    ]);
  });
});
