import { describe, it, expect } from 'vitest';
import { assembleSiblingWindow, SEAM_TRIM_WINDOW, SEAM_TRIM_MIN_MATCH } from './sibling-assembly.js';

// The pure half of #1106 PR 2: given a page's sibling chunks (sorted by
// chunk_index), an anchor, and a char budget, produce the merged context
// text. The DB fetch, soft-fail and pipeline placement live in rag-service;
// everything HERE is deterministic string/window logic.
const chunk = (chunkIndex: number, chunkText: string) => ({ chunkIndex, chunkText });

describe('assembleSiblingWindow (#1106 PR 2)', () => {
  it('anchors at the given chunk and expands alternately under the budget, rendering in document order', () => {
    const sibs = [chunk(0, 'aaaa'), chunk(1, 'bbbb'), chunk(2, 'CCCC'), chunk(3, 'dddd'), chunk(4, 'eeee')];
    // Budget fits anchor + two neighbours (4 + (4+2) + (4+2) = 16, joiners
    // counted per m9); expansion alternates prev/next from the anchor, so
    // the window is contiguous AROUND the match — the anchor can never be
    // the part truncated away.
    const out = assembleSiblingWindow(sibs, 2, 16);
    expect(out.text).toBe('bbbb\n\nCCCC\n\ndddd');
    expect(out.mergedChunkCount).toBe(3);
  });

  it('the anchor is always included whole, even when it alone exceeds the budget', () => {
    const sibs = [chunk(0, 'short'), chunk(1, 'x'.repeat(50))];
    const out = assembleSiblingWindow(sibs, 1, 10);
    expect(out.text).toBe('x'.repeat(50));
    expect(out.mergedChunkCount).toBe(1);
  });

  it('an ABSENT anchor returns null — keyword-only rows keep their excerpt, never an unanchored page prefix (#1270 m3)', () => {
    const sibs = [chunk(3, 'first'), chunk(4, 'second')];
    expect(assembleSiblingWindow(sibs, undefined, 100)).toBeNull();
  });

  it('a STALE anchor returns null — a re-embed between candidate query and sibling fetch must not produce a silent page-prefix window (#1270 m2)', () => {
    const sibs = [chunk(0, 'intro'), chunk(1, 'body'), chunk(2, 'end')];
    expect(assembleSiblingWindow(sibs, 7, 100)).toBeNull();
  });

  it('marks chunk_index holes with an ellipsis joiner — skipped embedding batches leave gaps', () => {
    // chunk_index is document order but NOT contiguous (a batch skipped on a
    // context-length 400 leaves holes); rendered neighbours with a gap get
    // a visible marker instead of silently reading as adjacent prose.
    const sibs = [chunk(0, 'aaaa'), chunk(5, 'bbbb')];
    const out = assembleSiblingWindow(sibs, 0, 100);
    expect(out.text).toBe('aaaa\n\n[…]\n\nbbbb');
  });

  it('trims the seam overlap between truly adjacent chunks — bounded exact suffix/prefix match', () => {
    // Oversized-section splits carry ~150 chars of raw tail into the next
    // chunk (embedding-service CHUNK_OVERLAP). The duplicated run must not
    // appear twice in the merged text.
    // The REAL chunker shape: the oversized-section splitter builds the
    // next chunk as tail + '\n\n' + para, so a genuine overlap is always
    // followed by a paragraph break — the discriminator (#1270 B1).
    const overlap = 'shared overlap text that both chunks carry';
    const a = 'unique first part. ' + overlap;
    const b = overlap + '\n\nunique second part.';
    const out = assembleSiblingWindow([chunk(0, a), chunk(1, b)], 0, 1000);
    expect(out.text).toBe('unique first part. ' + overlap + '\n\nunique second part.');
  });

  it('refuses seam matches below the floor — short legitimately-repeated prose is not an overlap', () => {
    const a = 'first chunk ends with the';
    const b = 'the\n\nnext chunk also starts';
    const out = assembleSiblingWindow([chunk(0, a), chunk(1, b)], 0, 1000);
    // 'the' (3 chars) is under SEAM_TRIM_MIN_MATCH — no trim, plain join,
    // even though the paragraph-break discriminator would accept it.
    expect(out.text).toBe(a + '\n\n' + b);
    expect(SEAM_TRIM_MIN_MATCH).toBeGreaterThanOrEqual(20);
    // The window must COVER the max configurable chunker overlap
    // (512 tokens x 3 chars) — see #1270 m8.
    expect(SEAM_TRIM_WINDOW).toBeGreaterThanOrEqual(1536);
  });

  it('a coincidental match NOT followed by a paragraph break is never trimmed — repeated table headers survive (#1270 B1)', () => {
    // Packed-section seams carry ZERO real overlap, so any suffix/prefix
    // match there is boilerplate coincidence. The old trim deleted a
    // legitimate header row and glued table two under table one's header.
    const a = 'Table one\n\n| Status | Owner | Date |\n| ok | me | x |\n| Status | Owner | Date |';
    const b = '| Status | Owner | Date |\n| no | you | y |\n\nTable two';
    const out = assembleSiblingWindow([chunk(0, a), chunk(1, b)], 0, 5000);
    expect(out.text).toBe(a + '\n\n' + b);
  });

  it('joiners count against the budget — the knob is an honest per-page character bound (#1270 m9)', () => {
    // Nine 10-char chunks with all-hole seams: text 90 + 8 joiners x 7 =
    // 146 chars. A budget of 100 must admit only what actually fits.
    const sibs = Array.from({ length: 9 }, (_, i) => chunk(i * 2, 'x'.repeat(10)));
    const out = assembleSiblingWindow(sibs, 8, 100);
    expect(out.text.length).toBeLessThanOrEqual(100);
  });

  it('never trims across a hole — the gap marker breaks adjacency', () => {
    const overlap = 'this text would match as a seam if the chunks were adjacent';
    const out = assembleSiblingWindow([chunk(0, 'a. ' + overlap), chunk(4, overlap + '\n\nb.')], 0, 1000);
    expect(out.text).toContain('[…]');
    expect(out.text.split(overlap).length).toBe(3); // appears twice — no trim
  });

  it('an unaffordable side does not block the other — per-side fit, not break-on-first-miss', () => {
    const sibs = [chunk(0, 'y'.repeat(500)), chunk(1, 'ANCHOR'), chunk(2, 'tail')];
    // Budget fits anchor + tail but not the 500-char head; expansion must
    // skip the head and still take the tail.
    const out = assembleSiblingWindow(sibs, 1, 20);
    expect(out.text).toBe('ANCHOR\n\ntail');
    expect(out.mergedChunkCount).toBe(2);
  });

  it('a single sibling returns its own text with count 1', () => {
    const out = assembleSiblingWindow([chunk(0, 'only')], 0, 1000);
    expect(out.text).toBe('only');
    expect(out.mergedChunkCount).toBe(1);
  });

  it('empty siblings return null — the caller soft-fails to chunk-level', () => {
    expect(assembleSiblingWindow([], 0, 1000)).toBeNull();
  });

  it('a non-positive budget returns null — 0 is the operator kill switch', () => {
    expect(assembleSiblingWindow([chunk(0, 'a')], 0, 0)).toBeNull();
  });
});
