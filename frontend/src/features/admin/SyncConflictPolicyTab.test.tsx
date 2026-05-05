/**
 * Tests for SyncConflictPolicyTab (Compendiq/compendiq-ee#118 Phase D).
 *
 * Covers the contract surface:
 *   - feature-gate (no licence → empty state)
 *   - cold load + radio hydration
 *   - PUT on save
 *   - 404 fallback when the EE overlay isn't deployed (CE-only)
 *   - Save button disabled when pristine / pending / 404
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domMax } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SyncConflictPolicyTab } from './SyncConflictPolicyTab';
import { useAuthStore } from '../../stores/auth-store';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
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

interface MockOptions {
  policy?: 'confluence-wins' | 'compendiq-wins' | 'manual-review';
  /** When true, GET returns 404 (mimics the CE-only deployment). */
  getStatus?: 404;
  /** PUT response — 204 OK by default; 500 on 'error'. */
  putBehaviour?: 'ok' | 'error';
}

function mockFetch(opts: MockOptions = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = (init?.method ?? (input as Request)?.method ?? 'GET').toUpperCase();

    if (url.endsWith('/admin/sync-conflict-policy') && method === 'GET') {
      if (opts.getStatus === 404) {
        return new Response(JSON.stringify({ error: 'not_found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ policy: opts.policy ?? 'confluence-wins' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.endsWith('/admin/sync-conflict-policy') && method === 'PUT') {
      if (opts.putBehaviour === 'error') {
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

describe('SyncConflictPolicyTab', () => {
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
    render(<SyncConflictPolicyTab />, { wrapper: Wrapper });
    expect(screen.getByTestId('sync-conflict-policy-not-licensed')).toBeInTheDocument();
  });

  it('cold-loads the policy and selects the matching radio', async () => {
    mockFetch({ policy: 'manual-review' });
    const Wrapper = createWrapper();
    render(<SyncConflictPolicyTab />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('sync-conflict-policy-tab')).toBeInTheDocument();
    });

    const radio = await screen.findByTestId('sync-conflict-policy-radio-manual-review') as HTMLInputElement;
    expect(radio.checked).toBe(true);
  });

  it('save button is disabled when the form is pristine', async () => {
    mockFetch({ policy: 'confluence-wins' });
    const Wrapper = createWrapper();
    render(<SyncConflictPolicyTab />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByTestId('sync-conflict-policy-tab')).toBeInTheDocument();
    });
    const btn = screen.getByTestId('sync-conflict-policy-save-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('save button enables after the admin picks a different policy and PUT fires', async () => {
    const fetchSpy = mockFetch({ policy: 'confluence-wins' });
    const Wrapper = createWrapper();
    render(<SyncConflictPolicyTab />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('sync-conflict-policy-tab')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('sync-conflict-policy-radio-manual-review'));

    const btn = screen.getByTestId('sync-conflict-policy-save-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith('Sync conflict policy saved');
    });

    // PUT fired with the new policy
    const putCall = fetchSpy.mock.calls.find(
      ([_url, opts]) => (opts?.method ?? 'GET').toUpperCase() === 'PUT',
    );
    expect(putCall).toBeDefined();
    expect(JSON.parse(putCall![1]!.body as string)).toEqual({ policy: 'manual-review' });
  });

  it('shows an inline notice when the EE overlay is not deployed (404 GET)', async () => {
    mockFetch({ getStatus: 404 });
    const Wrapper = createWrapper();
    render(<SyncConflictPolicyTab />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('sync-conflict-policy-overlay-missing')).toBeInTheDocument();
    });

    // Save button stays disabled even after a radio click — the API isn't there.
    fireEvent.click(screen.getByTestId('sync-conflict-policy-radio-compendiq-wins'));
    const btn = screen.getByTestId('sync-conflict-policy-save-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('surfaces a toast.error when the PUT fails', async () => {
    mockFetch({ policy: 'confluence-wins', putBehaviour: 'error' });
    const Wrapper = createWrapper();
    render(<SyncConflictPolicyTab />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('sync-conflict-policy-tab')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('sync-conflict-policy-radio-manual-review'));
    fireEvent.click(screen.getByTestId('sync-conflict-policy-save-btn'));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalled();
    });
  });
});
