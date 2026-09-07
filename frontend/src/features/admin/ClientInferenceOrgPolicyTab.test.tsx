import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domMax } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ClientInferenceOrgPolicyTab } from './ClientInferenceOrgPolicyTab';
import { useAuthStore } from '../../stores/auth-store';

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

vi.mock('../../shared/lib/client-inference/client-inference-manager', () => ({
  getClientInferenceManager: () => ({
    refreshOrgPolicy: vi.fn(async () => ({
      active: true,
      mode: 'allowed',
      allowedModels: [],
      enforceWebGpuOnly: false,
    })),
  }),
}));

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
  enabled: true,
  mode: 'disabled_server_only' as const,
  allowedModels: [],
  maxModelSizeBytes: null,
  enforceWebGpuOnly: false,
};

function mockFetch(overrides: Partial<typeof mockPolicy> = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/admin/client-inference-policy')) {
      return new Response(JSON.stringify({ ...mockPolicy, ...overrides }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({}), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('ClientInferenceOrgPolicyTab', () => {
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
    render(<ClientInferenceOrgPolicyTab />, { wrapper: createWrapper() });
    expect(screen.getByTestId('client-inference-policy-gated')).toBeInTheDocument();
    expect(screen.getByText('Enterprise Feature')).toBeInTheDocument();
  });

  it('renders the policy form when feature is enabled', async () => {
    mockFetch();
    render(<ClientInferenceOrgPolicyTab />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('client-inference-policy-form')).toBeInTheDocument();
    });
  });

  it('hydrates enabled and mode from the fetched policy', async () => {
    mockFetch();
    render(<ClientInferenceOrgPolicyTab />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('client-inference-policy-enabled-toggle')).toBeInTheDocument();
    });
    const toggle = screen.getByTestId('client-inference-policy-enabled-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(screen.getByTestId('client-inference-policy-mode-disabled_server_only')).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('submits PUT with enabled and the selected mode', async () => {
    const fetchSpy = mockFetch();
    render(<ClientInferenceOrgPolicyTab />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('client-inference-policy-save-btn')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('client-inference-policy-mode-mandated_offline_only'));
    fireEvent.click(screen.getByTestId('client-inference-policy-save-btn'));
    await waitFor(() => {
      const putCall = fetchSpy.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('/admin/client-inference-policy') && (call[1] as RequestInit | undefined)?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(String((putCall?.[1] as RequestInit).body));
      expect(body).toEqual({ enabled: true, mode: 'mandated_offline_only' });
    });
  });
});
