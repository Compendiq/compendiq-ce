import { describe, it, expect } from 'vitest';
import { assembleSiblingWindow, SEAM_TRIM_WINDOW, SEAM_TRIM_MIN_MATCH } from './sibling-assembly.js';
import { chunkText, CHARS_PER_TOKEN } from './embedding-service.js';

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
    // The window must COVER the max chunker overlap, DERIVED from the
    // exported chars-per-token and the contracts-schema cap (512) that
    // getAdminChunkSettings clamps at read time — not restated as a bare
    // literal that drifts when either moves (#1270 review F14; #1114's
    // embedding-model upgrade is the expected mover).
    expect(SEAM_TRIM_WINDOW).toBeGreaterThanOrEqual(512 * CHARS_PER_TOKEN);
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

describe('chunker seam contract (#1270 re-verification N2)', () => {
  it("the REAL chunker's oversized-section overlap trims — binding the tail + '\\n\\n' + para shape this module's discriminator rests on", () => {
    // An oversized single section forces the splitter path that carries the
    // raw-tail overlap. If the chunker's joiner ever stops being a literal
    // paragraph break, this test fails HERE instead of the trim silently
    // never firing again (safe direction, but silent — the exact class B1
    // hid in).
    const para = (i: number) => `Paragraph of the oversized section, long enough to matter for the splitter and carrying real prose content across boundary marker number ${i} here.`;
    const section = '# One Big Section\n\n' + Array.from({ length: 60 }, (_, i) => para(i)).join('\n\n');
    const chunks = chunkText(section, 'Big Page', 'DEV', 'p1', 500, 50).map((c, i) => ({ chunkIndex: i, chunkText: c.text }));
    expect(chunks.length).toBeGreaterThan(1);

    const merged = assembleSiblingWindow(chunks.slice(0, 2), 0, 100_000)!;
    const naive = chunks[0]!.chunkText + '\n\n' + chunks[1]!.chunkText;
    // The trim removed the duplicated overlap: merged is strictly shorter
    // than the naive join, and no 60-char run appears twice.
    expect(merged.text.length).toBeLessThan(naive.length);
    const probe = chunks[0]!.chunkText.slice(-60);
    expect(merged.text.split(probe).length).toBe(2);
  });
});
