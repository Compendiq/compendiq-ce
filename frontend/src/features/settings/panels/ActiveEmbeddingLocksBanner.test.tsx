import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ActiveEmbeddingLocksBanner } from './ActiveEmbeddingLocksBanner';
import { useAuthStore } from '../../../stores/auth-store';

function createWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe('ActiveEmbeddingLocksBanner', () => {
  beforeEach(() => {
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'admin',
      role: 'admin',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  // RED #13 (plan §4.10) — empty state: render nothing.
  it('renders nothing when no locks are held', async () => {
    const Wrapper = createWrapper();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ locks: [] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const { container } = render(<ActiveEmbeddingLocksBanner />, { wrapper: Wrapper });

    // Wait for the initial poll to settle.
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  // RED #13 — populated state: render per-user rows + Force release button.
  it('renders one row per active lock with a Force release button', async () => {
    const Wrapper = createWrapper();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          locks: [
            { userId: 'alice', holderEpoch: 'uuid-a', ttlRemainingMs: 1_200_000 },
            { userId: 'bob', holderEpoch: 'uuid-b', ttlRemainingMs: 2_400_000 },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });

    render(<ActiveEmbeddingLocksBanner />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('embedding-lock-row-alice')).toBeTruthy();
      expect(screen.getByTestId('embedding-lock-row-bob')).toBeTruthy();
    });
    const buttons = await screen.findAllByRole('button', { name: /force release/i });
    expect(buttons).toHaveLength(2);
  });

  // RED #14a — confirm flow: cancel does NOT fire the release call.
  it('cancel on confirm-inline does not fire a release call', async () => {
    const Wrapper = createWrapper();
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('/admin/embedding/locks') && !url.includes('/release')) {
        return new Response(
          JSON.stringify({
            locks: [{ userId: 'alice', holderEpoch: 'uuid-a', ttlRemainingMs: 1_000_000 }],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    });

    render(<ActiveEmbeddingLocksBanner />, { wrapper: Wrapper });
    const releaseBtn = await screen.findByRole('button', { name: /force release/i });
    fireEvent.click(releaseBtn);
    const cancelBtn = await screen.findByRole('button', { name: /cancel/i });
    fireEvent.click(cancelBtn);

    // No POST went out.
    const releaseCalls = spy.mock.calls.filter(([input]) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      return url.includes('/release');
    });
    expect(releaseCalls).toHaveLength(0);
  });

  // RED #14a — confirm flow happy path: confirm fires POST.
  it('confirm on inline-confirm fires POST /admin/embedding/locks/:userId/release', async () => {
    const Wrapper = createWrapper();
    let postFired = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.endsWith('/admin/embedding/locks/alice/release') && init?.method === 'POST') {
        postFired = true;
        return new Response(JSON.stringify({ released: true, userId: 'alice' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/admin/embedding/locks')) {
        return new Response(
          JSON.stringify({
            locks: postFired
              ? []
              : [{ userId: 'alice', holderEpoch: 'uuid-a', ttlRemainingMs: 1_000_000 }],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    });

    render(<ActiveEmbeddingLocksBanner />, { wrapper: Wrapper });
    const releaseBtn = await screen.findByRole('button', { name: /force release/i });
    fireEvent.click(releaseBtn);
    const confirmBtn = await screen.findByRole('button', { name: /^confirm$/i });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(postFired).toBe(true);
    });
  });

  // RED #14b — error path: non-2xx response surfaces without removing the row.
  it('keeps the row in place when the release POST returns a non-2xx', async () => {
    const Wrapper = createWrapper();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.endsWith('/release') && init?.method === 'POST') {
        return new Response(JSON.stringify({ error: 'forbidden' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/admin/embedding/locks')) {
        return new Response(
          JSON.stringify({
            locks: [{ userId: 'alice', holderEpoch: 'uuid-a', ttlRemainingMs: 1_000_000 }],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    });

    render(<ActiveEmbeddingLocksBanner />, { wrapper: Wrapper });
    const releaseBtn = await screen.findByRole('button', { name: /force release/i });
    fireEvent.click(releaseBtn);
    const confirmBtn = await screen.findByRole('button', { name: /^confirm$/i });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    // Row still visible after the failed POST — user can retry or cancel.
    await waitFor(() => {
      expect(screen.getByTestId('embedding-lock-row-alice')).toBeTruthy();
    });
  });
});
