import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
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

/**
 * Flags this session has already written, keyed by the QueryClient they were
 * written through.
 *
 * The cache read below cannot carry the dedupe on its own: `['settings']` is
 * only populated where something mounts `useSettings()`, and **`/ai` mounts
 * nothing that does** — `invalidateQueries` never creates an entry, and an
 * inactive one is marked stale rather than refetched. So on the busiest
 * auto-mark surface in the app the guard read `undefined` forever and every
 * answered question fired another `PUT /settings`.
 *
 * A `WeakMap` rather than a module-level `Set` so the record dies with the
 * QueryClient it belongs to, which keeps it out of every other test file's way.
 *
 * **The QueryClient is NOT rebuilt on sign-out.** `main.tsx` builds exactly one
 * at module scope and login is a pure SPA transition, so this record outlives a
 * logout the way the query cache would — issue #885's class of bug. It is
 * therefore cleared by `useClearCacheOnLogout`, the single choke point every
 * `clearAuth` path already flows through: without that, the second user in a
 * tab has their milestones silently suppressed for the rest of the page load
 * while their server-side flags are still false.
 *
 * The entry is added optimistically and **removed again if the write fails**,
 * which is what keeps the documented retry-on-the-next-occurrence behaviour of
 * a `silentErrors` auto-mark: a flag lost to a network blip must not be
 * suppressed for the rest of the page load. That release runs from the
 * mutation's **hook-level** `onError` and not from `mutate`'s own options,
 * because react-query delivers the latter through the MutationObserver, which
 * `useMutation` detaches on unmount — and `useCreatePage().onSuccess` marks its
 * milestone and navigates away in the same breath, so the caller is normally
 * already gone by the time the write settles.
 */
const flagsWrittenThisSession = new WeakMap<QueryClient, Set<OnboardingFlag>>();

function sessionWrites(queryClient: QueryClient): Set<OnboardingFlag> {
  let written = flagsWrittenThisSession.get(queryClient);
  if (!written) {
    written = new Set<OnboardingFlag>();
    flagsWrittenThisSession.set(queryClient, written);
  }
  return written;
}

/**
 * Forget every flag this client has written, so the next user in the tab starts
 * from their own server state. Called by `useClearCacheOnLogout` beside the
 * cache wipe — see the record's own note above for why that is necessary.
 */
export function resetOnboardingSessionWrites(queryClient: QueryClient): void {
  flagsWrittenThisSession.delete(queryClient);
}

export interface OnboardingActions {
  /**
   * Record one milestone. Idempotent and fire-and-forget: the write is skipped
   * entirely when the cached settings already report the flag or this session
   * has already written it, so the AI composers and page mutations can call
   * this on every success without turning every send into a second request.
   */
  markComplete: (flag: OnboardingFlag) => void;
  /**
   * Hide the checklist for this user, persistently.
   *
   * `onError` is safe as a mutate-level option here — unlike the auto-marks
   * above — because the only caller is the checklist card, which `PagesPage`
   * mounts unconditionally and keeps mounted while it renders nothing. It is
   * how the card rolls back its optimistic hide.
   */
  dismiss: (options?: { onError?: () => void }) => void;
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
  const autoMark = useUpdateSettings({
    silent: true,
    silentErrors: true,
    // Hook-level, not `mutate`'s second argument — the caller is usually
    // unmounted by now (see the session record's note).
    onWriteError: (_error, body) => {
      const state = (body as { onboardingState?: Record<string, unknown> }).onboardingState;
      if (!state) return;
      const written = sessionWrites(queryClient);
      for (const flag of Object.keys(state)) written.delete(flag as OnboardingFlag);
    },
  });
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
      const written = sessionWrites(queryClient);
      if (written.has(flag)) return;
      written.add(flag);
      autoMarkMutate({ onboardingState: { [flag]: true } });
    },
    [queryClient, autoMarkMutate],
  );

  const dismiss = useCallback(
    (options?: { onError?: () => void }) =>
      explicitMutate({ onboardingState: { dismissed: true } }, { onError: options?.onError }),
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
  /**
   * Has the graduation write already landed for this user (`completedAt` set)?
   *
   * The card needs the *server's* answer to "has anyone congratulated this
   * user yet", not an in-mount transition: three of the five CTAs navigate
   * away from `/`, so the last milestone usually lands on another route and
   * the overview is re-entered already-complete.
   */
  graduated: boolean;
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
  const graduated = state?.completedAt != null;
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
    if (graduated || graduationWritten.current) return;
    graduationWritten.current = true;
    graduateMutate({
      onboardingState: { completedAt: new Date().toISOString(), dismissed: true },
    });
  }, [trackCompletion, allComplete, graduated, graduateMutate]);

  return {
    ready,
    steps,
    completedCount,
    allComplete,
    graduated,
    dismissed,
    visible: ready && !dismissed,
    ...actions,
  };
}
