import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuthStore } from './stores/auth-store';
import { createQueryClient } from './shared/lib/query-client';
import { App } from './App';

describe('App – ProtectedRoute token restoration', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
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

describe('App – expired session must not hang on the loading fallback', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    useAuthStore.getState().clearAuth();
  });

  function renderApp(queryClient: QueryClient, initialPath = '/') {
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  // Reproduces the reported hang: opening the app with an expired/revoked
  // refresh cookie shows the boot skeleton forever until a manual reload.
  //
  // The sequence is a starvation, not a failed fetch. useSessionInit's refresh
  // 401s and calls clearAuth(); that true->false flip fires
  // useClearCacheOnLogout, whose queryClient.clear() evicts the already-
  // resolved ['setup-status'] entry. useSetupStatus then reports isLoading
  // again with no data, and ProtectedRoute's `if (isLoading)` gate returns the
  // fallback *before* reaching its `<Navigate to="/login">` — with nothing left
  // to refetch the evicted query, the spinner never resolves.
  //
  // The pre-existing "clears auth and redirects to login when refresh fails on
  // reload" test above cannot catch this: it asserts only the store flag, which
  // flips correctly while the UI stays stuck.
  it('lands on the login page when the session refresh fails on load', async () => {
    useAuthStore.setState({
      accessToken: null,
      user: { id: '1', username: 'test', role: 'user' },
      isAuthenticated: true,
    });

    // The app's own client — staleTime and the retry predicate both affect
    // whether an evicted query refetches, so a bespoke one would not be
    // testing the app.
    const queryClient = createQueryClient();

    // A configured instance (setupComplete: true) whose refresh cookie is no
    // longer accepted. Returning a real setup-status payload matters: an empty
    // {} would leave setupComplete falsy and route to /setup instead, which is
    // why the existing coverage never exercised this path.
    //
    // The ordering below is the whole bug. The refresh must fail while the
    // setup-status request is still IN FLIGHT, so queryClient.clear() removes a
    // pending query: the response then arrives for a query that no longer
    // exists and is discarded, leaving the observer with no data and nothing to
    // trigger a refetch. If setup-status resolves first the app behaves
    // correctly — clearAuth re-renders ProtectedRoute while the cached answer
    // is still there, and it redirects to /login as intended.
    let refreshFailed: () => void;
    const refreshHasFailed = new Promise<void>((resolve) => {
      refreshFailed = resolve;
    });

    fetchSpy.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/api/health/setup-status')) {
        await refreshHasFailed;
        return new Response(
          JSON.stringify({
            setupComplete: true,
            steps: { admin: true, llm: true, confluence: true },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/auth/refresh')) {
        // Let the 401 land, then release setup-status on a later macrotask so
        // clearAuth's effect (and its clear()) has run first.
        setTimeout(() => refreshFailed(), 0);
        return new Response('Unauthorized', { status: 401 });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    renderApp(queryClient, '/');

    await waitFor(() => {
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
    });

    // The user must end up somewhere actionable rather than on a spinner.
    await waitFor(() => {
      expect(screen.getByTestId('sso-status-announcer')).toBeInTheDocument();
    });
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
  }, 10000);
});

describe('App – ProtectedRoute setup-status fail-safe (#932)', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
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
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
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

describe('App – boot loading chrome', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { promise } = Promise.withResolvers<Response>();
    fetchSpy.mockImplementation(() => promise);
  });

  afterEach(() => {
    useAuthStore.getState().clearAuth();
    localStorage.removeItem('compendiq-auth');
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

  it('paints the workspace chassis while setup-status is in flight for a session', () => {
    useAuthStore.setState({
      accessToken: 'persisted-token',
      user: { id: '1', username: 'test', role: 'user' },
      isAuthenticated: true,
    });

    renderApp('/');

    expect(screen.getByTestId('app-boot-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
    expect(document.querySelector('.nm-card')).toBeNull();
  });

  it('paints a quiet header while setup-status is in flight for a guest', () => {
    useAuthStore.setState({
      accessToken: null,
      user: null,
      isAuthenticated: false,
    });

    renderApp('/');

    expect(screen.getByTestId('quiet-boot-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('library-list-skeleton')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
  });

  it('paints the workspace chassis from a persisted session before the store hydrates', () => {
    useAuthStore.setState({
      accessToken: null,
      user: null,
      isAuthenticated: false,
    });
    localStorage.setItem(
      'compendiq-auth',
      JSON.stringify({
        state: {
          isAuthenticated: true,
          user: { id: '1', username: 'test', role: 'user' },
        },
        version: 1,
      }),
    );

    renderApp('/');

    expect(screen.getByTestId('app-boot-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('quiet-boot-skeleton')).not.toBeInTheDocument();
  });
});

describe('App – route-based code splitting (#186)', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
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

describe('App routes — the AI family (#1361)', () => {
  // A source guard rather than a render: this file mounts the real lazy tree
  // behind Suspense, so a behavioural assertion for /ai/c/:id would have to
  // wait out AiAssistantPage's whole query fan-out to be non-vacuous — and
  // would pass on the fallback either way. The route's BEHAVIOUR is covered
  // where the provider reads it (AiContext.threads.test.tsx) and where the
  // conversation is fetched (the hydration tests). What this pins is that the
  // path exists at all, i.e. that a pasted /ai/c/<id> is not a 404.
  // Precedent: PageTransition.test.tsx:86-108, src/ai-scroll-chain.test.ts.
  it('registers /ai/c/:conversationId beside /ai, on the same component', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = await fs.readFile(path.join(here, 'App.tsx'), 'utf-8');
    // Negative lookahead so the wildcard route literal `path="/*"` (#1054's
    // ProtectedRoute catch-all, App.tsx:193) is not mistaken for the start of
    // a block comment — a real comment never opens with `/*"`, but a naive
    // strip here swallows everything up to the next genuine `*/`, which would
    // silently eat every route between the two, this one included.
    const code = src.replace(/\/\*(?!")[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(code).toMatch(/path="\/ai"\s+element=\{<AiAssistantPage \/>\}/);
    expect(code).toMatch(
      /path="\/ai\/c\/:conversationId"[\s\S]{0,80}element=\{<AiAssistantPage \/>\}/,
    );
  });
});
