import { describe, it, expect } from 'vitest';
import {
  groupByPage,
  imageRawLimit,
  IMAGE_PAGE_FANOUT,
  IMAGE_RAW_LIMIT_CAP,
  MAX_IMAGE_HITS_PER_PAGE,
} from './image-leg-search.js';

/**
 * The image leg's page-denomination ARITHMETIC (#1115 P3, review r3).
 *
 * Its behaviour against real Postgres lives in
 * `image-leg-search.integration.test.ts`; these two functions are pure, and
 * both were deletable with the whole suite green — `imageRawLimit` could be
 * replaced by the identity and `groupByPage`'s page cap by `void limit`
 * without a single failure. Both are documented as load-bearing, so they get
 * the vector leg's treatment: its own `page-denominated vector fetch (#1106
 * PR 1)` block does exactly this for `vectorRawLimit`.
 *
 * They are in a UNIT file rather than beside the integration cases because
 * that file is `describe.skipIf(!dbAvailable)`, and arithmetic that needs no
 * database should not go dark with one.
 */

/** The `ImageRow` shape `imageKnn` produces, minimal and ordered by the caller. */
function row(pageId: number, key: string) {
  return {
    pageId,
    source: 'confluence' as const,
    key,
    similarity: 0.5,
    attachmentUrl: `/api/attachments/${pageId}/${key}`,
  };
}

describe('imageRawLimit (#1115 P3)', () => {
  it.each([
    // [stage limit, expected raw rows, why]
    [1, IMAGE_PAGE_FANOUT, 'the fan-out applies at the smallest width'],
    [10, 40, 'the default stage limit — 4x, the window `fuseWithStableHead` assumes'],
    [125, 500, 'exactly at the cap'],
    [200, IMAGE_RAW_LIMIT_CAP, 'past the cap, clamped — ef headroom stays inside pgvector 1000'],
    [900, 900, 'past the cap AND past it: never NARROWER than the page count asked for'],
  ])('imageRawLimit(%i) = %i (%s)', (limit, expected) => {
    expect(imageRawLimit(limit)).toBe(expected);
  });

  it('is never below the requested page count', () => {
    // The `Math.max` half, stated as the invariant rather than as a case: a
    // raw window narrower than the page count would make the leg structurally
    // unable to answer with what it was asked for. `vectorRawLimit` carries
    // the same guarantee for the same reason (#1269 review m16).
    for (const limit of [1, 5, 10, 50, 125, 200, 500, 1000, 2000]) {
      expect(imageRawLimit(limit)).toBeGreaterThanOrEqual(limit);
    }
  });
});

describe('groupByPage (#1115 P3)', () => {
  it('ranks a page by its BEST image and counts it once', () => {
    const pages = groupByPage(
      [row(7, 'a.png'), row(9, 'b.png'), row(7, 'c.png')],
      10,
    );

    expect(pages.map((p) => p.pageId)).toEqual([7, 9]);
    expect(pages[0]!.hits.map((h) => h.key)).toEqual(['a.png', 'c.png']);
    expect(pages[0]!.bestRawIndex).toBe(0);
    expect(pages[1]!.bestRawIndex).toBe(1);
  });

  it('stops at `limit` DISTINCT PAGES', () => {
    // Mutation check: replace the `byPage.size >= limit` guard with `void
    // limit` and this fails. The leg is denominated in pages and the raw
    // stream is over-fetched by `IMAGE_PAGE_FANOUT`, so without the cap it
    // answers with up to 4x the pages the caller (and `fuseWithStableHead`'s
    // narrow reconstruction) budgeted for.
    const pages = groupByPage([row(1, 'a.png'), row(2, 'b.png'), row(3, 'c.png')], 1);

    expect(pages.map((p) => p.pageId)).toEqual([1]);
  });

  it('keeps carrying hits for a page already admitted, past the page cap', () => {
    // The cap counts PAGES, not rows: a page inside the window keeps
    // collecting its own pictures for the source list even once no new page
    // can be admitted.
    const pages = groupByPage(
      [row(1, 'a.png'), row(2, 'b.png'), row(1, 'c.png')],
      1,
    );

    expect(pages).toHaveLength(1);
    expect(pages[0]!.hits.map((h) => h.key)).toEqual(['a.png', 'c.png']);
  });

  it('caps the hits one page carries at MAX_IMAGE_HITS_PER_PAGE', () => {
    const rows = Array.from({ length: MAX_IMAGE_HITS_PER_PAGE + 3 }, (_, i) =>
      row(4, `g${i}.png`),
    );

    const pages = groupByPage(rows, 10);

    expect(pages[0]!.hits).toHaveLength(MAX_IMAGE_HITS_PER_PAGE);
    expect(pages[0]!.hits[0]!.key).toBe('g0.png');
  });

  it('returns nothing at limit 0 rather than everything', () => {
    expect(groupByPage([row(1, 'a.png')], 0)).toEqual([]);
  });
});
