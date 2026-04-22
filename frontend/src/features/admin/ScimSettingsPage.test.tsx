import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domMax } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ScimSettingsPage } from './ScimSettingsPage';
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

// ── Mock clipboard ────────────────────────────────────────────────────────────

const mockWriteText = vi.fn().mockResolvedValue(undefined);

Object.assign(navigator, {
  clipboard: { writeText: mockWriteText },
});

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

const mockTokens = [
  {
    id: 'tok-1',
    name: 'Okta SCIM',
    lastUsedAt: '2026-04-10T12:00:00Z',
    createdAt: '2026-04-01T09:00:00Z',
    expiresAt: '2027-04-01T09:00:00Z',
    createdBy: 'admin',
  },
  {
    id: 'tok-2',
    name: 'Azure AD',
    lastUsedAt: null,
    createdAt: '2026-04-05T14:00:00Z',
    expiresAt: null,
    createdBy: 'admin',
  },
];

const mockCreateResult = {
  id: 'tok-3',
  name: 'New Token',
  token: 'scim_bEaReR_tOkEn_PlAiNtExT_12345',
  expiresAt: null,
};

function mockFetchWithTokens(tokens = mockTokens) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = init?.method ?? 'GET';

    if (url.includes('/admin/scim/tokens') && method === 'GET') {
      return new Response(JSON.stringify(tokens), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/admin/scim/tokens') && method === 'POST') {
      return new Response(JSON.stringify(mockCreateResult), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/admin/scim/tokens/') && method === 'DELETE') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({}), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('ScimSettingsPage', () => {
  beforeEach(() => {
    mockHasFeature = () => true;
    mockWriteText.mockClear();
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

  // 1. Feature gate
  it('shows feature-gated banner when scim_provisioning is not enabled', () => {
    mockHasFeature = () => false;
    mockFetchWithTokens();
    render(<ScimSettingsPage />, { wrapper: createWrapper() });
    expect(screen.getByTestId('scim-gated')).toBeInTheDocument();
    expect(screen.getByText('Enterprise Feature')).toBeInTheDocument();
  });

  // 2. Token list renders
  it('renders token list table when feature is enabled and tokens exist', async () => {
    mockFetchWithTokens();
    render(<ScimSettingsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Okta SCIM')).toBeInTheDocument();
    });
    expect(screen.getByText('Azure AD')).toBeInTheDocument();
  });

  // 3. Empty state
  it('shows empty state when no tokens exist', async () => {
    mockFetchWithTokens([]);
    render(<ScimSettingsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('No SCIM tokens')).toBeInTheDocument();
    });
  });

  // 4. Create form toggle
  it('opens create form on Generate Token button click', async () => {
    mockFetchWithTokens();
    render(<ScimSettingsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('generate-token-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('generate-token-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('scim-create-form')).toBeInTheDocument();
    });
  });

  // 5. Create submission
  it('submits POST with name and expiresInDays on form submit', async () => {
    const fetchSpy = mockFetchWithTokens();
    render(<ScimSettingsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('generate-token-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('generate-token-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('scim-token-name')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('scim-token-name'), { target: { value: 'New Token' } });
    fireEvent.change(screen.getByTestId('scim-expires-days'), { target: { value: '90' } });
    fireEvent.click(screen.getByTestId('scim-create-submit'));

    await waitFor(() => {
      const postCalls = fetchSpy.mock.calls.filter(
        ([, opts]) => opts && typeof opts === 'object' && 'method' in opts && (opts as RequestInit).method === 'POST',
      );
      expect(postCalls.length).toBeGreaterThanOrEqual(1);
      const body = JSON.parse((postCalls[0][1] as RequestInit).body as string);
      expect(body.name).toBe('New Token');
      expect(body.expiresInDays).toBe(90);
    });
  });

  // 6. Plaintext reveal
  it('shows plaintext reveal overlay after successful creation', async () => {
    mockFetchWithTokens();
    render(<ScimSettingsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('generate-token-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('generate-token-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('scim-token-name')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('scim-token-name'), { target: { value: 'New Token' } });
    fireEvent.click(screen.getByTestId('scim-create-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('scim-token-reveal')).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue('scim_bEaReR_tOkEn_PlAiNtExT_12345')).toBeInTheDocument();
  });

  // 7. Copy to clipboard
  it('calls navigator.clipboard.writeText when Copy button is clicked', async () => {
    mockFetchWithTokens();
    render(<ScimSettingsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('generate-token-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('generate-token-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('scim-token-name')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('scim-token-name'), { target: { value: 'New Token' } });
    fireEvent.click(screen.getByTestId('scim-create-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('scim-copy-token')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('scim-copy-token'));

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith('scim_bEaReR_tOkEn_PlAiNtExT_12345');
    });
  });

  // 8. Dismiss disabled until checkbox checked
  it('disables dismiss button until checkbox is checked', async () => {
    mockFetchWithTokens();
    render(<ScimSettingsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('generate-token-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('generate-token-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('scim-token-name')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('scim-token-name'), { target: { value: 'New Token' } });
    fireEvent.click(screen.getByTestId('scim-create-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('scim-dismiss-token')).toBeInTheDocument();
    });

    // Dismiss should be disabled
    expect(screen.getByTestId('scim-dismiss-token')).toBeDisabled();

    // Check the confirmation checkbox
    fireEvent.click(screen.getByTestId('scim-copied-confirm'));

    // Dismiss should now be enabled
    expect(screen.getByTestId('scim-dismiss-token')).not.toBeDisabled();
  });

  // 9. Dismiss clears plaintext from DOM
  it('clears revealed token from DOM on dismiss', async () => {
    mockFetchWithTokens();
    render(<ScimSettingsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('generate-token-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('generate-token-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('scim-token-name')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('scim-token-name'), { target: { value: 'New Token' } });
    fireEvent.click(screen.getByTestId('scim-create-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('scim-token-reveal')).toBeInTheDocument();
    });

    // Check confirmation and dismiss
    fireEvent.click(screen.getByTestId('scim-copied-confirm'));
    fireEvent.click(screen.getByTestId('scim-dismiss-token'));

    // Token plaintext must no longer be in the DOM
    await waitFor(() => {
      expect(screen.queryByTestId('scim-token-reveal')).not.toBeInTheDocument();
    });
    expect(screen.queryByDisplayValue('scim_bEaReR_tOkEn_PlAiNtExT_12345')).not.toBeInTheDocument();
  });

  // 10. Revoke
  it('sends DELETE request when Revoke button is clicked', async () => {
    const fetchSpy = mockFetchWithTokens();
    render(<ScimSettingsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('revoke-token-tok-1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('revoke-token-tok-1'));

    await waitFor(() => {
      const deleteCalls = fetchSpy.mock.calls.filter(
        ([, opts]) => opts && typeof opts === 'object' && 'method' in opts && (opts as RequestInit).method === 'DELETE',
      );
      expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
      expect(String(deleteCalls[0][0])).toContain('/admin/scim/tokens/tok-1');
    });
  });

  // 11. SCIM base URL
  it('renders SCIM base URL with /scim/v2', async () => {
    mockFetchWithTokens();
    render(<ScimSettingsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('/scim/v2')).toBeInTheDocument();
    });
  });

  // 12. No expiry option
  it('omits expiresInDays when the field is empty', async () => {
    const fetchSpy = mockFetchWithTokens();
    render(<ScimSettingsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('generate-token-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('generate-token-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('scim-token-name')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('scim-token-name'), { target: { value: 'No Expiry' } });
    // Leave expiresInDays empty
    fireEvent.click(screen.getByTestId('scim-create-submit'));

    await waitFor(() => {
      const postCalls = fetchSpy.mock.calls.filter(
        ([, opts]) => opts && typeof opts === 'object' && 'method' in opts && (opts as RequestInit).method === 'POST',
      );
      expect(postCalls.length).toBeGreaterThanOrEqual(1);
      const body = JSON.parse((postCalls[0][1] as RequestInit).body as string);
      expect(body.name).toBe('No Expiry');
      expect(body).not.toHaveProperty('expiresInDays');
    });
  });
});
