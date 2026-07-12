import type { ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Capture the props framer-motion's MotionConfig is rendered with. Everything
// else stays real so <App/> mounts its normal tree (LazyMotion, m.* etc.).
const motionConfigSpy = vi.fn();

vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>();
  return {
    ...actual,
    MotionConfig: (props: { reducedMotion?: string; children?: ReactNode }) => {
      motionConfigSpy(props);
      return (
        <div data-testid="motion-config" data-reduced-motion={props.reducedMotion}>
          {props.children}
        </div>
      );
    },
  };
});

import { useAuthStore } from './stores/auth-store';
import { App } from './App';

describe('App – Framer Motion reduced-motion (#933)', () => {
  afterEach(() => {
    useAuthStore.getState().clearAuth();
    vi.clearAllMocks();
  });

  function renderApp(initialPath = '/login') {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('wraps the app tree in a MotionConfig that honors the OS reduced-motion preference', () => {
    useAuthStore.setState({
      accessToken: null,
      user: null,
      isAuthenticated: false,
    });

    renderApp('/login');

    // Without MotionConfig, Framer Motion animations ignore
    // prefers-reduced-motion. The tree must render a MotionConfig with
    // reducedMotion="user" so m.* animations follow the OS setting.
    const config = screen.getByTestId('motion-config');
    expect(config).toHaveAttribute('data-reduced-motion', 'user');
    expect(motionConfigSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reducedMotion: 'user' }),
    );
  });
});
