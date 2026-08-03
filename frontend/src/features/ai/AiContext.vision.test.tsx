import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

const mockApiFetch = vi.fn();
vi.mock('../../shared/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../shared/lib/api')>(),
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

import { AiProvider, useAiContext } from './AiContext';

// AiProvider reads useSearchParams/useLocation (it mounts above the router
// outlet in AppLayout, so it always has a Router ancestor there) — a bare
// QueryClientProvider isn't enough context for it to render.
function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AiProvider>{children}</AiProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  mockApiFetch.mockReset().mockImplementation(async (path: string) => {
    if (path === '/llm/usecase-default?usecase=chat') {
      return { usecase: 'chat', providerId: 'p1', providerName: 'X', model: 'qwen2.5vl', vision: true };
    }
    if (path.startsWith('/ollama/models')) return [{ name: 'qwen2.5vl' }];
    return {};
  });
});

describe('AiContext chatVision (#1154)', () => {
  it('exposes the vision verdict from usecase-default', async () => {
    const { result } = renderHook(() => useAiContext(), { wrapper });
    await waitFor(() => expect(result.current.chatVision).toBe(true));
  });

  it.each([[false], [null]] as const)('passes through a %s verdict unchanged', async (vision) => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/llm/usecase-default?usecase=chat') {
        return { usecase: 'chat', providerId: 'p1', providerName: 'X', model: 'llama3.1', vision };
      }
      if (path.startsWith('/ollama/models')) return [{ name: 'llama3.1' }];
      return {};
    });
    const { result } = renderHook(() => useAiContext(), { wrapper });
    await waitFor(() => expect(result.current.model).toBe('llama3.1'));
    expect(result.current.chatVision).toBe(vision);
  });

  /** No default configured (the 404 path) must not read as "no vision". */
  it('is null when no chat default resolves', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/llm/usecase-default?usecase=chat') throw new Error('404');
      if (path.startsWith('/ollama/models')) return [{ name: 'llama3.1' }];
      return {};
    });
    const { result } = renderHook(() => useAiContext(), { wrapper });
    await waitFor(() => expect(result.current.chatVision).toBeNull());
  });
});
