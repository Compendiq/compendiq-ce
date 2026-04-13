import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { useSetupStatus } from './useSetupStatus';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

describe('useSetupStatus', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns loading state initially', () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({
        setupComplete: true,
        steps: { admin: true, llm: true, confluence: false },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const { result } = renderHook(() => useSetupStatus(), { wrapper: createWrapper() });
    expect(result.current.isLoading).toBe(true);
  });

  it('returns setup status when fetch succeeds', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({
        setupComplete: true,
        steps: { admin: true, llm: true, confluence: false },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const { result } = renderHook(() => useSetupStatus(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.setupComplete).toBe(true);
    expect(result.current.steps.admin).toBe(true);
    expect(result.current.steps.llm).toBe(true);
    expect(result.current.steps.confluence).toBe(false);
  });

  it('returns setupComplete=false when not set up', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({
        setupComplete: false,
        steps: { admin: false, llm: false, confluence: false },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const { result } = renderHook(() => useSetupStatus(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.setupComplete).toBe(false);
    expect(result.current.steps.admin).toBe(false);
  });

  it('defaults to false values when fetch fails', async () => {
    fetchSpy.mockResolvedValue(new Response('Internal Server Error', { status: 500 }));

    const { result } = renderHook(() => useSetupStatus(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    }, { timeout: 5000 });

    expect(result.current.setupComplete).toBe(false);
    expect(result.current.steps).toEqual({ admin: false, llm: false, confluence: false });
  });

  it('calls the correct endpoint', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({
        setupComplete: true,
        steps: { admin: true, llm: true, confluence: false },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    renderHook(() => useSetupStatus(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('/api/health/setup-status');
    });
  });
});
