import type { QualityStatus, SummaryStatus } from '../../hooks/use-pages';

/**
 * Resolves a page's background-pipeline state to at most ONE badge.
 *
 * Three pipelines run over every page — embedding, summarisation, quality
 * scoring — and each shipped its own badge, so a list row carried three pills
 * that mostly said the same thing ("Skipped / Skipped / Not Embedded"). That is
 * noise in the one place density matters most.
 *
 * The product decision behind collapsing them, stated so it can be argued with:
 *
 * 1. **Silence is the healthy state.** A page that is indexed, summarised and
 *    scored resolves to `null` and renders nothing. Previously every row
 *    carried pills whatever happened, so the pills stopped meaning anything;
 *    now a badge appearing is itself the signal and a healthy corpus scans
 *    clean.
 *
 * 2. **`skipped` is a configuration, not a condition.** An operator turning
 *    summarisation off is not a problem with the page, and it produced most of
 *    the visible noise. It resolves to `null`.
 *
 * 3. **One severity ladder, most severe wins.** failed > not indexed >
 *    processing. A row has one line of horizontal space for this, so the worst
 *    thing is more useful than all of it.
 *
 * 4. **The quality SCORE is not pipeline state** and keeps its own badge — a
 *    number about the content that an author acts on, categorically unlike
 *    "has the machine finished". But "Not Scored" IS pipeline state and belongs
 *    here, which is why the score badge now renders only when a score exists.
 *
 * `not indexed` outranks `processing` because it is the only state that changes
 * what the product can DO with the page: an unembedded page is invisible to
 * semantic search. That is also why the badge renders at every viewport width,
 * while the quality score is desktop-only.
 *
 * Kept in its own module so the ladder is unit-testable and so the component
 * file exports only a component (react-refresh).
 */

export type PageStateTone = 'failed' | 'idle' | 'working';

export interface PageStateInput {
  /** True when the page's embedding is missing or stale. */
  embeddingDirty?: boolean;
  summaryStatus?: SummaryStatus;
  qualityStatus?: QualityStatus | null;
  /**
   * When false, idle "Not indexed" resolves to null. Failures and in-flight
   * work still render. The Library list turns this off at rest so an unindexed
   * corpus is not a wall of identical chips, and turns it on when the list is
   * filtered to Needs Embedding. Default true so other callers and the ladder
   * tests keep the full signal.
   */
  showIdleEmbedding?: boolean;
}

export interface PageState {
  label: string;
  title: string;
  tone: PageStateTone;
}

export function resolvePageState({
  embeddingDirty,
  summaryStatus,
  qualityStatus,
  showIdleEmbedding = true,
}: PageStateInput): PageState | null {
  // Named per pipeline, not a bare "Failed": a page that was scored once and
  // then fails re-analysis keeps its last score, so QualityScoreBadge renders
  // its OWN "Analysis Failed" state right beside this one. Two badges both
  // saying "Failed" left a reader unable to tell whether one thing failed
  // twice or two different things failed — and neither of them is the state
  // that actually blocks retrieval (that's `not indexed`, below).
  if (summaryStatus === 'failed' && qualityStatus === 'failed') {
    return {
      label: 'Summary & quality failed',
      title: 'Both summary generation and quality scoring failed for this page',
      tone: 'failed',
    };
  }
  if (qualityStatus === 'failed') {
    return {
      label: 'Quality failed',
      title: 'Quality scoring failed for this page',
      tone: 'failed',
    };
  }
  if (summaryStatus === 'failed') {
    return {
      label: 'Summary failed',
      title: 'Summary generation failed for this page',
      tone: 'failed',
    };
  }

  if (embeddingDirty && showIdleEmbedding) {
    return {
      label: 'Not indexed',
      title: 'Not embedded yet — this page will not appear in semantic search',
      tone: 'idle',
    };
  }

  if (summaryStatus === 'summarizing' || qualityStatus === 'analyzing') {
    return {
      label: 'Processing',
      title: 'A background job is running for this page',
      tone: 'working',
    };
  }

  // Healthy, or deliberately skipped. Silence.
  return null;
}
