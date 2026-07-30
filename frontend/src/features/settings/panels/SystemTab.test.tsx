import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { SystemTab } from './SystemTab';
import { useAuthStore } from '../../../stores/auth-store';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('SystemTab', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    // Diagnostics is admin-only; seed an admin user + token.
    useAuthStore.setState({
      user: { id: 'u1', username: 'admin', role: 'admin' },
      accessToken: 'admin-token',
      isAuthenticated: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.setState({ user: null, accessToken: null, isAuthenticated: false });
  });

  it('sends the admin access token to /api/health and renders the backend commit (#1052)', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/health')) {
        return new Response(
          JSON.stringify({
            status: 'ok',
            commit: 'abc1234',
            ceCommit: 'ce999',
            builtAt: '2026-01-01T00:00:00Z',
            edition: 'community',
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({ variant: 'local-loop' }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });

    render(<SystemTab />, { wrapper: createWrapper() });

    // #1052: /api/health returns build metadata only to an authenticated admin,
    // so the request must carry the Authorization header.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/health',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer admin-token' }),
        }),
      );
    });

    // The backend commit from the (authenticated) response is rendered.
    await waitFor(() => {
      expect(screen.getByTestId('backend-commit')).toHaveTextContent('abc1234');
    });
    expect(screen.getByTestId('backend-ce-commit')).toHaveTextContent('ce999');
  });

  it('loads the current design and persists a Change Desk selection', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/health')) {
        return new Response(
          JSON.stringify({ status: 'ok', edition: 'community' }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/api/admin/login-page-config') && init?.method === 'PUT') {
        return new Response(
          JSON.stringify({ variant: 'change-desk' }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({ variant: 'local-loop' }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });

    render(<SystemTab />, { wrapper: createWrapper() });

    const localLoop = await screen.findByRole('radio', { name: /Local Loop/i });
    expect(localLoop).toBeChecked();
    expect(screen.getByTestId('apply-login-page-variant')).toBeDisabled();

    fireEvent.click(screen.getByRole('radio', { name: /Change Desk/i }));
    fireEvent.click(screen.getByTestId('apply-login-page-variant'));

    await waitFor(() => {
      const updateCall = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).includes('/api/admin/login-page-config') &&
          (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(updateCall).toBeDefined();
      expect(JSON.parse((updateCall![1] as RequestInit).body as string)).toEqual({
        variant: 'change-desk',
      });
    });
  });
});
