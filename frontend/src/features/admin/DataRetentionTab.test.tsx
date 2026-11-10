import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domMax } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DataRetentionTab } from './DataRetentionTab';
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

// #1875 — same providers, but the client is returned so a test can drive a
// background refetch of the shared ['admin-settings'] query.
function createWrapperWithClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <LazyMotion features={domMax}>
            {children}
          </LazyMotion>
        </MemoryRouter>
      </QueryClientProvider>
    );
  }
  return { wrapper: Wrapper, queryClient };
}

// Matches backend `RetentionConfig` returned by GET /admin/data-retention.
const mockRetentionConfig = {
  policies: [
    { tableName: 'llm_audit_log', displayName: 'LLM Audit Log', retentionDays: 90, enabled: true },
    { tableName: 'audit_log', displayName: 'Audit Log', retentionDays: 30, enabled: true },
    { tableName: 'error_log', displayName: 'Error Log', retentionDays: 0, enabled: false },
  ],
  extendedRetentionEnabled: false,
  extendedRetentionDays: 365,
};

// Matches backend `RetentionPreview[]` from GET /admin/data-retention/preview.
const mockPreview = [
  { tableName: 'llm_audit_log', displayName: 'LLM Audit Log', retentionDays: 90, estimatedRows: 1250 },
  { tableName: 'audit_log', displayName: 'Audit Log', retentionDays: 30, estimatedRows: 340 },
  { tableName: 'error_log', displayName: 'Error Log', retentionDays: 0, estimatedRows: 0 },
];

// #264 / #1875 — GET /admin/settings is consumed by RetentionWindowsSection.
// Default to 90 (matches backend default) but overridable per test. A PUT
// persists into this object, like the real UPSERT of only the supplied keys.
type RetentionSettingsFixture = Partial<
  Record<'adminAccessDeniedRetentionDays' | 'webhookDeliveriesRetentionDays', number>
>;
let mockAdminSettings: RetentionSettingsFixture = {
  adminAccessDeniedRetentionDays: 90,
};
// #1875 — failure injection: the next N GETs of /admin/settings answer 500,
// and a PUT handler can replace the default persisting 200.
let settingsGetFailures = 0;
let settingsPutResponse: (() => Promise<Response>) | null = null;

