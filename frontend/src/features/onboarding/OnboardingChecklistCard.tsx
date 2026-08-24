import { useEffect, useRef, useState } from 'react';
import { Check, Compass } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  useOnboarding,
  type OnboardingStepId,
} from '../../shared/hooks/use-onboarding';
import { useKeyboardShortcutsStore } from '../../stores/keyboard-shortcuts-store';
import { CONFLUENCE_SETTINGS_PATH, SPACES_SETTINGS_PATH } from '../../shared/lib/routes';

/**
 * The Getting Started checklist on the Pages overview (#1402, phase 2/3).
 *
 * Deliberately **additive chrome**, not a gate: it sits above the page tree
 * and never replaces its loading, failed, failed-with-cache or empty states.
 * It is dismissible, it comes back from the User Menu, and it renders nothing
 * at all — not a collapsed sliver — once dismissed.
 *
 * It also claims no filled accent. The Confluence PAT banner learned this the
 * expensive way (see CLAUDE.md): an onboarding prompt wearing the one Steel
 * button on screen outranks the page's own primary action. Every control here
 * is `nm-button-ghost`, and the completion state is neutral rather than green —
 * finishing a checklist is an achievement, not a pipeline state, and the status
 * hues are reserved for pipeline states.
 */

interface StepCopy {
  /** The milestone, phrased as the thing the user does. */
  title: string;
  /** The control's label. Names the action, never "click here". */
  cta: string;
}

/**
 * Copy lives beside the rendering rather than in the hook: the hook answers
 * "which of these is done", which is data, and this is the surface.
 *
 * No label names a settings panel — `settings-wayfinding.test.ts` polices copy
 * that does, and a step called "Go to Settings → Confluence" would describe
 * the route instead of the goal anyway.
 */
const STEP_COPY: Record<OnboardingStepId, StepCopy> = {
  'connect-confluence': { title: 'Connect your Confluence account', cta: 'Connect' },
  'select-spaces': { title: 'Choose the spaces to sync', cta: 'Choose spaces' },
  'ask-ai': { title: 'Ask your first question', cta: 'Open assistant' },
  shortcuts: { title: 'Learn the keyboard shortcuts', cta: 'Show shortcuts' },
  'create-page': { title: 'Create or edit a page', cta: 'New page' },
};

export interface OnboardingChecklistCardProps {
  /**
   * Called once, after a user-pressed Dismiss has actually removed the card.
   *
   * The card cannot rehome focus itself: the element the user was on goes with
   * it. `PagesPage` owns the heading above it and does the move, guarded the
   * way `RetrievalTab` guards its own (CLAUDE.md's "unmounted the button under
   * the user's focus, dropping it to `<body>`").
   */
  onDismissed?: () => void;
}

