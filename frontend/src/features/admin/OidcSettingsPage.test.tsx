import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domMax } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OidcSettingsPage } from './OidcSettingsPage';
import { useAuthStore } from '../../stores/auth-store';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <LazyMotion features={domMax}>
            {children}
          </LazyMotion>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

const mockProvider = {
  id: 1,
  name: 'default',
  issuerUrl: 'https://idp.example.com',
  clientId: 'test-client-id',
  redirectUri: 'http://localhost:3051/api/auth/oidc/callback',
  groupsClaim: 'groups',
  enabled: true,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

const mockMappings = [
  { id: 1, oidcGroup: 'engineering', roleId: 3, roleName: 'editor', spaceKey: 'DEV' },
  { id: 2, oidcGroup: 'admin-team', roleId: 1, roleName: 'system_admin', spaceKey: null },
];

const mockRoles = [
  { id: 1, name: 'system_admin', displayName: 'System Administrator' },
  { id: 3, name: 'editor', displayName: 'Editor' },
  { id: 5, name: 'viewer', displayName: 'Viewer' },
];

function mockFetch(options?: { configured?: boolean; enabled?: boolean }) {
  const configured = options?.configured ?? true;
  const enabled = options?.enabled ?? true;

  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;

    if (url.includes('/admin/license')) {
      return new Response(
        JSON.stringify({ tier: 'enterprise', seats: 50, expiry: '2027-12-31T23:59:59Z', features: ['oidc'], isValid: true }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/admin/oidc/mappings')) {
      return new Response(JSON.stringify(mockMappings), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/admin/oidc')) {
      return new Response(
        JSON.stringify({
          configured,
          provider: configured ? { ...mockProvider, enabled } : null,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/roles')) {
      return new Response(JSON.stringify(mockRoles), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({}), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('OidcSettingsPage', () => {
  beforeEach(() => {
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'admin',
      role: 'admin',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('renders the page heading', () => {
    mockFetch();
    render(<OidcSettingsPage />, { wrapper: createWrapper() });
    expect(screen.getByText('SSO / OIDC')).toBeInTheDocument();
  });

  it('renders both tab buttons', () => {
    mockFetch();
    render(<OidcSettingsPage />, { wrapper: createWrapper() });
    expect(screen.getByTestId('oidc-tab-provider')).toBeInTheDocument();
    expect(screen.getByTestId('oidc-tab-mappings')).toBeInTheDocument();
  });

  it('shows provider tab by default with config form', async () => {
    mockFetch();
    render(<OidcSettingsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('oidc-provider-form')).toBeInTheDocument();
    });
    expect(screen.getByTestId('oidc-issuer-url')).toBeInTheDocument();
    expect(screen.getByTestId('oidc-client-id')).toBeInTheDocument();
    expect(screen.getByTestId('oidc-client-secret')).toBeInTheDocument();
    expect(screen.getByTestId('oidc-redirect-uri')).toBeInTheDocument();
    expect(screen.getByTestId('oidc-groups-claim')).toBeInTheDocument();
  });

  it('shows SSO Active status when configured and enabled', async () => {
    mockFetch({ configured: true, enabled: true });
    render(<OidcSettingsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('SSO Active')).toBeInTheDocument();
    });
  });

  it('shows "Not configured" status when no provider', async () => {
    mockFetch({ configured: false });
    render(<OidcSettingsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Not configured')).toBeInTheDocument();
    });
  });

  it('has a test connection button', async () => {
    mockFetch();
    render(<OidcSettingsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('oidc-test-btn')).toBeInTheDocument();
    });
  });

  it('has a save button', async () => {
    mockFetch();
    render(<OidcSettingsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('oidc-save-btn')).toBeInTheDocument();
    });
  });

  it('switches to mappings tab', async () => {
    mockFetch();
    render(<OidcSettingsPage />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByTestId('oidc-tab-mappings'));

    await waitFor(() => {
      expect(screen.getByTestId('oidc-mappings')).toBeInTheDocument();
    });
  });

  it('shows existing mappings in table', async () => {
    mockFetch();
    render(<OidcSettingsPage />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByTestId('oidc-tab-mappings'));

    await waitFor(() => {
      expect(screen.getByText('engineering')).toBeInTheDocument();
    });
    expect(screen.getByText('editor')).toBeInTheDocument();
    expect(screen.getByText('DEV')).toBeInTheDocument();
  });

  it('shows enterprise-required banner in community mode', async () => {
    // Override fetch to return community license
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/admin/license')) {
        return new Response(
          JSON.stringify({ tier: 'community', seats: 0, expiry: null, features: [], isValid: false }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/admin/oidc/mappings')) {
        return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/admin/oidc')) {
        return new Response(
          JSON.stringify({ configured: false, provider: null }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/roles')) {
        return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
    });

    render(<OidcSettingsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('enterprise-required-banner')).toBeInTheDocument();
    });
    expect(screen.getByText('Enterprise License Required')).toBeInTheDocument();
    // Save button should be disabled
    expect(screen.getByTestId('oidc-save-btn')).toBeDisabled();
  });

  it('shows create mapping form when button clicked', async () => {
    mockFetch();
    render(<OidcSettingsPage />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByTestId('oidc-tab-mappings'));

    await waitFor(() => {
      expect(screen.getByTestId('create-mapping-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('create-mapping-btn'));
    expect(screen.getByTestId('create-mapping-form')).toBeInTheDocument();
    expect(screen.getByTestId('mapping-oidc-group')).toBeInTheDocument();
    expect(screen.getByTestId('mapping-role')).toBeInTheDocument();
    expect(screen.getByTestId('mapping-space-key')).toBeInTheDocument();
  });
});
