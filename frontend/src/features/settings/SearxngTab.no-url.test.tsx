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

/** Answers GET/PUT /admin/searxng and POST /admin/searxng/test at the network boundary; records PUT bodies and Test calls. */
function mockSearxngApi() {
  const putBodies: unknown[] = [];
  const calls = { test: 0 };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/admin/searxng/test')) {
      calls.test += 1;
      return json({ ok: true, resultCount: 2, sample: [{ title: 'R1', url: 'https://example.test/1' }] });
    }
    if (url.endsWith('/admin/searxng') && init?.method === 'PUT') {
      putBodies.push(JSON.parse(String(init.body)));
      return json({ message: 'SearXNG settings updated' });
    }
    if (url.endsWith('/admin/searxng')) {
      return json({ maxResults: 5, categories: 'general' });
    }
    return new Response('Not found', { status: 404 });
  });
  return { putBodies, calls };
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

describe('SearxngTab — the SearXNG URL is operator configuration, not a setting (#1769)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows no SearXNG URL input', async () => {
    mockSearxngApi();
    render(<SearxngTab />, { wrapper: createWrapper() });

    await screen.findByTestId('searxng-categories');
    expect(screen.queryByTestId('searxng-url')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/searxng url/i)).not.toBeInTheDocument();
    // The only text field left is the categories one.
    expect(screen.getAllByRole('textbox')).toEqual([screen.getByTestId('searxng-categories')]);
  });

  it('points to SEARXNG_URL on the mcp-docs service instead', async () => {
    mockSearxngApi();
    render(<SearxngTab />, { wrapper: createWrapper() });

    const note = await screen.findByTestId('searxng-url-note');
    expect(note).toHaveTextContent('The SearXNG URL is set by the operator via SEARXNG_URL on the mcp-docs service.');
    expect(note.querySelector('code')).toHaveTextContent('SEARXNG_URL');
  });

  it('keeps Test, described by that note, and it still runs the connection test', async () => {
    const { calls } = mockSearxngApi();
    render(<SearxngTab />, { wrapper: createWrapper() });

    const test = await screen.findByRole('button', { name: 'Test' });
    expect(test).toHaveAccessibleDescription(/SEARXNG_URL on the mcp-docs service/);

    fireEvent.click(test);

    await waitFor(() => expect(calls.test).toBe(1));
    expect(await screen.findByText('Connection successful (2 results)')).toBeInTheDocument();
  });

  it('saves the result count and categories only — no url', async () => {
    const { putBodies } = mockSearxngApi();
    render(<SearxngTab />, { wrapper: createWrapper() });

    fireEvent.change(await screen.findByTestId('searxng-categories'), { target: { value: 'general,it' } });
    fireEvent.click(screen.getByTestId('searxng-save'));

    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0]).toEqual({ maxResults: 5, categories: 'general,it' });
  });

  it('describes the categories format the API accepts', async () => {
    mockSearxngApi();
    render(<SearxngTab />, { wrapper: createWrapper() });

    const categories = await screen.findByLabelText('Search Categories');
    expect(categories).toHaveAccessibleDescription(/separated by commas without spaces/);
    expect(categories).toHaveAccessibleDescription(/general,it/);
  });
});
