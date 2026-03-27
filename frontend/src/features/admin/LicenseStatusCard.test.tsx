import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domMax } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LicenseStatusCard } from './LicenseStatusCard';
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

function mockFetch(license: {
  tier: string;
  seats: number;
  expiry: string | null;
  features: string[];
  isValid: boolean;
}) {
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
      tier: 'community',
      seats: 0,
      expiry: null,
      features: [],
      isValid: false,
    });

    render(<LicenseStatusCard />, { wrapper: createWrapper() });

    expect(await screen.findByText('Community Edition')).toBeInTheDocument();
    expect(screen.getByText('Free')).toBeInTheDocument();
    expect(screen.getByText(/Upgrade to unlock/)).toBeInTheDocument();
  });

  it('shows enterprise tier with features when licensed', async () => {
    mockFetch({
      tier: 'enterprise',
      seats: 50,
      expiry: '2027-12-31T23:59:59.999Z',
      features: ['oidc', 'audit-export', 'custom-branding', 'multi-instance', 'priority-support'],
      isValid: true,
    });

    render(<LicenseStatusCard />, { wrapper: createWrapper() });

    expect(await screen.findByText('Enterprise Edition')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('50')).toBeInTheDocument();
  });

  it('shows feature availability based on license', async () => {
    mockFetch({
      tier: 'team',
      seats: 10,
      expiry: '2027-06-15T00:00:00.000Z',
      features: ['oidc'],
      isValid: true,
    });

    render(<LicenseStatusCard />, { wrapper: createWrapper() });

    expect(await screen.findByText('Team Edition')).toBeInTheDocument();

    // OIDC should be listed (it's always in the features list)
    const oidcFeature = screen.getByTestId('feature-oidc');
    expect(oidcFeature).toBeInTheDocument();
  });

  it('does not show upgrade notice for licensed tiers', async () => {
    mockFetch({
      tier: 'enterprise',
      seats: 50,
      expiry: '2027-12-31T23:59:59.999Z',
      features: ['oidc'],
      isValid: true,
    });

    render(<LicenseStatusCard />, { wrapper: createWrapper() });

    expect(await screen.findByText('Enterprise Edition')).toBeInTheDocument();
    expect(screen.queryByText(/Upgrade to unlock/)).not.toBeInTheDocument();
  });

  it('does not show seat/expiry stats for community tier', async () => {
    mockFetch({
      tier: 'community',
      seats: 0,
      expiry: null,
      features: [],
      isValid: false,
    });

    render(<LicenseStatusCard />, { wrapper: createWrapper() });

    expect(await screen.findByText('Community Edition')).toBeInTheDocument();
    expect(screen.queryByText('Licensed Seats')).not.toBeInTheDocument();
    expect(screen.queryByText('Expires')).not.toBeInTheDocument();
  });
});
