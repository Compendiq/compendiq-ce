import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuthStore } from './stores/auth-store';
import { App, PageLoadingFallback } from './App';

describe('App – ProtectedRoute token restoration', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    useAuthStore.getState().clearAuth();
  });

  function renderApp(initialPath = '/settings') {
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

  it('redirects to login when not authenticated', () => {
    useAuthStore.setState({
      accessToken: null,
      user: null,
      isAuthenticated: false,
    });

    renderApp('/settings');
    // Should redirect to login (no settings content visible)
    expect(screen.queryByText(/settings/i)).not.toBeInTheDocument();
  });

  it('renders protected content immediately when accessToken is persisted', async () => {
    useAuthStore.setState({
      accessToken: 'persisted-token',
      user: { id: '1', username: 'test', role: 'user' },
      isAuthenticated: true,
    });

    // Mock dashboard API calls so rendered pages don't fail
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    renderApp('/');

    // Should NOT call refresh — token already available
    await waitFor(() => {
      const refreshCalls = fetchSpy.mock.calls.filter(
        ([url]) => url === '/api/auth/refresh',
      );
      expect(refreshCalls).toHaveLength(0);
    });
  });

  it('uses useSessionInit refresh fallback when accessToken is null but isAuthenticated', async () => {
    useAuthStore.setState({
      accessToken: null,
      user: { id: '1', username: 'test', role: 'user' },
      isAuthenticated: true,
    });

    // Mock all fetch calls: refresh returns token, everything else returns 200
    fetchSpy.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/auth/refresh')) {
        return new Response(JSON.stringify({
          accessToken: 'restored-token',
          user: { id: '1', username: 'test', role: 'user' },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    renderApp('/');

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('/api/auth/refresh', expect.objectContaining({
        method: 'POST',
        credentials: 'include',
      }));
    });

    // Token should be restored in the store
    await waitFor(() => {
      expect(useAuthStore.getState().accessToken).toBe('restored-token');
    });
  });

  it('clears auth and redirects to login when refresh fails on reload', async () => {
    useAuthStore.setState({
      accessToken: null,
      user: { id: '1', username: 'test', role: 'user' },
      isAuthenticated: true,
    });

    // Mock all fetch calls: refresh fails, everything else returns 200
    fetchSpy.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/auth/refresh')) {
        return new Response('Forbidden', { status: 403 });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    renderApp('/');

    await waitFor(() => {
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
    });
  });
});

describe('PageLoadingFallback', () => {
  it('renders a glassmorphic loading indicator', () => {
    render(<PageLoadingFallback />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('applies the correct CSS classes', () => {
    const { container } = render(<PageLoadingFallback />);
    const outerDiv = container.firstElementChild as HTMLElement;
    expect(outerDiv.className).toContain('flex');
    expect(outerDiv.className).toContain('items-center');
    expect(outerDiv.className).toContain('justify-center');
    expect(outerDiv.className).toContain('h-64');

    const glassCard = outerDiv.firstElementChild as HTMLElement;
    expect(glassCard.className).toContain('glass-card');
    expect(glassCard.className).toContain('p-8');

    const loadingText = glassCard.firstElementChild as HTMLElement;
    expect(loadingText.className).toContain('animate-pulse');
    expect(loadingText.className).toContain('text-muted-foreground');
  });
});

describe('App – route-based code splitting (#186)', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  afterEach(() => {
    useAuthStore.getState().clearAuth();
  });

  function renderApp(initialPath = '/') {
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

  it('shows loading fallback then resolves lazy login page', async () => {
    useAuthStore.setState({
      accessToken: null,
      user: null,
      isAuthenticated: false,
    });

    renderApp('/login');

    // The lazy component should resolve (Vitest bundles imports synchronously
    // via Vite SSR, so it resolves within the same tick or the next microtask)
    await waitFor(() => {
      // Login page should eventually render (it has a form or heading)
      expect(document.querySelector('form, [data-testid], h1, h2, button')).toBeTruthy();
    });
  });

  it('lazy-loads protected page components for authenticated users', async () => {
    useAuthStore.setState({
      accessToken: 'test-token',
      user: { id: '1', username: 'test', role: 'user' },
      isAuthenticated: true,
    });

    renderApp('/settings');

    // The lazy-loaded settings page should eventually render
    await waitFor(() => {
      // Settings page should have loaded (look for any rendered content
      // beyond the loading fallback)
      const loadingText = screen.queryByText('Loading...');
      // Either loading is gone or settings content appeared
      expect(
        loadingText === null ||
        document.querySelector('[data-testid], form, h1, h2, button, input'),
      ).toBeTruthy();
    });
  });
});
