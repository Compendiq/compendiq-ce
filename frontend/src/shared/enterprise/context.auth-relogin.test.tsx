import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { EnterpriseProvider } from './context';
import { useEnterprise } from './use-enterprise';
import { _resetForTesting, _setScriptLoaderForTesting } from './loader';
// Deliberately NOT mocking the auth store here: the fix relies on the
// provider subscribing to real (reactive) auth state, so this test drives the
// real zustand store to reproduce a post-mount login.
import { useAuthStore } from '../../stores/auth-store';

function TestConsumer() {
  const { isEnterprise, license, ui, isLoading } = useEnterprise();
  return (
    <div>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="enterprise">{String(isEnterprise)}</span>
      <span data-testid="ui">{ui === null ? 'null' : 'loaded'}</span>
      <span data-testid="license">{license === null ? 'null' : license.tier}</span>
    </div>
  );
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof Request) return input.url;
  return String(input);
}

describe('EnterpriseProvider re-fetches license on auth change (#881)', () => {
  beforeEach(() => {
    _resetForTesting();
    useAuthStore.getState().clearAuth();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('flips EE surfaces on when an admin logs in after mount (SPA navigate, no reload)', async () => {
    let loggedIn = false;
    _setScriptLoaderForTesting(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__COMPENDIQ_UI__ = { LicenseStatusCard: () => null, version: '1.0.0' };
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = urlOf(input as RequestInfo | URL);
      if (url.includes('/auth/refresh')) {
        // No refresh cookie in a fresh tab → refresh fails.
        return new Response(null, { status: 401 });
      }
      if (url.includes('/admin/license')) {
        if (!loggedIn) return new Response(null, { status: 401 });
        return new Response(
          JSON.stringify({
            edition: 'enterprise',
            tier: 'enterprise',
            features: ['oidc_sso'],
            valid: true,
            canUpdate: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(null, { status: 404 });
    });

    render(
      <EnterpriseProvider>
        <TestConsumer />
      </EnterpriseProvider>,
    );

    // Mounted unauthenticated → /admin/license 401 → community fallback.
    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    expect(screen.getByTestId('enterprise').textContent).toBe('false');
    expect(screen.getByTestId('license').textContent).toBe('null');

    // Admin logs in after mount (LoginPage does setAuth + navigate, no reload).
    loggedIn = true;
    act(() => {
      useAuthStore
        .getState()
        .setAuth('ee-admin-token', { id: '1', username: 'admin', role: 'admin' });
    });

    // The license must be re-fetched so EE surfaces switch on without a reload.
    // Assert the fully-settled state INSIDE waitFor: the provider flips
    // isEnterprise via setLicense first, then loads the overlay bundle on a
    // separate async tick (`await loadEnterpriseUI()` → setUi). Gating only on
    // `enterprise` and then asserting `ui` synchronously races that later tick.
    await waitFor(() => {
      expect(screen.getByTestId('enterprise').textContent).toBe('true');
      expect(screen.getByTestId('license').textContent).toBe('enterprise');
      expect(screen.getByTestId('ui').textContent).toBe('loaded');
    });
  });

  it("clears the previous admin's license and ui from memory on logout", async () => {
    _setScriptLoaderForTesting(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__COMPENDIQ_UI__ = { LicenseStatusCard: () => null, version: '1.0.0' };
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = urlOf(input as RequestInfo | URL);
      const { accessToken } = useAuthStore.getState();
      if (url.includes('/auth/refresh')) {
        return new Response(null, { status: 401 });
      }
      if (url.includes('/admin/license')) {
        if (!accessToken) return new Response(null, { status: 401 });
        return new Response(
          JSON.stringify({
            edition: 'enterprise',
            tier: 'enterprise',
            features: ['oidc_sso'],
            valid: true,
            canUpdate: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(null, { status: 404 });
    });

    act(() => {
      useAuthStore
        .getState()
        .setAuth('ee-admin-token', { id: '1', username: 'admin', role: 'admin' });
    });

    render(
      <EnterpriseProvider>
        <TestConsumer />
      </EnterpriseProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('enterprise').textContent).toBe('true');
    });

    act(() => {
      useAuthStore.getState().clearAuth();
    });

    await waitFor(() => {
      expect(screen.getByTestId('enterprise').textContent).toBe('false');
    });
    expect(screen.getByTestId('license').textContent).toBe('null');
  });

  it('preserves an already-loaded EE license when a refetch fails transiently (5xx)', async () => {
    let failLicense = false;
    let licenseCalls = 0;
    _setScriptLoaderForTesting(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__COMPENDIQ_UI__ = { LicenseStatusCard: () => null, version: '1.0.0' };
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = urlOf(input as RequestInfo | URL);
      if (url.includes('/auth/refresh')) {
        return new Response(null, { status: 401 });
      }
      if (url.includes('/admin/license')) {
        licenseCalls += 1;
        if (failLicense) return new Response(null, { status: 500 });
        return new Response(
          JSON.stringify({
            edition: 'enterprise',
            tier: 'enterprise',
            features: ['oidc_sso'],
            valid: true,
            canUpdate: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(null, { status: 404 });
    });

    act(() => {
      useAuthStore
        .getState()
        .setAuth('ee-admin-token', { id: '1', username: 'admin', role: 'admin' });
    });

    render(
      <EnterpriseProvider>
        <TestConsumer />
      </EnterpriseProvider>,
    );

    // Wait for the FULLY-settled EE state (incl. the overlay bundle) before
    // triggering the refetch — `ui` loads a tick after the license, so the
    // preservation assertions below would otherwise race the initial load.
    await waitFor(() => {
      expect(screen.getByTestId('enterprise').textContent).toBe('true');
      expect(screen.getByTestId('ui').textContent).toBe('loaded');
    });

    // Token rotates mid-session (routine refresh) but the refetch hits a 500.
    const callsBefore = licenseCalls;
    failLicense = true;
    act(() => {
      useAuthStore
        .getState()
        .setAuth('ee-admin-token-rotated', { id: '1', username: 'admin', role: 'admin' });
    });

    await waitFor(() => {
      expect(licenseCalls).toBeGreaterThan(callsBefore);
    });

    // Transient failure must NOT flip an EE admin to community.
    expect(screen.getByTestId('enterprise').textContent).toBe('true');
    expect(screen.getByTestId('license').textContent).toBe('enterprise');
    expect(screen.getByTestId('ui').textContent).toBe('loaded');
    // And no loading flicker on a refetch.
    expect(screen.getByTestId('loading').textContent).toBe('false');
  });
});
