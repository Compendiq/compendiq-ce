import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SettingsLayout, SettingsIndexRedirect } from './SettingsLayout';
import { SettingsPanelRoute } from './SettingsPanelRoute';
import { SettingsSidebar } from '../../shared/components/layout/SettingsSidebar';

// --- Mocks ---
const authState = {
  user: { role: 'user' as 'user' | 'admin' },
  accessToken: 'test-token',
  setAuth: vi.fn(),
  clearAuth: vi.fn(),
};
vi.mock('../../stores/auth-store', () => ({
  useAuthStore: Object.assign(
    (selector: (state: typeof authState) => unknown) => selector(authState),
    { getState: () => authState },
  ),
}));

const enterpriseState = {
  isEnterprise: false,
  hasFeature: (_feature: string) => false,
  isLoading: false,
  ui: null,
  license: null,
};
vi.mock('../../shared/enterprise/use-enterprise', () => ({
  useEnterprise: () => enterpriseState,
}));

// Stub useSettings so panel routes can render without hitting the network.
vi.mock('../../shared/hooks/use-settings', () => ({
  useSettings: () => ({
    data: {
      confluenceUrl: 'https://example.atlassian.net',
      hasConfluencePat: true,
      selectedSpaces: [],
      showSpaceHomeContent: true,
      ollamaModel: 'qwen3:4b',
      llmProvider: 'ollama',
      openaiBaseUrl: null,
      hasOpenaiApiKey: false,
      openaiModel: null,
      embeddingModel: 'bge-m3',
      theme: 'dark',
      syncIntervalMin: 15,
      confluenceConnected: true,
    },
    isLoading: false,
  }),
}));

// Stub api-fetch so lazy-loaded panels don't explode on mount in JSDOM.
vi.mock('../../shared/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue({}),
}));

/**
 * Mounts the sidebar nav + the route shell so tests can assert on both
 * rail visibility (sidebar) and panel resolution (panel route).
 */
function renderLayoutAt(url: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[url]}>
        <div className="flex">
          <SettingsSidebar />
          <Routes>
            <Route path="/settings" element={<SettingsLayout />}>
              <Route index element={<SettingsIndexRedirect />} />
              <Route path=":category/:item" element={<SettingsPanelRoute />} />
            </Route>
            <Route path="*" element={<div data-testid="non-settings-page">Non-settings route</div>} />
          </Routes>
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  authState.user = { role: 'user' };
  enterpriseState.isEnterprise = false;
  enterpriseState.hasFeature = () => false;
  enterpriseState.isLoading = false;
});

