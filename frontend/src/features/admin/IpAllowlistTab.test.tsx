import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domMax } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { IpAllowlistConfig, IpAllowlistTestResponse } from '@compendiq/contracts';
import { IpAllowlistTab } from './IpAllowlistTab';
import { useAuthStore } from '../../stores/auth-store';

// Mock sonner so we can assert on toasts without needing the real renderer.
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <LazyMotion features={domMax}>{children}</LazyMotion>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

const defaultConfig: IpAllowlistConfig = {
  enabled: true,
  cidrs: ['10.0.0.0/8', '192.168.1.0/24'],
  trustedProxies: ['127.0.0.1/32', '::1/128'],
  exceptions: ['/api/health', '/api/admin/ip-allowlist', '/api/admin/ip-allowlist/test'],
};

interface MockOptions {
  /** Override the config returned by GET. */
  config?: IpAllowlistConfig;
  /** Response for POST /test. Set to `null` for 400 invalid_ip. */
  testResponse?: IpAllowlistTestResponse | null;
  /** Response behaviour for PUT. 'ok' → 204, 'invalid_cidr' → 400 with cidr. */
  putBehaviour?: 'ok' | 'invalid_cidr' | 'invalid_exception' | 'error';
  /** The CIDR to echo back on `invalid_cidr`. */
  putInvalidCidr?: string;
}

