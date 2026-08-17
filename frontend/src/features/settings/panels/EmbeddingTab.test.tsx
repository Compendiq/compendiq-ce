import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmbeddingTab } from './EmbeddingTab';
import { IMAGE_EMBEDDING_INDEX_POINTER } from './ImageEmbeddingCapability';
import { useAuthStore } from '../../../stores/auth-store';

/**
 * #1115 P2 (review r1) — the destination of the LLM-providers row's pointer.
 *
 * That pointer's COPY is pinned (`LlmTab.test.tsx`) and the card's own
 * behaviour is pinned (`ImageIndexCard.test.tsx`), but nothing asserted the
 * card is actually mounted here: deleting the import and the JSX was
 * lint-clean, typecheck-clean and suite-green, leaving a signpost to a
 * demolished street — the exact failure `settings-wayfinding.test.ts` exists
 * to prevent, one layer below where it can see.
 */

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <EmbeddingTab />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAuthStore.getState().setAuth('t', { id: '1', username: 'admin', role: 'admin' });
  // Mocked at the network boundary; every panel on this tab reads its own
  // endpoint and none of them is the subject here.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/admin/embedding/image-index')) {
      return new Response(
        JSON.stringify({
          assigned: false,
          identity: null,
          identityMatchesAssignment: null,
          rows: 0,
          pagesDirty: 0,
          pagesTotal: 0,
          running: false,
          lastRun: null,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.getState().clearAuth();
});

describe('EmbeddingTab (#1115 P2)', () => {
  it('mounts the image index card the LLM-providers row points at', async () => {
    // The pointer names this tab by name, so the assertion reads it from the
    // same constant the row renders rather than restating the sentence.
    expect(IMAGE_EMBEDDING_INDEX_POINTER).toMatch(/Embeddings tab/);

    renderTab();

    expect(await screen.findByTestId('image-index-card')).toBeTruthy();
  });
});
