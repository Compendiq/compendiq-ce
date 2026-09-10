import { cn } from '../../lib/cn';
import { neutralChipInk } from './neutral-chip';
import { resolvePageState, type PageStateInput, type PageStateTone } from './page-state';

/**
 * One badge for a page's background-pipeline state, or nothing at all.
 * The severity ladder and the product reasoning live in `page-state.ts`.
 */

const TONE_CLASS: Record<PageStateTone, string> = {
  // Tinted pills rather than solid fills: this sits in a dense row and must not
  // outweigh the page title beside it. The rows hover with `bg-accent`, so
  // every tone is measured on BOTH row grounds, in both themes.
  //
  // `failed` is amber, not destructive red. It used to be red — but this badge
  // covers summary/quality-analysis failures, the same event QualityScoreBadge
  // already renders in amber ("Analysis Failed") per ADR-010: "failure keeps
  // amber — it is the one quality state that is genuinely attention-worthy."
  // The same underlying failure wearing two different hues depending on which
  // of the two badges happened to render it was the bug. text-warning needs no
  // ink swap: QualityScoreBadge ships this exact border/bg/text trio already,
  // so it is proven to clear AA at this size.
  failed: 'border-warning/40 bg-warning/10 text-warning',
  // `idle` is the settled neutral-chip recipe (see neutral-chip.ts). It was
  // `bg-muted text-muted-foreground`: in Graphite accent == muted (1.00:1),
  // so "Not indexed" — the one state that changes what the product can DO
  // with the page — vanished on hover while Local/Shared beside it stayed
  // crisp on the tint.
  //
  // It stays neutral, not destructive red, even though it is functionally the
  // more serious state (it blocks retrieval; a failed summary or quality score
  // does not). Red is this system's hue for an active failure/disconnection —
  // ADR-010's status palette — and an unembedded page is usually just pending
  // its next sync pass, not broken. Painting every not-yet-indexed page red
  // would misreport "hasn't happened yet" as "something is wrong."
  idle: `border-border ${neutralChipInk}`,
  // `working` clears AA as-is: text-status-ai on its own /10 tint measured
  // 4.98/4.94:1 on hovered Graphite/Paper rows (5.78/6.00:1 resting).
  working: 'border-status-ai/40 bg-status-ai/10 text-status-ai',
};

export function PageStateBadge({ className, ...input }: PageStateInput & { className?: string }) {
  const state = resolvePageState(input);
  if (!state) return null;

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
        TONE_CLASS[state.tone],
        className,
      )}
      title={state.title}
      data-testid="page-state-badge"
      data-state={state.tone}
    >
      {state.label}
    </span>
  );
}
