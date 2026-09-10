/**
 * Does this article open with a lede the reader should meet first?
 *
 * The AI summary used to render expanded above the body unconditionally, which
 * on a well-written page meant the reader's first contact with the document was
 * a machine paraphrase of a paragraph sitting 70px below it — and on a 390px
 * phone the first viewport ended before a single sentence the author wrote.
 *
 * A good lede IS the author's own summary, so when one exists it wins the first
 * screen and the AI summary defers to it (collapsed, header still visible). When
 * the document opens with a heading, a macro, a table or a one-line stub, there
 * is nothing to defer to and the summary stays expanded — which is exactly the
 * page the feature was built for.
 *
 * Deliberately conservative: anything it cannot confidently read as a lede
 * returns false and the summary expands, because showing the summary is the
 * incumbent behaviour and the safe direction to fail in.
 */

/**
 * A paragraph shorter than this is a one-line intro or a stub, not a lede.
 *
 * 25 words is roughly two full sentences. The two failure directions are not
 * symmetric: set it too high and a page with a perfectly good lede still opens
 * on a machine paraphrase of it, which is the whole problem this exists to fix;
 * set it too low and a thin intro collapses a summary the reader can expand
 * with one click, with the header still telling them it is there. So it errs
 * low. (A real 37-word incident-runbook lede fails a 40-word bar, which is how
 * this number was calibrated.)
 */
export const LEDE_MIN_WORDS = 25;

/**
 * Confluence wraps most synced bodies in layout scaffolding that carries no
 * content of its own. Without descending through it, `firstElementChild` is a
 * `<div>` on nearly every real Confluence page and the check would answer
 * "no lede" for the entire corpus.
 */
const LAYOUT_WRAPPERS = new Set([
  'confluence-layout',
  'confluence-layout-section',
  'confluence-layout-cell',
]);

function isLayoutWrapper(el: Element): boolean {
  for (const cls of el.classList) {
    if (LAYOUT_WRAPPERS.has(cls)) return true;
  }
  return false;
}

/** Words, counted the way a reader would — runs of non-whitespace. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/**
 * True when the article's first block is a paragraph of at least `minWords`.
 *
 * @param bodyHtml sanitized article HTML (the same string `ArticleViewer` renders)
 */
export function hasSubstantialLede(
  bodyHtml: string | null | undefined,
  minWords: number = LEDE_MIN_WORDS,
): boolean {
  if (!bodyHtml || bodyHtml.trim() === '') return false;

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(bodyHtml, 'text/html');
  } catch {
    // No DOMParser (or malformed beyond recovery) — fail to "expand".
    return false;
  }

  let el: Element | null = doc.body.firstElementChild;
  // Descend through layout-only scaffolding to the first real block.
  let guard = 0;
  while (el && isLayoutWrapper(el) && guard++ < 10) {
    el = el.firstElementChild;
  }

  if (!el || el.tagName !== 'P') return false;
  return countWords(el.textContent ?? '') >= minWords;
}

/**
 * Has the page been edited since its summary was generated?
 *
 * This is the *same predicate* the backend summary worker uses to re-queue a
 * stale summary (`last_modified_at > summary_generated_at`, Phase 1 of
 * `summary-worker.ts`), evaluated client-side so the reader is told during the
 * window between the edit and the worker's next batch — which is precisely when
 * the page shows a summary of content that no longer exists and says nothing
 * about it. It needs no new API field: both timestamps are already on the page
 * payload.
 *
 * Equal timestamps are NOT stale: the worker uses a strict `>` and this must not
 * disagree with it, or a freshly summarized page would flag itself.
 */
export function isSummaryStale(
  lastModifiedAt: string | null | undefined,
  summaryGeneratedAt: string | null | undefined,
): boolean {
  if (!lastModifiedAt || !summaryGeneratedAt) return false;
  const modified = Date.parse(lastModifiedAt);
  const generated = Date.parse(summaryGeneratedAt);
  if (Number.isNaN(modified) || Number.isNaN(generated)) return false;
  return modified > generated;
}