function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = init && typeof init === 'object' && 'method' in init ? (init as RequestInit).method : 'GET';

    if (url.includes('/admin/data-retention/preview')) {
      return new Response(JSON.stringify(mockPreview), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/admin/data-retention/purge') && method === 'POST') {
      return new Response(
        JSON.stringify({
          results: [
            { tableName: 'llm_audit_log', displayName: 'LLM Audit Log', deletedRows: 1250 },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/admin/data-retention')) {
      return new Response(JSON.stringify(mockRetentionConfig), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/admin/settings')) {
      if (method === 'PUT') {
        if (settingsPutResponse) return settingsPutResponse();
        Object.assign(mockAdminSettings, JSON.parse((init as RequestInit).body as string));
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (settingsGetFailures > 0) {
        settingsGetFailures -= 1;
        return new Response(JSON.stringify({ message: 'Database unavailable' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ...mockAdminSettings }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({}), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

function settingsPutCalls(fetchSpy: MockInstance<typeof fetch>) {
  return fetchSpy.mock.calls.filter(
    ([url, opts]) =>
      typeof url === 'string' &&
      url.includes('/admin/settings') &&
      (opts as RequestInit | undefined)?.method === 'PUT',
  );
}

function settingsGetCount(fetchSpy: MockInstance<typeof fetch>) {
  return fetchSpy.mock.calls.filter(
    ([url, opts]) =>
      typeof url === 'string' &&
      url.includes('/admin/settings') &&
      ((opts as RequestInit | undefined)?.method ?? 'GET') === 'GET',
  ).length;
}

function putBody(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('DataRetentionTab', () => {
  beforeEach(() => {
    mockHasFeature = () => true;
    mockAdminSettings = { adminAccessDeniedRetentionDays: 90 };
    settingsGetFailures = 0;
    settingsPutResponse = null;
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
    render(<DataRetentionTab />, { wrapper: createWrapper() });
    expect(screen.getByTestId('data-retention-gated')).toBeInTheDocument();
    expect(screen.getByText('Enterprise Feature')).toBeInTheDocument();
  });

  it('renders the retention form when feature is enabled', async () => {
    mockFetch();
    render(<DataRetentionTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('data-retention-form')).toBeInTheDocument();
    });
  });

  it('displays per-table policies with displayName + tableName from the API', async () => {
    mockFetch();
    render(<DataRetentionTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('retention-rules-table')).toBeInTheDocument();
    });
    expect(screen.getByText('LLM Audit Log')).toBeInTheDocument();
    expect(screen.getByText('llm_audit_log')).toBeInTheDocument();
    expect(screen.getByText('audit_log')).toBeInTheDocument();
    expect(screen.getByText('error_log')).toBeInTheDocument();
  });

  it('has extended retention toggle and days input', async () => {
    mockFetch();
    render(<DataRetentionTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('extended-retention-toggle')).toBeInTheDocument();
    });
    expect(screen.getByTestId('extended-retention-days-input')).toBeInTheDocument();
  });

  it('shows preview results when preview button is clicked', async () => {
    mockFetch();
    render(<DataRetentionTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('preview-purge-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('preview-purge-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('preview-results')).toBeInTheDocument();
    });
    // estimatedRows from mock
    expect(screen.getByText('1,250')).toBeInTheDocument();
    expect(screen.getByText('340')).toBeInTheDocument();
  });

  it('shows purge confirmation dialog requiring type-to-confirm', async () => {
    mockFetch();
    render(<DataRetentionTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('purge-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('purge-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('purge-confirm-dialog')).toBeInTheDocument();
    });

    // Confirm button should be disabled until user types PURGE
    expect(screen.getByTestId('purge-confirm-btn')).toBeDisabled();

    fireEvent.change(screen.getByTestId('purge-confirm-input'), { target: { value: 'PURGE' } });
    expect(screen.getByTestId('purge-confirm-btn')).not.toBeDisabled();
  });

  it('has a save button', async () => {
    mockFetch();
    render(<DataRetentionTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('data-retention-save-btn')).toBeInTheDocument();
    });
  });

  it('submits PUT with policies/extendedRetentionEnabled/extendedRetentionDays matching the backend schema', async () => {
    const fetchSpy = mockFetch();
    render(<DataRetentionTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('data-retention-save-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('data-retention-save-btn'));

    await waitFor(() => {
      const putCall = fetchSpy.mock.calls.find(
        ([url, opts]) =>
          typeof url === 'string' &&
          url.includes('/admin/data-retention') &&
          !url.includes('/preview') &&
          !url.includes('/purge') &&
          opts && typeof opts === 'object' && 'method' in opts && (opts as RequestInit).method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      expect(Array.isArray(body.policies)).toBe(true);
      expect(body.policies[0]).toHaveProperty('tableName');
      expect(body.policies[0]).toHaveProperty('retentionDays');
      expect(body.policies[0]).not.toHaveProperty('table');
      expect(typeof body.extendedRetentionEnabled).toBe('boolean');
      expect(typeof body.extendedRetentionDays).toBe('number');
    });
  });

  // ─── #264 — denied-admin retention (CE-native) ──────────────────────────
  describe('AdminAccessDeniedRetentionSection (#264)', () => {
    it('renders the server value from /admin/settings', async () => {
      mockAdminSettings = { adminAccessDeniedRetentionDays: 45 };
      mockFetch();
      render(<DataRetentionTab />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByTestId('admin-denied-retention-input')).toBeInTheDocument();
      });
      const input = screen.getByTestId('admin-denied-retention-input') as HTMLInputElement;
      expect(input.value).toBe('45');
    });

    it('falls back to 90 (default) when the server omits the field', async () => {
      // Simulate an older backend that has not yet been upgraded.
      mockAdminSettings = {} as { adminAccessDeniedRetentionDays: number };
      mockFetch();
      render(<DataRetentionTab />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByTestId('admin-denied-retention-input')).toBeInTheDocument();
      });
      const input = screen.getByTestId('admin-denied-retention-input') as HTMLInputElement;
      expect(input.value).toBe('90');
    });

    it('PUT /admin/settings carries only adminAccessDeniedRetentionDays when the save button is used', async () => {
      const fetchSpy = mockFetch();
      render(<DataRetentionTab />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByTestId('admin-denied-retention-input')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByTestId('admin-denied-retention-input'), { target: { value: '30' } });
      fireEvent.click(screen.getByTestId('admin-denied-retention-save-btn'));

      await waitFor(() => {
        const putCall = fetchSpy.mock.calls.find(
          ([url, opts]) =>
            typeof url === 'string' &&
            url.includes('/admin/settings') &&
            opts &&
            typeof opts === 'object' &&
            'method' in opts &&
            (opts as RequestInit).method === 'PUT',
        );
        expect(putCall).toBeTruthy();
        const body = JSON.parse((putCall![1] as RequestInit).body as string) as {
          adminAccessDeniedRetentionDays?: number;
        };
        expect(body.adminAccessDeniedRetentionDays).toBe(30);
        // Nothing else in the payload — this save button is single-field.
        expect(Object.keys(body)).toEqual(['adminAccessDeniedRetentionDays']);
      });
    });

    it('save button is disabled until the value diverges from the server state', async () => {
      mockAdminSettings = { adminAccessDeniedRetentionDays: 90 };
      const fetchSpy = mockFetch();
      render(<DataRetentionTab />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByTestId('admin-denied-retention-save-btn')).toBeInTheDocument();
      });
      // #1875: unavailability is aria-disabled (focus survives), so it is
      // proven by the attribute AND by a save attempt that sends nothing.
      expect(screen.getByTestId('admin-denied-retention-save-btn')).toHaveAttribute('aria-disabled', 'true');
      await act(async () => {
        fireEvent.click(screen.getByTestId('admin-denied-retention-save-btn'));
      });
      expect(settingsPutCalls(fetchSpy)).toHaveLength(0);

      fireEvent.change(screen.getByTestId('admin-denied-retention-input'), { target: { value: '120' } });
      expect(screen.getByTestId('admin-denied-retention-save-btn')).not.toHaveAttribute('aria-disabled');
    });

    it('renders the CE-native section even when the Enterprise data_retention_policies feature is gated off', async () => {
      mockHasFeature = () => false;
      mockFetch();
      render(<DataRetentionTab />, { wrapper: createWrapper() });

      // CE-native control visible
      await waitFor(() => {
        expect(screen.getByTestId('admin-denied-retention-input')).toBeInTheDocument();
      });
      // Enterprise-feature gate still present below it
      expect(screen.getByTestId('data-retention-gated')).toBeInTheDocument();
    });
  });

  // ─── #1875 — retention windows (webhook delivery ledger + shared row) ─────
  describe('Retention windows (#1875)', () => {
    const VALIDATION_MESSAGE = 'Enter a whole number from 7 to 3650.';
    const WEBHOOK_INPUT = 'webhook-deliveries-retention-input';
    const WEBHOOK_SAVE = 'webhook-deliveries-retention-save-btn';
    const WEBHOOK_ROW = 'webhook-deliveries-retention-section';
    const DENIED_INPUT = 'admin-denied-retention-input';
    const DENIED_SAVE = 'admin-denied-retention-save-btn';

    const ROWS = [
      {
        name: 'webhook deliveries',
        field: 'webhookDeliveriesRetentionDays',
        input: WEBHOOK_INPUT,
        save: WEBHOOK_SAVE,
        row: WEBHOOK_ROW,
      },
      {
        name: 'admin access-denied',
        field: 'adminAccessDeniedRetentionDays',
        input: DENIED_INPUT,
        save: DENIED_SAVE,
        row: 'denied-admin-retention-section',
      },
    ] as const;

    async function renderLoaded() {
      const fetchSpy = mockFetch();
      const { wrapper, queryClient } = createWrapperWithClient();
      render(<DataRetentionTab />, { wrapper });
      await screen.findByTestId(WEBHOOK_INPUT);
      return { fetchSpy, queryClient };
    }

    function inputValue(testId: string) {
      return (screen.getByTestId(testId) as HTMLInputElement).value;
    }

    it('renders the server webhookDeliveriesRetentionDays value', async () => {
      mockAdminSettings = { adminAccessDeniedRetentionDays: 45, webhookDeliveriesRetentionDays: 120 };
      await renderLoaded();

      expect(inputValue(WEBHOOK_INPUT)).toBe('120');
      expect(inputValue(DENIED_INPUT)).toBe('45');
    });

    it('falls back to 90 when an older backend omits webhookDeliveriesRetentionDays', async () => {
      mockAdminSettings = { adminAccessDeniedRetentionDays: 45 };
      await renderLoaded();

      expect(inputValue(WEBHOOK_INPUT)).toBe('90');
      expect(inputValue(DENIED_INPUT)).toBe('45');
    });

    it('renders the webhook window even when the Enterprise data_retention_policies feature is gated off', async () => {
      mockHasFeature = () => false;
      await renderLoaded();

      expect(screen.getByTestId(WEBHOOK_INPUT)).toBeInTheDocument();
      expect(screen.getByTestId('data-retention-gated')).toBeInTheDocument();
    });

    describe.each(ROWS)('$name validation', (row) => {
      it.each(['7', '3650'])('accepts the boundary %s and saves it', async (value) => {
        mockAdminSettings = { adminAccessDeniedRetentionDays: 90, webhookDeliveriesRetentionDays: 90 };
        const { fetchSpy } = await renderLoaded();

        fireEvent.change(screen.getByTestId(row.input), { target: { value } });
        fireEvent.blur(screen.getByTestId(row.input));
        expect(screen.getByTestId(row.input)).not.toHaveAttribute('aria-invalid');
        expect(screen.queryByText(VALIDATION_MESSAGE)).not.toBeInTheDocument();
        expect(screen.getByTestId(row.save)).not.toHaveAttribute('aria-disabled');

        fireEvent.click(screen.getByTestId(row.save));
        await waitFor(() => expect(settingsPutCalls(fetchSpy)).toHaveLength(1));
        expect(putBody(settingsPutCalls(fetchSpy)[0]!)).toEqual({ [row.field]: Number(value) });
      });

      it.each(['6', '3651', '30.5', ''])('rejects %j inline and blocks saving', async (value) => {
        mockAdminSettings = { adminAccessDeniedRetentionDays: 90, webhookDeliveriesRetentionDays: 90 };
        const { fetchSpy } = await renderLoaded();
        const input = screen.getByTestId(row.input);

        fireEvent.change(input, { target: { value } });
        expect(input).toHaveAttribute('aria-invalid', 'true');
        expect(screen.getByTestId(row.save)).toHaveAttribute('aria-disabled', 'true');
        // The message waits for blur so typing towards a valid value is quiet.
        expect(screen.queryByText(VALIDATION_MESSAGE)).not.toBeInTheDocument();

        fireEvent.blur(input);
        const message = screen.getByText(VALIDATION_MESSAGE);
        expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(message.id);

        // Enter (form submit) and a click both refuse; flush before asserting.
        await act(async () => {
          fireEvent.submit(screen.getByTestId(row.row));
        });
        await act(async () => {
          fireEvent.click(screen.getByTestId(row.save));
        });
        expect(settingsPutCalls(fetchSpy)).toHaveLength(0);
      });
    });

    it('enables Save only for a valid value that differs from the server value', async () => {
      mockAdminSettings = { adminAccessDeniedRetentionDays: 90, webhookDeliveriesRetentionDays: 90 };
      await renderLoaded();
      const save = screen.getByTestId(WEBHOOK_SAVE);

      expect(save).toHaveAttribute('aria-disabled', 'true');
      fireEvent.change(screen.getByTestId(WEBHOOK_INPUT), { target: { value: '120' } });
      expect(save).not.toHaveAttribute('aria-disabled');
      fireEvent.change(screen.getByTestId(WEBHOOK_INPUT), { target: { value: '90' } });
      expect(save).toHaveAttribute('aria-disabled', 'true');
      fireEvent.change(screen.getByTestId(WEBHOOK_INPUT), { target: { value: '090' } });
      expect(save).toHaveAttribute('aria-disabled', 'true');
    });

    it('PUTs only webhookDeliveriesRetentionDays, refreshes the settings and clears the draft', async () => {
      mockAdminSettings = { adminAccessDeniedRetentionDays: 90, webhookDeliveriesRetentionDays: 90 };
      const { fetchSpy, queryClient } = await renderLoaded();
      const getsBeforeSave = settingsGetCount(fetchSpy);

      fireEvent.change(screen.getByTestId(WEBHOOK_INPUT), { target: { value: '120' } });
      fireEvent.click(screen.getByTestId(WEBHOOK_SAVE));

      await waitFor(() => expect(settingsPutCalls(fetchSpy)).toHaveLength(1));
      const body = putBody(settingsPutCalls(fetchSpy)[0]!);
      expect(Object.keys(body)).toEqual(['webhookDeliveriesRetentionDays']);
      expect(body.webhookDeliveriesRetentionDays).toBe(120);

      await waitFor(() => expect(settingsGetCount(fetchSpy)).toBeGreaterThan(getsBeforeSave));
      await waitFor(() => expect(screen.getByTestId(WEBHOOK_SAVE)).toHaveAttribute('aria-disabled', 'true'));
      expect(inputValue(WEBHOOK_INPUT)).toBe('120');

      // The draft is gone: a later server change shows through instead of a
      // pinned '120'.
      mockAdminSettings.webhookDeliveriesRetentionDays = 150;
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      });
      await waitFor(() => expect(inputValue(WEBHOOK_INPUT)).toBe('150'));
    });

    it('keeps the draft and shows the server error inline when the save fails, then retries', async () => {
      mockAdminSettings = { adminAccessDeniedRetentionDays: 90, webhookDeliveriesRetentionDays: 90 };
      settingsPutResponse = async () =>
        new Response(JSON.stringify({ message: 'Retention window rejected by policy' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      const { fetchSpy } = await renderLoaded();

      fireEvent.change(screen.getByTestId(WEBHOOK_INPUT), { target: { value: '120' } });
      fireEvent.click(screen.getByTestId(WEBHOOK_SAVE));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(
        'Retention window rejected by policy. Your change has been kept. Retry saving.',
      );
      expect(inputValue(WEBHOOK_INPUT)).toBe('120');
      expect(screen.getByTestId(WEBHOOK_SAVE)).not.toHaveAttribute('aria-disabled');

      settingsPutResponse = null;
      fireEvent.click(screen.getByTestId(WEBHOOK_SAVE));
      await waitFor(() => expect(settingsPutCalls(fetchSpy)).toHaveLength(2));
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
      expect(mockAdminSettings.webhookDeliveriesRetentionDays).toBe(120);
    });

    it('sends one PUT for two activations in the same tick and shows the pending state', async () => {
      mockAdminSettings = { adminAccessDeniedRetentionDays: 90, webhookDeliveriesRetentionDays: 90 };
      const pendingPut = Promise.withResolvers<Response>();
      settingsPutResponse = () => pendingPut.promise;
      const { fetchSpy } = await renderLoaded();

      fireEvent.change(screen.getByTestId(WEBHOOK_INPUT), { target: { value: '120' } });
      fireEvent.click(screen.getByTestId(WEBHOOK_SAVE));
      fireEvent.click(screen.getByTestId(WEBHOOK_SAVE));

      await waitFor(() => expect(screen.getByTestId(WEBHOOK_SAVE)).toHaveAttribute('aria-busy', 'true'));
      expect(screen.getByTestId(WEBHOOK_SAVE)).toHaveTextContent('Saving…');
      expect(settingsPutCalls(fetchSpy)).toHaveLength(1);

      await act(async () => {
        pendingPut.resolve(new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        }));
      });
      await waitFor(() => expect(screen.getByTestId(WEBHOOK_SAVE)).not.toHaveAttribute('aria-busy'));
      expect(settingsPutCalls(fetchSpy)).toHaveLength(1);
    });

    it.each(['click', 'submit'] as const)(
      'a webhook save by %s never carries or clears the unsaved access-denied draft',
      async (activation) => {
        mockAdminSettings = { adminAccessDeniedRetentionDays: 90, webhookDeliveriesRetentionDays: 90 };
        const { fetchSpy } = await renderLoaded();
        const getsBeforeSave = settingsGetCount(fetchSpy);

        fireEvent.change(screen.getByTestId(DENIED_INPUT), { target: { value: '30' } });
        fireEvent.change(screen.getByTestId(WEBHOOK_INPUT), { target: { value: '120' } });
        await act(async () => {
          if (activation === 'click') fireEvent.click(screen.getByTestId(WEBHOOK_SAVE));
          else fireEvent.submit(screen.getByTestId(WEBHOOK_ROW));
        });

        await waitFor(() => expect(settingsPutCalls(fetchSpy)).toHaveLength(1));
        expect(Object.keys(putBody(settingsPutCalls(fetchSpy)[0]!))).toEqual(['webhookDeliveriesRetentionDays']);
        await waitFor(() => expect(settingsGetCount(fetchSpy)).toBeGreaterThan(getsBeforeSave));

        expect(inputValue(DENIED_INPUT)).toBe('30');
        expect(screen.getByTestId(DENIED_SAVE)).not.toHaveAttribute('aria-disabled');
        expect(mockAdminSettings.adminAccessDeniedRetentionDays).toBe(90);
      },
    );

    it('shows a read failure without inventing values, and Retry restores the rows and focus', async () => {
      settingsGetFailures = 1;
      mockFetch();
      render(<DataRetentionTab />, { wrapper: createWrapper() });

      await screen.findByText('Retention settings could not be read.');
      expect(screen.queryByTestId(WEBHOOK_INPUT)).not.toBeInTheDocument();
      expect(screen.queryByTestId(DENIED_INPUT)).not.toBeInTheDocument();

      const retry = screen.getByTestId('retention-windows-retry');
      retry.focus();
      fireEvent.click(retry);

      await screen.findByTestId(WEBHOOK_INPUT);
      expect(screen.queryByText('Retention settings could not be read.')).not.toBeInTheDocument();
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Retention windows' })),
      );
    });

    it('keeps cached values and unsaved drafts when a background refresh fails', async () => {
      mockAdminSettings = { adminAccessDeniedRetentionDays: 90, webhookDeliveriesRetentionDays: 90 };
      const { queryClient } = await renderLoaded();

      fireEvent.change(screen.getByTestId(DENIED_INPUT), { target: { value: '30' } });
      settingsGetFailures = 1;
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      });

      await screen.findByText(
        'Retention settings could not be refreshed. Last loaded values and unsaved edits are still shown.',
      );
      expect(inputValue(DENIED_INPUT)).toBe('30');
      expect(inputValue(WEBHOOK_INPUT)).toBe('90');
      expect(screen.getByTestId(DENIED_SAVE)).not.toHaveAttribute('aria-disabled');

      fireEvent.click(screen.getByTestId('retention-windows-retry'));
      await waitFor(() =>
        expect(screen.queryByTestId('retention-windows-retry')).not.toBeInTheDocument(),
      );
      expect(inputValue(DENIED_INPUT)).toBe('30');
    });
  });
});
