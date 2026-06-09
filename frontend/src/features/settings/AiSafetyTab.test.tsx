import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AiSafetyTab } from './AiSafetyTab';

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
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes('/admin/settings')) {
      if ((input as Request)?.method === 'PUT') {
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
