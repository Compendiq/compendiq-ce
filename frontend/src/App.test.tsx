import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuthStore } from './stores/auth-store';
import { App } from './App';

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
