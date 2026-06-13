import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

  it('renders SSO button with the configured IdP display name when OIDC is enabled', async () => {
    const { apiFetch } = await import('../../shared/lib/api');
    vi.mocked(apiFetch).mockResolvedValueOnce({
      enabled: true,
      issuer: 'https://idp.example.com',
      name: 'OrgSSO',
      enterpriseRequired: false,
    } as never);

    renderLoginPage();
    expect(await screen.findByRole('button', { name: 'Sign in with OrgSSO' })).toBeInTheDocument();
    expect(screen.getByText('or continue with credentials')).toBeInTheDocument();
  });

  it('falls back to the generic "SSO" label when no IdP display name is configured', async () => {
    const { apiFetch } = await import('../../shared/lib/api');
    vi.mocked(apiFetch).mockResolvedValueOnce({
      enabled: true,
      issuer: 'https://idp.example.com',
      name: null,
      enterpriseRequired: false,
    } as never);

    renderLoginPage();
    expect(await screen.findByRole('button', { name: 'Sign in with SSO' })).toBeInTheDocument();
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

  it('shows a mapped error toast when redirected back with a known OIDC error code', async () => {
    const { toast } = await import('sonner');
    const { apiFetch } = await import('../../shared/lib/api');
    vi.mocked(apiFetch).mockResolvedValueOnce({
      enabled: false,
      issuer: null,
      name: null,
      enterpriseRequired: true,
    } as never);

    renderLoginPage('/login?error=access_denied');

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('SSO sign-in was cancelled or denied.');
    });
  });

  it('shows a generic toast (never the raw param) for an unknown OIDC error code', async () => {
    const { toast } = await import('sonner');
    const { apiFetch } = await import('../../shared/lib/api');
    vi.mocked(apiFetch).mockResolvedValueOnce({
      enabled: false,
      issuer: null,
      name: null,
      enterpriseRequired: true,
    } as never);

    renderLoginPage('/login?error=<script>alert(1)</script>');

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        'SSO sign-in failed. Please try again or use local login.',
      );
    });
    const echoedRaw = vi.mocked(toast.error).mock.calls.some((c) => String(c[0]).includes('<script>'));
    expect(echoedRaw).toBe(false);
  });

  it('renders the SSO button when EE omits optional config fields (fails open)', async () => {
    const { apiFetch } = await import('../../shared/lib/api');
    // EE returns only `enabled` + `name`; issuer and enterpriseRequired are absent.
    vi.mocked(apiFetch).mockResolvedValueOnce({ enabled: true, name: 'OrgSSO' } as never);

    renderLoginPage();
    expect(await screen.findByRole('button', { name: 'Sign in with OrgSSO' })).toBeInTheDocument();
  });

  describe('registration confirm password', () => {
    function switchToRegister() {
      fireEvent.click(screen.getByRole('button', { name: 'Create one' }));
    }

    it('shows the confirm-password input and the 8-char hint in register mode only', async () => {
      const { apiFetch } = await import('../../shared/lib/api');
      vi.mocked(apiFetch).mockRejectedValue(new Error('no oidc'));

      renderLoginPage();

      // Login mode: neither the confirm field nor the hint is rendered.
      expect(screen.queryByLabelText('Confirm password')).not.toBeInTheDocument();
      expect(screen.queryByText('At least 8 characters')).not.toBeInTheDocument();

      switchToRegister();

      expect(screen.getByLabelText('Confirm password')).toBeInTheDocument();
      expect(screen.getByText('At least 8 characters')).toBeInTheDocument();
    });

    it('blocks submit and shows an error when the passwords do not match', async () => {
      const { apiFetch } = await import('../../shared/lib/api');
      vi.mocked(apiFetch).mockRejectedValue(new Error('no oidc'));

      renderLoginPage();
      switchToRegister();

      fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'newuser' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
      fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'password124' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));

      expect(await screen.findByText("Passwords don't match")).toBeInTheDocument();

      // No registration request was fired.
      const registerCall = vi
        .mocked(apiFetch)
        .mock.calls.find(([url]) => String(url).includes('/auth/register'));
      expect(registerCall).toBeUndefined();
    });

    it('clears the mismatch error as soon as the user retypes either password field', async () => {
      const { apiFetch } = await import('../../shared/lib/api');
      vi.mocked(apiFetch).mockRejectedValue(new Error('no oidc'));

      renderLoginPage();
      switchToRegister();

      fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'newuser' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
      fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'password124' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));

      expect(await screen.findByText("Passwords don't match")).toBeInTheDocument();

      // Correcting the confirm field must dismiss the stale error immediately.
      fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'password123' } });
      expect(screen.queryByText("Passwords don't match")).not.toBeInTheDocument();

      // Same when editing the password field after a fresh mismatch.
      fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'password124' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));
      expect(await screen.findByText("Passwords don't match")).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password124' } });
      expect(screen.queryByText("Passwords don't match")).not.toBeInTheDocument();
    });

    it('submits the registration when the passwords match', async () => {
      const { apiFetch } = await import('../../shared/lib/api');
      vi.mocked(apiFetch).mockImplementation(async (url: string) => {
        if (String(url).includes('/auth/register')) {
          return {
            accessToken: 'tok',
            user: { id: 'u1', username: 'newuser', role: 'user' },
          } as never;
        }
        throw new Error('no oidc');
      });

      renderLoginPage();
      switchToRegister();

      fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'newuser' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
      fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'password123' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));

      await waitFor(() => {
        const registerCall = vi
          .mocked(apiFetch)
          .mock.calls.find(([url]) => String(url).includes('/auth/register'));
        expect(registerCall).toBeDefined();
      });
      expect(screen.queryByText("Passwords don't match")).not.toBeInTheDocument();
    });
  });
});
