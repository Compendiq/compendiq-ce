import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SyncTab } from './SyncTab';
import { useAuthStore } from '../../../stores/auth-store';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

function createWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe('SyncTab', () => {
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

  it('renders an error card with retry when the sync-overview query fails (not an infinite skeleton)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.endsWith('/settings/sync-overview')) {
        return new Response(JSON.stringify({ message: 'boom' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Quality/summary status probes — irrelevant to the gate under test.
      return new Response(JSON.stringify({}), {
        headers: { 'Content-Type': 'application/json' },
      });
    });

    render(<SyncTab />, { wrapper: createWrapper() });

    await screen.findByTestId('sync-tab-error');
    expect(screen.getByTestId('sync-tab-retry')).toBeInTheDocument();
  });

  // #1349 (review r1): the Attachment Storage section is admin-only — its
  // routes are requireAdmin, so rendering it for a non-admin would only
  // paint two failing fetches beside a delete button that cannot work.
  describe('Attachment Storage section (#1349)', () => {
    const zeroAssets = { expected: 0, cached: 0, missing: 0 };
    const overview = {
      sync: { userId: '1', status: 'idle' },
      totals: {
        selectedSpaces: 0,
        totalPages: 0,
        pagesWithAssets: 0,
        pagesWithIssues: 0,
        healthyPages: 0,
        images: zeroAssets,
        drawio: zeroAssets,
      },
      spaces: [],
      issues: [],
    };

    beforeEach(() => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : (input as URL).toString();
        const body = url.endsWith('/settings/sync-overview') ? overview : {};
        return new Response(JSON.stringify(body), {
          headers: { 'Content-Type': 'application/json' },
        });
      });
    });

    it('renders for an admin', async () => {
      render(<SyncTab />, { wrapper: createWrapper() });
      expect(await screen.findByTestId('attachment-storage-section')).toBeInTheDocument();
    });

    it('is absent for a non-admin', async () => {
      useAuthStore.getState().setAuth('test-token', {
        id: '2',
        username: 'viewer',
        role: 'user',
      });
      render(<SyncTab />, { wrapper: createWrapper() });
      // Settle on a section that renders for every role before asserting an absence.
      await screen.findByTestId('quality-worker-section');
      expect(screen.queryByTestId('attachment-storage-section')).not.toBeInTheDocument();
    });
  });
});
