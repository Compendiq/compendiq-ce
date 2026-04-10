import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domMax } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LicenseStatusCard } from './LicenseStatusCard';
import { useAuthStore } from '../../stores/auth-store';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
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

interface LicenseMock {
  edition: string;
  tier: string;
  seats?: number;
  expiresAt?: string;
  features: string[];
  valid: boolean;
  canUpdate?: boolean;
  displayKey?: string;
}

function mockFetch(license: LicenseMock) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    return new Response(JSON.stringify(license), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('LicenseStatusCard', () => {
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

  it('shows community tier when no license', async () => {
    mockFetch({
      edition: 'community',
      tier: 'community',
      features: [],
      valid: true,
    });

    render(<LicenseStatusCard />, { wrapper: createWrapper() });

    expect(await screen.findByText('Community Edition')).toBeInTheDocument();
    expect(screen.getByText(/Upgrade to unlock/)).toBeInTheDocument();
  });

  it('shows enterprise tier with features when licensed', async () => {
    mockFetch({
      edition: 'enterprise',
      tier: 'enterprise',
      seats: 50,
      expiresAt: '2027-12-31T23:59:59.999Z',
      features: ['oidc', 'audit-export', 'custom-branding', 'multi-instance', 'priority-support'],
      valid: true,
      canUpdate: true,
    });

    render(<LicenseStatusCard />, { wrapper: createWrapper() });

    expect(await screen.findByText('Enterprise Edition')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('50')).toBeInTheDocument();
  });

  it('shows feature availability based on license', async () => {
    mockFetch({
      edition: 'enterprise',
      tier: 'team',
      seats: 10,
      expiresAt: '2027-06-15T00:00:00.000Z',
      features: ['oidc'],
      valid: true,
      canUpdate: true,
    });

    render(<LicenseStatusCard />, { wrapper: createWrapper() });

    expect(await screen.findByText('Team Edition')).toBeInTheDocument();

    const oidcFeature = screen.getByTestId('feature-oidc');
    expect(oidcFeature).toBeInTheDocument();
  });

  it('does not show upgrade notice for licensed tiers', async () => {
    mockFetch({
      edition: 'enterprise',
      tier: 'enterprise',
      seats: 50,
      expiresAt: '2027-12-31T23:59:59.999Z',
      features: ['oidc'],
      valid: true,
      canUpdate: true,
    });

    render(<LicenseStatusCard />, { wrapper: createWrapper() });

    expect(await screen.findByText('Enterprise Edition')).toBeInTheDocument();
    expect(screen.queryByText(/Upgrade to unlock/)).not.toBeInTheDocument();
  });

  it('does not show seat/expiry stats for community tier', async () => {
    mockFetch({
      edition: 'community',
      tier: 'community',
      features: [],
      valid: true,
    });

    render(<LicenseStatusCard />, { wrapper: createWrapper() });

    expect(await screen.findByText('Community Edition')).toBeInTheDocument();
    expect(screen.queryByText('Licensed Seats')).not.toBeInTheDocument();
    expect(screen.queryByText('Expires')).not.toBeInTheDocument();
  });

  it('hides key entry form when backend cannot accept updates (CE noop)', async () => {
    mockFetch({
      edition: 'community',
      tier: 'community',
      features: [],
      valid: true,
      // canUpdate omitted — CE noop fallback
    });

    render(<LicenseStatusCard />, { wrapper: createWrapper() });

    await screen.findByText('Community Edition');
    expect(screen.queryByTestId('license-key-form')).not.toBeInTheDocument();
    // Static upgrade message is shown instead
    expect(screen.getByText(/Upgrade to unlock/)).toBeInTheDocument();
  });

  it('shows key entry form when backend declares canUpdate (EE community)', async () => {
    mockFetch({
      edition: 'community',
      tier: 'community',
      features: [],
      valid: false,
      canUpdate: true,
    });

    render(<LicenseStatusCard />, { wrapper: createWrapper() });

    await screen.findByText('Community Edition');
    expect(screen.getByTestId('license-key-form')).toBeInTheDocument();
    expect(screen.getByTestId('license-key-input')).toBeInTheDocument();
    expect(screen.getByTestId('license-key-save-btn')).toBeInTheDocument();
    // No stored key yet, so Clear button is absent
    expect(screen.queryByTestId('license-key-clear-btn')).not.toBeInTheDocument();
  });

  it('shows masked display key and Clear button when a key is stored', async () => {
    mockFetch({
      edition: 'enterprise',
      tier: 'enterprise',
      seats: 50,
      expiresAt: '2027-12-31T23:59:59.999Z',
      features: ['oidc'],
      valid: true,
      canUpdate: true,
      displayKey: 'ATM-enterprise-50-20271231-CPQ1a2b3c4d.****',
    });

    render(<LicenseStatusCard />, { wrapper: createWrapper() });

    await screen.findByText('Enterprise Edition');
    const display = screen.getByTestId('license-key-display');
    expect(display.textContent).toContain('ATM-enterprise-50-20271231');
    expect(screen.getByTestId('license-key-clear-btn')).toBeInTheDocument();
  });

  it('sends PUT /admin/license when Save is clicked', async () => {
    const savedLicense = {
      edition: 'enterprise',
      tier: 'enterprise' as const,
      seats: 50,
      expiresAt: '2027-12-31T23:59:59.999Z',
      features: ['oidc'],
      valid: true,
      canUpdate: true,
      displayKey: 'ATM-enterprise-50-20271231-CPQ1a2b3c4d.****',
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (method === 'PUT' && url.includes('/admin/license')) {
        return new Response(JSON.stringify(savedLicense), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Initial GET — no stored key yet, canUpdate true
      return new Response(
        JSON.stringify({
          edition: 'community',
          tier: 'community',
          features: [],
          valid: false,
          canUpdate: true,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });

    render(<LicenseStatusCard />, { wrapper: createWrapper() });

    const input = await screen.findByTestId('license-key-input');
    fireEvent.change(input, { target: { value: 'ATM-enterprise-50-20271231-CPQ1a2b3c4d.signature' } });
    fireEvent.click(screen.getByTestId('license-key-save-btn'));

    await waitFor(() => {
      expect(screen.getByText('Enterprise Edition')).toBeInTheDocument();
    });

    const putCall = fetchSpy.mock.calls.find((call) => {
      const method = call[1]?.method;
      return method === 'PUT';
    });
    expect(putCall).toBeTruthy();
    expect(putCall?.[1]?.body).toContain('ATM-enterprise-50-20271231-CPQ1a2b3c4d.signature');
  });
});
