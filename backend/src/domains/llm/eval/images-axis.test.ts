import { describe, expect, it } from 'vitest';
import {
  IMAGE_AXIS,
  IMAGE_AXIS_LANGUAGE,
  TEXT_AXIS,
  assertComparableAxis,
  assertImageAxisStagesPairable,
  parseImageAxisLanguage,
  wantsImageAxis,
} from './images-axis.js';
import { assertKnownFlags, EVAL_KNOWN_FLAGS, EVAL_USAGE, EVAL_VALUELESS_FLAGS } from './cli-flags.js';

/**
 * #1115 P5b — the `--images` axis's refusals.
 *
 * Every one of them exists because the alternative is a run that completes and
 * publishes a number describing something other than what its label says: an
 * English fixture over a German corpus, or a comparison between two reports
 * that measured different corpora on different axes.
 */

describe('the --images flag itself', () => {
  it('is a known, valueless flag the shared guard admits', () => {
    expect(EVAL_KNOWN_FLAGS).toContain('images');
    expect(EVAL_VALUELESS_FLAGS).toContain('images');
    expect(() => assertKnownFlags(['--images'], EVAL_KNOWN_FLAGS, EVAL_USAGE, EVAL_VALUELESS_FLAGS)).not.toThrow();
  });

  it('refuses the = spelling, like every other switch', () => {
    // `wantsImageAxis` reads it with `includes`, so `--images=true` would run
    // the TEXT axis under a report that says images.
    const boom = () => assertKnownFlags(['--images=true'], EVAL_KNOWN_FLAGS, EVAL_USAGE, EVAL_VALUELESS_FLAGS);
    expect(boom).toThrow(/--images/);
    expect(boom).toThrow(/takes no value/i);
  });

  it('is documented in the usage text', () => {
    expect(EVAL_USAGE).toContain('--images');
  });

  it('is read as a bare switch', () => {
    expect(wantsImageAxis(['--images'])).toBe(true);
    expect(wantsImageAxis(['--rerank'])).toBe(false);
  });
});

describe('parseImageAxisLanguage', () => {
  it('implies de when --lang is absent', () => {
    expect(parseImageAxisLanguage(['--images'])).toBe(IMAGE_AXIS_LANGUAGE);
  });

  it('accepts the redundant --lang de', () => {
    expect(parseImageAxisLanguage(['--images', '--lang', 'de'])).toBe('de');
  });

  it('refuses --lang en, which would score German pages against an English corpus that is not seeded', () => {
    const boom = () => parseImageAxisLanguage(['--images', '--lang', 'en']);
    expect(boom).toThrow(/--images/);
    expect(boom).toThrow(/de/);
  });

  it('refuses any other language too, rather than silently loading a fixture that does not exist', () => {
    expect(() => parseImageAxisLanguage(['--images', '--lang=fr'])).toThrow(/fr/);
  });
});

describe('assertImageAxisStagesPairable', () => {
  it('admits the stage flags that really are held constant across both arms', () => {
    expect(() => assertImageAxisStagesPairable(['--images', '--rerank', '--mmr', '--no-pin', '--no-assemble']))
      .not.toThrow();
  });

  it('refuses --deep-search, whose paraphrases are drawn afresh on every call', () => {
    // Each arm calls `multiQuerySearch`, which calls `reformulateQuery` — one
    // unseeded, uncached chat completion with no seam for a precomputed list.
    // So the arms get DIFFERENT paraphrases, two of each arm's three fused legs
    // differ for a reason that is not the image leg, and the pairing McNemar
    // needs is gone while the report still claims it.
    const boom = () => assertImageAxisStagesPairable(['--images', '--deep-search']);
    expect(boom).toThrow(/--deep-search/);
    expect(boom).toThrow(/paraphrase/i);
  });
});

describe('assertComparableAxis', () => {
  it('accepts two image-axis reports', () => {
    expect(() => assertComparableAxis(IMAGE_AXIS, IMAGE_AXIS)).not.toThrow();
  });

  it('reads an absent axis as the text gate, which is what every report before P5b was', () => {
    expect(() => assertComparableAxis(undefined, TEXT_AXIS)).not.toThrow();
  });

  it('refuses a text baseline against an image run, and says which is which', () => {
    const boom = () => assertComparableAxis(undefined, IMAGE_AXIS);
    expect(boom).toThrow(/text/i);
    expect(boom).toThrow(/images/i);
  });

  it('refuses an image baseline against a text run', () => {
    expect(() => assertComparableAxis(IMAGE_AXIS, TEXT_AXIS)).toThrow(/images/i);
  });
});
