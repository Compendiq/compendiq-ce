import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useInlineCompletionAvailability } from './use-inline-completion-availability';

const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {children}
    </QueryClientProvider>
  );
}

describe('useInlineCompletionAvailability (#1417)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('reports true for an assigned use case', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ usecase: 'inline_completion' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const { result } = renderHook(() => useInlineCompletionAvailability(), { wrapper });
    await waitFor(() => expect(result.current.data).toBe(true));
  });

  it.each([403, 404])('treats HTTP %s as dormant, not an error', async (status) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: 'not available' }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }));
    const { result } = renderHook(() => useInlineCompletionAvailability(), { wrapper });
    await waitFor(() => expect(result.current.data).toBe(false));
    expect(result.current.isError).toBe(false);
  });
});
