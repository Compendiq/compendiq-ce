import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmbeddingTab } from './EmbeddingTab';
import { useAuthStore } from '../../../stores/auth-store';

/**
 * #1115 P2 (review r1), re-pointed by #1618 — the image card is really
 * MOUNTED on this tab.
 *
 * The card's own behaviour is pinned by `ImageAnalysisProgressCard.test.tsx`,
 * but nothing there asserts it is reachable: deleting the import and the JSX
 * from this tab was lint-clean, typecheck-clean and suite-green, leaving the
 * settings navigation pointing at a demolished street — the exact failure
 * `settings-wayfinding.test.ts` exists to prevent, one layer below where it
 * can see. That is why this file outlived the legacy card it was written for:
 * #1618 retired ADR-025's `ImageIndexCard` and the analysis card took its
 * slot (ADR-027 "Retirement plan"), so the mount is the same property about a
 * different component.
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
    if (url.includes('/admin/embedding/image-analysis')) {
      return new Response(
        JSON.stringify({
          assigned: false,
          retainedIdentity: null,
          identityMatchesAssignment: null,
          rows: {
            analyzed: 0,
            reused: 0,
            pending: 0,
            stale: 0,
            failed: 0,
            givenUp: 0,
            skipped: 0,
          },
          skipReasons: {},
          dirtyPages: 0,
          pagesAwaitingEmbed: 0,
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

describe('EmbeddingTab', () => {
  it('mounts the image-analysis card the settings navigation points at', async () => {
    renderTab();

    expect(await screen.findByTestId('image-analysis-card')).toBeTruthy();
  });

  it('no longer mounts the retired legacy image-index card (#1618)', async () => {
    renderTab();
    await screen.findByTestId('image-analysis-card');

    expect(screen.queryByTestId('image-index-card')).toBeNull();
  });
});
