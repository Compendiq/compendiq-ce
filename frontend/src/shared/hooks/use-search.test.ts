import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useSearch } from './use-search';
import { useAuthStore } from '../../stores/auth-store';

// ── Auth setup ──────────────────────────────────────────────────────────────

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

// ── Helpers ─────────────────────────────────────────────────────────────────

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

const makeSearchResponse = (overrides: Partial<{
  items: unknown[];
  total: number;
  mode: string;
  hasEmbeddings: boolean;
  warning: string;
}> = {}) => ({
  items: [
    {
      id: 1,
      title: 'Test Result',
      spaceKey: 'DEV',
      snippet: 'A snippet of content',
      rank: 0.8,
    },
  ],
  total: 1,
  page: 1,
  limit: 10,
  totalPages: 1,
  facets: { spaces: [], authors: [], tags: [] },
  mode: 'keyword',
  hasEmbeddings: true,
  ...overrides,
});

function mockFetch(keywordResponse: object, semanticResponse?: object) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;

    if (url.includes('mode=keyword') || (url.includes('/search') && !url.includes('mode='))) {
      return new Response(JSON.stringify(keywordResponse), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if ((url.includes('mode=semantic') || url.includes('mode=hybrid')) && semanticResponse) {
      return new Response(JSON.stringify(semanticResponse), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(makeSearchResponse()), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useSearch', () => {
  it('does not fire any query when q is empty string', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(makeSearchResponse()), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    renderHook(() => useSearch({ query: '', mode: 'keyword' }), {
      wrapper: createWrapper(),
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not fire any query when q is only whitespace', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(makeSearchResponse()), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    renderHook(() => useSearch({ query: '  ', mode: 'keyword' }), {
      wrapper: createWrapper(),
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fires only the immediate (keyword) query when mode=keyword', async () => {
    const fetchSpy = mockFetch(makeSearchResponse({ mode: 'keyword' }));

    const { result } = renderHook(
      () => useSearch({ query: 'redis', mode: 'keyword' }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isLoadingImmediate).toBe(false));

    // Only one request — keyword mode doesn't fire enhanced query
    const calls = fetchSpy.mock.calls.filter(([url]) =>
      typeof url === 'string' && (url as string).includes('/search'),
    );
    expect(calls).toHaveLength(1);
    const url = calls[0][0] as string;
    expect(url).toContain('mode=keyword');
  });

  it('fires both immediate and enhanced queries when mode=hybrid', async () => {
    const fetchSpy = mockFetch(
      makeSearchResponse({ mode: 'keyword' }),
      makeSearchResponse({ mode: 'hybrid', hasEmbeddings: true }),
    );

    const { result } = renderHook(
      () => useSearch({ query: 'kubernetes', mode: 'hybrid' }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isLoadingImmediate).toBe(false));
    await waitFor(() => expect(result.current.isLoadingEnhanced).toBe(false));

    const searchCalls = fetchSpy.mock.calls.filter(([url]) =>
      typeof url === 'string' && (url as string).includes('/search'),
    );
    // Two requests: keyword (immediate) + hybrid (enhanced)
    expect(searchCalls.length).toBeGreaterThanOrEqual(2);
    const urls = searchCalls.map(([url]) => url as string);
    expect(urls.some((u) => u.includes('mode=keyword'))).toBe(true);
    expect(urls.some((u) => u.includes('mode=hybrid'))).toBe(true);
  });

  it('fires both immediate and enhanced queries when mode=semantic', async () => {
    const fetchSpy = mockFetch(
      makeSearchResponse({ mode: 'keyword' }),
      makeSearchResponse({ mode: 'semantic', hasEmbeddings: true }),
    );

    const { result } = renderHook(
      () => useSearch({ query: 'docker', mode: 'semantic' }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isLoadingImmediate).toBe(false));
    await waitFor(() => expect(result.current.isLoadingEnhanced).toBe(false));

    const searchCalls = fetchSpy.mock.calls.filter(([url]) =>
      typeof url === 'string' && (url as string).includes('/search'),
    );
    const urls = searchCalls.map(([url]) => url as string);
    expect(urls.some((u) => u.includes('mode=keyword'))).toBe(true);
    expect(urls.some((u) => u.includes('mode=semantic'))).toBe(true);
  });

  it('returns immediateResults from keyword endpoint response', async () => {
    mockFetch(makeSearchResponse({
      items: [{ id: 42, title: 'Redis Guide', spaceKey: 'DEV', snippet: 'Caching tips', rank: 0.9 }],
      mode: 'keyword',
      hasEmbeddings: true,
    }));

    const { result } = renderHook(
      () => useSearch({ query: 'redis', mode: 'keyword' }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isLoadingImmediate).toBe(false));

    expect(result.current.immediateResults).toBeDefined();
    expect(result.current.immediateResults).toHaveLength(1);
    expect(result.current.immediateResults[0].title).toBe('Redis Guide');
  });

  it('returns enhancedResults from hybrid endpoint response', async () => {
    mockFetch(
      makeSearchResponse({ items: [{ id: 1, title: 'Keyword Result', spaceKey: 'DEV', snippet: '', rank: 0.5 }], mode: 'keyword' }),
      makeSearchResponse({ items: [{ id: 2, title: 'Vector Result', spaceKey: 'DEV', snippet: '', rank: 0.95 }], mode: 'hybrid', hasEmbeddings: true }),
    );

    const { result } = renderHook(
      () => useSearch({ query: 'kubernetes', mode: 'hybrid' }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isLoadingEnhanced).toBe(false));

    expect(result.current.enhancedResults).toBeDefined();
    expect(result.current.enhancedResults).toHaveLength(1);
    expect(result.current.enhancedResults![0].title).toBe('Vector Result');
  });

  it('returns hasEmbeddings:false when response.hasEmbeddings is false', async () => {
    mockFetch(makeSearchResponse({ hasEmbeddings: false }));

    const { result } = renderHook(
      () => useSearch({ query: 'test', mode: 'keyword' }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isLoadingImmediate).toBe(false));

    expect(result.current.hasEmbeddings).toBe(false);
  });

  it('hasEmbeddings defaults to true before first response arrives', () => {
    // Do NOT let fetch resolve — check the pre-response state
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise(() => {})); // never resolves

    const { result } = renderHook(
      () => useSearch({ query: 'test', mode: 'keyword' }),
      { wrapper: createWrapper() },
    );

    // Before any response, hasEmbeddings should be true (optimistic default)
    expect(result.current.hasEmbeddings).toBe(true);
    expect(result.current.isLoadingImmediate).toBe(true);
  });

  it('enhanced query is disabled when mode=keyword', async () => {
    const fetchSpy = mockFetch(makeSearchResponse({ mode: 'keyword' }));

    const { result } = renderHook(
      () => useSearch({ query: 'redis', mode: 'keyword' }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isLoadingImmediate).toBe(false));

    // isLoadingEnhanced should be false and enhancedResults undefined
    expect(result.current.isLoadingEnhanced).toBe(false);
    expect(result.current.enhancedResults).toBeUndefined();

    // No semantic/hybrid calls
    const enhancedCalls = fetchSpy.mock.calls.filter(([url]) =>
      typeof url === 'string' &&
      ((url as string).includes('mode=semantic') || (url as string).includes('mode=hybrid')),
    );
    expect(enhancedCalls).toHaveLength(0);
  });

  it('passes spaceKey to both query URLs', async () => {
    const fetchSpy = mockFetch(makeSearchResponse(), makeSearchResponse({ mode: 'hybrid' }));

    const { result } = renderHook(
      () => useSearch({ query: 'docker', mode: 'hybrid', spaceKey: 'INFRA' }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isLoadingImmediate).toBe(false));

    const searchCalls = fetchSpy.mock.calls.filter(([url]) =>
      typeof url === 'string' && (url as string).includes('/search'),
    );
    const allHaveSpaceKey = searchCalls.every(([url]) =>
      (url as string).includes('spaceKey=INFRA'),
    );
    expect(allHaveSpaceKey).toBe(true);
  });
});
