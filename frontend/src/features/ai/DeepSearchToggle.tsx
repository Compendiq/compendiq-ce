import { useId, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Info, ScanSearch } from 'lucide-react';
import { cn } from '../../shared/lib/cn';

/**
 * Per-question opt-in for #1112's multi-query expansion ("deep search").
 *
 * ## The lifetime is the feature
 *
 * This control MUST NOT be persisted — not in localStorage, not in a Zustand
 * slice, not in a search param, not in `AiThread`. It is read and cleared at
 * submit time by whichever composer owns it, so every question starts from
 * off. That is not a stylistic preference; it is what makes the feature safe.
 *
 * Measured on the #1102 fixture with the rerank stage live: expansion is a
 * large win on the vocabulary-gap slice (R@1 .182 -> .424, n=33) and a
 * REGRESSION on the other 164 queries (R@5 .921 -> .866, 2 wins / 11 losses,
 * McNemar exact p = 0.0225), at 1.40 -> 3.76 s/query. So it is net-positive
 * only while the person asking picks it for the question that needs it. A
 * sticky toggle — one someone switches on for a hard question and forgets —
 * silently applies the measured regression to every ordinary question after
 * it, which converts a measured win into a measured loss. The same constraint
 * is recorded in CLAUDE.md, docs/architecture/09-flow-rag-chat.md and a
 * comment in `backend/src/routes/llm/llm-ask.ts`.
 *
 * ## Why it lives in the composer, not the header chip row
 *
 * `/ai`'s header chips are where LIFETIME-ful settings sit: `Think` is written
 * to localStorage, `+ Sub-pages` is provider-level session state, the model
 * select outlives the thread. A strictly per-question control placed in that
 * row would claim their lifetime by association, and the reset would then read
 * as a bug. Down here it sits with `externalUrls`, the other thing this
 * composer clears on send — and, more usefully, the state can simply be
 * `useState` in the composer that submits it, so there is no shared store for
 * a future change to accidentally persist.
 *
 * ## Colour
 *
 * Steel when active, like `+ Sub-pages`: under ADR-010 the accent marks
 * "you can operate this". Violet is reserved for "an AI does this" and would
 * misdescribe what is a retrieval mode — the expansion call is incidental, the
 * user is choosing how the knowledge base is searched.
 */
interface DeepSearchToggleProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  /** Distinguishes the two composers' controls in tests and in the DOM. */
  testId?: string;
  className?: string;
  /**
   * Layout presentation:
   * - 'popover' (default): compact chip + info icon trigger with Radix popover for caveat. Saves vertical space in docked sidebars.
   * - 'inline': displays the caveat as an inline text node next to the toggle.
   */
  variant?: 'popover' | 'inline';
}

/**
 * The tooltip does not sell the feature. It names the one case it helps, the
 * cost, the case it hurts, and the lifetime — in that order, because a user who
 * reads only the first clause should still come away with "sometimes".
 *
 * "Roughly 2 seconds" was a rounding of 2.36 in the direction that flatters the
 * feature. The measurement is 1.40 -> 3.76 s/query, so the number is quoted
 * both ways: the delta a user waits, and the pair it came from.
 */
export const DEEP_SEARCH_HINT =
  'Searches again with a few rephrasings of your question and merges the results. '
  + 'Helps when the page words things differently than you do; adds about 2.4 seconds '
  + '(measured 1.4 s -> 3.8 s per question), and does slightly worse on straightforward '
  + 'questions. Applies to this question only — it switches off when you send.';

/**
 * The same three facts, on screen and unconditional.
 *
 * This used to live only in the `title` above, plus a "Slower; this question
 * only." line that appeared *after* the user switched the toggle on. Both are
 * the wrong shape for what this control is. The decision a user makes here is
 * whether to turn it on, so the caveat has to be readable at rest; a `title` is
 * unreachable by touch and by most screen-reader flows; and "slower" alone
 * reads as slower-BUT-BETTER, which is the inverse of the measurement — this
 * ships opt-in precisely because it is a regression on ordinary questions
 * (R@5 .921 -> .866, McNemar exact p = 0.0225).
 *
 * Kept to one line's worth of words because it is permanent chrome now. The
 * `title` keeps the longer version for anyone who hovers.
 */
export const DEEP_SEARCH_CAVEAT =
  'Helps when normal search missed it; slightly worse on straightforward questions. '
  + 'About 2.4 seconds slower; this question only.';

export function DeepSearchToggle({
  checked,
  onChange,
  disabled = false,
  testId = 'deep-search-toggle',
  className,
  variant = 'popover',
}: DeepSearchToggleProps) {
  const [infoOpen, setInfoOpen] = useState(false);

  // The caveat is the control's accessible description, so it needs a stable id
  // rather than a testid — `aria-describedby` is the only thing that carries
  // visible text to a screen reader without also renaming the control.
  const caveatId = useId();

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <label
        className={cn(
          'flex h-7 items-center gap-1.5 rounded-[var(--radius-sm)] border border-transparent px-2 text-xs select-none transition-colors duration-100 ease-out',
          'focus-within:outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1',
          checked
            ? 'bg-primary/15 text-primary font-medium hover:bg-primary/20'
            : 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground active:bg-secondary',
          disabled
            ? 'cursor-not-allowed opacity-45 pointer-events-none'
            : 'cursor-pointer',
        )}
        title={DEEP_SEARCH_HINT}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="sr-only"
          aria-label="Deep search for this question"
          // The description wins over the label's `title` per the accname spec,
          // so the two do not double up: hover gets the long form, everyone
          // else gets the line that is already on screen.
          aria-describedby={caveatId}
          data-testid={testId}
        />
        <ScanSearch size={12} aria-hidden />
        <span>Deep search</span>
      </label>

      {variant === 'popover' ? (
        <>
          <Popover.Root open={infoOpen} onOpenChange={setInfoOpen}>
            <Popover.Trigger asChild>
              <button
                type="button"
                disabled={disabled}
                aria-label="Deep search details and caveats"
                title="Deep search information"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-transparent text-muted-foreground transition-colors duration-100 hover:border-border-interactive hover:bg-accent hover:text-foreground active:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-45 disabled:pointer-events-none"
                data-testid={`${testId}-info-trigger`}
              >
                <Info size={13} aria-hidden />
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                align="start"
                side="top"
                sideOffset={6}
                collisionPadding={8}
                className="nm-card-elevated z-50 max-w-[280px] p-2.5 text-xs leading-relaxed text-muted-foreground motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95"
                data-testid={`${testId}-popover-content`}
              >
                <p className="mb-1 font-medium text-foreground">Deep search (multi-query expansion)</p>
                <p>{DEEP_SEARCH_CAVEAT}</p>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          <span
            id={caveatId}
            className="sr-only"
            data-testid={`${testId}-caveat`}
          >
            {DEEP_SEARCH_CAVEAT}
          </span>
        </>
      ) : (
        <span
          id={caveatId}
          className="text-xs text-muted-foreground"
          data-testid={`${testId}-caveat`}
        >
          {DEEP_SEARCH_CAVEAT}
        </span>
      )}
    </div>
  );
}
