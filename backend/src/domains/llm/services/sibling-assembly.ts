/**
 * #1106 PR 2 — the pure half of sibling-chunk context assembly. Given one
 * page's sibling chunks, an anchor (the retrieval representative's
 * chunk_index), and a per-page char budget, produce the merged context text
 * that buildRagContext will prefer over the lone best chunk.
 *
 * Design of record (issue #1106): the window is best-chunk-ANCHORED and
 * expands alternately to the previous/next sibling in SORTED order — never
 * index arithmetic, chunk_index has holes where embedding batches were
 * skipped — and renders in document order, so the text is contiguous prose
 * around the match and the anchor can never be the part truncated away.
 * The DB fetch, soft-fail and pipeline placement live in rag-service; this
 * module is deterministic string/window logic with no imports.
 */

/** How far into each side of a seam the overlap scan looks. Must COVER the
 * largest real chunker overlap — `embedding_chunk_overlap` is admin-settable
 * to 512 tokens ≈ 1536 chars (#1270 review m8; the old 400 silently stopped
 * trimming above ~133 tokens) — while staying bounded so a pathological
 * chunk cannot make the scan expensive. */
export const SEAM_TRIM_WINDOW = 1600;
/** Minimum exact suffix/prefix match treated as chunker overlap — below
 * this, repeated short prose ("the", a shared phrase) is legitimate text,
 * not a seam (#1106 design graft from the judge round). */
export const SEAM_TRIM_MIN_MATCH = 20;

/** Joiner marking a chunk_index hole — skipped embedding batches must not
 * read as adjacent prose. */
const HOLE_JOINER = '\n\n[…]\n\n';
const PLAIN_JOINER = '\n\n';

export interface SiblingChunk {
  chunkIndex: number;
  chunkText: string;
}

export interface AssembledWindow {
  text: string;
  mergedChunkCount: number;
}

/**
 * Longest exact overlap where a suffix of `a` equals a prefix of `b` AND
 * the remainder of `b` starts with a paragraph break — bounded by
 * SEAM_TRIM_WINDOW, floored at SEAM_TRIM_MIN_MATCH. Returns 0 when no
 * qualifying overlap exists.
 *
 * The `\n\n` condition is the discriminator that makes this safe (#1270
 * review B1): a GENUINE chunker overlap is always followed by a literal
 * `\n\n`, because the oversized-section splitter builds the next chunk as
 * `tailFragment + '\n\n' + para` — while the chunker's other seam shape
 * (section packing, and splitByWords' hard-limit parts) produces ZERO
 * overlap, so on those seams any suffix/prefix match is coincidence
 * (repeated table headers, boilerplate field blocks) and trimming it
 * deletes legitimate text and fuses adjacent blocks. Scanning only the
 * paragraph-break positions also makes the scan O(breaks), not O(window²).
 */
function seamOverlap(a: string, b: string): number {
  const max = Math.min(SEAM_TRIM_WINDOW, a.length, b.length);
  for (let brk = b.lastIndexOf('\n\n', max); brk >= SEAM_TRIM_MIN_MATCH; brk = b.lastIndexOf('\n\n', brk - 1)) {
    if (a.endsWith(b.slice(0, brk))) return brk;
  }
  return 0;
}

/**
 * Assemble the merged window. `anchorIndex` is the retrieval
 * representative's chunk_index. Returns null — the caller keeps the
 * chunk-level row — when there is nothing to assemble (no siblings), the
 * budget is non-positive (0 is the operator kill switch on the
 * `rag_context_chars_per_page` knob), or **the anchor does not resolve**:
 * an absent anchor (keyword-only rows carry no measured chunk) or a stale
 * one (the page re-embedded between the candidate query and the sibling
 * fetch — the rerank stage's 5s budget makes that window seconds wide)
 * would silently produce a page-PREFIX window labelled with the stale
 * chunk's section, and on a keyword_fallback outage would inflate five
 * sources to page intros carrying zero anchoring signal (#1270 review
 * m2+m3). No anchor, no assembly — the best chunk the leg actually
 * measured is the honest context.
 */
export function assembleSiblingWindow(
  siblings: SiblingChunk[],
  anchorIndex: number | undefined,
  budgetChars: number,
): AssembledWindow | null {
  if (siblings.length === 0 || budgetChars <= 0 || anchorIndex === undefined) return null;

  const sorted = [...siblings].sort((x, y) => x.chunkIndex - y.chunkIndex);
  const anchorPos = sorted.findIndex((s) => s.chunkIndex === anchorIndex);
  if (anchorPos === -1) return null;

  // Alternating expansion from the anchor: prev, next, prev, next… in
  // sorted-position space. The anchor is admitted unconditionally — a
  // budget below one chunk still returns the whole anchor, because
  // returning a truncated match would defeat the feature's purpose.
  let lo = anchorPos;
  let hi = anchorPos;
  let used = sorted[anchorPos]!.chunkText.length;
  let preferPrev = true;
  // Per-side affordability, not break-on-first-miss: a large previous
  // sibling must not stop a small next one (or vice versa) from joining
  // while the budget still has room for it.
  // Joiner-aware accounting (#1270 review m9): each admitted neighbour
  // costs its text PLUS the seam joiner (2 chars adjacent, 7 across a
  // hole). Seam trimming can only shrink the final text, so this is a safe
  // upper bound and the knob stays an honest per-page character budget.
  const joinCost = (a: SiblingChunk, b: SiblingChunk) =>
    b.chunkIndex - a.chunkIndex === 1 ? PLAIN_JOINER.length : HOLE_JOINER.length;
  for (;;) {
    const prevCost = lo > 0 ? sorted[lo - 1]!.chunkText.length + joinCost(sorted[lo - 1]!, sorted[lo]!) : Infinity;
    const nextCost = hi < sorted.length - 1 ? sorted[hi + 1]!.chunkText.length + joinCost(sorted[hi]!, sorted[hi + 1]!) : Infinity;
    const prevFits = used + prevCost <= budgetChars;
    const nextFits = used + nextCost <= budgetChars;
    if (!prevFits && !nextFits) break;
    const takePrev = prevFits && (preferPrev || !nextFits);
    if (takePrev) {
      lo--;
      used += prevCost;
    } else {
      hi++;
      used += nextCost;
    }
    preferPrev = !preferPrev;
  }

  const window = sorted.slice(lo, hi + 1);
  let text = window[0]!.chunkText;
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1]!;
    const cur = window[i]!;
    if (cur.chunkIndex - prev.chunkIndex === 1) {
      // Truly adjacent: trim the chunker's raw-tail overlap once.
      const overlap = seamOverlap(text, cur.chunkText);
      text = overlap > 0 ? text + cur.chunkText.slice(overlap) : text + PLAIN_JOINER + cur.chunkText;
    } else {
      // A hole — never trim across it; the gap is real document distance.
      text = text + HOLE_JOINER + cur.chunkText;
    }
  }

  return { text, mergedChunkCount: window.length };
}
