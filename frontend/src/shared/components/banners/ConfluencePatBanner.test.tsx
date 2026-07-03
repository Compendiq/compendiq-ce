import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SettingsResponse } from '@compendiq/contracts';
import { ConfluencePatBanner } from './ConfluencePatBanner';
import { CONFLUENCE_SETTINGS_PATH } from '../../lib/routes';

const baseSettings: SettingsResponse = {
  confluenceUrl: null,
  hasConfluencePat: false,
  selectedSpaces: [],
  theme: 'glass-dark',
  syncIntervalMin: 15,
  confluenceConnected: false,
  showSpaceHomeContent: true,
  customPrompts: {},
  confluencePatPromptDismissed: false,
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Network-boundary mock: serves GET /api/settings from in-memory state and
 * records PUT /api/settings bodies, applying confluencePatPromptDismissed so
 * the post-dismiss refetch behaves like the real backend.
 */
function mockSettingsApi(overrides: Partial<SettingsResponse> = {}) {
  const state = { settings: { ...baseSettings, ...overrides } };
  const puts: Array<Record<string, unknown>> = [];

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    if (url.endsWith('/api/settings') && method === 'GET') {
      return jsonResponse(state.settings);
    }
    if (url.endsWith('/api/settings') && method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      puts.push(body);
      if (typeof body.confluencePatPromptDismissed === 'boolean') {
        state.settings = {
          ...state.settings,
          confluencePatPromptDismissed: body.confluencePatPromptDismissed,
        };
      }
      return jsonResponse({ message: 'Settings updated' });
    }
    return new Response('Not found', { status: 404 });
  });

  return { state, puts };
}

function renderBanner() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<ConfluencePatBanner />} />
          <Route
            path={CONFLUENCE_SETTINGS_PATH}
            element={<div data-testid="confluence-settings-page">Confluence settings</div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ConfluencePatBanner', () => {
  it('shows for a user without a PAT who has not dismissed the prompt', async () => {
    mockSettingsApi({ hasConfluencePat: false, confluencePatPromptDismissed: false });
    renderBanner();

    const banner = await screen.findByTestId('confluence-pat-banner');
    expect(banner).toHaveTextContent('personal access token');
    expect(banner).toHaveAttribute('role', 'status');
    expect(screen.getByRole('link', { name: /configure pat/i })).toHaveAttribute(
      'href',
      CONFLUENCE_SETTINGS_PATH,
    );
  });

  it('renders nothing while settings are still loading', () => {
    // Fetch never resolves → query stays pending.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    renderBanner();
    expect(screen.queryByTestId('confluence-pat-banner')).toBeNull();
  });

  it('renders nothing when a PAT is already configured', async () => {
    mockSettingsApi({ hasConfluencePat: true });
    renderBanner();

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId('confluence-pat-banner')).toBeNull();
  });

  it('renders nothing when the prompt was previously dismissed', async () => {
    mockSettingsApi({ confluencePatPromptDismissed: true });
    renderBanner();

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId('confluence-pat-banner')).toBeNull();
  });

  it('hides optimistically on dismiss, before the PUT resolves', async () => {
    // GET resolves normally; PUT hangs forever — the banner must still hide.
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (init?.method === 'PUT') return new Promise<Response>(() => {});
      void input;
      return Promise.resolve(jsonResponse(baseSettings));
    });
    renderBanner();

    await screen.findByTestId('confluence-pat-banner');
    fireEvent.click(screen.getByRole('button', { name: /dismiss confluence pat reminder/i }));

    await waitFor(() => expect(screen.queryByTestId('confluence-pat-banner')).toBeNull());
  });

  it('persists the dismissal via PUT /api/settings and stays hidden after refetch', async () => {
    const { puts } = mockSettingsApi();
    renderBanner();

    await screen.findByTestId('confluence-pat-banner');
    fireEvent.click(screen.getByRole('button', { name: /dismiss confluence pat reminder/i }));

    // Dismissal reaches the server…
    await waitFor(() => expect(puts).toEqual([{ confluencePatPromptDismissed: true }]));

    // …and after the settings query is invalidated + refetched (mock server
    // now reports dismissed=true), the banner stays hidden.
    await waitFor(() =>
      expect(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
          ([, init]) => (init as RequestInit | undefined)?.method !== 'PUT',
        ).length,
      ).toBeGreaterThanOrEqual(2),
    );
    expect(screen.queryByTestId('confluence-pat-banner')).toBeNull();
  });

  it('CTA navigates to Settings → Confluence', async () => {
    mockSettingsApi();
    renderBanner();

    fireEvent.click(await screen.findByRole('link', { name: /configure pat/i }));

    expect(await screen.findByTestId('confluence-settings-page')).toBeInTheDocument();
  });
});
