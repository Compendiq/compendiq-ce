import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { RateLimitsTab } from './RateLimitsTab';

// Mock auth store
const authState = { user: { role: 'admin' }, accessToken: 'test-token', setAuth: vi.fn(), clearAuth: vi.fn() };
vi.mock('../../stores/auth-store', () => ({
  useAuthStore: Object.assign(
    (selector: (state: typeof authState) => unknown) => selector(authState),
    { getState: () => authState },
  ),
}));

const defaultSettings = {
  llmProvider: 'ollama',
  ollamaModel: 'qwen3.5',
  openaiBaseUrl: null,
  hasOpenaiApiKey: false,
  openaiModel: null,
  embeddingModel: 'bge-m3',
  embeddingChunkSize: 500,
  embeddingChunkOverlap: 50,
  drawioEmbedUrl: null,
  rateLimitGlobal: 100,
  rateLimitAuth: 5,
  rateLimitAdmin: 20,
  rateLimitLlmStream: 10,
  rateLimitLlmEmbedding: 5,
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

describe('RateLimitsTab', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all 5 rate limit categories', async () => {
    mockFetchWith(defaultSettings);
    render(<RateLimitsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Global (default)')).toBeInTheDocument();
    });

    expect(screen.getByText('Authentication')).toBeInTheDocument();
    expect(screen.getByText('Admin operations')).toBeInTheDocument();
    expect(screen.getByText('LLM streaming')).toBeInTheDocument();
    expect(screen.getByText('Embedding & PDF')).toBeInTheDocument();
  });

  it('initializes inputs from settings', async () => {
    mockFetchWith(defaultSettings);
    render(<RateLimitsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      const globalInput = screen.getByTestId('rate-limit-rateLimitGlobal') as HTMLInputElement;
      expect(globalInput.value).toBe('100');
    });

    const authInput = screen.getByTestId('rate-limit-rateLimitAuth') as HTMLInputElement;
    expect(authInput.value).toBe('5');
  });

  it('save button is disabled when no changes', async () => {
    mockFetchWith(defaultSettings);
    render(<RateLimitsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('rate-limits-save-btn')).toBeDisabled();
    });
  });

  it('save button enables after changing a value', async () => {
    mockFetchWith(defaultSettings);
    render(<RateLimitsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('rate-limit-rateLimitAuth')).toBeInTheDocument();
    });

    const authInput = screen.getByTestId('rate-limit-rateLimitAuth');
    fireEvent.change(authInput, { target: { value: '50' } });

    expect(screen.getByTestId('rate-limits-save-btn')).not.toBeDisabled();
  });

  it('shows reset-to-default when value differs from default', async () => {
    mockFetchWith({ ...defaultSettings, rateLimitAuth: 50 });
    render(<RateLimitsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Reset to default (5/min)')).toBeInTheDocument();
    });
  });

  it('shows security warning for auth < 5', async () => {
    mockFetchWith(defaultSettings);
    render(<RateLimitsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('rate-limit-rateLimitAuth')).toBeInTheDocument();
    });

    const authInput = screen.getByTestId('rate-limit-rateLimitAuth');
    fireEvent.change(authInput, { target: { value: '3' } });

    expect(screen.getByText(/Values below 5 may cause issues/)).toBeInTheDocument();
  });

  it('calls PUT /admin/settings on save', async () => {
    const fetchSpy = mockFetchWith(defaultSettings);
    render(<RateLimitsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('rate-limit-rateLimitAuth')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('rate-limit-rateLimitAuth'), { target: { value: '25' } });
    fireEvent.click(screen.getByTestId('rate-limits-save-btn'));

    await waitFor(() => {
      const putCall = fetchSpy.mock.calls.find(
        (c) => {
          const req = c[1] as RequestInit | undefined;
          return req?.method === 'PUT';
        },
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      expect(body.rateLimitAuth).toBe(25);
    });
  });
});
