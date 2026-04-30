/**
 * Unit tests for ComplianceReportsTab.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LazyMotion, domMax } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ComplianceReportsTab } from './ComplianceReportsTab';
import { useAuthStore } from '../../stores/auth-store';

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { toast } from 'sonner';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <LazyMotion features={domMax}>{children}</LazyMotion>
      </QueryClientProvider>
    );
  };
}

const ALL_REPORTS = [
  'user_access',
  'admin_actions',
  'sync_data_flow',
  'auth_session',
  'ai_usage',
  'rbac_changes',
  'data_retention',
];

function setupCatalogue(opts: {
  catalogue?: string[];
  available?: string[];
  status?: number;
}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.endsWith('/api/admin/compliance-reports')) {
      if (opts.status && opts.status >= 400) {
        return new Response(JSON.stringify({ message: 'gated' }), {
          status: opts.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          catalogue: opts.catalogue ?? ALL_REPORTS,
          available: opts.available ?? ALL_REPORTS,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('not mocked', { status: 500 });
  });
}

beforeEach(() => {
  // Stub a logged-in admin so the auth header can be set.
  useAuthStore.setState({
    user: { id: 'u-admin', username: 'admin', role: 'admin', email: 'a@b.c' } as never,
    accessToken: 'test-token',
  });
  // Stub the DOM URL APIs the download path uses.
  Object.defineProperty(globalThis.URL, 'createObjectURL', {
    value: vi.fn(() => 'blob:mock'),
    writable: true,
    configurable: true,
  });
  Object.defineProperty(globalThis.URL, 'revokeObjectURL', {
    value: vi.fn(),
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────

describe('ComplianceReportsTab', () => {
  it('renders all 7 reports from the local catalogue', async () => {
    setupCatalogue({});
    render(<ComplianceReportsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('compliance-reports-tab')).toBeTruthy();
    });

    for (const id of ALL_REPORTS) {
      expect(screen.getByTestId(`compliance-report-card-${id}`)).toBeTruthy();
    }
  });

  it('shows Coming-Soon badges for reports the backend has not wired yet', async () => {
    setupCatalogue({
      catalogue: ALL_REPORTS,
      available: ['user_access'], // only one wired
    });
    render(<ComplianceReportsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('badge-available-user_access')).toBeTruthy();
    });
    // The other 6 should carry the coming-soon badge.
    expect(screen.getByTestId('badge-coming-soon-ai_usage')).toBeTruthy();
    expect(screen.getByTestId('badge-coming-soon-sync_data_flow')).toBeTruthy();
    expect(screen.getByTestId('badge-coming-soon-data_retention')).toBeTruthy();
  });

  it('disables the Generate button on Coming-Soon cards', async () => {
    setupCatalogue({ available: ['user_access'] });
    render(<ComplianceReportsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('generate-user_access')).toBeTruthy();
    });

    const wiredBtn = screen.getByTestId('generate-user_access') as HTMLButtonElement;
    expect(wiredBtn.disabled).toBe(false);

    const unwiredBtn = screen.getByTestId('generate-ai_usage') as HTMLButtonElement;
    expect(unwiredBtn.disabled).toBe(true);
  });

  it('rejects ranges where from >= to with an inline validation message', async () => {
    setupCatalogue({});
    render(<ComplianceReportsTab />, { wrapper: createWrapper() });

    await waitFor(() => screen.getByTestId('from-user_access'));

    const fromInput = screen.getByTestId('from-user_access') as HTMLInputElement;
    const toInput = screen.getByTestId('to-user_access') as HTMLInputElement;

    fireEvent.change(fromInput, { target: { value: '2026-04-20T00:00' } });
    fireEvent.change(toInput, { target: { value: '2026-04-10T00:00' } });

    expect(screen.getByTestId('validation-error-user_access').textContent).toContain(
      'From must be earlier than to',
    );
    const btn = screen.getByTestId('generate-user_access') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('rejects to-dates more than 24h in the future', async () => {
    setupCatalogue({});
    render(<ComplianceReportsTab />, { wrapper: createWrapper() });

    await waitFor(() => screen.getByTestId('from-user_access'));

    // Pick a date 7 days in the future.
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const futureLocal =
      `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}` +
      `T${String(future.getHours()).padStart(2, '0')}:${String(future.getMinutes()).padStart(2, '0')}`;

    fireEvent.change(screen.getByTestId('to-user_access') as HTMLInputElement, {
      target: { value: futureLocal },
    });

    expect(screen.getByTestId('validation-error-user_access').textContent).toContain(
      'cannot be more than 24 hours in the future',
    );
  });

  it('POSTs to /generate and triggers a blob download on success', async () => {
    const fetchSpy = setupCatalogue({});
    // Add a second mock for the generate endpoint that returns a ZIP.
    fetchSpy.mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.endsWith('/api/admin/compliance-reports')) {
        return new Response(
          JSON.stringify({ catalogue: ALL_REPORTS, available: ALL_REPORTS }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/api/admin/compliance-reports/generate')) {
        // Verify the headers + body on the way out
        const headers = new Headers(init?.headers);
        expect(headers.get('Authorization')).toBe('Bearer test-token');
        const body = JSON.parse(String(init!.body));
        expect(body.reportId).toBe('user_access');
        expect(typeof body.from).toBe('string');
        expect(typeof body.to).toBe('string');
        // Use ArrayBuffer rather than a Blob constructor — jsdom's
        // Response.blob() fails with "object.stream is not a function"
        // when constructed from a Blob input.
        return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
          status: 200,
          headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': 'attachment; filename="compliance-user_access-2026-04-30.zip"',
            'X-Report-Sha256': 'a'.repeat(64),
          },
        });
      }
      return new Response('not mocked', { status: 500 });
    });

    // Spy on HTMLElement.prototype.click so any anchor created later —
    // including the throwaway one in the download path — picks up the
    // stub. jsdom defines click() on HTMLElement, not on the per-tag
    // subclass prototype; spying on HTMLAnchorElement.prototype is a
    // no-op because the resolution walks up to HTMLElement first.
    const clickSpy = vi
      .spyOn(HTMLElement.prototype, 'click')
      .mockImplementation(() => {});

    render(<ComplianceReportsTab />, { wrapper: createWrapper() });

    await waitFor(() => screen.getByTestId('generate-user_access'));
    fireEvent.click(screen.getByTestId('generate-user_access'));

    await waitFor(
      () => {
        // Fetch should have been called for both catalogue + generate.
        const generateCalls = fetchSpy.mock.calls.filter((c) => {
          const url = typeof c[0] === 'string' ? c[0] : (c[0] as Request).url;
          return url.endsWith('/compliance-reports/generate');
        });
        expect(generateCalls.length).toBeGreaterThan(0);
      },
      { timeout: 3000 },
    );

    // The toast.success call is the most reliable signal that the
    // download happened — the click on the prototype is only cosmetic
    // (the test environment can't actually trigger a download anyway).
    await waitFor(() => {
      const calls = (toast.success as ReturnType<typeof vi.fn>).mock.calls;
      const errorCalls = (toast.error as ReturnType<typeof vi.fn>).mock.calls;
      // Surface the error text in the assertion message so a future
      // failure points at the actual root cause instead of timing out.
      expect(
        calls,
        `toast.error calls: ${JSON.stringify(errorCalls)}`,
      ).toHaveLength(1);
      expect(calls[0]![0]).toMatch(/SHA-256|generated/i);
    });
    // Best-effort: anchor click should have been invoked too. Not
    // load-bearing — the success toast is the canonical signal.
    expect(clickSpy).toHaveBeenCalled();
  });

  it('shows an error toast when /generate returns 400', async () => {
    const fetchSpy = setupCatalogue({});
    fetchSpy.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.endsWith('/api/admin/compliance-reports')) {
        return new Response(
          JSON.stringify({ catalogue: ALL_REPORTS, available: ALL_REPORTS }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/api/admin/compliance-reports/generate')) {
        return new Response(
          JSON.stringify({ error: 'BadRequest', message: 'Invalid range', statusCode: 400 }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('not mocked', { status: 500 });
    });

    render(<ComplianceReportsTab />, { wrapper: createWrapper() });

    await waitFor(() => screen.getByTestId('generate-user_access'));
    fireEvent.click(screen.getByTestId('generate-user_access'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Invalid range');
    });
  });

  it('renders the EE-gated message when the catalogue endpoint returns 404', async () => {
    setupCatalogue({ status: 404 });
    render(<ComplianceReportsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('compliance-reports-gated')).toBeTruthy();
    });
    expect(screen.queryByTestId('compliance-reports-tab')).toBeNull();
  });
});
