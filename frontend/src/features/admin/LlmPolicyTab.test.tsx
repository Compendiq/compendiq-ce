import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domMax } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LlmPolicyTab } from './LlmPolicyTab';
import { useAuthStore } from '../../stores/auth-store';

// ── Mock useEnterprise ─────────────────────────────────────────────────────────

let mockHasFeature = (_f: string) => true;

vi.mock('../../shared/enterprise/use-enterprise', () => ({
  useEnterprise: () => ({
    isEnterprise: true,
    hasFeature: (f: string) => mockHasFeature(f),
    ui: null,
    license: null,
    isLoading: false,
  }),
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <LazyMotion features={domMax}>
            {children}
          </LazyMotion>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

// Matches the new backend `OrgLlmPolicy` shape (provider id + model).
const mockPolicy = {
  enabled: true,
  providerId: 'prov-b',
  model: 'gpt-4o-mini',
};

const mockProviders = [
  { id: 'prov-a', name: 'Local Ollama', baseUrl: 'http://o/v1', defaultModel: 'llama3' },
  { id: 'prov-b', name: 'OpenAI Proxy', baseUrl: 'http://p/v1', defaultModel: 'gpt-4o-mini' },
];

function mockFetch(overrides: Partial<typeof mockPolicy> = {}, providers = mockProviders) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/admin/llm-providers')) {
      return new Response(JSON.stringify(providers), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/admin/llm-policy')) {
      return new Response(JSON.stringify({ ...mockPolicy, ...overrides }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({}), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('LlmPolicyTab', () => {
  beforeEach(() => {
    mockHasFeature = () => true;
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

  it('shows feature-gated banner when feature is not enabled', () => {
    mockHasFeature = () => false;
    mockFetch();
    render(<LlmPolicyTab />, { wrapper: createWrapper() });
    expect(screen.getByTestId('llm-policy-gated')).toBeInTheDocument();
    expect(screen.getByText('Enterprise Feature')).toBeInTheDocument();
  });

  it('renders the policy form when feature is enabled', async () => {
    mockFetch();
    render(<LlmPolicyTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('llm-policy-form')).toBeInTheDocument();
    });
  });

  it('shows the warning banner about immediate effect', async () => {
    mockFetch();
    render(<LlmPolicyTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Changes take effect immediately for all users.')).toBeInTheDocument();
    });
  });

  it('hydrates the enable toggle, provider dropdown, and model from the fetched policy', async () => {
    mockFetch();
    render(<LlmPolicyTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('llm-policy-enabled-toggle')).toBeInTheDocument();
    });

    const toggle = screen.getByTestId('llm-policy-enabled-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    await waitFor(() => {
      const select = screen.getByTestId('llm-policy-provider') as HTMLSelectElement;
      expect(select.value).toBe('prov-b');
    });

    const modelInput = screen.getByTestId('model-input') as HTMLInputElement;
    expect(modelInput.value).toBe('gpt-4o-mini');
  });

  it('lists all configured providers in the dropdown', async () => {
    mockFetch();
    render(<LlmPolicyTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('llm-policy-provider')).toBeInTheDocument();
    });

    const select = screen.getByTestId('llm-policy-provider') as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).toEqual(expect.arrayContaining(['prov-a', 'prov-b']));
  });

  it('does not crash when the backend returns a disabled policy with null providerId/model', async () => {
    mockFetch({ enabled: false, providerId: null as unknown as string, model: null as unknown as string });
    render(<LlmPolicyTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('llm-policy-form')).toBeInTheDocument();
    });

    const toggle = screen.getByTestId('llm-policy-enabled-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    const modelInput = screen.getByTestId('model-input') as HTMLInputElement;
    expect(modelInput.value).toBe('');
  });

  it('has a save button', async () => {
    mockFetch();
    render(<LlmPolicyTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('llm-policy-save-btn')).toBeInTheDocument();
    });
  });

  it('submits PUT with { enabled, providerId, model } matching the new backend schema', async () => {
    const fetchSpy = mockFetch();
    render(<LlmPolicyTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('llm-policy-save-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('llm-policy-save-btn'));

    await waitFor(() => {
      const putCall = fetchSpy.mock.calls.find(
        ([, opts]) => opts && typeof opts === 'object' && 'method' in opts && (opts as RequestInit).method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      expect(body).toEqual({ enabled: true, providerId: 'prov-b', model: 'gpt-4o-mini' });
    });
  });

  it('sends providerId=null and model=null when the policy is toggled off', async () => {
    const fetchSpy = mockFetch();
    render(<LlmPolicyTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('llm-policy-enabled-toggle')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('llm-policy-enabled-toggle'));
    fireEvent.click(screen.getByTestId('llm-policy-save-btn'));

    await waitFor(() => {
      const putCall = fetchSpy.mock.calls.find(
        ([, opts]) => opts && typeof opts === 'object' && 'method' in opts && (opts as RequestInit).method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      expect(body).toEqual({ enabled: false, providerId: null, model: null });
    });
  });

  it('switching provider via the dropdown is reflected in the PUT body', async () => {
    const fetchSpy = mockFetch();
    render(<LlmPolicyTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('llm-policy-provider')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('llm-policy-provider'), { target: { value: 'prov-a' } });
    fireEvent.click(screen.getByTestId('llm-policy-save-btn'));

    await waitFor(() => {
      const putCall = fetchSpy.mock.calls.find(
        ([, opts]) => opts && typeof opts === 'object' && 'method' in opts && (opts as RequestInit).method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      expect(body.providerId).toBe('prov-a');
    });
  });
});
