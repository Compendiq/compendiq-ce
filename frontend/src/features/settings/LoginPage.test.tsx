import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { LoginPage } from './LoginPage';
import { useAuthStore } from '../../stores/auth-store';

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

  it('does not show SSO button (enterprise feature)', () => {
    renderLoginPage();
    expect(screen.queryByTestId('sso-login-btn')).not.toBeInTheDocument();
  });
});