export function OnboardingChecklistCard({ onDismissed }: OnboardingChecklistCardProps = {}) {
  const navigate = useNavigate();
  const openShortcuts = useKeyboardShortcutsStore((s) => s.open);
  // This is the one mount that records `completedAt` — see the hook's
  // `trackCompletion` note for why exactly one instance may.
  const { ready, steps, completedCount, allComplete, graduated, visible, dismissed, dismiss } =
    useOnboarding({ trackCompletion: true });

  /**
   * Is THIS client the one graduating the user?
   *
   * Not "did this mount watch the last step land". Three of the five CTAs
   * navigate away from `/` (`/settings/…`, `/ai`, `/pages/new`), so the fifth
   * milestone is normally recorded on another route and the overview is
   * re-entered already-complete — an in-mount transition latch never fires for
   * that user, and because graduation persists `dismissed: true` they instead
   * saw the fully-checked list flash and vanish a round-trip later, never
   * reading the line that tells them where the guide went.
   *
   * The server fact is the right test: `completedAt` is null exactly until
   * someone congratulates them, so the client that finds all five done with it
   * still null is the one doing it, wherever the last step landed.
   *
   * `!dismissed` is the other half. A user who dismissed the guide asked for it
   * to be gone, and the card is still MOUNTED while hidden (`PagesPage` renders
   * it unconditionally), so without this a background flag flip — pressing `?`
   * on `/`, or a cross-tab completion arriving on refetch — resurfaced a panel
   * they had closed. There is no race with the graduation write: `dismissed` is
   * still false on the render that decides this, and the write's own
   * `dismissed: true` only returns a round-trip later, by which time the latch
   * is set.
   *
   * The latch then holds the completion state until they leave the overview or
   * press Dismiss; there is no timer, because a panel that removes itself on a
   * clock is one a slow reader never gets to read. Reopening a FINISHED guide
   * from the User Menu shows the checked list rather than a second
   * congratulation — by then `completedAt` is set.
   */
  const [celebrating, setCelebrating] = useState(false);
  useEffect(() => {
    if (!ready) return;
    if (allComplete && !graduated && !dismissed) setCelebrating(true);
  }, [ready, allComplete, graduated, dismissed]);

  /**
   * Steps whose CTA the user has activated on this mount.
   *
   * Only `shortcuts` acts in place, and it completes itself: opening the modal
   * marks `shortcutsModalViewed`, the settings refetch ticks the row, and the
   * button the user is still standing on used to disappear from under them —
   * so closing the dialog had nothing to restore focus to and dropped it to
   * `<body>`. A control the user just pressed stays where they left it for the
   * life of the mount; the row's checkmark is what reports the new state.
   */
  const [activated, setActivated] = useState<readonly OnboardingStepId[]>([]);

  /**
   * Dismiss removes the card on the press, not a round-trip later.
   *
   * `dismiss()` is a `PUT /settings` plus the `['settings']` refetch it
   * invalidates, and waiting for both left the one control the user pressed
   * with no pending state, no disabled state and no visible effect for that
   * whole window — so a second and third press each fired another PUT. Worse,
   * on the celebration the press cleared `celebrating` while `dismissed` was
   * still false, which put the fully-checked five-row list back on screen: the
   * user pressed Dismiss on a congratulation and got the checklist.
   *
   * Optimistic, and rolled back if the write fails — the card returns and
   * `dismiss()`'s own error toast (it is `silent`, never `silentErrors`) says
   * why. Once the server reports the dismissal the override is dropped again,
   * or a User Menu reopen would find the card locally hidden forever.
   */
  const [dismissing, setDismissing] = useState(false);
  const onScreen = !dismissing && (visible || celebrating);
  useEffect(() => {
    if (dismissed && dismissing) setDismissing(false);
  }, [dismissed, dismissing]);

  /**
   * The removal is reported once the card is really gone — which is now the
   * commit right after the press, so `PagesPage` rehomes focus at the moment
   * the button under it disappears rather than a round-trip later.
   */
  const dismissPressed = useRef(false);
  useEffect(() => {
    if (!dismissPressed.current) return;
    dismissPressed.current = false;
    onDismissed?.();
  }, [onScreen, onDismissed]);

  if (!ready) return null;
  if (!onScreen) return null;

  const runStep = (id: OnboardingStepId) => {
    setActivated((prev) => (prev.includes(id) ? prev : [...prev, id]));
    switch (id) {
      case 'connect-confluence':
        return navigate(CONFLUENCE_SETTINGS_PATH);
      case 'select-spaces':
        return navigate(SPACES_SETTINGS_PATH);
      // `/ai` rather than the docked assistant: the dock is a tab on an open
      // article, and this card lives on the overview where none is open.
      case 'ask-ai':
        return navigate('/ai');
      case 'shortcuts':
        return openShortcuts();
      case 'create-page':
        return navigate('/pages/new');
    }
  };

  const handleDismiss = () => {
    dismissPressed.current = true;
    setCelebrating(false);
    setDismissing(true);
    dismiss({ onError: () => setDismissing(false) });
  };

  return (
    <section
      aria-labelledby="onboarding-checklist-heading"
      data-testid="onboarding-checklist"
      className="nm-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Compass size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" />
          <h2
            id="onboarding-checklist-heading"
            className="truncate text-sm font-semibold text-foreground"
          >
            Getting started
          </h2>
          {/* Progress in words. The five rows already carry the length channel;
              a second meter beside them would be decoration. */}
          <span
            data-testid="onboarding-progress"
            className="shrink-0 text-xs text-muted-foreground tabular-nums"
          >
            {completedCount} of {steps.length} done
          </span>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          data-testid="onboarding-dismiss"
          className="nm-button-ghost h-8 px-2.5 text-xs"
        >
          Dismiss guide
        </button>
      </div>

      {/* The live region is mounted from the first paint and only its TEXT
          changes: a region inserted together with its content is announced
          inconsistently at best, and in the flow this card is dominated by —
          arriving at `/` already complete — it would be present on the first
          paint, which is never announced at all. `sr-only` while empty, so an
          idle region costs no layout. */}
      <p
        role="status"
        data-testid="onboarding-status"
        className={celebrating ? 'mt-3 text-sm text-muted-foreground' : 'sr-only'}
      >
        {celebrating ? (
          <span data-testid="onboarding-complete">
            All five done — Compendiq is set up. You can reopen this guide from your
            account menu.
          </span>
        ) : null}
      </p>

      {/* The list stays through the graduation. Replacing it with the
          completion note removed an activated CTA out from under the modal it
          had opened: `shortcuts` is the one milestone completable in place, so
          when it is the fifth step its own button vanished on exactly the
          render that graduates, and Radix had nothing to restore focus to on
          close — the failure `activated` exists to prevent. The five checked
          rows are the evidence for the congratulation above them anyway. */}
      <ul className="mt-3 space-y-0.5">
        {steps.map((step) => {
          const copy = STEP_COPY[step.id];
          return (
            <li
              key={step.id}
              data-testid={`onboarding-step-${step.id}`}
              data-complete={String(step.complete)}
              className="flex items-center gap-2.5 py-1"
            >
              {step.complete ? (
                <Check size={15} className="shrink-0 text-foreground" aria-hidden="true" />
              ) : (
                <span
                  className="h-[15px] w-[15px] shrink-0 rounded-full border border-border-interactive"
                  aria-hidden="true"
                />
              )}
              {/* Wraps rather than truncates: at phone widths a truncated
                  instruction is the one thing the row exists to say. */}
              <span
                id={`onboarding-step-title-${step.id}`}
                className={
                  step.complete
                    ? 'min-w-0 flex-1 text-sm text-muted-foreground'
                    : 'min-w-0 flex-1 text-sm text-foreground'
                }
              >
                {copy.title}
              </span>
              {/* The glyph is decoration; the state has to be readable. */}
              <span className="sr-only">{step.complete ? 'Done' : 'Not done yet'}</span>
              {(!step.complete || activated.includes(step.id)) && (
                <button
                  type="button"
                  onClick={() => runStep(step.id)}
                  data-testid={`onboarding-cta-${step.id}`}
                  /* The visible label stays the accessible name (WCAG 2.5.3),
                     but "Connect" and "New page" say nothing on their own to
                     a reader browsing by control — the row title is the
                     missing half, and DOM proximity is not an accessibility
                     relationship. */
                  aria-describedby={`onboarding-step-title-${step.id}`}
                  className="nm-button-ghost h-8 shrink-0 px-2.5 text-xs"
                >
                  {copy.cta}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
