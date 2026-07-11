import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TrialBanner } from './TrialBanner';
import { useAuthStore } from '../../../stores/auth-store';

interface MockLicense {
  tier: string;
  type: 'trial' | 'paid' | null;
  expiresAt: string | null;
  daysRemaining: number | null;
  isValid: boolean;
}

function mockLicenseFetch(value: MockLicense | null, status = 200) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(value ? JSON.stringify(value) : '', {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function signInAs(role: 'admin' | 'user') {
  useAuthStore.getState().setAuth('test-token', {
    id: '1',
    username: role,
    role,
  });
}

describe('TrialBanner', () => {
  beforeEach(() => {
    // Default: signed in as admin so the banner is allowed to render.
    // Individual tests override via signInAs() when they need a non-admin.
    signInAs('admin');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('renders nothing when /api/license/info 404s (CE deployment)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404 }));
    render(<TrialBanner />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId('trial-banner')).toBeNull();
  });

  it('renders nothing for a paid license', async () => {
    mockLicenseFetch({
      tier: 'enterprise',
      type: 'paid',
      expiresAt: '2027-12-31T23:59:59Z',
      daysRemaining: 365,
      isValid: true,
    });
    render(<TrialBanner />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId('trial-banner')).toBeNull();
  });

  it('renders nothing for community (no key set)', async () => {
    mockLicenseFetch({
      tier: 'community',
      type: null,
      expiresAt: null,
      daysRemaining: null,
      isValid: false,
    });
    render(<TrialBanner />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId('trial-banner')).toBeNull();
  });

  it('renders an info banner for an active trial with > 7 days remaining', async () => {
    mockLicenseFetch({
      tier: 'business',
      type: 'trial',
      expiresAt: '2026-06-04T23:59:59Z',
      daysRemaining: 28,
      isValid: true,
    });
    render(<TrialBanner />);
    const banner = await screen.findByTestId('trial-banner');
    expect(banner).toHaveTextContent('Trial — 28 days remaining');
  });

  it('renders a warning banner when 1 < daysRemaining ≤ 7', async () => {
    mockLicenseFetch({
      tier: 'business',
      type: 'trial',
      expiresAt: '2026-05-09T23:59:59Z',
      daysRemaining: 4,
      isValid: true,
    });
    render(<TrialBanner />);
    const banner = await screen.findByTestId('trial-banner');
    expect(banner).toHaveTextContent('only 4 days left');
  });

  it('singularizes "1 day left" at the boundary', async () => {
    mockLicenseFetch({
      tier: 'business',
      type: 'trial',
      expiresAt: '2026-05-06T23:59:59Z',
      daysRemaining: 1,
      isValid: true,
    });
    render(<TrialBanner />);
    const banner = await screen.findByTestId('trial-banner');
    expect(banner).toHaveTextContent('only 1 day left');
    expect(banner).not.toHaveTextContent('days');
  });

  it('renders a destructive banner with "today" copy when daysRemaining is 0', async () => {
    mockLicenseFetch({
      tier: 'community',
      type: 'trial',
      expiresAt: '2026-05-05T23:59:59Z',
      daysRemaining: 0,
      isValid: false,
    });
    render(<TrialBanner />);
    const banner = await screen.findByTestId('trial-banner');
    expect(banner).toHaveTextContent('Trial expired today');
    expect(banner).not.toHaveTextContent('0 days');
  });

  it('renders a destructive banner with absolute days when daysRemaining is negative', async () => {
    mockLicenseFetch({
      tier: 'community',
      type: 'trial',
      expiresAt: '2026-05-01T23:59:59Z',
      daysRemaining: -4,
      isValid: false,
    });
    render(<TrialBanner />);
    const banner = await screen.findByTestId('trial-banner');
    expect(banner).toHaveTextContent('Trial expired 4 days ago');
  });

  it('singularizes "expired 1 day ago" at the boundary', async () => {
    mockLicenseFetch({
      tier: 'community',
      type: 'trial',
      expiresAt: '2026-05-04T23:59:59Z',
      daysRemaining: -1,
      isValid: false,
    });
    render(<TrialBanner />);
    const banner = await screen.findByTestId('trial-banner');
    expect(banner).toHaveTextContent('Trial expired 1 day ago');
    expect(banner).not.toHaveTextContent('days');
  });

  it('attaches the Authorization Bearer token to the license request (#956)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          tier: 'business',
          type: 'trial',
          expiresAt: '2026-06-04T23:59:59Z',
          daysRemaining: 28,
          isValid: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    render(<TrialBanner />);
    // The banner only renders once the auth-protected endpoint answers, which
    // requires the Bearer token to be attached to the request.
    await screen.findByTestId('trial-banner');
    const [, init] = fetchSpy.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer test-token');
  });

  it('renders nothing when fetch rejects (network error)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'));
    render(<TrialBanner />);
    // Allow the promise rejection to propagate
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('trial-banner')).toBeNull();
  });

  it('renders nothing for a non-admin user, even on an active trial', async () => {
    signInAs('user');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    mockLicenseFetch({
      tier: 'business',
      type: 'trial',
      expiresAt: '2026-05-09T23:59:59Z',
      daysRemaining: 4,
      isValid: true,
    });
    render(<TrialBanner />);
    // Allow any pending microtasks to settle so a stray fetch would be observed.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('trial-banner')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('renders nothing when no user is signed in', async () => {
    useAuthStore.getState().clearAuth();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<TrialBanner />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('trial-banner')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
