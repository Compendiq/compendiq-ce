import { Brain } from 'lucide-react';
import { cn } from '../../shared/lib/cn';

/**
 * Extended thinking (#20), as a composer chip.
 *
 * ## Where it lives
 *
 * In the action row inside the composer box, beside the skill select and Deep
 * search — the dock's arrangement, adopted on `/ai` (owner request,
 * 2026-09-01). It used to sit in a `bg-card` options row above the message
 * pane, which was the page's only remaining durable-option row: one chip in a
 * full-width card, 12px above the thread, describing a request composed 600px
 * further down. Sitting with the send button, it reads as part of what Send is
 * about to do.
 *
 * ## Lifetime, and why the geometry is shared with Deep search but the colour
 * is not
 *
 * This one IS sticky — `AiContext` writes it to `localStorage` — and that is
 * the deliberate opposite of `DeepSearchToggle`, which must be read and cleared
 * per question. Same chip geometry so the row reads as one set of controls;
 * different accent so the two are not confusable at a glance: violet marks "an
 * AI does this" under ADR-010 (the model spends longer reasoning), while Deep
 * search keeps Steel because the user is choosing how retrieval runs.
 */
export const THINK_HINT_ON =
  'Extended thinking is on — responses take longer but reason more carefully';
export const THINK_HINT_OFF = 'Enable extended thinking for more thorough responses';

export function ThinkToggle({
  checked,
  onChange,
  disabled = false,
  testId = 'ai-think-toggle',
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  /** Distinguishes each composer's control in tests and in the DOM. */
  testId?: string;
  className?: string;
}) {
  return (
    <label
      className={cn(
        'flex h-7 shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] border border-transparent px-2 text-xs select-none transition-colors duration-100 ease-out',
        'focus-within:outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1',
        checked
          ? 'bg-status-ai/15 font-medium text-status-ai hover:bg-status-ai/20'
          : 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground active:bg-secondary',
        disabled
          ? 'cursor-not-allowed opacity-45 pointer-events-none'
          : 'cursor-pointer',
        className,
      )}
      title={checked ? THINK_HINT_ON : THINK_HINT_OFF}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only"
        aria-label="Thinking mode"
        data-testid={testId}
      />
      <Brain size={12} aria-hidden />
      <span>Think</span>
    </label>
  );
}
