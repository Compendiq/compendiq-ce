import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TrialBanner } from './TrialBanner';

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

describe('TrialBanner', () => {
  beforeEach(() => {
    // Default: no fetch mock — individual tests configure as needed.
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('renders a destructive banner when daysRemaining is 0', async () => {
    mockLicenseFetch({
      tier: 'community',
      type: 'trial',
      expiresAt: '2026-05-05T23:59:59Z',
      daysRemaining: 0,
      isValid: false,
    });
    render(<TrialBanner />);
    const banner = await screen.findByTestId('trial-banner');
    expect(banner).toHaveTextContent('Trial expired 0 days ago');
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

  it('renders nothing when fetch rejects (network error)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'));
    render(<TrialBanner />);
    // Allow the promise rejection to propagate
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('trial-banner')).toBeNull();
  });
});
