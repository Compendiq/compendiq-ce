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

/**
 * Mock fetch at the network boundary with a stateful in-memory "server":
 * GET /admin/settings returns a snapshot of `serverSettings`, and PUT merges
 * the request body into it — so GETs after a save reflect the saved state.
 * `holdGets()` / `releaseGets()` gate GET responses behind a manually-resolved
 * promise, letting a test deterministically pin an invalidation refetch in
 * flight (e.g. across an unmount).
 */
function mockSettingsServer(initial: Record<string, unknown>) {
  const serverSettings = { ...initial };
  let gate: Promise<void> | null = null;
  let openGate: (() => void) | null = null;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (!url.includes('/admin/settings')) {
      return new Response('Not found', { status: 404 });
    }
    // apiFetch calls fetch(stringURL, optionsObject), so the method lives on
    // the 2nd arg, not on `input`.
    if ((init as RequestInit)?.method === 'PUT') {
      Object.assign(serverSettings, JSON.parse((init as RequestInit).body as string));
      return new Response(JSON.stringify({ message: 'Admin settings updated' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (gate) await gate;
    return new Response(JSON.stringify({ ...serverSettings }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return {
    spy,
    serverSettings,
    /** Hold every GET response from now on until `releaseGets()` is called. */
    holdGets() {
      gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
    },
    releaseGets() {
      openGate?.();
      gate = null;
      openGate = null;
    },
  };
}

/** The testid sits on the wrapper label; the actual checkbox is the inner <input>. */
async function getSwissToggle(): Promise<HTMLInputElement> {
  return await waitFor(() => {
    const input = screen.getByTestId('ai-output-rule-swiss-spelling-toggle').querySelector('input');
    expect(input).not.toBeNull();
    return input as HTMLInputElement;
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
    mockSettingsServer(defaultSettings);
    render(<AiSafetyTab />, { wrapper: createWrapper() });

    const toggle = await getSwissToggle();
    expect(toggle.checked).toBe(false);
    expect(screen.getByText('Swiss spelling — never use ß')).toBeInTheDocument();
  });

  it('initializes the toggle as checked when the setting is on', async () => {
    mockSettingsServer({ ...defaultSettings, aiOutputRuleSwissSpelling: true });
    render(<AiSafetyTab />, { wrapper: createWrapper() });

    const toggle = await getSwissToggle();
    await waitFor(() => {
      expect(toggle.checked).toBe(true);
    });
  });

  it('enables the save button after toggling Swiss spelling on', async () => {
    mockSettingsServer(defaultSettings);
    render(<AiSafetyTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('ai-safety-save-btn')).toBeDisabled();
    });

    const toggle = await getSwissToggle();
    fireEvent.click(toggle);

    expect(screen.getByTestId('ai-safety-save-btn')).not.toBeDisabled();
  });

  it('sends aiOutputRuleSwissSpelling=true in the PUT payload on save', async () => {
    const { spy } = mockSettingsServer(defaultSettings);
    render(<AiSafetyTab />, { wrapper: createWrapper() });

    const toggle = await getSwissToggle();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId('ai-safety-save-btn'));

    await waitFor(() => {
      const putCall = spy.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PUT');
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

  function persistentWrapper(queryClient: QueryClient) {
    return function Wrapper({ children }: { children: React.ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>{children}</MemoryRouter>
        </QueryClientProvider>
      );
    };
  }

  it('keeps the toggle checked after save, unmount (navigate away) and remount (navigate back)', async () => {
    const { serverSettings } = mockSettingsServer(defaultSettings);
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
    const server = mockSettingsServer(defaultSettings);
    const queryClient = createQueryClient();
    const wrapper = persistentWrapper(queryClient);

    const first = render(<AiSafetyTab />, { wrapper });
    const toggle = await getSwissToggle();
    fireEvent.click(toggle);

    // Gate GETs BEFORE saving: the invalidation refetch the PUT triggers
    // genuinely cannot resolve until `releaseGets()` below, so the unmount is
    // deterministically "before the refetch lands" — not a race against it.
    server.holdGets();
    fireEvent.click(screen.getByTestId('ai-safety-save-btn'));

    // Wait only for the PUT itself — then immediately unmount, simulating a
    // user who saves and leaves the page before the invalidated query
    // refetches.
    await waitFor(() => {
      expect(server.spy.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'PUT')).toBe(true);
    });
    expect(server.serverSettings.aiOutputRuleSwissSpelling).toBe(true);
    // The refetch is provably still in flight: the cache must still hold the
    // STALE pre-save settings at the moment the user leaves the page.
    expect(
      (queryClient.getQueryData(['admin-settings']) as Record<string, unknown>).aiOutputRuleSwissSpelling,
    ).toBe(false);
    first.unmount();
    server.releaseGets();

    // Returning must show the saved value once the (invalidated) query
    // refetches on mount — a permanent `false` here is the #768 symptom.
    render(<AiSafetyTab />, { wrapper });
    const toggleAfterReturn = await getSwissToggle();
    await waitFor(() => {
      expect(toggleAfterReturn.checked).toBe(true);
    });
  });

  it('shows the persisted value on a fresh page load (empty cache, server has true)', async () => {
    mockSettingsServer({ ...defaultSettings, aiOutputRuleSwissSpelling: true });
    const queryClient = createQueryClient();

    render(<AiSafetyTab />, { wrapper: persistentWrapper(queryClient) });
    const toggle = await getSwissToggle();
    await waitFor(() => {
      expect(toggle.checked).toBe(true);
    });
  });
});
