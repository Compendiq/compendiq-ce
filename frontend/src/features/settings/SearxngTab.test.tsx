import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { SearxngTab } from './SearxngTab';

// Mock auth store
const authState = { user: { role: 'admin' }, accessToken: 'test-token', setAuth: vi.fn(), clearAuth: vi.fn() };
vi.mock('../../stores/auth-store', () => ({
  useAuthStore: Object.assign(
    (selector: (state: typeof authState) => unknown) => selector(authState),
    { getState: () => authState },
  ),
}));

const savedSettings = { url: 'http://searxng:8080', maxResults: 5, categories: 'general' };

/** Answers GET/PUT /admin/searxng at the network boundary and records every PUT body. */
function mockSearxngApi() {
  const putBodies: unknown[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.endsWith('/admin/searxng') && init?.method === 'PUT') {
      putBodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ message: 'SearXNG settings updated' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/admin/searxng')) {
      return new Response(JSON.stringify(savedSettings), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('Not found', { status: 404 });
  });
  return putBodies;
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

describe('SearxngTab — Max Results shares the sidecar range (#1768)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // Literal 1 and 10 on purpose: the mcp-docs search_web tool accepts
  // num_results 1–10, and the contract constants are pinned to the same
  // literals in packages/contracts.
  it('bounds Max Results to the sidecar range (1–10)', async () => {
    mockSearxngApi();
    render(<SearxngTab />, { wrapper: createWrapper() });

    const input = await screen.findByTestId('searxng-max-results');
    expect(input).toHaveAttribute('min', '1');
    expect(input).toHaveAttribute('max', '10');
  });

  it('describes Max Results with its range for assistive tech', async () => {
    mockSearxngApi();
    render(<SearxngTab />, { wrapper: createWrapper() });

    const input = await screen.findByTestId('searxng-max-results');
    expect(input).toHaveAccessibleDescription(/\(1–10\)/);
  });

  it('keeps a typed value above the range inside it before save', async () => {
    const putBodies = mockSearxngApi();
    render(<SearxngTab />, { wrapper: createWrapper() });

    const input = await screen.findByTestId('searxng-max-results');
    fireEvent.change(input, { target: { value: '15' } });
    expect(input).toHaveValue(10);

    fireEvent.click(screen.getByTestId('searxng-save'));

    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0]).toMatchObject({ maxResults: 10 });
  });
});
