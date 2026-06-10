import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { useUpdateSettings } from './use-settings';

// Mock at the network boundary only.
const apiFetchMock = vi.fn();
vi.mock('../lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

function createQueryClientAndWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, wrapper };
}

afterEach(() => {
  vi.restoreAllMocks();
  apiFetchMock.mockReset();
});

describe('useUpdateSettings', () => {
  it('PUTs the body and invalidates the settings query', async () => {
    apiFetchMock.mockResolvedValue({});
    const { queryClient, wrapper } = createQueryClientAndWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useUpdateSettings(), { wrapper });
    result.current.mutate({ theme: 'honey-linen' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith('/settings', {
      method: 'PUT',
      body: JSON.stringify({ theme: 'honey-linen' }),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['settings'] });
  });

  it('invalidates cached page-versions queries when Confluence credentials are saved (#763 stale skipped_no_credentials hint)', async () => {
    apiFetchMock.mockResolvedValue({});
    const { queryClient, wrapper } = createQueryClientAndWrapper();
    // Seed a cached versions list carrying the stale "no credentials" hint,
    // a cached version detail, and an unrelated page query.
    queryClient.setQueryData(['pages', 'page-1', 'versions'], {
      versions: [],
      pageId: 'page-1',
      backfillStatus: 'skipped_no_credentials',
    });
    queryClient.setQueryData(['pages', 'page-1', 'versions', 2], { versionNumber: 2 });
    queryClient.setQueryData(['pages', 'page-1'], { id: 1, title: 'Article' });

    const { result } = renderHook(() => useUpdateSettings(), { wrapper });
    result.current.mutate({ confluenceUrl: 'https://confluence.example.com', confluencePat: 'pat-123' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // Version list + detail are stale now; the article query is untouched.
    expect(queryClient.getQueryState(['pages', 'page-1', 'versions'])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(['pages', 'page-1', 'versions', 2])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(['pages', 'page-1'])?.isInvalidated).toBe(false);
  });

  it('does not touch page-versions queries on unrelated settings saves', async () => {
    apiFetchMock.mockResolvedValue({});
    const { queryClient, wrapper } = createQueryClientAndWrapper();
    queryClient.setQueryData(['pages', 'page-1', 'versions'], {
      versions: [],
      pageId: 'page-1',
      backfillStatus: 'ok',
    });

    const { result } = renderHook(() => useUpdateSettings(), { wrapper });
    result.current.mutate({ theme: 'graphite-honey' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryState(['pages', 'page-1', 'versions'])?.isInvalidated).toBe(false);
  });
});
