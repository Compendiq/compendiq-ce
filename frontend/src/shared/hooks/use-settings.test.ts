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

// `sonner` is the toast boundary, not an internal component — the whole point
// of the `silent` option below is which of these two functions runs.
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
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
  // `restoreMocks` only restores spies; these are bare `vi.fn()`s.
  toastSuccess.mockReset();
  toastError.mockReset();
});

describe('useUpdateSettings', () => {
  it('PUTs the body and invalidates the settings query', async () => {
    apiFetchMock.mockResolvedValue({});
    const { queryClient, wrapper } = createQueryClientAndWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useUpdateSettings(), { wrapper });
    result.current.mutate({ theme: 'paper' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith('/settings', {
      method: 'PUT',
      body: JSON.stringify({ theme: 'paper' }),
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
    result.current.mutate({ theme: 'graphite' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryState(['pages', 'page-1', 'versions'])?.isInvalidated).toBe(false);
  });
});

/**
 * #1402: a Settings panel's Save is an explicit act the user is watching for,
 * so it keeps its confirmation. A background onboarding flag flip is not — it
 * happens seconds after the user asked an AI question or saved a page, and a
 * "Settings saved" toast there describes an act nobody performed.
 *
 * The option lives on the HOOK rather than on `mutate`'s variables so the
 * flag can never reach the wire body: `mutationFn` stringifies its argument
 * straight into `PUT /settings`, and `UpdateSettingsSchema` is `.strict()`
 * on the fields it does accept.
 */
describe('useUpdateSettings toast policy', () => {
  it('toasts "Settings saved" on an ordinary (non-onboarding) save', async () => {
    apiFetchMock.mockResolvedValue({});
    const { wrapper } = createQueryClientAndWrapper();

    const { result } = renderHook(() => useUpdateSettings(), { wrapper });
    result.current.mutate({ theme: 'paper' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(toastSuccess).toHaveBeenCalledWith('Settings saved');
  });

  it('skips the success toast when the hook is created silent', async () => {
    apiFetchMock.mockResolvedValue({});
    const { wrapper } = createQueryClientAndWrapper();

    const { result } = renderHook(() => useUpdateSettings({ silent: true }), { wrapper });
    result.current.mutate({ onboardingState: { dismissed: true } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(toastSuccess).not.toHaveBeenCalled();
    // The write itself is unchanged — silence is about the confirmation only.
    expect(apiFetchMock).toHaveBeenCalledWith('/settings', {
      method: 'PUT',
      body: JSON.stringify({ onboardingState: { dismissed: true } }),
    });
  });

  it('still reports a failure for a silent save the user pressed a button for', async () => {
    apiFetchMock.mockRejectedValue(new Error('Network down'));
    const { wrapper } = createQueryClientAndWrapper();

    const { result } = renderHook(() => useUpdateSettings({ silent: true }), { wrapper });
    result.current.mutate({ onboardingState: { dismissed: true } });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toastError).toHaveBeenCalledWith('Network down');
  });

  it('suppresses the failure toast too when the write is a background auto-mark', async () => {
    apiFetchMock.mockRejectedValue(new Error('Network down'));
    const { wrapper } = createQueryClientAndWrapper();

    const { result } = renderHook(
      () => useUpdateSettings({ silent: true, silentErrors: true }),
      { wrapper },
    );
    result.current.mutate({ onboardingState: { firstAiQueryMade: true } });

    await waitFor(() => expect(result.current.isError).toBe(true));
    // Nobody asked for this write; a red toast beside the answer they DID ask
    // for reads as "your question failed", which is the opposite of the truth.
    expect(toastError).not.toHaveBeenCalled();
  });
});
