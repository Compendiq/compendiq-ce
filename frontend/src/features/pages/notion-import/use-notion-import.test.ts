import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { waitFor } from '@testing-library/react';
import { useAuthStore } from '../../../stores/auth-store';
import { prefetchNotionConnection } from './use-notion-import';

describe('prefetchNotionConnection', () => {
  let calls: Array<{ url: string }>;
  let hasToken = true;

  beforeEach(() => {
    hasToken = true;
    calls = [];
    useAuthStore.getState().setAuth('test-access', { id: 'u1', username: 'me', role: 'user' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push({ url });
        if (/\/notion\/connection$/.test(url)) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => ({ hasToken }),
          } as Response;
        }
        if (/\/notion\/tree$/.test(url)) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => ({ nodes: [] }),
          } as Response;
        }
        return {
          ok: false,
          status: 404,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ message: `no stub for ${url}` }),
        } as Response;
      }),
    );
  });

  afterEach(() => {
    useAuthStore.getState().clearAuth();
    vi.unstubAllGlobals();
  });

  it('prefetches the workspace tree once connection reports a token', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    prefetchNotionConnection(queryClient);
    await waitFor(() => {
      expect(calls.some((c) => /\/notion\/tree$/.test(c.url))).toBe(true);
    });
  });

  it('does not prefetch the tree when Notion is not connected', async () => {
    hasToken = false;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    prefetchNotionConnection(queryClient);
    await waitFor(() => {
      expect(calls.some((c) => /\/notion\/connection$/.test(c.url))).toBe(true);
    });
    expect(calls.some((c) => /\/notion\/tree$/.test(c.url))).toBe(false);
  });
});
