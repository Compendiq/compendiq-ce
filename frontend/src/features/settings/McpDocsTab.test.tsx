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

describe('McpDocsTab — numeric fields share the sidecar tool ranges (#1769)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // Literal on purpose: the mcp-docs fetch_url tool accepts cache_ttl 60–86400
  // and max_length ≤ 100000 (ABSOLUTE_MAX_LENGTH); the contract constants are
  // pinned to the same literals in packages/contracts.
  it('bounds Max Content Length to the sidecar cap (1000–100000) and describes it', async () => {
    mockFetchWith({ ...defaultSettings, enabled: true });
    render(<McpDocsTab />, { wrapper: createWrapper() });

    const input = await screen.findByTestId('mcp-docs-max-length');
    expect(input).toHaveAttribute('min', '1000');
    expect(input).toHaveAttribute('max', '100000');
    expect(input).toHaveAccessibleDescription(/100,000/);
    expect(input).toHaveAccessibleDescription(/5,000 per source/);
  });

  it('bounds Cache TTL to 60–86400 and says it applies to newly fetched documents', async () => {
    mockFetchWith({ ...defaultSettings, enabled: true });
    render(<McpDocsTab />, { wrapper: createWrapper() });

    const input = await screen.findByTestId('mcp-docs-cache-ttl');
    expect(input).toHaveAttribute('min', '60');
    expect(input).toHaveAttribute('max', '86400');
    expect(input).toHaveAccessibleDescription(/60–86400/);
    expect(input).toHaveAccessibleDescription(/newly fetched document/);
  });

  it('labels both numeric fields (visible label is the accessible name)', async () => {
    mockFetchWith({ ...defaultSettings, enabled: true });
    render(<McpDocsTab />, { wrapper: createWrapper() });

    expect(await screen.findByLabelText('Max Content Length')).toHaveAttribute('data-testid', 'mcp-docs-max-length');
    expect(screen.getByLabelText('Cache TTL (seconds)')).toHaveAttribute('data-testid', 'mcp-docs-cache-ttl');
  });
});
