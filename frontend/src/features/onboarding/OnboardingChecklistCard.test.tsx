/**
 * The Getting Started checklist (#1402, phase 2/3).
 *
 * Mounted the way `PagesPage` mounts it and mocked only at the network
 * boundary, so these describe what a user can observe.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SettingsResponse } from '@compendiq/contracts';
import { OnboardingChecklistCard } from './OnboardingChecklistCard';
import { useKeyboardShortcutsStore } from '../../stores/keyboard-shortcuts-store';
import { CONFLUENCE_SETTINGS_PATH, SPACES_SETTINGS_PATH } from '../../shared/lib/routes';

const apiFetchMock = vi.fn();
vi.mock('../../shared/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

function settingsFixture(
  overrides: Partial<SettingsResponse> = {},
  onboarding: Partial<SettingsResponse['onboardingState']> = {},
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

function renderCard(settings: SettingsResponse | undefined, onDismissed?: () => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  if (settings) queryClient.setQueryData(['settings'], settings);
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <OnboardingChecklistCard onDismissed={onDismissed} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

/**
 * A settings endpoint that behaves like phase 1's: `GET` answers the current
 * row and `PUT` merges `onboardingState` into it, top level by top-level key.
 *
 * The graduation tests below turn on what the invalidation REFETCH brings
 * back, so a mock that answered `{}` (or a frozen fixture) would be testing the
 * stub rather than the card.
 */
function serveSettings(initial: SettingsResponse) {
  let current = initial;
  apiFetchMock.mockImplementation((path: string, init?: { method?: string; body?: string }) => {
    if (path !== '/settings') return Promise.resolve({});
    if (init?.method === 'PUT') {
      const patch = JSON.parse(init.body ?? '{}') as Partial<SettingsResponse>;
      current = {
        ...current,
        ...patch,
        onboardingState: { ...current.onboardingState, ...(patch.onboardingState ?? {}) },
      };
      return Promise.resolve({});
    }
    return Promise.resolve(current);
  });
}

