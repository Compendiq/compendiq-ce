import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { LazyMotion, domMax } from 'framer-motion';
import { OidcCallbackPage } from './OidcCallbackPage';
import { useAuthStore } from '../../stores/auth-store';
import { reloadPage } from '../../shared/lib/client-protocol';
import type * as ClientProtocol from '../../shared/lib/client-protocol';

// jsdom's `location.reload` is unforgeable; the surfaces reload through this seam.
vi.mock('../../shared/lib/client-protocol', async (importOriginal) => ({
  ...(await importOriginal<typeof ClientProtocol>()),
  reloadPage: vi.fn(),
}));

/** Exposes the live router location so tests can assert query-param stripping. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-search">{location.search}</div>;
}

function renderWithRouter(initialEntry: string) {
  return render(
    <LazyMotion features={domMax}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <LocationProbe />
        <Routes>
          <Route path="/auth/oidc/callback" element={<OidcCallbackPage />} />
          <Route path="/login" element={<div data-testid="login-page">Login</div>} />
          <Route path="/" element={<div data-testid="home-page">Home</div>} />
        </Routes>
      </MemoryRouter>
    </LazyMotion>,
  );
}

describe('OidcCallbackPage', () => {
  beforeEach(() => {
    useAuthStore.getState().clearAuth();
    vi.restoreAllMocks();
    vi.mocked(reloadPage).mockClear();
  });

  afterEach(() => {
    useAuthStore.getState().clearAuth();
  });

  it('shows error when login_code is missing', () => {
    renderWithRouter('/auth/oidc/callback');
    expect(screen.getByText('SSO Login Failed')).toBeInTheDocument();
    expect(screen.getByText(/Missing login code/)).toBeInTheDocument();
  });

  it('shows loading state while exchanging code', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise(() => {}), // Never resolves
    );

    renderWithRouter('/auth/oidc/callback?login_code=test-code');
    expect(screen.getByText('Completing SSO sign-in...')).toBeInTheDocument();
  });

  it('exchanges code and navigates to home on success', async () => {
    const mockResponse = {
      accessToken: 'test-access-token',
      user: { id: 'user-1', username: 'jdoe', role: 'user' },
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    renderWithRouter('/auth/oidc/callback?login_code=valid-code');

    await waitFor(() => {
      expect(screen.getByTestId('home-page')).toBeInTheDocument();
    });

    // Auth store should be populated
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().user?.username).toBe('jdoe');
  });

  it('shows error on failed exchange', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'Invalid or expired login code' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    renderWithRouter('/auth/oidc/callback?login_code=expired-code');

    await waitFor(() => {
      expect(screen.getByText('SSO Login Failed')).toBeInTheDocument();
    });
    expect(screen.getByText(/Invalid or expired login code/)).toBeInTheDocument();
  });

  it('strips the login_code from the URL on a failed exchange', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'Invalid or expired login code' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    renderWithRouter('/auth/oidc/callback?login_code=expired-code');

    // The error UI still renders (we stay on the callback route)...
    await waitFor(() => {
      expect(screen.getByText('SSO Login Failed')).toBeInTheDocument();
    });
    // ...but the one-time credential must be gone from the URL/history.
    await waitFor(() => {
      expect(screen.getByTestId('location-search').textContent).toBe('');
    });
    expect(screen.getByTestId('location-search').textContent).not.toContain('login_code');
  });

  // #1881: the exchange identifies this bundle as policy-aware.
  it('sends the legacy-client marker on the exchange', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ accessToken: 't', user: { id: 'u', username: 'j', role: 'user' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    renderWithRouter('/auth/oidc/callback?login_code=valid-code');
    await waitFor(() => expect(screen.getByTestId('home-page')).toBeInTheDocument());

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/auth/oidc/exchange');
    const headers = init?.headers as Headers;
    expect(headers.get('X-Compendiq-Client-Protocol')).toBe('1');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  // The backend refuses in onRequest, before consuming the single-use code,
  // so the code must survive in the URL for the reloaded bundle to exchange.
  it('offers a reload, not a failure, on client_reload_required and keeps the login code for it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'client_reload_required' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    renderWithRouter('/auth/oidc/callback?login_code=still-valid');

    expect(await screen.findByRole('heading', { name: 'Reload to continue' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('This page is out of date. Reload to continue.');
    expect(screen.queryByText('SSO Login Failed')).not.toBeInTheDocument();
    expect(screen.getByTestId('location-search').textContent).toBe('?login_code=still-valid');
    expect(useAuthStore.getState().isAuthenticated).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Reload page' }));
    expect(vi.mocked(reloadPage)).toHaveBeenCalledTimes(1);
  });

  it('treats an ordinary 409 as a failed exchange and strips the code', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'Login code already used' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    renderWithRouter('/auth/oidc/callback?login_code=used');

    expect(await screen.findByText('SSO Login Failed')).toBeInTheDocument();
    expect(screen.getByText(/Login code already used/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('location-search').textContent).toBe(''));
  });
});
