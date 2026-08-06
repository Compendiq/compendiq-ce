import { cn } from '../../lib/cn';
import { resolvePageState, type PageStateInput, type PageStateTone } from './page-state';

/**
 * One badge for a page's background-pipeline state, or nothing at all.
 * The severity ladder and the product reasoning live in `page-state.ts`.
 */

const TONE_CLASS: Record<PageStateTone, string> = {
  // Tinted pills rather than solid fills: this sits in a dense row and must not
  // outweigh the page title beside it.
  failed: 'border-destructive/40 bg-destructive/10 text-destructive',
  idle: 'border-border bg-muted text-muted-foreground',
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
