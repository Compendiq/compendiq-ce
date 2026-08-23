import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import type { SettingsResponse } from '@compendiq/contracts';
import { useOnboarding, useOnboardingActions, ONBOARDING_STEP_IDS } from './use-onboarding';

// Network boundary only.
const apiFetchMock = vi.fn();
vi.mock('../lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

type OnboardingFixture = Partial<SettingsResponse['onboardingState']>;

function settingsFixture(
  overrides: Partial<SettingsResponse> = {},
  onboarding: OnboardingFixture = {},
): SettingsResponse {
  return {
    confluenceUrl: null,
    hasConfluencePat: false,
    selectedSpaces: [],
    theme: 'graphite',
    syncIntervalMin: 15,
    confluenceConnected: false,
    showSpaceHomeContent: true,
    customPrompts: {},
    inlineCompletionEnabled: false,
    inlineCompletionDelay: 'balanced',
    inlineCompletionMode: 'word',
    inlineCompletionCodeOnly: false,
    confluencePatPromptDismissed: false,
    ...overrides,
    onboardingState: {
      firstAiQueryMade: false,
      shortcutsModalViewed: false,
      pageCreatedOrEdited: false,
      dismissed: false,
      completedAt: null,
      ...onboarding,
    },
  } as SettingsResponse;
}

/**
 * `useSettings` is a real `useQuery` here; only `apiFetch` is stubbed. Seeding
 * the cache instead of resolving a promise keeps the hook's first render
 * already-loaded, which is what every derivation assertion below is about.
 */
function harness(settings: SettingsResponse | undefined) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  if (settings) queryClient.setQueryData(['settings'], settings);
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, wrapper };
}

/** Every `PUT /settings` body this test file's mutations produced. */
function putBodies(): unknown[] {
  return apiFetchMock.mock.calls
    .filter(([path, init]) => path === '/settings' && (init as { method?: string })?.method === 'PUT')
    .map(([, init]) => JSON.parse((init as { body: string }).body));
}

