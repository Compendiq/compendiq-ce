import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { RegistrationPolicyTab } from './RegistrationPolicyTab';

// Mock auth store (same shape as RateLimitsTab.test.tsx)
const authState = { user: { role: 'admin' }, accessToken: 'test-token', setAuth: vi.fn(), clearAuth: vi.fn() };
vi.mock('../../stores/auth-store', () => ({
  useAuthStore: Object.assign(
    (selector: (state: typeof authState) => unknown) => selector(authState),
    { getState: () => authState },
  ),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

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

describe('RegistrationPolicyTab (#1051)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes the select from the current registrationMode', async () => {
    mockFetchWith({ registrationMode: 'open' });
    render(<RegistrationPolicyTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      const select = screen.getByTestId('registration-mode-select') as HTMLSelectElement;
      expect(select.value).toBe('open');
    });
  });

  it('defaults the select to closed when the setting is absent', async () => {
    mockFetchWith({});
    render(<RegistrationPolicyTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      const select = screen.getByTestId('registration-mode-select') as HTMLSelectElement;
      expect(select.value).toBe('closed');
    });
  });

  it('does not show the open-mode warning while closed', async () => {
    mockFetchWith({ registrationMode: 'closed' });
    render(<RegistrationPolicyTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('registration-mode-select')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('registration-open-warning')).not.toBeInTheDocument();
  });

  it('shows the shared-page warning when Open is selected', async () => {
    mockFetchWith({ registrationMode: 'closed' });
    render(<RegistrationPolicyTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('registration-mode-select')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('registration-mode-select'), { target: { value: 'open' } });

    const warning = screen.getByTestId('registration-open-warning');
    expect(warning).toBeInTheDocument();
    expect(warning).toHaveTextContent(/shared standalone/i);
  });

  it('fires PUT /admin/settings with { registrationMode: "open" } on save', async () => {
    const fetchSpy = mockFetchWith({ registrationMode: 'closed' });
    render(<RegistrationPolicyTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('registration-mode-select')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('registration-mode-select'), { target: { value: 'open' } });
    fireEvent.click(screen.getByTestId('registration-policy-save-btn'));

    await waitFor(() => {
      const putCall = fetchSpy.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PUT');
      expect(putCall).toBeDefined();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      expect(body.registrationMode).toBe('open');
    });
  });

  it('keeps Save disabled until the mode changes', async () => {
    mockFetchWith({ registrationMode: 'closed' });
    render(<RegistrationPolicyTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('registration-policy-save-btn')).toBeDisabled();
    });

    fireEvent.change(screen.getByTestId('registration-mode-select'), { target: { value: 'open' } });
    expect(screen.getByTestId('registration-policy-save-btn')).not.toBeDisabled();
  });
});
