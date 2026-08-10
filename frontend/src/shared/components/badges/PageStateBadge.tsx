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
  // `failed` keeps its destructive fill and border — failure is a state and
  // earns its hue — but the LABEL takes the secondary ink: text-destructive
  // measured 3.94:1 on its own /10 tint over a hovered Paper row, under AA at
  // this 11px. The secondary ink measures 8.33–10.28:1 on the same fills, so
  // the red states the failure and the label stays readable.
  failed: 'border-destructive/40 bg-destructive/10 text-secondary-foreground',
  // `idle` is the settled neutral-chip recipe (see neutral-chip.ts). It was
  // `bg-muted text-muted-foreground`: in Graphite accent == muted (1.00:1),
  // so "Not indexed" — the one state that changes what the product can DO
  // with the page — vanished on hover while Local/Shared beside it stayed
  // crisp on the tint.
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
