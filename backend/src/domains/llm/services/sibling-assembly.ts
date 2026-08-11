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

/** How far into each side of a seam the overlap scan looks. Bounded so a
 * pathological chunk cannot make the trim quadratic. */
export const SEAM_TRIM_WINDOW = 400;
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
 * Longest exact overlap where a suffix of `a` equals a prefix of `b`,
 * bounded by SEAM_TRIM_WINDOW and floored at SEAM_TRIM_MIN_MATCH.
 * Returns 0 when no qualifying overlap exists.
 */
function seamOverlap(a: string, b: string): number {
  const max = Math.min(SEAM_TRIM_WINDOW, a.length, b.length);
  for (let len = max; len >= SEAM_TRIM_MIN_MATCH; len--) {
    if (a.endsWith(b.slice(0, len))) return len;
  }
  return 0;
}

/**
 * Assemble the merged window. `anchorIndex` is the retrieval
 * representative's chunk_index; `undefined` (keyword-only rows carry no
 * measured anchor) anchors at the first sibling. Returns null when there is
 * nothing to assemble (no siblings — the caller soft-fails to chunk-level)
 * or the budget is non-positive (0 is the operator kill switch on the
 * `rag_context_chars_per_page` knob).
 */
export function assembleSiblingWindow(
  siblings: SiblingChunk[],
  anchorIndex: number | undefined,
  budgetChars: number,
): AssembledWindow | null {
  if (siblings.length === 0 || budgetChars <= 0) return null;

  const sorted = [...siblings].sort((x, y) => x.chunkIndex - y.chunkIndex);
  let anchorPos = anchorIndex === undefined ? 0 : sorted.findIndex((s) => s.chunkIndex === anchorIndex);
  if (anchorPos === -1) anchorPos = 0;

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
  for (;;) {
    const prevFits = lo > 0 && used + sorted[lo - 1]!.chunkText.length <= budgetChars;
    const nextFits = hi < sorted.length - 1 && used + sorted[hi + 1]!.chunkText.length <= budgetChars;
    if (!prevFits && !nextFits) break;
    const takePrev = prevFits && (preferPrev || !nextFits);
    if (takePrev) {
      lo--;
      used += sorted[lo]!.chunkText.length;
    } else {
      hi++;
      used += sorted[hi]!.chunkText.length;
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
