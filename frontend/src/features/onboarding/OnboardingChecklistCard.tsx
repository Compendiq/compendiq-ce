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

export function OnboardingChecklistCard() {
  const navigate = useNavigate();
  const openShortcuts = useKeyboardShortcutsStore((s) => s.open);
  // This is the one mount that records `completedAt` — see the hook's
  // `trackCompletion` note for why exactly one instance may.
  const { ready, steps, completedCount, allComplete, visible, dismiss } = useOnboarding({
    trackCompletion: true,
  });

  /**
   * Did THIS mount watch the last step land?
   *
   * Graduation persists `dismissed: true`, so without a latch the card would
   * vanish the moment the write's invalidation returned — the user would see
   * their fifth checkmark and then an empty space. The latch holds the
   * completion state until they leave the overview or press Dismiss; there is
   * no timer, because a panel that removes itself on a clock is one a slow
   * reader never gets to read.
   *
   * It is deliberately per-mount: reopening the finished guide from the User
   * Menu shows the checked list, not a second congratulation.
   */
  const [celebrating, setCelebrating] = useState(false);
  const wasComplete = useRef<boolean | null>(null);
  useEffect(() => {
    if (!ready) return;
    if (wasComplete.current === false && allComplete) setCelebrating(true);
    wasComplete.current = allComplete;
  }, [ready, allComplete]);

  if (!ready) return null;
  if (!visible && !celebrating) return null;

  const runStep = (id: OnboardingStepId) => {
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
    setCelebrating(false);
    dismiss();
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

      {celebrating ? (
        <p
          role="status"
          data-testid="onboarding-complete"
          className="mt-3 text-sm text-muted-foreground"
        >
          All five done — Compendiq is set up. You can reopen this guide from your
          account menu.
        </p>
      ) : (
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
                {!step.complete && (
                  <button
                    type="button"
                    onClick={() => runStep(step.id)}
                    data-testid={`onboarding-cta-${step.id}`}
                    className="nm-button-ghost h-8 shrink-0 px-2.5 text-xs"
                  >
                    {copy.cta}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
