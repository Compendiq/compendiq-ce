import { ScanSearch } from 'lucide-react';
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
 * Teal when active, like `+ Sub-pages`: under ADR-010 the accent marks
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
}

/**
 * The tooltip does not sell the feature. It names the one case it helps, the
 * cost, the case it hurts, and the lifetime — in that order, because a user who
 * reads only the first clause should still come away with "sometimes".
 */
export const DEEP_SEARCH_HINT =
  'Searches again with a few rephrasings of your question and merges the results. '
  + 'Helps when the page words things differently than you do; adds roughly 2 seconds, '
  + 'and does slightly worse on straightforward questions. '
  + 'Applies to this question only — it switches off when you send.';

export function DeepSearchToggle({
  checked, onChange, disabled = false, testId = 'deep-search-toggle', className,
}: DeepSearchToggleProps) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-1', className)}>
      <label
        className={cn(
          // h-7 matches the chip rows either composer sits under. Border and
          // background only — no lift, no scale (ADR-010 v0.6). The 1px border
          // is `border-border-interactive` at rest, not the quiet separator
          // hairline: this is an operable surface and owes WCAG 1.4.11 3:1.
          //
          // The checkbox is sr-only, so the ring has to be raised by the label
          // — without this the keyboard focus indicator is on an invisible box.
          // `focus-within` rather than `has-[:focus-visible]` because the
          // control is only ever reached by keyboard or by clicking the label,
          // and the label's own click does not focus it in every browser.
          'flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors',
          'focus-within:outline-none focus-within:ring-2 focus-within:ring-ring',
          checked
            ? 'border-primary/45 bg-primary/12 text-primary-ink'
            : 'border-border-interactive text-muted-foreground',
          disabled
            ? 'cursor-not-allowed opacity-50'
            : cn('cursor-pointer', !checked && 'hover:bg-foreground/5 hover:text-foreground'),
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
          data-testid={testId}
        />
        <ScanSearch size={12} aria-hidden />
        <span>Deep search</span>
      </label>
      {/* Shown only while it is on, so it is never permanent chrome. A tooltip
          is unreachable by touch and by most screen-reader flows, and the two
          things a user has to know before waiting — that it is slower, and
          that it is gone after this question — should not be behind hover. */}
      {checked && (
        <span className="text-xs text-muted-foreground" data-testid={`${testId}-hint`}>
          Slower; this question only.
        </span>
      )}
    </div>
  );
}
