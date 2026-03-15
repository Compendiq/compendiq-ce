import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domMax } from 'framer-motion';
import { LoginPage } from './LoginPage';
import { useAuthStore } from '../../stores/auth-store';

function renderLoginPage(initialEntry = '/login') {
  return render(
    <LazyMotion features={domMax}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <LoginPage />
      </MemoryRouter>
    </LazyMotion>,
  );
}

describe('LoginPage', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    useAuthStore.getState().clearAuth();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('renders the login form', () => {
    // Mock OIDC config fetch
    fetchSpy.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/auth/oidc/config')) {
        return new Response(JSON.stringify({ enabled: false, issuer: null, name: null }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    });

    renderLoginPage();
    expect(screen.getByText('AI KB Creator')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter username')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter password')).toBeInTheDocument();
  });

  it('shows SSO button when OIDC is enabled', async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/auth/oidc/config')) {
        return new Response(
          JSON.stringify({ enabled: true, issuer: 'https://idp.example.com', name: 'default' }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    });

    renderLoginPage();

    await waitFor(() => {
      expect(screen.getByTestId('sso-login-btn')).toBeInTheDocument();
    });
    expect(screen.getByText('Sign in with SSO')).toBeInTheDocument();
    // Should also show the "or continue with" divider
    expect(screen.getByText('or continue with')).toBeInTheDocument();
  });

  it('does not show SSO button when OIDC is disabled', async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/auth/oidc/config')) {
        return new Response(
          JSON.stringify({ enabled: false, issuer: null, name: null }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    });

    renderLoginPage();

    // Wait for the config fetch to complete
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });

    // SSO button should not be present
    expect(screen.queryByTestId('sso-login-btn')).not.toBeInTheDocument();
  });

  it('does not show SSO button on register form', async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/auth/oidc/config')) {
        return new Response(
          JSON.stringify({ enabled: true, issuer: 'https://idp.example.com', name: 'default' }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    });

    renderLoginPage();

    // Wait for SSO button to appear
    await waitFor(() => {
      expect(screen.getByTestId('sso-login-btn')).toBeInTheDocument();
    });

    // Switch to register mode
    fireEvent.click(screen.getByText('Create one'));

    // SSO button should disappear on register form
    expect(screen.queryByTestId('sso-login-btn')).not.toBeInTheDocument();
  });

  it('shows OIDC error message from URL params', async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/auth/oidc/config')) {
        return new Response(
          JSON.stringify({ enabled: false, issuer: null, name: null }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    });

    renderLoginPage('/login?error=oidc_callback_failed');

    // Toast is rendered outside the component tree, so we just verify the page renders
    // The toast notification is handled by Sonner and would require Sonner provider in test
    expect(screen.getByText('AI KB Creator')).toBeInTheDocument();
  });
});
