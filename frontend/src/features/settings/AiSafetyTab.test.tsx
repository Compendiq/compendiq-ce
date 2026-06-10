import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AiSafetyTab } from './AiSafetyTab';
import { createQueryClient } from '../../shared/lib/query-client';

// Mock auth store (apiFetch reads the access token from it)
const authState = { user: { role: 'admin' }, accessToken: 'test-token', setAuth: vi.fn(), clearAuth: vi.fn() };
vi.mock('../../stores/auth-store', () => ({
  useAuthStore: Object.assign(
    (selector: (state: typeof authState) => unknown) => selector(authState),
    { getState: () => authState },
  ),
}));

const defaultSettings = {
  aiGuardrailNoFabricationEnabled: true,
  aiGuardrailNoFabrication:
    'IMPORTANT: Do not fabricate, invent, or hallucinate references, sources, URLs, citations, or bibliographic entries. If you do not have a verified source for a claim, say so explicitly. Never generate fake links or made-up author names. Only cite sources that were provided to you in the context.',
  aiOutputRuleStripReferences: true,
  aiOutputRuleReferenceAction: 'flag' as const,
  aiOutputRuleSwissSpelling: false,
};

function mockFetchWith(settings: Record<string, unknown>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes('/admin/settings')) {
      // apiFetch calls fetch(stringURL, optionsObject), so the method lives on
      // the 2nd arg, not on `input`.
      if ((init as RequestInit)?.method === 'PUT') {
        return new Response(JSON.stringify({ message: 'Updated' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify(settings), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('Not found', { status: 404 });
  });
}

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('AiSafetyTab — Swiss spelling toggle (#705)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the Swiss spelling toggle, unchecked by default', async () => {
    mockFetchWith(defaultSettings);
    render(<AiSafetyTab />, { wrapper: createWrapper() });

    const toggle = await waitFor(() =>
      screen.getByTestId('ai-output-rule-swiss-spelling-toggle').querySelector('input') as HTMLInputElement,
    );
    expect(toggle.checked).toBe(false);
    expect(screen.getByText('Swiss spelling — never use ß')).toBeInTheDocument();
  });

  it('initializes the toggle as checked when the setting is on', async () => {
    mockFetchWith({ ...defaultSettings, aiOutputRuleSwissSpelling: true });
    render(<AiSafetyTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      const toggle = screen.getByTestId('ai-output-rule-swiss-spelling-toggle').querySelector('input') as HTMLInputElement;
      expect(toggle.checked).toBe(true);
    });
  });

  it('enables the save button after toggling Swiss spelling on', async () => {
    mockFetchWith(defaultSettings);
    render(<AiSafetyTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('ai-safety-save-btn')).toBeDisabled();
    });

    const toggle = screen.getByTestId('ai-output-rule-swiss-spelling-toggle').querySelector('input') as HTMLInputElement;
    fireEvent.click(toggle);

    expect(screen.getByTestId('ai-safety-save-btn')).not.toBeDisabled();
  });

  it('sends aiOutputRuleSwissSpelling=true in the PUT payload on save', async () => {
    const fetchSpy = mockFetchWith(defaultSettings);
    render(<AiSafetyTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('ai-output-rule-swiss-spelling-toggle')).toBeInTheDocument();
    });

    const toggle = screen.getByTestId('ai-output-rule-swiss-spelling-toggle').querySelector('input') as HTMLInputElement;
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId('ai-safety-save-btn'));

    await waitFor(() => {
      const putCall = fetchSpy.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PUT');
      expect(putCall).toBeDefined();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      expect(body.aiOutputRuleSwissSpelling).toBe(true);
    });
  });
});

