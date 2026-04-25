/**
 * Tests for SyncConflictResolveDialog (Compendiq/compendiq-ee#118 Phase D).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domMax } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SyncConflictResolveDialog } from './SyncConflictResolveDialog';
import type { SyncConflict } from './SyncConflictsPage';
import { useAuthStore } from '../../stores/auth-store';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
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

const sampleConflict: SyncConflict = {
  id: 42,
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
  resolveBehaviour?: 'ok' | 'error';
}

function mockFetch(opts: MockOptions = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = (init?.method ?? (input as Request)?.method ?? 'GET').toUpperCase();

    if (url.match(/\/admin\/sync-conflicts\/\d+\/resolve$/) && method === 'POST') {
      if (opts.resolveBehaviour === 'error') {
        return new Response(JSON.stringify({ message: 'boom' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(null, { status: 204 });
    }

    return new Response('Not found', { status: 404 });
  });
}

describe('SyncConflictResolveDialog', () => {
  beforeEach(() => {
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'admin',
      email: 'admin@test',
      role: 'admin',
      displayName: null,
      isActive: true,
    });
    toastSuccess.mockClear();
    toastError.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the dialog with the page title and the diff', () => {
    mockFetch();
    const Wrapper = createWrapper();
    render(
      <SyncConflictResolveDialog
        conflict={sampleConflict}
        onClose={vi.fn()}
        onResolved={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByTestId('sync-conflict-resolve-dialog')).toBeInTheDocument();
    expect(screen.getByText(/Onboarding runbook/)).toBeInTheDocument();
  });

  it('POSTs { resolution: "local" } when "Keep local" is clicked', async () => {
    const fetchSpy = mockFetch();
    const onResolved = vi.fn();
    const Wrapper = createWrapper();
    render(
      <SyncConflictResolveDialog
        conflict={sampleConflict}
        onClose={vi.fn()}
        onResolved={onResolved}
      />,
      { wrapper: Wrapper },
    );

    fireEvent.click(screen.getByTestId('sync-conflict-resolve-keep-local-btn'));

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith('Kept local edits');
    });
    expect(onResolved).toHaveBeenCalled();

    const postCall = fetchSpy.mock.calls.find(
      ([_url, opts]) => (opts?.method ?? 'GET').toUpperCase() === 'POST',
    );
    expect(postCall).toBeDefined();
    const url = typeof postCall![0] === 'string' ? postCall![0] : (postCall![0] as Request).url;
    expect(url).toContain('/admin/sync-conflicts/42/resolve');
    expect(JSON.parse(postCall![1]!.body as string)).toEqual({ resolution: 'local' });
  });

  it('POSTs { resolution: "remote" } when "Take Confluence" is clicked', async () => {
    const fetchSpy = mockFetch();
    const onResolved = vi.fn();
    const Wrapper = createWrapper();
    render(
      <SyncConflictResolveDialog
        conflict={sampleConflict}
        onClose={vi.fn()}
        onResolved={onResolved}
      />,
      { wrapper: Wrapper },
    );

    fireEvent.click(screen.getByTestId('sync-conflict-resolve-take-remote-btn'));

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith('Took Confluence version');
    });
    expect(onResolved).toHaveBeenCalled();

    const postCall = fetchSpy.mock.calls.find(
      ([_url, opts]) => (opts?.method ?? 'GET').toUpperCase() === 'POST',
    );
    expect(JSON.parse(postCall![1]!.body as string)).toEqual({ resolution: 'remote' });
  });

  it('Cancel calls onClose without firing a request', () => {
    const fetchSpy = mockFetch();
    const onClose = vi.fn();
    const onResolved = vi.fn();
    const Wrapper = createWrapper();
    render(
      <SyncConflictResolveDialog
        conflict={sampleConflict}
        onClose={onClose}
        onResolved={onResolved}
      />,
      { wrapper: Wrapper },
    );

    fireEvent.click(screen.getByTestId('sync-conflict-resolve-cancel-btn'));
    expect(onClose).toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls.filter(
      ([_url, opts]) => (opts?.method ?? 'GET').toUpperCase() === 'POST',
    )).toHaveLength(0);
  });

  it('toast.error fires when resolve POST fails', async () => {
    mockFetch({ resolveBehaviour: 'error' });
    const Wrapper = createWrapper();
    render(
      <SyncConflictResolveDialog
        conflict={sampleConflict}
        onClose={vi.fn()}
        onResolved={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    fireEvent.click(screen.getByTestId('sync-conflict-resolve-keep-local-btn'));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalled();
    });
  });
});