afterEach(() => {
  vi.restoreAllMocks();
  apiFetchMock.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

describe('useOnboarding — step derivation', () => {
  it('exposes the five milestones in a stable order', () => {
    const { wrapper } = harness(settingsFixture());
    const { result } = renderHook(() => useOnboarding(), { wrapper });

    expect(result.current.steps.map((s) => s.id)).toEqual([
      'connect-confluence',
      'select-spaces',
      'ask-ai',
      'shortcuts',
      'create-page',
    ]);
    expect(ONBOARDING_STEP_IDS).toEqual(result.current.steps.map((s) => s.id));
  });

  it('reports nothing complete for a brand-new user', () => {
    const { wrapper } = harness(settingsFixture());
    const { result } = renderHook(() => useOnboarding(), { wrapper });

    expect(result.current.steps.every((s) => !s.complete)).toBe(true);
    expect(result.current.completedCount).toBe(0);
    expect(result.current.allComplete).toBe(false);
  });

  it('computes the PAT step from hasConfluencePat, not from a stored flag', () => {
    const { wrapper } = harness(settingsFixture({ hasConfluencePat: true }));
    const { result } = renderHook(() => useOnboarding(), { wrapper });

    const step = result.current.steps.find((s) => s.id === 'connect-confluence');
    expect(step?.complete).toBe(true);
    expect(result.current.completedCount).toBe(1);
  });

  it('computes the spaces step from the saved selection', () => {
    const { wrapper } = harness(settingsFixture({ selectedSpaces: ['ENG'] }));
    const { result } = renderHook(() => useOnboarding(), { wrapper });

    expect(result.current.steps.find((s) => s.id === 'select-spaces')?.complete).toBe(true);
  });

  it('reads the three persisted milestones off onboardingState', () => {
    const { wrapper } = harness(
      settingsFixture({}, {
        firstAiQueryMade: true,
        shortcutsModalViewed: true,
        pageCreatedOrEdited: true,
      }),
    );
    const { result } = renderHook(() => useOnboarding(), { wrapper });

    expect(result.current.steps.find((s) => s.id === 'ask-ai')?.complete).toBe(true);
    expect(result.current.steps.find((s) => s.id === 'shortcuts')?.complete).toBe(true);
    expect(result.current.steps.find((s) => s.id === 'create-page')?.complete).toBe(true);
    expect(result.current.completedCount).toBe(3);
    // Two computed steps are still open, so the checklist is not done.
    expect(result.current.allComplete).toBe(false);
  });

  it('is allComplete only when all five — two computed and three stored — are true', () => {
    const { wrapper } = harness(
      settingsFixture({ hasConfluencePat: true, selectedSpaces: ['ENG'] }, {
        firstAiQueryMade: true,
        shortcutsModalViewed: true,
        pageCreatedOrEdited: true,
      }),
    );
    const { result } = renderHook(() => useOnboarding(), { wrapper });

    expect(result.current.completedCount).toBe(5);
    expect(result.current.allComplete).toBe(true);
  });

  it('is not ready — and shows nothing — while settings are still loading', () => {
    apiFetchMock.mockReturnValue(new Promise(() => {}));
    const { wrapper } = harness(undefined);
    const { result } = renderHook(() => useOnboarding(), { wrapper });

    expect(result.current.ready).toBe(false);
    expect(result.current.visible).toBe(false);
  });
});

describe('useOnboarding — dismiss and reopen', () => {
  it('is visible for an undismissed user and hidden once dismissed', () => {
    const open = harness(settingsFixture());
    const { result: openResult } = renderHook(() => useOnboarding(), { wrapper: open.wrapper });
    expect(openResult.current.visible).toBe(true);

    const hidden = harness(settingsFixture({}, { dismissed: true }));
    const { result: hiddenResult } = renderHook(() => useOnboarding(), { wrapper: hidden.wrapper });
    expect(hiddenResult.current.visible).toBe(false);
    expect(hiddenResult.current.dismissed).toBe(true);
  });

  it('dismiss() persists dismissed:true without a "Settings saved" toast', async () => {
    apiFetchMock.mockResolvedValue({});
    const { wrapper } = harness(settingsFixture());
    const { result } = renderHook(() => useOnboarding(), { wrapper });

    act(() => result.current.dismiss());

    await waitFor(() => expect(putBodies()).toEqual([{ onboardingState: { dismissed: true } }]));
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('reopen() persists dismissed:false, so the round-trip survives a reload', async () => {
    apiFetchMock.mockResolvedValue({});
    const { wrapper } = harness(settingsFixture({}, { dismissed: true }));
    const { result } = renderHook(() => useOnboarding(), { wrapper });

    act(() => result.current.reopen());

    await waitFor(() => expect(putBodies()).toEqual([{ onboardingState: { dismissed: false } }]));
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('surfaces a failed dismiss — the user pressed a button and it did not stick', async () => {
    apiFetchMock.mockRejectedValue(new Error('Network down'));
    const { wrapper } = harness(settingsFixture());
    const { result } = renderHook(() => useOnboarding(), { wrapper });

    act(() => result.current.dismiss());

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Network down'));
  });
});

describe('useOnboardingActions — silent auto-marks', () => {
  it('PATCHes the single flag it was given, silently', async () => {
    apiFetchMock.mockResolvedValue({});
    const { wrapper } = harness(settingsFixture());
    const { result } = renderHook(() => useOnboardingActions(), { wrapper });

    act(() => result.current.markComplete('firstAiQueryMade'));

    await waitFor(() =>
      expect(putBodies()).toEqual([{ onboardingState: { firstAiQueryMade: true } }]),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('says nothing when a background auto-mark fails', async () => {
    apiFetchMock.mockRejectedValue(new Error('Network down'));
    const { wrapper } = harness(settingsFixture());
    const { result } = renderHook(() => useOnboardingActions(), { wrapper });

    act(() => result.current.markComplete('pageCreatedOrEdited'));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('does not re-PATCH a flag the cached settings already report as true', async () => {
    apiFetchMock.mockResolvedValue({});
    const { wrapper } = harness(settingsFixture({}, { shortcutsModalViewed: true }));
    const { result } = renderHook(() => useOnboardingActions(), { wrapper });

    act(() => result.current.markComplete('shortcutsModalViewed'));

    await Promise.resolve();
    expect(putBodies()).toEqual([]);
  });

  /**
   * `/ai` mounts nothing that calls `useSettings()`, so the `['settings']`
   * entry is genuinely absent there: `invalidateQueries` never creates one and
   * an inactive entry is marked stale rather than refetched. The cache read
   * alone therefore deduped nothing on the busiest auto-mark surface in the
   * app, and every answered question fired another silent `PUT /settings`.
   */
  it('writes a flag once per session even with no settings observer to cache it', async () => {
    apiFetchMock.mockResolvedValue({});
    const { queryClient, wrapper } = harness(undefined);
    const { result } = renderHook(() => useOnboardingActions(), { wrapper });

    act(() => result.current.markComplete('firstAiQueryMade'));
    await waitFor(() => expect(putBodies()).toHaveLength(1));
    act(() => result.current.markComplete('firstAiQueryMade'));
    act(() => result.current.markComplete('firstAiQueryMade'));

    await Promise.resolve();
    expect(putBodies()).toEqual([{ onboardingState: { firstAiQueryMade: true } }]);
    // The premise: nothing ever populated the cache the old guard read.
    expect(queryClient.getQueryData(['settings'])).toBeUndefined();
  });

  it('retries on the next occurrence when the write failed — the flag is not lost', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('Network down')).mockResolvedValue({});
    const { wrapper } = harness(undefined);
    const { result } = renderHook(() => useOnboardingActions(), { wrapper });

    act(() => result.current.markComplete('pageCreatedOrEdited'));
    // Let the rejection settle, so the session record is released before the
    // next occurrence rather than in the middle of it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(putBodies()).toHaveLength(1);

    act(() => result.current.markComplete('pageCreatedOrEdited'));
    await waitFor(() => expect(putBodies()).toHaveLength(2));
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe('useOnboarding — completion', () => {
  it('records completedAt exactly once on the transition to all-complete, and retires the card', async () => {
    apiFetchMock.mockResolvedValue({});
    const complete = settingsFixture({ hasConfluencePat: true, selectedSpaces: ['ENG'] }, {
      firstAiQueryMade: true,
      shortcutsModalViewed: true,
      pageCreatedOrEdited: true,
    });
    const { queryClient, wrapper } = harness(
      settingsFixture({ hasConfluencePat: true, selectedSpaces: ['ENG'] }, {
        firstAiQueryMade: true,
        shortcutsModalViewed: true,
      }),
    );
    const { result, rerender } = renderHook(() => useOnboarding({ trackCompletion: true }), {
      wrapper,
    });
    expect(result.current.allComplete).toBe(false);
    expect(putBodies()).toEqual([]);

    act(() => {
      queryClient.setQueryData(['settings'], complete);
    });

    await waitFor(() => expect(putBodies()).toHaveLength(1));
    const [body] = putBodies() as [{ onboardingState: { completedAt: string; dismissed: boolean } }];
    expect(typeof body.onboardingState.completedAt).toBe('string');
    // Graduation retires the card in the same write; the User Menu can bring
    // it back, and `completedAt` is then never rewritten.
    expect(body.onboardingState.dismissed).toBe(true);
    expect(toastSuccess).not.toHaveBeenCalled();

    rerender();
    await Promise.resolve();
    expect(putBodies()).toHaveLength(1);
  });

  /**
   * The ref half of the graduation guard, on its own.
   *
   * A bare `rerender()` cannot reach it — every dependency is unchanged, so
   * the effect never re-runs and the assertion passes with the ref deleted.
   * This drives a real second invocation: `allComplete` genuinely leaves and
   * re-enters while the write is still out and `completedAt` is therefore
   * still null on the server, which is the window (React StrictMode's dev
   * double-invoke is the other) the ref exists for.
   */
  it('records completedAt once even when all-complete is re-entered before the write lands', async () => {
    // The PUT never settles, so nothing can invalidate the guard for us.
    apiFetchMock.mockReturnValue(new Promise(() => {}));
    const base = { hasConfluencePat: true, selectedSpaces: ['ENG'] };
    const marks = {
      firstAiQueryMade: true,
      shortcutsModalViewed: true,
      pageCreatedOrEdited: true,
    };
    const { queryClient, wrapper } = harness(settingsFixture(base, marks));
    const { result } = renderHook(() => useOnboarding({ trackCompletion: true }), { wrapper });

    await waitFor(() => expect(putBodies()).toHaveLength(1));

    act(() => {
      queryClient.setQueryData(
        ['settings'],
        settingsFixture(base, { ...marks, pageCreatedOrEdited: false }),
      );
    });
    // The observer notification is batched, so the effect has genuinely re-run
    // on a false `allComplete` before the second write goes back to true.
    await waitFor(() => expect(result.current.allComplete).toBe(false));
    act(() => {
      queryClient.setQueryData(['settings'], settingsFixture(base, marks));
    });
    await waitFor(() => expect(result.current.allComplete).toBe(true));

    expect(putBodies()).toHaveLength(1);
  });

  it('never overwrites a completedAt that is already set', async () => {
    apiFetchMock.mockResolvedValue({});
    const { wrapper } = harness(
      settingsFixture({ hasConfluencePat: true, selectedSpaces: ['ENG'] }, {
        firstAiQueryMade: true,
        shortcutsModalViewed: true,
        pageCreatedOrEdited: true,
        completedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    const { result } = renderHook(() => useOnboarding({ trackCompletion: true }), { wrapper });

    expect(result.current.allComplete).toBe(true);
    await Promise.resolve();
    expect(putBodies()).toEqual([]);
  });

  it('does not record completedAt from a hook instance that is not tracking it', async () => {
    apiFetchMock.mockResolvedValue({});
    const { wrapper } = harness(
      settingsFixture({ hasConfluencePat: true, selectedSpaces: ['ENG'] }, {
        firstAiQueryMade: true,
        shortcutsModalViewed: true,
        pageCreatedOrEdited: true,
      }),
    );
    renderHook(() => useOnboarding(), { wrapper });

    await Promise.resolve();
    expect(putBodies()).toEqual([]);
  });
});