function mockFetch(options: MockOptions = {}) {
  const config = options.config ?? defaultConfig;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method =
      (init?.method ?? (input as Request)?.method ?? 'GET').toUpperCase();

    if (url.includes('/admin/ip-allowlist/test') && method === 'POST') {
      if (options.testResponse === null) {
        return new Response(JSON.stringify({ error: 'invalid_ip' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const result: IpAllowlistTestResponse =
        options.testResponse ?? {
          allowed: true,
          matchedCidr: '10.0.0.0/8',
          isTrustedProxy: false,
          reason: 'allowed (matches 10.0.0.0/8)',
        };
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/admin/ip-allowlist') && method === 'PUT') {
      if (options.putBehaviour === 'invalid_cidr') {
        return new Response(
          JSON.stringify({ error: 'invalid_cidr', cidr: options.putInvalidCidr ?? 'not-a-cidr' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (options.putBehaviour === 'invalid_exception') {
        return new Response(
          JSON.stringify({ error: 'invalid_exception', path: '/not-api/ok' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (options.putBehaviour === 'error') {
        return new Response(JSON.stringify({ message: 'boom' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(null, { status: 204 });
    }

    if (url.includes('/admin/ip-allowlist') && method === 'GET') {
      return new Response(JSON.stringify({ config }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  });
}

describe('IpAllowlistTab', () => {
  beforeEach(() => {
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'admin',
      role: 'admin',
    });
    toastSuccess.mockClear();
    toastError.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('renders the loaded config', async () => {
    mockFetch();
    render(<IpAllowlistTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('ip-allowlist-tab')).toBeInTheDocument();
    });

    const cidrs = screen.getByTestId('ip-allowlist-cidrs') as HTMLTextAreaElement;
    expect(cidrs.value).toBe('10.0.0.0/8\n192.168.1.0/24');

    const proxies = screen.getByTestId('ip-allowlist-proxies') as HTMLTextAreaElement;
    expect(proxies.value).toBe('127.0.0.1/32\n::1/128');

    // Exempt paths are rendered as a read-only list.
    expect(screen.getByTestId('ip-allowlist-exception-/api/health')).toBeInTheDocument();
    expect(
      screen.getByTestId('ip-allowlist-exception-/api/admin/ip-allowlist'),
    ).toBeInTheDocument();
  });

  it('enable toggle flips config.enabled', async () => {
    mockFetch({ config: { ...defaultConfig, enabled: false } });
    render(<IpAllowlistTab />, { wrapper: createWrapper() });

    const toggle = await screen.findByTestId('ip-allowlist-enabled-toggle');
    expect(toggle).toHaveAttribute('data-state', 'unchecked');

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(toggle).toHaveAttribute('data-state', 'checked');
    });
  });

  it('save button is disabled when form is pristine', async () => {
    mockFetch();
    render(<IpAllowlistTab />, { wrapper: createWrapper() });

    const save = await screen.findByTestId('ip-allowlist-save-btn');
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute('title', 'No changes to save');
  });

  it('save button is disabled when dirty + enabled=true + no IP confirmed', async () => {
    mockFetch();
    render(<IpAllowlistTab />, { wrapper: createWrapper() });

    const cidrs = await screen.findByTestId('ip-allowlist-cidrs');
    fireEvent.change(cidrs, { target: { value: '10.0.0.0/8\n172.16.0.0/12' } });

    const save = screen.getByTestId('ip-allowlist-save-btn');
    expect(save).toBeDisabled();
    expect(save.getAttribute('title')).toContain(
      "Test your own IP in the panel above first",
    );
  });

  it('save button enables after a successful test panel confirmation', async () => {
    mockFetch();
    render(<IpAllowlistTab />, { wrapper: createWrapper() });

    // Dirty the form first.
    const cidrs = await screen.findByTestId('ip-allowlist-cidrs');
    fireEvent.change(cidrs, { target: { value: '10.0.0.0/8\n172.16.0.0/12' } });

    // Run a test that succeeds.
    const testInput = screen.getByTestId('ip-allowlist-test-ip');
    fireEvent.change(testInput, { target: { value: '10.0.0.5' } });
    fireEvent.click(screen.getByTestId('ip-allowlist-test-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('ip-allowlist-test-outcome')).toHaveTextContent('allowed');
    });

    await waitFor(() => {
      expect(screen.getByTestId('ip-allowlist-save-btn')).not.toBeDisabled();
    });
  });

  it('save button is enabled when dirty + enabled=false', async () => {
    mockFetch();
    render(<IpAllowlistTab />, { wrapper: createWrapper() });

    // Wait for load, then turn it off.
    const toggle = await screen.findByTestId('ip-allowlist-enabled-toggle');
    expect(toggle).toHaveAttribute('data-state', 'checked');
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(toggle).toHaveAttribute('data-state', 'unchecked');
    });

    // No IP has been tested — save should still be enabled because we're
    // turning the feature OFF (no lockout risk).
    await waitFor(() => {
      expect(screen.getByTestId('ip-allowlist-save-btn')).not.toBeDisabled();
    });
  });

  it('test panel POST — entering an IP renders the response', async () => {
    mockFetch({
      testResponse: {
        allowed: true,
        matchedCidr: '10.0.0.0/8',
        isTrustedProxy: true,
        reason: 'allowed (matches 10.0.0.0/8)',
      },
    });
    render(<IpAllowlistTab />, { wrapper: createWrapper() });

    const testInput = await screen.findByTestId('ip-allowlist-test-ip');
    fireEvent.change(testInput, { target: { value: '10.0.0.5' } });
    fireEvent.click(screen.getByTestId('ip-allowlist-test-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('ip-allowlist-test-result')).toBeInTheDocument();
    });

    expect(screen.getByTestId('ip-allowlist-test-outcome')).toHaveTextContent('allowed');
    expect(screen.getByText('matched 10.0.0.0/8')).toBeInTheDocument();
    expect(screen.getByTestId('ip-allowlist-test-trusted-proxy')).toBeInTheDocument();
    expect(screen.getByTestId('ip-allowlist-test-reason')).toHaveTextContent(
      'allowed (matches 10.0.0.0/8)',
    );
  });

  it('test panel on 400 invalid_ip shows "Invalid IP address" inline', async () => {
    mockFetch({ testResponse: null });
    render(<IpAllowlistTab />, { wrapper: createWrapper() });

    const testInput = await screen.findByTestId('ip-allowlist-test-ip');
    fireEvent.change(testInput, { target: { value: 'garbage' } });
    fireEvent.click(screen.getByTestId('ip-allowlist-test-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('ip-allowlist-test-invalid')).toHaveTextContent(
        'Invalid IP address',
      );
    });

    // No result panel when the IP was rejected outright.
    expect(screen.queryByTestId('ip-allowlist-test-result')).not.toBeInTheDocument();
  });

  it('PUT on success calls the endpoint with parsed config and shows success toast', async () => {
    const fetchSpy = mockFetch();
    render(<IpAllowlistTab />, { wrapper: createWrapper() });

    // Dirty the CIDRs, confirm an IP is allowed, then save.
    const cidrs = await screen.findByTestId('ip-allowlist-cidrs');
    fireEvent.change(cidrs, {
      target: { value: '10.0.0.0/8\n172.16.0.0/12\n192.168.2.0/24' },
    });

    const testInput = screen.getByTestId('ip-allowlist-test-ip');
    fireEvent.change(testInput, { target: { value: '10.0.0.5' } });
    fireEvent.click(screen.getByTestId('ip-allowlist-test-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('ip-allowlist-test-outcome')).toHaveTextContent('allowed');
    });

    const save = screen.getByTestId('ip-allowlist-save-btn');
    await waitFor(() => expect(save).not.toBeDisabled());

    await act(async () => {
      fireEvent.click(save);
    });

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith('IP allowlist saved');
    });

    // Verify the PUT body was the parsed config.
    const putCall = fetchSpy.mock.calls.find((call) => {
      const url = typeof call[0] === 'string' ? call[0] : (call[0] as Request).url;
      const method = (call[1]?.method ?? '').toUpperCase();
      return url.includes('/admin/ip-allowlist') &&
        !url.includes('/test') &&
        method === 'PUT';
    });
    expect(putCall).toBeDefined();
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body).toEqual({
      enabled: true,
      cidrs: ['10.0.0.0/8', '172.16.0.0/12', '192.168.2.0/24'],
      trustedProxies: ['127.0.0.1/32', '::1/128'],
      exceptions: defaultConfig.exceptions,
    });
  });

  it('PUT on 400 invalid_cidr shows the offending CIDR in the inline error', async () => {
    mockFetch({ putBehaviour: 'invalid_cidr', putInvalidCidr: '999.999.0.0/8' });
    render(<IpAllowlistTab />, { wrapper: createWrapper() });

    const cidrs = await screen.findByTestId('ip-allowlist-cidrs');
    fireEvent.change(cidrs, { target: { value: '999.999.0.0/8' } });

    // Confirm test (so save is enabled).
    const testInput = screen.getByTestId('ip-allowlist-test-ip');
    fireEvent.change(testInput, { target: { value: '10.0.0.5' } });
    fireEvent.click(screen.getByTestId('ip-allowlist-test-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('ip-allowlist-test-outcome')).toHaveTextContent('allowed');
    });

    const save = screen.getByTestId('ip-allowlist-save-btn');
    await waitFor(() => expect(save).not.toBeDisabled());

    await act(async () => {
      fireEvent.click(save);
    });

    await waitFor(() => {
      expect(screen.getByTestId('ip-allowlist-cidrs-error')).toHaveTextContent(
        '999.999.0.0/8',
      );
    });
    expect(toastError).toHaveBeenCalled();
  });

  it('lockout warning box is visible and has role="alert"', async () => {
    mockFetch();
    render(<IpAllowlistTab />, { wrapper: createWrapper() });

    const warning = await screen.findByTestId('ip-allowlist-warning');
    expect(warning).toHaveAttribute('role', 'alert');
    expect(warning).toHaveTextContent(
      /Make sure your own IP is in the Allowed ranges before saving/,
    );
  });
});
