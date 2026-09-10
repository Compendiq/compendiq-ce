import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ConversationSummary } from '@compendiq/contracts';
import { useRenameConversation, useDeleteConversation } from './use-conversation-mutations';

const { purgeConversation, toastSuccess, toastError } = vi.hoisted(() => ({
  purgeConversation: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

/**
 * `purgeConversation` is the delete mutation's one non-network dependency and
 * is the AI context's public seam (Task 4), so the context module is the
 * boundary this test stubs — not an internal component. Mounting the real
 * `AiProvider` would drag the models, embedding-status and page-context queries
 * into a mutation test and prove nothing about either mutation.
 */
vi.mock('../AiContext', () => ({
  useAiContext: () => ({ purgeConversation }),
}));

function summary(id: string, title: string): ConversationSummary {
  return {
    id,
    title,
    titleSource: 'user',
    model: 'test-model',
    pageId: null,
    pageTitle: null,
    createdAt: '2026-08-18T09:00:00.000Z',
    updatedAt: '2026-08-18T09:00:00.000Z',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderMutations() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  const { result } = renderHook(
    () => ({ rename: useRenameConversation(), remove: useDeleteConversation() }),
    { wrapper: Wrapper },
  );
  return { result, invalidate };
}

beforeEach(() => {
  // `mockReset`, not `mockClear`: the ordering test below installs an
  // implementation on `purgeConversation`, and a leftover one would push into a
  // dead array on every later test in the file.
  purgeConversation.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useRenameConversation', () => {
  it('PATCHes the title and invalidates the conversations prefix', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(summary('c1', 'Renamed')));

    const { result, invalidate } = renderMutations();
    await act(async () => {
      await result.current.rename.mutateAsync({ id: 'c1', title: 'Renamed' });
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/llm/conversations/c1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ title: 'Renamed' }) }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['llm', 'conversations'] });
    // The mutation observer's own re-render (which is what `result.current`
    // reads) lands one tick after `mutateAsync` resolves in this React 19 +
    // Testing Library combination — `waitFor` is this codebase's own idiom for
    // it (`use-standalone.test.ts`), not a workaround invented here.
    await waitFor(() => expect(result.current.rename.data?.title).toBe('Renamed'));
  });

  it('stays silent on failure so the row can keep the field open and toast once', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ message: 'Title already used' }, 409));

    const { result, invalidate } = renderMutations();
    await act(async () => {
      await result.current.rename.mutateAsync({ id: 'c1', title: 'x' }).catch(() => undefined);
    });

    await waitFor(() => expect(result.current.rename.isError).toBe(true));
    expect(result.current.rename.error?.message).toBe('Title already used');
    expect(toastError).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('useDeleteConversation', () => {
  it('DELETEs, purges the retained thread, invalidates and confirms', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ message: 'Conversation deleted' }));

    const { result, invalidate } = renderMutations();
    await act(async () => {
      await result.current.remove.mutateAsync({ id: 'c1', title: 'Alpha' });
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/llm/conversations/c1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(purgeConversation).toHaveBeenCalledWith('c1');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['llm', 'conversations'] });
    expect(toastSuccess).toHaveBeenCalledWith('Conversation deleted');
  });

  it('purges before it invalidates, so the refetch lands on a URL that still exists', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ message: 'Conversation deleted' }));

    const order: string[] = [];
    purgeConversation.mockImplementation(() => order.push('purge'));
    const { result, invalidate } = renderMutations();
    invalidate.mockImplementation(() => {
      order.push('invalidate');
      return Promise.resolve();
    });

    await act(async () => {
      await result.current.remove.mutateAsync({ id: 'c1', title: 'Alpha' });
    });

    expect(order).toEqual(['purge', 'invalidate']);
  });

  it('reports a failed delete and purges nothing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ message: 'Conversation not found' }, 404));

    const { result, invalidate } = renderMutations();
    await act(async () => {
      await result.current.remove.mutateAsync({ id: 'c1', title: 'Alpha' }).catch(() => undefined);
    });

    expect(toastError).toHaveBeenCalledWith('Conversation not found');
    expect(purgeConversation).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('falls back to a plain sentence when the failure carries no message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));

    const { result } = renderMutations();
    await act(async () => {
      await result.current.remove.mutateAsync({ id: 'c1', title: 'Alpha' }).catch(() => undefined);
    });

    // `failureMessage` composes "<statusText> (HTTP 503)" or "Request failed
    // (HTTP 503)"; either way it is non-empty, so the fallback string is the
    // belt for a message that is empty rather than absent.
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(String(toastError.mock.calls[0]?.[0])).toContain('503');
  });
});
