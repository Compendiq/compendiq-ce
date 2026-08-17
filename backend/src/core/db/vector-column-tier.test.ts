import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IMAGE_EMBEDDING_TARGET_DIMENSIONS_MAX } from '@compendiq/contracts';
import {
  columnTypeFor,
  HNSW_PARAMS,
  VECTOR_MAX_DIMS,
  type VectorColumnTier,
} from './vector-column-tier.js';

/**
 * The tiering rule lived in four places by #1115 — `shadow-migration-service`,
 * `embedding-service`'s destructive re-embed, `eval/seed` and (about to be) the
 * image index. Three of them were byte-identical; the fourth was the same rule
 * spelled as an if/else over interpolated SQL. This is the one copy.
 *
 * The boundary cases are the whole content of the rule, so they are the test:
 * 2000/2001 and 4000/4001 are where pgvector's HNSW limits sit.
 */
describe('columnTypeFor', () => {
  it.each([
    [1, 'vector(1)', 'vector_cosine_ops', 'vector'],
    [1024, 'vector(1024)', 'vector_cosine_ops', 'vector'],
    [2000, 'vector(2000)', 'vector_cosine_ops', 'vector'],
    [2001, 'halfvec(2001)', 'halfvec_cosine_ops', 'halfvec'],
    [2560, 'halfvec(2560)', 'halfvec_cosine_ops', 'halfvec'],
    [4000, 'halfvec(4000)', 'halfvec_cosine_ops', 'halfvec'],
  ])('%i dims → %s indexed with %s', (dims, columnType, opclass, tier) => {
    expect(columnTypeFor(dims)).toEqual({ columnType, opclass, tier });
  });

  // Above 4000 there is no HNSW opclass at all — the column stays `vector` and
  // queries sequentially scan. Callers must WARN rather than silently omit an
  // index, which is why the tier is named rather than implied by `opclass:
  // null`.
  it('leaves widths over 4000 unindexed on a plain vector column', () => {
    expect(columnTypeFor(4096)).toEqual({
      columnType: 'vector(4096)',
      opclass: null,
      tier: 'unindexed' satisfies VectorColumnTier,
    });
  });

  // pgvector type arguments are LITERAL — they cannot be bound — so every
  // caller interpolates this string into DDL. A non-integer or out-of-range
  // width must never reach that interpolation.
  it.each([0, -1, 16_001, 2048.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses %s rather than interpolating it into DDL',
    (bad) => {
      expect(() => columnTypeFor(bad)).toThrow(/dimension/i);
    },
  );

  it('exposes the HNSW build parameters migrations 011/048 use', () => {
    expect(HNSW_PARAMS).toBe('WITH (m = 16, ef_construction = 200)');
  });

  /**
   * Final review, nit 4 — the same pgvector ceiling is stated twice: here, as
   * the widest column `columnTypeFor` will plan, and in the contracts as the
   * upper bound on the MRL truncation width an admin may ask for. They are one
   * number, and they have to move together: a contracts bound raised above this
   * one would let a width through `ImageEmbeddingTargetDimensionsSchema` that
   * `columnTypeFor` then throws on *after* the probe has succeeded, and a lower
   * one would refuse a width the column could hold. The equality lives on this
   * side because `packages/contracts` cannot import the backend, while the
   * backend imports contracts everywhere.
   */
  it('shares pgvector’s column ceiling with the contracts truncation bound', () => {
    expect(VECTOR_MAX_DIMS).toBe(IMAGE_EMBEDDING_TARGET_DIMENSIONS_MAX);
  });
});

/**
 * Move, not copy (#1115). A fifth private copy is how the rule drifts, and it
 * drifts silently: a `halfvec` column with a `vector_cosine_ops` index simply
 * fails to build, but a *missing* index only shows up as latency.
 */
describe('the tiering rule has exactly one definition', () => {
  const CALLERS = [
    'domains/llm/services/shadow-migration-service.ts',
    'domains/llm/services/embedding-service.ts',
    'domains/llm/eval/seed.ts',
  ];

  it.each(CALLERS)('%s imports the shared helper instead of re-deriving it', (rel) => {
    const src = readFileSync(resolve(__dirname, '..', '..', rel), 'utf8');
    expect(src).toMatch(/from '(\.\.\/)+core\/db\/vector-column-tier\.js'/);
    // The literal opclass names may only reach SQL through the helper. Comment
    // lines are exempt — `embedding-service` explains the DROP-before-ALTER
    // ordering by naming the opclass, which is prose about the rule, not a
    // second copy of it.
    const code = src
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/vector_cosine_ops/);
    expect(code).not.toMatch(/halfvec_cosine_ops/);
  });
});