function settingsPuts() {
  return apiFetchMock.mock.calls.filter(
    ([path, init]) =>
      path === '/settings' && (init as { method?: string } | undefined)?.method === 'PUT',
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue({});
  mockNavigate.mockReset();
  useKeyboardShortcutsStore.setState({ isOpen: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OnboardingChecklistCard — presence', () => {
  it('renders nothing while settings are still loading', () => {
    apiFetchMock.mockReturnValue(new Promise(() => {}));
    renderCard(undefined);
    expect(screen.queryByTestId('onboarding-checklist')).not.toBeInTheDocument();
  });

  it('renders nothing at all — not even a collapsed sliver — once dismissed', () => {
    renderCard(settingsFixture({}, { dismissed: true }));
    expect(screen.queryByTestId('onboarding-checklist')).not.toBeInTheDocument();
  });

  it('is a labelled section for a user with steps outstanding', () => {
    renderCard(settingsFixture());
    const card = screen.getByTestId('onboarding-checklist');
    expect(card.tagName).toBe('SECTION');
    expect(card).toHaveAccessibleName(/getting started/i);
  });
});

describe('OnboardingChecklistCard — steps', () => {
  it('renders the five milestones with their completion state', () => {
    renderCard(
      settingsFixture({ hasConfluencePat: true }, { shortcutsModalViewed: true }),
    );

    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByTestId('onboarding-step-connect-confluence')).toHaveAttribute(
      'data-complete',
      'true',
    );
    expect(screen.getByTestId('onboarding-step-shortcuts')).toHaveAttribute(
      'data-complete',
      'true',
    );
    expect(screen.getByTestId('onboarding-step-select-spaces')).toHaveAttribute(
      'data-complete',
      'false',
    );
    expect(screen.getByTestId('onboarding-step-ask-ai')).toHaveAttribute('data-complete', 'false');
    expect(screen.getByTestId('onboarding-step-create-page')).toHaveAttribute(
      'data-complete',
      'false',
    );
  });

  it('states progress in words, not colour alone', () => {
    renderCard(settingsFixture({ hasConfluencePat: true, selectedSpaces: ['ENG'] }));
    expect(screen.getByTestId('onboarding-progress')).toHaveTextContent('2 of 5 done');
  });

  it('names the state of each step for a screen reader, not only with a glyph', () => {
    renderCard(settingsFixture({ hasConfluencePat: true }));
    expect(screen.getByTestId('onboarding-step-connect-confluence')).toHaveTextContent('Done');
  });

  it('offers a CTA only for the steps still outstanding', () => {
    renderCard(settingsFixture({ hasConfluencePat: true }));
    expect(screen.queryByTestId('onboarding-cta-connect-confluence')).not.toBeInTheDocument();
    expect(screen.getByTestId('onboarding-cta-select-spaces')).toBeInTheDocument();
  });

  // "Connect" and "New page" are meaningless to a reader browsing by control;
  // the row title is the missing half and DOM proximity does not supply it.
  it('describes each CTA with the milestone its row names', () => {
    renderCard(settingsFixture());
    expect(screen.getByTestId('onboarding-cta-connect-confluence')).toHaveAccessibleDescription(
      'Connect your Confluence account',
    );
    expect(screen.getByTestId('onboarding-cta-create-page')).toHaveAccessibleDescription(
      'Create or edit a page',
    );
    // …without borrowing it as the name (WCAG 2.5.3: the visible label is the
    // name, so "Connect" still matches a voice command).
    expect(screen.getByTestId('onboarding-cta-connect-confluence')).toHaveAccessibleName(
      'Connect',
    );
  });

  /**
   * The shortcuts CTA is the one that acts in place, and it completes its own
   * step: opening the modal marks `shortcutsModalViewed`. Removing the button
   * the user is still standing on strands their focus — the modal then has
   * nothing to restore to on close and it falls to `<body>`.
   */
  it('keeps a CTA the user just pressed, so its completion does not strand focus', async () => {
    const { queryClient } = renderCard(settingsFixture());
    const cta = screen.getByTestId('onboarding-cta-shortcuts');
    cta.focus();
    fireEvent.click(cta);

    act(() => {
      queryClient.setQueryData(
        ['settings'],
        settingsFixture({ hasConfluencePat: true }, { shortcutsModalViewed: true }),
      );
    });

    await waitFor(() =>
      expect(screen.getByTestId('onboarding-step-shortcuts')).toHaveAttribute(
        'data-complete',
        'true',
      ),
    );
    expect(screen.getByTestId('onboarding-cta-shortcuts')).toBe(document.activeElement);
    // A step that completed without the user pressing its CTA still loses it.
    expect(screen.queryByTestId('onboarding-cta-connect-confluence')).not.toBeInTheDocument();
  });
});

describe('OnboardingChecklistCard — CTAs', () => {
  it('sends the Confluence step to the Confluence settings panel', () => {
    renderCard(settingsFixture());
    fireEvent.click(screen.getByTestId('onboarding-cta-connect-confluence'));
    expect(mockNavigate).toHaveBeenCalledWith(CONFLUENCE_SETTINGS_PATH);
  });

  it('sends the spaces step to the spaces panel', () => {
    renderCard(settingsFixture());
    fireEvent.click(screen.getByTestId('onboarding-cta-select-spaces'));
    expect(mockNavigate).toHaveBeenCalledWith(SPACES_SETTINGS_PATH);
  });

  // `/ai` rather than the dock: the dock is a tab on an open article, and the
  // checklist lives on the overview where no article is open.
  it('sends the AI step to the assistant route', () => {
    renderCard(settingsFixture());
    fireEvent.click(screen.getByTestId('onboarding-cta-ask-ai'));
    expect(mockNavigate).toHaveBeenCalledWith('/ai');
  });

  it('opens the shortcuts modal in place rather than navigating', () => {
    renderCard(settingsFixture());
    fireEvent.click(screen.getByTestId('onboarding-cta-shortcuts'));
    expect(useKeyboardShortcutsStore.getState().isOpen).toBe(true);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('sends the page step to the new-page form', () => {
    renderCard(settingsFixture());
    fireEvent.click(screen.getByTestId('onboarding-cta-create-page'));
    expect(mockNavigate).toHaveBeenCalledWith('/pages/new');
  });
});

describe('OnboardingChecklistCard — dismissal', () => {
  it('hides itself and persists the dismissal', async () => {
    renderCard(settingsFixture());
    fireEvent.click(screen.getByTestId('onboarding-dismiss'));

    await waitFor(() =>
      expect(JSON.parse((settingsPuts()[0]![1] as { body: string }).body)).toEqual({
        onboardingState: { dismissed: true },
      }),
    );
  });

  it('names the control by its action', () => {
    renderCard(settingsFixture());
    expect(screen.getByTestId('onboarding-dismiss')).toHaveAccessibleName('Dismiss guide');
  });

  /**
   * The card removes itself while the user's focus is on its button, which
   * drops focus to `<body>` — the `RetrievalTab` Retry failure CLAUDE.md
   * records. The card cannot rehome focus itself (the target goes with it), so
   * it reports the removal and `PagesPage` moves focus to the Library heading.
   */
  it('reports the removal once the dismissal has actually taken the card away', async () => {
    serveSettings(settingsFixture());
    const onDismissed = vi.fn();
    renderCard(settingsFixture(), onDismissed);

    fireEvent.click(screen.getByTestId('onboarding-dismiss'));
    // Not while the write is still out and the button is still under focus.
    expect(onDismissed).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(screen.queryByTestId('onboarding-checklist')).not.toBeInTheDocument(),
    );
    expect(onDismissed).toHaveBeenCalledTimes(1);
  });
});

describe('OnboardingChecklistCard — graduation', () => {
  const allDone = settingsFixture({ hasConfluencePat: true, selectedSpaces: ['ENG'] }, {
    firstAiQueryMade: true,
    shortcutsModalViewed: true,
    pageCreatedOrEdited: true,
  });

  it('shows a completion state when the last step lands, and stops listing steps', async () => {
    const { queryClient } = renderCard(
      settingsFixture({ hasConfluencePat: true, selectedSpaces: ['ENG'] }, {
        firstAiQueryMade: true,
        shortcutsModalViewed: true,
      }),
    );
    expect(screen.queryByTestId('onboarding-complete')).not.toBeInTheDocument();

    act(() => {
      queryClient.setQueryData(['settings'], allDone);
    });

    const done = await screen.findByTestId('onboarding-complete');
    expect(done).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });

  /**
   * The dominant flow: three of the five CTAs navigate away from `/`, so the
   * fifth milestone is normally recorded elsewhere and the overview is
   * re-entered already-complete. A transition-only latch never fires for that
   * user — the fully-checked list flashed and vanished a round-trip later, and
   * the line telling them where the guide went was never shown at all.
   */
  it('congratulates a user who arrives already complete but not yet graduated', async () => {
    serveSettings(allDone);
    renderCard(allDone);

    expect(screen.getByTestId('onboarding-complete')).toBeInTheDocument();

    // The graduation write lands and reports `dismissed: true`; the completion
    // state stays on screen rather than deleting itself under the reader.
    await waitFor(() => expect(settingsPuts()).toHaveLength(1));
    await waitFor(() =>
      expect(apiFetchMock.mock.calls.some(([p, i]) => p === '/settings' && !i)).toBe(true),
    );
    expect(screen.getByTestId('onboarding-complete')).toBeInTheDocument();
  });

  /**
   * `shortcutsModalViewed` is the one milestone completable without leaving
   * `/` — pressing `?` while the card is mounted-but-hidden. The card must
   * stay gone: a guide the user closed does not come back as a congratulation.
   */
  it('stays gone for a dismissed user when the last step lands behind it', async () => {
    const dismissed = settingsFixture({ hasConfluencePat: true, selectedSpaces: ['ENG'] }, {
      firstAiQueryMade: true,
      pageCreatedOrEdited: true,
      dismissed: true,
    });
    serveSettings(dismissed);
    const { queryClient } = renderCard(dismissed);
    expect(screen.queryByTestId('onboarding-checklist')).not.toBeInTheDocument();

    act(() => {
      queryClient.setQueryData(['settings'], {
        ...dismissed,
        onboardingState: { ...dismissed.onboardingState, shortcutsModalViewed: true },
      });
    });

    // Graduation is still recorded — it just does not resurface the card.
    await waitFor(() => expect(settingsPuts()).toHaveLength(1));
    expect(screen.queryByTestId('onboarding-checklist')).not.toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-complete')).not.toBeInTheDocument();
  });

  it('does not celebrate again for a user who already graduated', () => {
    renderCard(
      settingsFixture({ hasConfluencePat: true, selectedSpaces: ['ENG'] }, {
        firstAiQueryMade: true,
        shortcutsModalViewed: true,
        pageCreatedOrEdited: true,
        completedAt: '2026-01-01T00:00:00.000Z',
        dismissed: true,
      }),
    );
    expect(screen.queryByTestId('onboarding-checklist')).not.toBeInTheDocument();
  });

  it('lets the reopened, finished guide be closed again', async () => {
    renderCard(
      settingsFixture({ hasConfluencePat: true, selectedSpaces: ['ENG'] }, {
        firstAiQueryMade: true,
        shortcutsModalViewed: true,
        pageCreatedOrEdited: true,
        completedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    // Reopened from the User Menu: all five checked, nothing to do, and the
    // Dismiss control is the way back out.
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    fireEvent.click(screen.getByTestId('onboarding-dismiss'));
    await waitFor(() => expect(settingsPuts()).toHaveLength(1));
  });
});

describe('OnboardingChecklistCard — ADR-010 compliance', () => {
  it('is a flat hairline pane, never an elevated overlay', () => {
    renderCard(settingsFixture());
    const card = screen.getByTestId('onboarding-checklist');
    expect(card.className).toContain('nm-card');
    expect(card.className).not.toContain('nm-card-elevated');
  });

  // The Confluence PAT banner's lesson (CLAUDE.md): an onboarding prompt that
  // wears the one filled accent on screen outranks the page's own primary
  // action. Every control here is quiet.
  it('claims no filled accent', () => {
    renderCard(settingsFixture());
    const card = screen.getByTestId('onboarding-checklist');
    expect(card.innerHTML).not.toContain('nm-button-primary');
    expect(card.innerHTML).not.toMatch(/\bbg-(primary|action)\b/);
  });

  it('borrows no pipeline status hue for an achievement', () => {
    renderCard(settingsFixture({ hasConfluencePat: true }));
    const card = screen.getByTestId('onboarding-checklist');
    expect(card.innerHTML).not.toMatch(/status-(connected|syncing|disconnected|embedding)/);
    expect(card.innerHTML).not.toMatch(/\b(text|bg|border)-(success|warning|destructive)\b/);
  });

  it('keeps its controls at the 32px density floor', () => {
    renderCard(settingsFixture());
    for (const button of screen.getAllByRole('button')) {
      expect(button.className).toMatch(/\bh-8\b/);
    }
  });
});
