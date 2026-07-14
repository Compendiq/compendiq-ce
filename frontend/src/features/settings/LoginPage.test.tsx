import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { LoginPage } from './LoginPage';
import { apiFetch } from '../../shared/lib/api';
import { useAuthStore } from '../../stores/auth-store';

vi.mock('../../shared/lib/api', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

type OidcOpt = Record<string, unknown> | 'reject';
type RegOpt = { allowRegistration: boolean } | 'reject';

/**
 * URL-keyed apiFetch mock. LoginPage fires two independent probes on mount
 * (`/auth/oidc/config` and `/auth/registration-policy`), so a call-order-based
 * `mockResolvedValueOnce` is brittle — key the resolution on the URL instead.
 */
function mockApi(opts: { oidc?: OidcOpt; registration?: RegOpt } = {}) {
  const oidc = opts.oidc ?? { enabled: false, issuer: null, name: null, enterpriseRequired: false };
  const registration = opts.registration ?? { allowRegistration: false };
  vi.mocked(apiFetch).mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes('/auth/oidc/config')) {
      if (oidc === 'reject') throw new Error('no oidc');
      return oidc as never;
    }
    if (u.includes('/auth/registration-policy')) {
      if (registration === 'reject') throw new Error('policy fetch failed');
      return registration as never;
    }
    if (u.includes('/auth/register')) {
      return { accessToken: 'tok', user: { id: 'u1', username: 'newuser', role: 'user' } } as never;
    }
    throw new Error(`unexpected apiFetch url: ${u}`);
  });
}

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
    mockApi();
    renderLoginPage();
    expect(screen.getByRole('img', { name: 'Compendiq' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter username')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter password')).toBeInTheDocument();
  });

  it('renders SSO button with the configured IdP display name when OIDC is enabled', async () => {
    mockApi({
      oidc: { enabled: true, issuer: 'https://idp.example.com', name: 'OrgSSO', enterpriseRequired: false },
    });
    renderLoginPage();
    expect(await screen.findByRole('button', { name: 'Sign in with OrgSSO' })).toBeInTheDocument();
    expect(screen.getByText('or continue with credentials')).toBeInTheDocument();
  });

  it('falls back to the generic "SSO" label when no IdP display name is configured', async () => {
    mockApi({
      oidc: { enabled: true, issuer: 'https://idp.example.com', name: null, enterpriseRequired: false },
    });
    renderLoginPage();
    expect(await screen.findByRole('button', { name: 'Sign in with SSO' })).toBeInTheDocument();
  });

  it('does not render SSO button when OIDC is disabled', async () => {
    mockApi({ oidc: { enabled: false, issuer: null, name: null, enterpriseRequired: false } });
    renderLoginPage();
    expect(screen.queryByTestId('sso-login-btn')).not.toBeInTheDocument();
  });

  it('does not render SSO button when OIDC config fetch fails', async () => {
    mockApi({ oidc: 'reject' });
    renderLoginPage();
    expect(screen.queryByTestId('sso-login-btn')).not.toBeInTheDocument();
  });

  it('shows a mapped error toast when redirected back with a known OIDC error code', async () => {
    const { toast } = await import('sonner');
    mockApi({ oidc: { enabled: false, issuer: null, name: null, enterpriseRequired: true } });

    renderLoginPage('/login?error=access_denied');

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('SSO sign-in was cancelled or denied.');
    });
  });

  it('shows a generic toast (never the raw param) for an unknown OIDC error code', async () => {
    const { toast } = await import('sonner');
    mockApi({ oidc: { enabled: false, issuer: null, name: null, enterpriseRequired: true } });

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
    // EE returns only `enabled` + `name`; issuer and enterpriseRequired are absent.
    mockApi({ oidc: { enabled: true, name: 'OrgSSO' } });
    renderLoginPage();
    expect(await screen.findByRole('button', { name: 'Sign in with OrgSSO' })).toBeInTheDocument();
  });

  // ─── #1051 — signup toggle visibility (fail closed) ──────────────────────
  describe('registration policy gating', () => {
    it('does not render the signup toggle when registration is disabled', async () => {
      mockApi({ oidc: 'reject', registration: { allowRegistration: false } });
      renderLoginPage();
      // Give both mount effects a chance to resolve.
      await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
      expect(screen.queryByRole('button', { name: 'Create one' })).not.toBeInTheDocument();
    });

    it('renders the signup toggle when registration is allowed', async () => {
      mockApi({ oidc: 'reject', registration: { allowRegistration: true } });
      renderLoginPage();
      expect(await screen.findByRole('button', { name: 'Create one' })).toBeInTheDocument();
    });

    it('does not render the signup toggle when the policy fetch fails (fail closed)', async () => {
      mockApi({ oidc: 'reject', registration: 'reject' });
      renderLoginPage();
      await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
      expect(screen.queryByRole('button', { name: 'Create one' })).not.toBeInTheDocument();
    });
  });

  describe('registration confirm password', () => {
    async function switchToRegister() {
      // The toggle only appears once the (allowed) policy resolves.
      fireEvent.click(await screen.findByRole('button', { name: 'Create one' }));
    }

    it('shows the confirm-password input and the 8-char hint in register mode only', async () => {
      mockApi({ oidc: 'reject', registration: { allowRegistration: true } });
      renderLoginPage();

      // Login mode: neither the confirm field nor the hint is rendered.
      expect(screen.queryByLabelText('Confirm password')).not.toBeInTheDocument();
      expect(screen.queryByText('At least 8 characters')).not.toBeInTheDocument();

      await switchToRegister();

      expect(screen.getByLabelText('Confirm password')).toBeInTheDocument();
      expect(screen.getByText('At least 8 characters')).toBeInTheDocument();
    });

    it('blocks submit and shows an error when the passwords do not match', async () => {
      mockApi({ oidc: 'reject', registration: { allowRegistration: true } });
      renderLoginPage();
      await switchToRegister();

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
      mockApi({ oidc: 'reject', registration: { allowRegistration: true } });
      renderLoginPage();
      await switchToRegister();

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
      mockApi({ oidc: 'reject', registration: { allowRegistration: true } });
      renderLoginPage();
      await switchToRegister();

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
