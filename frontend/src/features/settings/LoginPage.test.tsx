import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { LoginPage } from './LoginPage';
import { useAuthStore } from '../../stores/auth-store';

vi.mock('../../shared/lib/api', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

function renderLoginPage(initialEntry = '/login') {
  return render(
    <LazyMotion features={domAnimation}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <LoginPage />
      </MemoryRouter>
    </LazyMotion>,
  );
}

describe('LoginPage', () => {
  beforeEach(() => {
    useAuthStore.getState().clearAuth();
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('renders the login form', () => {
    renderLoginPage();
    expect(screen.getByRole('img', { name: 'Compendiq' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter username')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter password')).toBeInTheDocument();
  });

  it('renders SSO button when OIDC is enabled', async () => {
    const { apiFetch } = await import('../../shared/lib/api');
    vi.mocked(apiFetch).mockResolvedValueOnce({
      enabled: true,
      issuer: 'https://idp.example.com',
      name: 'OrgSSO',
      enterpriseRequired: false,
    } as never);

    renderLoginPage();
    expect(await screen.findByRole('button', { name: 'Sign in with OrgSSO' })).toBeInTheDocument();
  });

  it('does not render SSO button when OIDC is disabled', async () => {
    const { apiFetch } = await import('../../shared/lib/api');
    vi.mocked(apiFetch).mockResolvedValueOnce({
      enabled: false,
      issuer: null,
      name: null,
      enterpriseRequired: false,
    } as never);

    renderLoginPage();
    expect(screen.queryByTestId('sso-login-btn')).not.toBeInTheDocument();
  });

  it('does not render SSO button when OIDC config fetch fails', async () => {
    const { apiFetch } = await import('../../shared/lib/api');
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('Network error'));

    renderLoginPage();
    expect(screen.queryByTestId('sso-login-btn')).not.toBeInTheDocument();
  });

  it('shows an error toast when redirected back with an OIDC error param', async () => {
    const { toast } = await import('sonner');
    const { apiFetch } = await import('../../shared/lib/api');
    vi.mocked(apiFetch).mockResolvedValueOnce({
      enabled: false,
      issuer: null,
      name: null,
      enterpriseRequired: false,
    } as never);

    renderLoginPage('/login?error=access_denied');

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('SSO login failed: access_denied');
    });
  });
});
