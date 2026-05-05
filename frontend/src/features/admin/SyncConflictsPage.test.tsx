/**
 * Tests for SyncConflictsPage (Compendiq/compendiq-ee#118 Phase D).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domMax } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SyncConflictsPage } from './SyncConflictsPage';
import { useAuthStore } from '../../stores/auth-store';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const mockUseEnterprise = vi.fn();
vi.mock('../../shared/enterprise/use-enterprise', () => ({
  useEnterprise: () => mockUseEnterprise(),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <LazyMotion features={domMax}>{children}</LazyMotion>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

const sampleConflict = {
  id: 7,
  pageId: 100,
  pageTitle: 'Onboarding runbook',
  spaceKey: 'DOCS',
  spaceName: 'Documentation',
  detectedAt: '2026-04-23T12:00:00Z',
  pendingConfluenceVersion: 12,
  localBodyHtml: '<p>local edit</p>',
  localBodyText: 'local edit',
  pendingBodyHtml: '<p>remote update</p>',
  pendingBodyText: 'remote update',
};

interface MockOptions {
  conflicts?: typeof sampleConflict[];
  getStatus?: 404 | 500;
}

function mockFetch(opts: MockOptions = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = (init?.method ?? (input as Request)?.method ?? 'GET').toUpperCase();

    if (url.endsWith('/admin/sync-conflicts') && method === 'GET') {
      if (opts.getStatus === 404) {
        return new Response(JSON.stringify({ error: 'not_found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (opts.getStatus === 500) {
        return new Response(JSON.stringify({ message: 'boom' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ conflicts: opts.conflicts ?? [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.match(/\/admin\/sync-conflicts\/\d+\/resolve$/) && method === 'POST') {
      return new Response(null, { status: 204 });
    }

    return new Response('Not found', { status: 404 });
  });
}

describe('SyncConflictsPage', () => {
  beforeEach(() => {
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'admin',
      email: 'admin@test',
      role: 'admin',
      displayName: null,
      isActive: true,
    });
    mockUseEnterprise.mockReturnValue({
      isEnterprise: true,
      hasFeature: (f: string) => f === 'sync_conflict_resolution',
      license: null,
      refresh: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders an upgrade prompt when the licence does not grant the feature', () => {
    mockUseEnterprise.mockReturnValue({
      isEnterprise: false,
      hasFeature: () => false,
      license: null,
      refresh: vi.fn(),
    });
    const Wrapper = createWrapper();
    render(<SyncConflictsPage />, { wrapper: Wrapper });
    expect(screen.getByTestId('sync-conflicts-not-licensed')).toBeInTheDocument();
  });

  it('renders the empty state when no conflicts are pending', async () => {
    mockFetch({ conflicts: [] });
    const Wrapper = createWrapper();
    render(<SyncConflictsPage />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByTestId('sync-conflicts-empty')).toBeInTheDocument();
    });
  });

  it('renders one row per pending conflict', async () => {
    mockFetch({
      conflicts: [
        sampleConflict,
        { ...sampleConflict, id: 8, pageId: 101, pageTitle: 'Other page', spaceKey: 'OPS' },
      ],
    });
    const Wrapper = createWrapper();
    render(<SyncConflictsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('sync-conflict-row-7')).toBeInTheDocument();
    });
    expect(screen.getByTestId('sync-conflict-row-8')).toBeInTheDocument();
    expect(screen.getByTestId('sync-conflict-title-7')).toHaveTextContent('Onboarding runbook');
    expect(screen.getByTestId('sync-conflict-title-8')).toHaveTextContent('Other page');
  });

  it('opens the resolve dialog when the Review button is clicked', async () => {
    mockFetch({ conflicts: [sampleConflict] });
    const Wrapper = createWrapper();
    render(<SyncConflictsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('sync-conflict-row-7')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('sync-conflict-review-btn-7'));

    await waitFor(() => {
      expect(screen.getByTestId('sync-conflict-resolve-dialog')).toBeInTheDocument();
    });
  });

  it('shows an inline notice when the EE overlay is not deployed (404 GET)', async () => {
    mockFetch({ getStatus: 404 });
    const Wrapper = createWrapper();
    render(<SyncConflictsPage />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByTestId('sync-conflicts-overlay-missing')).toBeInTheDocument();
    });
  });

  it('shows a generic error banner on a 500', async () => {
    mockFetch({ getStatus: 500 });
    const Wrapper = createWrapper();
    render(<SyncConflictsPage />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByTestId('sync-conflicts-error')).toBeInTheDocument();
    });
  });
});
