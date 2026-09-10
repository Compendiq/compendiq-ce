import { SearchX } from 'lucide-react';
import { cn } from '../../shared/lib/cn';

/**
 * The #1105 low-confidence refusal, as a UI state.
 *
 * When retrieval confidence falls below the operator's threshold the backend
 * returns an honest refusal turn — real assistant text, the weak sources it
 * did find, `refused: true` on the final SSE frame, and NO chat completion.
 * Until #1119 the frontend had no idea, so that turn rendered as an ordinary
 * Markdown answer with a "Low confidence" badge stapled to sources it had
 * explicitly declined to use.
 *
 * ## Why it is neutral, and not amber
 *
 * ADR-010 reserves amber for warning/attention, and CLAUDE.md is explicit that
 * a permanent banner in amber teaches users to ignore amber. A refusal is
 * neither rare nor a fault: on an instance whose threshold is set at all, every
 * question the corpus does not cover produces one, and `/ai` already spends its
 * amber on the zero-embeddings notice — the corpus-wide warning that would sit
 * directly above this turn on exactly the instances most likely to refuse. Two
 * ambers on one screen, one of them recurring, is how the reserved colour stops
 * meaning anything.
 *
 * It is not `text-destructive` either. Destructive is the error path
 * (`Message.isError`), and this request did not fail — the server did the
 * retrieval, measured it, and correctly declined to guess. Painting a correct
 * response red tells the user to retry something that is working.
 *
 * Violet marks "an AI does this" and Steel marks "you can operate this";
 * neither is a verdict channel. So the refusal takes the treatment ADR-010
 * already settled on for a MEASUREMENT rather than a state — the same
 * de-colouring argument as `QualityScoreBadge` and `ConfidenceBadge`: the
 * word is the channel. One neutral chip, one hairline, and the backend's own
 * plain-language sentence.
 */

/** Chip that names the state. The label is the channel — no hue, no dot. */
export function RefusalMark({ className }: { className?: string }) {
  return (
    <span
      data-testid="refusal-mark"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-border bg-foreground/10 px-2 py-0.5 text-[11px] font-medium text-secondary-foreground',
        className,
      )}
    >
      <SearchX size={11} aria-hidden />
      Not answered
    </span>
  );
}

/**
 * Heading for the weak sources attached to a refusal.
 *
 * They must never render under the bare treatment an answer's citations get:
 * an unlabelled chip row under "I am not answering" reads as the sources the
 * answer was built from. The backend makes the same distinction in its live
 * text ("The closest partial matches are attached as sources for reference —
 * none matched well enough to use"), and deliberately omits that sentence from
 * the PERSISTED copy. Since #1361 the weak sources themselves ride the
 * persisted turn as structured data, so this heading renders on a reloaded
 * refusal too, whenever sources are present — live or replayed alike.
 */
export const REFUSAL_SOURCES_LABEL = 'Closest matches — not used';

export function RefusalSourcesLabel({ className }: { className?: string }) {
  return (
    <p className={cn('text-xs text-muted-foreground', className)} data-testid="refusal-sources-label">
      {REFUSAL_SOURCES_LABEL}
    </p>
  );
}

/**
 * What the `/ai` polite live region announces for a refusal.
 *
 * The region used to say "Answer ready" for every non-error assistant turn
 * with content, which is the one thing a refusal is not.
 *
 * It names the STATE and leaves the reason to the turn itself, which is
 * rendered as plain text directly below it. It used to say "nothing in the
 * knowledge base matched this question closely enough" — true of the two
 * score-shaped refusals and FALSE of the third: since #1114's prerequisite
 * the backend also refuses when the semantic index is unavailable, where the
 * knowledge base was never searched properly and may cover the question
 * perfectly. Announcing a corpus verdict for a service outage tells the one
 * user who cannot see the message the opposite of what it says. Per-reason
 * announcements are possible now that `refusalReason` rides the final SSE
 * frame, but that needs the reason carried onto `Message` first, and a wrong
 * announcement should not wait for it.
 */
export const REFUSAL_ANNOUNCEMENT =
  'No answer — the assistant declined to answer this question; its reason follows in the message';
