import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { useAuthStore } from '../../../stores/auth-store';
import { prefetchNotionConnection, useRunNotionImport } from './use-notion-import';
import { ApiError } from '../../../shared/lib/api';

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

describe('useRunNotionImport', () => {
  let calls: Array<{ url: string; method: string }>;
  let statusBodies: Array<{ status: string; items?: unknown[]; error?: string }>;

  beforeEach(() => {
    calls = [];
    statusBodies = [{ status: 'complete', items: [{ notionPageId: 'notes', status: 'success', localPageId: 11 }] }];
    useAuthStore.getState().setAuth('test-access', { id: 'u1', username: 'me', role: 'user' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ url, method });
        if (method === 'POST' && /\/notion\/import$/.test(url)) {
          return {
            ok: true,
            status: 202,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => ({ status: 'importing' }),
          } as Response;
        }
        if (method === 'GET' && /\/notion\/import\/status$/.test(url)) {
          const body = statusBodies.shift() ?? { status: 'idle' };
          return {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => body,
          } as Response;
        }
        return {
          ok: false,
          status: 404,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ message: `no stub for ${method} ${url}` }),
        } as Response;
      }),
    );
  });

  afterEach(() => {
    useAuthStore.getState().clearAuth();
    vi.unstubAllGlobals();
  });

  function wrapper({ children }: { children: ReactNode }) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }

  it('starts the import then returns items from GET status', async () => {
    const { result } = renderHook(() => useRunNotionImport(), { wrapper });
    await expect(result.current.mutateAsync({ pageIds: ['notes'], visibility: 'private' })).resolves.toEqual({
      items: [{ notionPageId: 'notes', status: 'success', localPageId: 11 }],
    });
    expect(calls.map((c) => `${c.method} ${c.url.replace(/^.*\/api/, '')}`)).toEqual([
      'POST /notion/import',
      'GET /notion/import/status',
    ]);
  });

  it('surfaces a failed background import as an ApiError', async () => {
    statusBodies = [{ status: 'error', error: 'Notion resource not found' }];
    const { result } = renderHook(() => useRunNotionImport(), { wrapper });
    await expect(result.current.mutateAsync({ pageIds: ['notes'], visibility: 'private' })).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});

