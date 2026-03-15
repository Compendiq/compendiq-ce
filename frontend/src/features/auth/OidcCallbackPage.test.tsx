import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LazyMotion, domMax } from 'framer-motion';
import { OidcCallbackPage } from './OidcCallbackPage';
import { useAuthStore } from '../../stores/auth-store';

function renderWithRouter(initialEntry: string) {
  return render(
    <LazyMotion features={domMax}>
      <MemoryRouter initialEntries={[initialEntry]}>
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
});