// ─── Issue #768 — full save → navigate-away → return cycle ───────────────────
// The reported symptom is "checkbox reverts after Save + leaving the settings
// page". The pre-existing tests above only assert the PUT payload; none of
// them remount the tab against a server whose state actually CHANGED as a
// result of the save. These tests use a stateful fetch mock (PUT mutates the
// "server" settings the next GET returns) and the PRODUCTION QueryClient
// factory (staleTime 30s) so TanStack Query cache behavior is in the loop.
describe('AiSafetyTab — Swiss spelling persists across save → unmount → remount (#768)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Stateful mock server: PUT merges the body into `serverSettings`; GET returns a snapshot. */
  function mockStatefulServer(initial: Record<string, unknown>) {
    const serverSettings = { ...initial };
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes('/admin/settings')) {
        if ((init as RequestInit)?.method === 'PUT') {
          Object.assign(serverSettings, JSON.parse((init as RequestInit).body as string));
          return new Response(JSON.stringify({ message: 'Admin settings updated' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ...serverSettings }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    });
    return { spy, serverSettings };
  }

  function persistentWrapper(queryClient: QueryClient) {
    return function Wrapper({ children }: { children: React.ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>{children}</MemoryRouter>
        </QueryClientProvider>
      );
    };
  }

  async function getSwissToggle(): Promise<HTMLInputElement> {
    return await waitFor(
      () => screen.getByTestId('ai-output-rule-swiss-spelling-toggle').querySelector('input') as HTMLInputElement,
    );
  }

  it('keeps the toggle checked after save, unmount (navigate away) and remount (navigate back)', async () => {
    const { serverSettings } = mockStatefulServer(defaultSettings);
    // SPA navigation keeps the same QueryClient alive — use the production
    // factory so staleTime/retry defaults match what users actually run.
    const queryClient = createQueryClient();
    const wrapper = persistentWrapper(queryClient);

    // 1. Open Settings → AI Safety, check the box, save.
    const first = render(<AiSafetyTab />, { wrapper });
    const toggle = await getSwissToggle();
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId('ai-safety-save-btn'));

    // The save must reach the "server" and the invalidation refetch must land.
    await waitFor(() => {
      expect(serverSettings.aiOutputRuleSwissSpelling).toBe(true);
    });
    await waitFor(() => {
      expect(
        (queryClient.getQueryData(['admin-settings']) as Record<string, unknown>)?.aiOutputRuleSwissSpelling,
      ).toBe(true);
    });

    // 2. Navigate away (tab switch unmounts the component — SettingsPage
    //    renders tabs conditionally).
    first.unmount();

    // 3. Navigate back: remount against the SAME query client.
    render(<AiSafetyTab />, { wrapper });
    const toggleAfterReturn = await getSwissToggle();
    await waitFor(() => {
      expect(toggleAfterReturn.checked).toBe(true);
    });
  });

  it('keeps the toggle checked even when the user navigates away BEFORE the refetch lands', async () => {
    const { serverSettings, spy } = mockStatefulServer(defaultSettings);
    const queryClient = createQueryClient();
    const wrapper = persistentWrapper(queryClient);

    const first = render(<AiSafetyTab />, { wrapper });
    const toggle = await getSwissToggle();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId('ai-safety-save-btn'));

    // Wait only for the PUT itself — then immediately unmount, simulating a
    // user who saves and leaves the page before the invalidated query
    // refetches. The cache still holds the STALE pre-save settings here.
    await waitFor(() => {
      expect(spy.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'PUT')).toBe(true);
    });
    expect(serverSettings.aiOutputRuleSwissSpelling).toBe(true);
    first.unmount();

    // Returning must show the saved value once the (invalidated) query
    // refetches on mount — a permanent `false` here is the #768 symptom.
    render(<AiSafetyTab />, { wrapper });
    const toggleAfterReturn = await getSwissToggle();
    await waitFor(() => {
      expect(toggleAfterReturn.checked).toBe(true);
    });
  });

  it('shows the persisted value on a fresh page load (empty cache, server has true)', async () => {
    mockStatefulServer({ ...defaultSettings, aiOutputRuleSwissSpelling: true });
    const queryClient = createQueryClient();

    render(<AiSafetyTab />, { wrapper: persistentWrapper(queryClient) });
    const toggle = await getSwissToggle();
    await waitFor(() => {
      expect(toggle.checked).toBe(true);
    });
  });
});