describe('SettingsSidebar — rail visibility', () => {
  it('shows only the Personal + Knowledge groups for a non-admin user', async () => {
    renderLayoutAt('/settings/personal/confluence');

    await waitFor(() => {
      expect(screen.getByRole('navigation', { name: /settings/i })).toBeInTheDocument();
    });

    // Personal is unrestricted; Knowledge has one non-admin item ("Spaces & Sync").
    expect(screen.getByRole('heading', { name: 'Personal' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Knowledge' })).toBeInTheDocument();
    // Admin-only groups stay hidden.
    expect(screen.queryByRole('heading', { name: 'AI' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Governance' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'System' })).not.toBeInTheDocument();

    // Non-admin sees only Spaces & Sync under Knowledge — Labels and AI Models
    // are admin-only.
    expect(screen.getByTestId('nav-settings-spaces')).toBeInTheDocument();
    expect(screen.queryByTestId('nav-settings-labels')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-settings-models')).not.toBeInTheDocument();
  });

  it('reveals all five groups for admin users (CE mode), but hides EE-only items', async () => {
    authState.user = { role: 'admin' };
    renderLayoutAt('/settings/personal/confluence');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'AI' })).toBeInTheDocument();
    });

    expect(screen.getByRole('heading', { name: 'Governance' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'System' })).toBeInTheDocument();

    // CE-visible admin items.
    expect(screen.getByTestId('nav-settings-labels')).toBeInTheDocument();
    expect(screen.getByTestId('nav-settings-models')).toBeInTheDocument();
    expect(screen.getByTestId('nav-settings-ai-safety')).toBeInTheDocument();
    expect(screen.getByTestId('nav-settings-access')).toBeInTheDocument();
    expect(screen.getByTestId('nav-settings-integrations')).toBeInTheDocument();
    expect(screen.getByTestId('nav-settings-license')).toBeInTheDocument();
    expect(screen.getByTestId('nav-settings-diagnostics')).toBeInTheDocument();

    // Data & Compliance is an all-EE wrapper — hidden in CE.
    expect(screen.queryByTestId('nav-settings-compliance')).not.toBeInTheDocument();
  });

  it('reveals the Data & Compliance wrapper when EE is licensed', async () => {
    authState.user = { role: 'admin' };
    enterpriseState.isEnterprise = true;

    renderLayoutAt('/settings/personal/confluence');

    await waitFor(() => {
      expect(screen.getByTestId('nav-settings-compliance')).toBeInTheDocument();
    });
  });
});

describe('SettingsSidebar — aria-current contract', () => {
  it('sets aria-current="page" on the active link', async () => {
    renderLayoutAt('/settings/personal/theme');

    await waitFor(() => {
      expect(screen.getByTestId('nav-settings-theme')).toBeInTheDocument();
    });

    const themeLink = screen.getByTestId('nav-settings-theme');
    expect(themeLink).toHaveAttribute('aria-current', 'page');

    const confluenceLink = screen.getByTestId('nav-settings-confluence');
    expect(confluenceLink).not.toHaveAttribute('aria-current', 'page');
  });
});

describe('SettingsIndexRedirect', () => {
  it('redirects /settings to /settings/personal/confluence for a non-admin user', async () => {
    renderLayoutAt('/settings');

    await waitFor(() => {
      expect(screen.getByTestId('nav-settings-confluence')).toHaveAttribute('aria-current', 'page');
    });
  });
});

describe('SettingsPanelRoute — gating via direct URL', () => {
  it('bounces a non-admin to the first visible panel when they hit an admin-only URL directly', async () => {
    // ai/models is admin-only — a non-admin should bounce.
    renderLayoutAt('/settings/ai/models');

    await waitFor(() => {
      expect(screen.getByTestId('nav-settings-confluence')).toHaveAttribute('aria-current', 'page');
    });
  });

  it('bounces unknown /settings/foo/bar URLs to the default panel', async () => {
    renderLayoutAt('/settings/foo/bar');

    await waitFor(() => {
      expect(screen.getByTestId('nav-settings-confluence')).toHaveAttribute('aria-current', 'page');
    });
  });
});

describe('SettingsPanelRoute — EE deep-link loading race', () => {
  it('does NOT redirect an EE-gated wrapper while the license fetch is still loading', async () => {
    authState.user = { role: 'admin' };
    enterpriseState.isLoading = true;
    enterpriseState.isEnterprise = false;
    enterpriseState.hasFeature = () => false;

    const { queryByTestId } = renderLayoutAt('/settings/governance/compliance');

    // Must NOT bounce to the default panel during the fetch window.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(queryByTestId('nav-settings-confluence')).not.toHaveAttribute('aria-current', 'page');
  });

  it('redirects a non-EE user when the license resolves as community', async () => {
    authState.user = { role: 'admin' };
    enterpriseState.isLoading = false;
    enterpriseState.isEnterprise = false;
    enterpriseState.hasFeature = () => false;

    renderLayoutAt('/settings/governance/compliance');

    await waitFor(() => {
      expect(screen.getByTestId('nav-settings-confluence')).toHaveAttribute('aria-current', 'page');
    });
  });

  it('renders the Data & Compliance wrapper once the license resolves as EE', async () => {
    authState.user = { role: 'admin' };
    enterpriseState.isLoading = false;
    enterpriseState.isEnterprise = true;
    enterpriseState.hasFeature = () => true;

    renderLayoutAt('/settings/governance/compliance');

    await waitFor(() => {
      expect(screen.getByTestId('nav-settings-compliance')).toHaveAttribute('aria-current', 'page');
    });
  });

  it('still bounces unknown URLs immediately even while license is loading', async () => {
    enterpriseState.isLoading = true;
    renderLayoutAt('/settings/foo/bar');

    await waitFor(() => {
      expect(screen.getByTestId('nav-settings-confluence')).toHaveAttribute('aria-current', 'page');
    });
  });
});
