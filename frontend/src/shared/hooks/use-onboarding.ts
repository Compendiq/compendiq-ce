import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { SettingsResponse } from '@compendiq/contracts';
import { useSettings, useUpdateSettings } from './use-settings';

/**
 * The Getting Started checklist's state (#1402, phase 2/3).
 *
 * There is deliberately **no `stores/onboarding-store.ts`**. Four of the five
 * milestones are already server state on `GET /settings`, and the TanStack
 * Query cache behind `useSettings()` is the store: a Zustand mirror of it
 * would need its own invalidation on every PAT save, space selection and
 * settings write that already invalidates `['settings']`, and would go stale
 * the first time one of those happened in another tab.
 *
 * Two of the five steps are **computed live** and are not persisted at all.
 * Phase 1 left `patConfigured` / `spacesSelected` out of `OnboardingStateSchema`
 * on purpose: a stored boolean drifts from the truth the moment a user
 * disconnects their PAT or clears their space selection, and `hasConfluencePat`
 * / `selectedSpaces` are on the same response already.
 */

/** The three milestones that have no live signal and must be remembered. */
export type OnboardingFlag = 'firstAiQueryMade' | 'shortcutsModalViewed' | 'pageCreatedOrEdited';

export const ONBOARDING_STEP_IDS = [
  'connect-confluence',
  'select-spaces',
  'ask-ai',
  'shortcuts',
  'create-page',
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

export interface OnboardingStep {
  id: OnboardingStepId;
  complete: boolean;
}

export interface OnboardingActions {
  /**
   * Record one milestone. Idempotent and fire-and-forget: the write is skipped
   * entirely when the cached settings already report the flag, so the AI
   * composers and page mutations can call this on every success without
   * turning every send into a second request.
   */
  markComplete: (flag: OnboardingFlag) => void;
  /** Hide the checklist for this user, persistently. */
  dismiss: () => void;
  /** Bring it back — the User Menu's "Getting Started Guide". */
  reopen: () => void;
}

/**
 * Actions only: no `useSettings()` subscription, so this is safe to mount
 * inside widely-used hooks (`useCreatePage`, `useUpdatePage`) and components
 * that have no other reason to re-render when settings change.
 *
 * The already-true check reads the query **cache** rather than subscribing to
 * it, which is what buys that: `getQueryData` is a plain read.
 */
export function useOnboardingActions(): OnboardingActions {
  const queryClient = useQueryClient();
  // Nobody asked for an auto-mark, so neither outcome is worth a toast — see
  // `UpdateSettingsToastOptions`.
  const autoMark = useUpdateSettings({ silent: true, silentErrors: true });
  // Dismiss/Reopen are button presses: no confirmation (there is nothing the
  // user is waiting to see beyond the card appearing or going), but a failure
  // has to be reported or the button looks broken.
  const explicit = useUpdateSettings({ silent: true });
  const autoMarkMutate = autoMark.mutate;
  const explicitMutate = explicit.mutate;

  const markComplete = useCallback(
    (flag: OnboardingFlag) => {
      const cached = queryClient.getQueryData<SettingsResponse>(['settings']);
      if (cached?.onboardingState?.[flag] === true) return;
      autoMarkMutate({ onboardingState: { [flag]: true } });
    },
    [queryClient, autoMarkMutate],
  );

  const dismiss = useCallback(
    () => explicitMutate({ onboardingState: { dismissed: true } }),
    [explicitMutate],
  );

  const reopen = useCallback(
    () => explicitMutate({ onboardingState: { dismissed: false } }),
    [explicitMutate],
  );

  return { markComplete, dismiss, reopen };
}

export interface UseOnboardingOptions {
  /**
   * Record `completedAt` when the checklist first reaches all-complete.
   *
   * Opt-in because the effect must run in exactly ONE place — the checklist
   * card, which `PagesPage` always mounts — or every hook instance on screen
   * races to write the same timestamp.
   */
  trackCompletion?: boolean;
}

export interface UseOnboarding extends OnboardingActions {
  /** False until `GET /settings` has answered. Nothing renders before then. */
  ready: boolean;
  steps: OnboardingStep[];
  completedCount: number;
  allComplete: boolean;
  dismissed: boolean;
  /** Whether the checklist card should be on screen at all. */
  visible: boolean;
}

export function useOnboarding({ trackCompletion = false }: UseOnboardingOptions = {}): UseOnboarding {
  const { data: settings } = useSettings();
  const actions = useOnboardingActions();
  const state = settings?.onboardingState;

  const steps = useMemo<OnboardingStep[]>(
    () => [
      // Computed, not stored — see the module comment.
      { id: 'connect-confluence', complete: settings?.hasConfluencePat === true },
      { id: 'select-spaces', complete: (settings?.selectedSpaces?.length ?? 0) > 0 },
      { id: 'ask-ai', complete: state?.firstAiQueryMade === true },
      { id: 'shortcuts', complete: state?.shortcutsModalViewed === true },
      { id: 'create-page', complete: state?.pageCreatedOrEdited === true },
    ],
    [settings?.hasConfluencePat, settings?.selectedSpaces, state],
  );

  const ready = settings !== undefined;
  const completedCount = steps.filter((s) => s.complete).length;
  const allComplete = ready && completedCount === steps.length;
  const dismissed = state?.dismissed === true;

  /**
   * One-shot graduation write.
   *
   * `completedAt` is set exactly once and never rewritten, so the guard is the
   * server value plus a ref for the window between the mutation firing and the
   * `['settings']` invalidation landing — without it, a re-render inside that
   * window would fire a second identical PATCH.
   *
   * `dismissed: true` rides along deliberately: "auto-graduation" means the
   * card retires itself, and folding it into the same write keeps visibility a
   * single server-derived fact rather than a local flag two components would
   * each need their own copy of. The card holds its completion state on screen
   * for a beat, and the User Menu brings the finished list back at any time.
   */
  const graduationWritten = useRef(false);
  const graduate = useUpdateSettings({ silent: true, silentErrors: true });
  const graduateMutate = graduate.mutate;
  useEffect(() => {
    if (!trackCompletion || !allComplete) return;
    if (state?.completedAt != null || graduationWritten.current) return;
    graduationWritten.current = true;
    graduateMutate({
      onboardingState: { completedAt: new Date().toISOString(), dismissed: true },
    });
  }, [trackCompletion, allComplete, state?.completedAt, graduateMutate]);

  return {
    ready,
    steps,
    completedCount,
    allComplete,
    dismissed,
    visible: ready && !dismissed,
    ...actions,
  };
}
