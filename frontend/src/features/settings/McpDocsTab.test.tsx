import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { McpDocsTab } from './McpDocsTab';

// Mock auth store
const authState = { user: { role: 'admin' }, accessToken: 'test-token', setAuth: vi.fn(), clearAuth: vi.fn() };
vi.mock('../../stores/auth-store', () => ({
  useAuthStore: Object.assign(
    (selector: (state: typeof authState) => unknown) => selector(authState),
    { getState: () => authState },
  ),
}));

function mockFetchWith(settings: Record<string, unknown>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes('/admin/mcp-docs')) {
      return new Response(JSON.stringify(settings), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('Not found', { status: 404 });
  });
}

const defaultSettings = {
  enabled: false,
  url: 'http://mcp-docs:3100/mcp',
  domainMode: 'blocklist',
  allowedDomains: ['*'],
  blockedDomains: [],
  cacheTtl: 3600,
  maxContentLength: 50000,
};

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

describe('McpDocsTab', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the MCP docs settings', async () => {
    mockFetchWith(defaultSettings);
    render(<McpDocsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('MCP Documentation Sidecar')).toBeInTheDocument();
    });

    expect(screen.getByTestId('mcp-docs-toggle')).toBeInTheDocument();
  });

  it('shows additional settings when enabled', async () => {
    mockFetchWith({ ...defaultSettings, enabled: true });
    render(<McpDocsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('mcp-docs-url')).toBeInTheDocument();
    });

    expect(screen.getByTestId('mcp-docs-test')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-docs-cache-ttl')).toBeInTheDocument();
  });

  it('toggles the enabled state', async () => {
    mockFetchWith(defaultSettings);
    render(<McpDocsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('mcp-docs-toggle')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('mcp-docs-toggle'));

    // After toggling, the URL input should appear
    await waitFor(() => {
      expect(screen.getByTestId('mcp-docs-url')).toBeInTheDocument();
    });
  });
});
