import { describe, expect, it } from 'vitest';
import {
  IMAGE_AXIS,
  IMAGE_AXIS_LANGUAGE,
  TEXT_AXIS,
  assertComparableAxis,
  parseImageAxisLanguage,
  readImageAxisEnv,
  wantsImageAxis,
} from './images-axis.js';
import { assertKnownFlags, EVAL_KNOWN_FLAGS, EVAL_USAGE, EVAL_VALUELESS_FLAGS } from './cli-flags.js';

/**
 * #1115 P5b — the `--images` axis's refusals.
 *
 * Every one of them exists because the alternative is a run that completes and
 * publishes a number describing something other than what its label says: an
 * English fixture over a German corpus, a leg-off measurement labelled
 * leg-on because the VL endpoint was never configured, or a paired comparison
 * between two reports that measured different corpora on different axes.
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

describe('readImageAxisEnv', () => {
  const BASE = {
    EVAL_IMAGE_EMBEDDING_BASE_URL: 'http://127.0.0.1:8011/v1',
    EVAL_IMAGE_EMBEDDING_MODEL: 'Qwen3-VL-Embedding-2B',
  } as NodeJS.ProcessEnv;

  it('reads the endpoint and the model', () => {
    expect(readImageAxisEnv(BASE)).toEqual({
      baseUrl: 'http://127.0.0.1:8011/v1',
      model: 'Qwen3-VL-Embedding-2B',
      targetDimensions: null,
    });
  });

  it('refuses a missing endpoint by name, never falling back to the TEXT embedder', () => {
    // The text endpoint is right there in the environment and would answer —
    // with a text-space vector, through the wrong request shape. That is the
    // silent-wrong-vectors class ADR-021's non-inheriting rule exists for.
    const boom = () => readImageAxisEnv({ EVAL_EMBEDDING_BASE_URL: 'http://text/v1' } as NodeJS.ProcessEnv);
    expect(boom).toThrow(/EVAL_IMAGE_EMBEDDING_BASE_URL/);
    expect(boom).toThrow(/EVAL_IMAGE_EMBEDDING_MODEL/);
  });

  it('refuses a missing model even when the endpoint is set', () => {
    expect(() => readImageAxisEnv({ EVAL_IMAGE_EMBEDDING_BASE_URL: 'http://h/v1' } as NodeJS.ProcessEnv))
      .toThrow(/EVAL_IMAGE_EMBEDDING_MODEL/);
  });

  it('reads an optional MRL truncation width', () => {
    expect(readImageAxisEnv({ ...BASE, EVAL_IMAGE_EMBEDDING_DIMENSIONS: '2048' }).targetDimensions).toBe(2048);
  });

  it('refuses a nonsense truncation width instead of quietly measuring the native one', () => {
    // `getImageEmbeddingTargetDimensions` DISCARDS an out-of-range row, because
    // that value can arrive from a restored dump. This one was typed for this
    // run, and measuring the native width under a report naming 2048 is the
    // mislabelling the whole rig refuses elsewhere.
    for (const raw of ['0', '-1', 'wide', '2048.5', '99999']) {
      expect(() => readImageAxisEnv({ ...BASE, EVAL_IMAGE_EMBEDDING_DIMENSIONS: raw }))
        .toThrow(/EVAL_IMAGE_EMBEDDING_DIMENSIONS/);
    }
  });

  it('records the serving backend as a free-text label when one is given', () => {
    expect(readImageAxisEnv({ ...BASE, EVAL_IMAGE_EMBEDDING_BACKEND: 'llama' }).backend).toBe('llama');
    expect(readImageAxisEnv(BASE).backend).toBeUndefined();
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
