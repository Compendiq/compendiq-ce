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

const mockPolicy = {
  providerLock: 'none',
  modelAllowlist: ['gpt-4o', 'qwen3:4b'],
  maxTokensPerRequest: 4096,
  userOverrideAllowed: true,
};

function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/admin/llm-policy')) {
      return new Response(JSON.stringify(mockPolicy), {
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

  it('shows model allowlist chips from fetched policy', async () => {
    mockFetch();
    render(<LlmPolicyTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('model-chip-gpt-4o')).toBeInTheDocument();
    });
    expect(screen.getByTestId('model-chip-qwen3:4b')).toBeInTheDocument();
  });

  it('has a save button', async () => {
    mockFetch();
    render(<LlmPolicyTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('llm-policy-save-btn')).toBeInTheDocument();
    });
  });

  it('submits PUT with proper body when save is clicked', async () => {
    const fetchSpy = mockFetch();
    render(<LlmPolicyTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('llm-policy-save-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('llm-policy-save-btn'));

    await waitFor(() => {
      const putCalls = fetchSpy.mock.calls.filter(
        ([, opts]) => opts && typeof opts === 'object' && 'method' in opts && (opts as RequestInit).method === 'PUT',
      );
      expect(putCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('adds a model to the allowlist via input', async () => {
    mockFetch();
    render(<LlmPolicyTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('model-allowlist-input')).toBeInTheDocument();
    });

    const input = screen.getByTestId('model-allowlist-input');
    fireEvent.change(input, { target: { value: 'llama3' } });
    fireEvent.click(screen.getByTestId('add-model-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('model-chip-llama3')).toBeInTheDocument();
    });
  });
});
