import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SettingsLayout, SettingsIndexRedirect } from './SettingsLayout';
import { SettingsPanelRoute } from './SettingsPanelRoute';

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

function renderLayoutAt(url: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/settings" element={<SettingsLayout />}>
            <Route index element={<SettingsIndexRedirect />} />
            <Route path=":category/:item" element={<SettingsPanelRoute />} />
          </Route>
          <Route path="*" element={<div data-testid="non-settings-page">Non-settings route</div>} />
        </Routes>
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

describe('SettingsLayout — rail visibility', () => {
  it('renders the Personal / Content group headers for a non-admin user', async () => {
    renderLayoutAt('/settings/personal/confluence');

    await waitFor(() => {
      expect(screen.getByRole('navigation', { name: /settings/i })).toBeInTheDocument();
    });

    // User-level categories are always visible.
    expect(screen.getByRole('heading', { name: 'Personal' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Content' })).toBeInTheDocument();
    // Admin-only categories are hidden — every item in them has adminOnly.
    expect(screen.queryByRole('heading', { name: 'AI' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Integrations' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Security & Access' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'System' })).not.toBeInTheDocument();
  });

  it('renders admin-only groups for admin users (CE mode)', async () => {
    authState.user = { role: 'admin' };
    renderLayoutAt('/settings/personal/confluence');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'AI' })).toBeInTheDocument();
    });

    expect(screen.getByRole('heading', { name: 'Integrations' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Security & Access' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'System' })).toBeInTheDocument();

    // EE-only items stay hidden in CE mode.
    expect(screen.queryByTestId('nav-settings-sso')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-settings-scim')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-settings-llm-policy')).not.toBeInTheDocument();
  });

  it('reveals EE-only items when isEnterprise + hasFeature are true', async () => {
    authState.user = { role: 'admin' };
    enterpriseState.isEnterprise = true;
    enterpriseState.hasFeature = (feature) =>
      ['org_llm_policy', 'llm_audit_trail', 'data_retention_policies', 'scim_provisioning'].includes(feature);

    renderLayoutAt('/settings/personal/confluence');

    await waitFor(() => {
      expect(screen.getByTestId('nav-settings-sso')).toBeInTheDocument();
    });
    expect(screen.getByTestId('nav-settings-scim')).toBeInTheDocument();
    expect(screen.getByTestId('nav-settings-llm-policy')).toBeInTheDocument();
    expect(screen.getByTestId('nav-settings-llm-audit')).toBeInTheDocument();
    expect(screen.getByTestId('nav-settings-retention')).toBeInTheDocument();
  });
});

describe('SettingsLayout — aria-current + testid contract', () => {
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

  it('keeps legacy tab-<id> data attribute on each rail link for one release', async () => {
    renderLayoutAt('/settings/personal/confluence');

    await waitFor(() => {
      expect(screen.getByTestId('nav-settings-confluence')).toBeInTheDocument();
    });

    expect(screen.getByTestId('nav-settings-confluence')).toHaveAttribute(
      'data-legacy-testid',
      'tab-confluence',
    );
  });
});

describe('SettingsIndexRedirect', () => {
  it('redirects /settings to /settings/personal/confluence for a non-admin user', async () => {
    renderLayoutAt('/settings');

    // The redirect is an effect, so wait for the confluence tab to become active.
    await waitFor(() => {
      expect(screen.getByTestId('nav-settings-confluence')).toHaveAttribute('aria-current', 'page');
    });
  });
});

describe('SettingsLayout — legacy ?tab= redirect', () => {
  it('redirects /settings?tab=theme → /settings/personal/theme', async () => {
    renderLayoutAt('/settings?tab=theme');

    await waitFor(() => {
      expect(screen.getByTestId('nav-settings-theme')).toHaveAttribute('aria-current', 'page');
    });
  });

  it('redirects /settings?tab=ollama → /settings/ai/llm (URL-segment rename)', async () => {
    authState.user = { role: 'admin' };
    renderLayoutAt('/settings?tab=ollama');

    await waitFor(() => {
      expect(screen.getByTestId('nav-settings-llm')).toHaveAttribute('aria-current', 'page');
    });
  });

  it('ignores unknown ?tab=<x> values and lands on the default panel', async () => {
    renderLayoutAt('/settings?tab=does-not-exist');

    await waitFor(() => {
      expect(screen.getByTestId('nav-settings-confluence')).toHaveAttribute('aria-current', 'page');
    });
  });
});

describe('SettingsPanelRoute — gating via direct URL', () => {
  it('bounces a non-admin to the first visible panel when they hit an admin-only URL directly', async () => {
    // User is non-admin; accessing /settings/ai/llm directly should bounce to /settings/personal/confluence.
    renderLayoutAt('/settings/ai/llm');

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

describe('SettingsPanelRoute — EE deep-link loading race (PR #218 review finding)', () => {
  it('does NOT redirect an EE-gated panel while the license fetch is still loading', async () => {
    // Admin user, EE panel URL, but license fetch not yet resolved.
    authState.user = { role: 'admin' };
    enterpriseState.isLoading = true;
    enterpriseState.isEnterprise = false; // not yet known
    enterpriseState.hasFeature = () => false;

    const { queryByTestId } = renderLayoutAt('/settings/ai/llm-policy');

    // Must NOT bounce to the default panel during the fetch window.
    // If the regression returns, this fails because the URL flips and
    // `nav-settings-confluence` becomes the active link.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(queryByTestId('nav-settings-confluence')).not.toHaveAttribute('aria-current', 'page');
  });

  it('redirects a non-EE user when the license resolves as community', async () => {
    // Admin user, EE panel URL, license has resolved as non-enterprise.
    authState.user = { role: 'admin' };
    enterpriseState.isLoading = false;
    enterpriseState.isEnterprise = false;
    enterpriseState.hasFeature = () => false;

    renderLayoutAt('/settings/ai/llm-policy');

    // After loading resolves as non-EE, the gate fires and bounces to default.
    await waitFor(() => {
      expect(screen.getByTestId('nav-settings-confluence')).toHaveAttribute('aria-current', 'page');
    });
  });

  it('renders the panel once the license resolves as EE with the required feature', async () => {
    authState.user = { role: 'admin' };
    enterpriseState.isLoading = false;
    enterpriseState.isEnterprise = true;
    enterpriseState.hasFeature = (feature) => feature === 'org_llm_policy';

    renderLayoutAt('/settings/ai/llm-policy');

    await waitFor(() => {
      expect(screen.getByTestId('nav-settings-llm-policy')).toHaveAttribute('aria-current', 'page');
    });
  });

  it('still bounces unknown URLs immediately even while license is loading', async () => {
    // Unknown path should not wait for EE resolution — there's nothing that
    // could ever grant access. Fast-path fail.
    enterpriseState.isLoading = true;
    renderLayoutAt('/settings/foo/bar');

    await waitFor(() => {
      expect(screen.getByTestId('nav-settings-confluence')).toHaveAttribute('aria-current', 'page');
    });
  });
});
