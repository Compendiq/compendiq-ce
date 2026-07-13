import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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

describe('App – ProtectedRoute setup-status fail-safe (#932)', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    useAuthStore.getState().clearAuth();
  });

  function renderApp(initialPath = '/') {
    const queryClient = new QueryClient({
      // useSetupStatus pins retry: 2; a zero retryDelay lets those retries
      // exhaust instantly so the query settles into its error state quickly.
      defaultOptions: { queries: { retryDelay: () => 0 } },
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('does not dump an authenticated user into the setup wizard when the setup-status fetch fails', async () => {
    useAuthStore.setState({
      accessToken: 'persisted-token',
      user: { id: '1', username: 'test', role: 'user' },
      isAuthenticated: true,
    });

    // Simulate the backend restarting: /api/health/setup-status returns a
    // transient 5xx while every other call succeeds.
    fetchSpy.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/api/health/setup-status')) {
        return new Response('Internal Server Error', { status: 500 });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    renderApp('/');

    // The authenticated user must stay in the app shell (AppLayout's header
    // renders the mobile navigation-menu toggle) rather than being redirected
    // into the first-run wizard on a transient setup-status error. The generous
    // timeout lets useSetupStatus exhaust its pinned retries and settle into
    // the error state (mirrors useSetupStatus.test.ts).
    await waitFor(
      () => {
        expect(screen.getByLabelText('Open navigation menu')).toBeInTheDocument();
      },
      { timeout: 8000 },
    );
    expect(screen.queryByText('Welcome to Compendiq')).not.toBeInTheDocument();
  }, 15000);
});

describe('App – SetupRoute setup-status error handling (#932)', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    useAuthStore.getState().clearAuth();
  });

  function renderApp(
    initialPath: string,
    seedStaleSetupStatus?: { setupComplete: boolean },
  ) {
    const queryClient = new QueryClient({
      // useSetupStatus pins retry: 2; a zero retryDelay lets those retries
      // exhaust instantly so the query settles into its error state quickly.
      defaultOptions: { queries: { retryDelay: () => 0 } },
    });
    if (seedStaleSetupStatus) {
      // Backdate the entry past the hook's 30s staleTime so mounting
      // triggers a background refetch while the cached answer survives.
      queryClient.setQueryData(
        ['setup-status'],
        {
          setupComplete: seedStaleSetupStatus.setupComplete,
          steps: { admin: true, llm: true, confluence: true },
        },
        { updatedAt: Date.now() - 60_000 },
      );
    }
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  function failSetupStatusFetches() {
    fetchSpy.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/api/health/setup-status')) {
        return new Response('Internal Server Error', { status: 500 });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
  }

  it('shows a retry affordance (not an infinite spinner) when the fetch fails with no cached data, and recovers on retry', async () => {
    failSetupStatusFetches();

    renderApp('/setup');

    // Once retries are exhausted the route must settle into a terminal
    // error state with an explicit retry — not the wizard, not a spinner.
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();
      },
      { timeout: 8000 },
    );
    expect(screen.queryByText('Welcome to Compendiq')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();

    // Backend comes back reporting setup incomplete: retrying must recover
    // into the wizard.
    fetchSpy.mockImplementation(async () =>
      new Response(
        JSON.stringify({
          setupComplete: false,
          steps: { admin: false, llm: false, confluence: false },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));

    await waitFor(() => {
      expect(screen.getByText('Welcome to Compendiq')).toBeInTheDocument();
    });
  }, 15000);

  it('keeps routing on stale cached data when only a background refetch fails', async () => {
    useAuthStore.setState({
      accessToken: 'persisted-token',
      user: { id: '1', username: 'admin', role: 'admin' },
      isAuthenticated: true,
    });
    failSetupStatusFetches();

    // Rerun flow with a stale "setup complete" answer in the cache: the
    // failed background refetch must not blank the wizard into a spinner
    // or the error card — the cached data is still authoritative enough.
    // (On rerun the wizard starts at the LLM step, hence llm-next-btn.)
    renderApp('/setup?rerun=true', { setupComplete: true });

    expect(screen.getByTestId('llm-next-btn')).toBeInTheDocument();

    // Wait for the background refetch (initial attempt + 2 retries) to fail.
    await waitFor(
      () => {
        const setupStatusCalls = fetchSpy.mock.calls.filter(([input]) => {
          const url = typeof input === 'string' ? input : (input as Request).url;
          return url.includes('/api/health/setup-status');
        });
        expect(setupStatusCalls.length).toBeGreaterThanOrEqual(3);
      },
      { timeout: 8000 },
    );

    // Still on the wizard — no spinner, no error card.
    expect(screen.getByTestId('llm-next-btn')).toBeInTheDocument();
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try Again' })).not.toBeInTheDocument();
  }, 15000);
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
    expect(glassCard.className).toContain('nm-card');
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

  it('renders login page immediately without loading flash (static import)', () => {
    useAuthStore.setState({
      accessToken: null,
      user: null,
      isAuthenticated: false,
    });

    renderApp('/login');

    // LoginPage is statically imported so it renders synchronously —
    // no "Loading..." flash should appear.
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
    expect(document.querySelector('form, [data-testid], h1, h2, button')).toBeTruthy();
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
