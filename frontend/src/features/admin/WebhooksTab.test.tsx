import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { LazyMotion, domMax } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  WebhookDelivery,
  WebhookSubscription,
  TestWebhookDeliveryResponse,
} from '@compendiq/contracts';
import { WebhooksTab } from './WebhooksTab';
import { useAuthStore } from '../../stores/auth-store';

// ── Sonner toast mocks ────────────────────────────────────────────────────
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

// ── Enterprise hook mock ──────────────────────────────────────────────────
let mockIsEnterprise = true;
let mockHasFeature: (f: string) => boolean = () => true;

vi.mock('../../shared/enterprise/use-enterprise', () => ({
  useEnterprise: () => ({
    isEnterprise: mockIsEnterprise,
    hasFeature: (f: string) => mockHasFeature(f),
    ui: null,
    license: null,
    isLoading: false,
  }),
}));

// ── Test wrapper ──────────────────────────────────────────────────────────
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
        <LazyMotion features={domMax}>{children}</LazyMotion>
      </QueryClientProvider>
    );
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────
const baseSubscription: WebhookSubscription = {
  id: 'wh_1',
  label: 'Slack ingress',
  url: 'https://hooks.example.com/ingest',
  eventTypes: ['page.created', 'page.updated'],
  active: true,
  secretHint: 'abcd',
  hasSecondarySecret: false,
  secretSecondaryAddedAt: null,
  createdAt: '2026-04-01T00:00:00.000Z',
  updatedAt: '2026-04-01T00:00:00.000Z',
};

const baseDelivery: WebhookDelivery = {
  id: 'del_1',
  outboxId: 'out_1',
  webhookId: 'wh_1',
  attemptNumber: 1,
  status: 'success',
  httpStatus: 200,
  responseBody: '{"ok":true}',
  errorMessage: null,
  durationMs: 142,
  attemptedAt: '2026-04-24T09:00:00.000Z',
};

// ── Fetch mock ────────────────────────────────────────────────────────────
interface MockOptions {
  subscriptions?: WebhookSubscription[];
  createError?: { status: number; body: Record<string, unknown> };
  testResponse?: TestWebhookDeliveryResponse;
  rotateResponse?: {
    subscription: WebhookSubscription;
    secondaryActiveUntil: string;
  };
  deliveries?: WebhookDelivery[];
  lastDelivery?: WebhookDelivery | null;
}

function mockFetch(options: MockOptions = {}) {
  const subs = options.subscriptions ?? [baseSubscription];
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = (init?.method ?? 'GET').toUpperCase();

      // GET list
      if (
        url.endsWith('/admin/webhooks') ||
        url.endsWith('/api/admin/webhooks')
      ) {
        if (method === 'GET') {
          return new Response(JSON.stringify({ subscriptions: subs }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (method === 'POST') {
          if (options.createError) {
            return new Response(JSON.stringify(options.createError.body), {
              status: options.createError.status,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return new Response(
            JSON.stringify({ subscription: { ...baseSubscription, id: 'wh_new' } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
      }

      // Last-delivery lazy fetch (limit=1)
      if (url.includes('/deliveries?limit=1')) {
        const last = options.lastDelivery === undefined ? baseDelivery : options.lastDelivery;
        return new Response(
          JSON.stringify({ deliveries: last ? [last] : [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // Full delivery history
      if (url.includes('/deliveries?limit=50')) {
        const deliveries = options.deliveries ?? [baseDelivery];
        return new Response(JSON.stringify({ deliveries }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // /test
      if (url.includes('/test') && method === 'POST') {
        const response: TestWebhookDeliveryResponse = options.testResponse ?? {
          status: 'success',
          httpStatus: 200,
          durationMs: 87,
        };
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // /rotate-secret
      if (url.includes('/rotate-secret') && method === 'POST') {
        const response = options.rotateResponse ?? {
          subscription: baseSubscription,
          secondaryActiveUntil: '2026-04-25T09:00:00.000Z',
        };
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // PUT update (toggle active, edit)
      if (/\/admin\/webhooks\/[^/]+$/.test(url) && method === 'PUT') {
        return new Response(
          JSON.stringify({ subscription: baseSubscription }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // DELETE
      if (/\/admin\/webhooks\/[^/]+$/.test(url) && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }

      return new Response('Not found', { status: 404 });
    });
}

// ── Tests ─────────────────────────────────────────────────────────────────
describe('WebhooksTab', () => {
  beforeEach(() => {
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'admin',
      role: 'admin',
    });
    mockIsEnterprise = true;
    mockHasFeature = () => true;
    toastSuccess.mockClear();
    toastError.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('renders the list from GET /api/admin/webhooks', async () => {
    mockFetch();
    render(<WebhooksTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('webhook-row-wh_1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('webhook-label-wh_1')).toHaveTextContent('Slack ingress');
    expect(screen.getByTestId('webhook-url-wh_1')).toHaveTextContent(
      'https://hooks.example.com/ingest',
    );
    expect(screen.getByTestId('webhook-secret-hint-wh_1')).toHaveTextContent('abcd');
  });

  it('renders an empty state when no subscriptions exist', async () => {
    mockFetch({ subscriptions: [] });
    render(<WebhooksTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('webhooks-empty')).toBeInTheDocument();
    });
  });

  it('create dialog submits POST with correct body; closes + refetches on success', async () => {
    const fetchSpy = mockFetch();
    render(<WebhooksTab />, { wrapper: createWrapper() });

    await waitFor(() => screen.getByTestId('webhooks-tab'));

    fireEvent.click(screen.getByTestId('webhooks-new-btn'));

    // Fill URL
    fireEvent.change(screen.getByTestId('webhook-url-input'), {
      target: { value: 'https://example.com/hook' },
    });
    // Select an event type
    fireEvent.click(screen.getByTestId('webhook-event-checkbox-page.created'));
    // Set a secret
    fireEvent.change(screen.getByTestId('webhook-secret-input'), {
      target: { value: 'this-is-a-strong-secret-32' },
    });

    const save = screen.getByTestId('webhook-save-btn');
    expect(save).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(save);
    });

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith('Webhook created');
    });

    // POST body assertion
    const postCall = fetchSpy.mock.calls.find((call) => {
      const url = typeof call[0] === 'string' ? call[0] : (call[0] as Request).url;
      const method = (call[1]?.method ?? '').toUpperCase();
      return url.endsWith('/admin/webhooks') && method === 'POST';
    });
    expect(postCall).toBeDefined();
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body).toEqual({
      url: 'https://example.com/hook',
      eventTypes: ['page.created'],
      secret: 'this-is-a-strong-secret-32',
    });

    // Dialog closed
    await waitFor(() => {
      expect(screen.queryByTestId('webhook-create-dialog')).not.toBeInTheDocument();
    });
  });

  it('create dialog shows inline error on 400 invalid_url', async () => {
    mockFetch({
      createError: {
        status: 400,
        body: { error: 'invalid_url', detail: 'URL points to an internal host' },
      },
    });
    render(<WebhooksTab />, { wrapper: createWrapper() });

    await waitFor(() => screen.getByTestId('webhooks-tab'));
    fireEvent.click(screen.getByTestId('webhooks-new-btn'));

    fireEvent.change(screen.getByTestId('webhook-url-input'), {
      target: { value: 'https://example.com/hook' },
    });
    fireEvent.click(screen.getByTestId('webhook-event-checkbox-page.created'));
    fireEvent.change(screen.getByTestId('webhook-secret-input'), {
      target: { value: 'long-enough-secret-value' },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('webhook-save-btn'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('webhook-url-error')).toHaveTextContent(
        'URL points to an internal host',
      );
    });
    // Dialog still open (inline error, not a close)
    expect(screen.getByTestId('webhook-create-dialog')).toBeInTheDocument();
  });

  it('toggle active calls PUT with { active: false }', async () => {
    const fetchSpy = mockFetch();
    render(<WebhooksTab />, { wrapper: createWrapper() });

    const toggle = await screen.findByTestId('webhook-toggle-wh_1');
    expect(toggle).toHaveAttribute('data-state', 'checked');

    await act(async () => {
      fireEvent.click(toggle);
    });

    await waitFor(() => {
      const putCall = fetchSpy.mock.calls.find((call) => {
        const url = typeof call[0] === 'string' ? call[0] : (call[0] as Request).url;
        const method = (call[1]?.method ?? '').toUpperCase();
        return url.endsWith('/admin/webhooks/wh_1') && method === 'PUT';
      });
      expect(putCall).toBeDefined();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      expect(body).toEqual({ active: false });
    });
  });

  it('rotate-secret dialog submits POST /rotate-secret and surfaces secondaryActiveUntil', async () => {
    mockFetch({
      rotateResponse: {
        subscription: baseSubscription,
        secondaryActiveUntil: '2026-04-25T09:00:00.000Z',
      },
    });
    render(<WebhooksTab />, { wrapper: createWrapper() });

    await waitFor(() => screen.getByTestId('webhook-row-wh_1'));
    fireEvent.click(screen.getByTestId('webhook-rotate-btn-wh_1'));

    await waitFor(() => screen.getByTestId('webhook-rotate-dialog'));

    fireEvent.change(screen.getByTestId('webhook-rotate-secret-input'), {
      target: { value: 'brand-new-strong-secret-xyz' },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('webhook-rotate-submit-btn'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('webhook-rotate-result')).toBeInTheDocument();
    });
    // The `until` text is a localized Date string — assert that the ISO has been
    // parsed and rendered (year + "2026" will always appear in any locale).
    expect(screen.getByTestId('webhook-rotate-until').textContent).toMatch(/2026/);
    expect(toastSuccess).toHaveBeenCalledWith('Secret rotated');
  });

  it('rotate-secret Save is disabled when the new-secret last-4 matches the current hint', async () => {
    mockFetch();
    render(<WebhooksTab />, { wrapper: createWrapper() });

    await waitFor(() => screen.getByTestId('webhook-row-wh_1'));
    fireEvent.click(screen.getByTestId('webhook-rotate-btn-wh_1'));

    // Current hint is 'abcd' (see baseSubscription); any value ending in abcd
    // trips the guard.
    fireEvent.change(screen.getByTestId('webhook-rotate-secret-input'), {
      target: { value: 'this-long-enough-secret-abcd' },
    });

    expect(screen.getByTestId('webhook-rotate-submit-btn')).toBeDisabled();
    expect(screen.getByTestId('webhook-rotate-reuse-warning')).toBeInTheDocument();
  });

  it('test dialog renders success branch', async () => {
    mockFetch({
      testResponse: { status: 'success', httpStatus: 200, durationMs: 42 },
    });
    render(<WebhooksTab />, { wrapper: createWrapper() });

    await waitFor(() => screen.getByTestId('webhook-row-wh_1'));
    fireEvent.click(screen.getByTestId('webhook-test-btn-wh_1'));

    await waitFor(() => screen.getByTestId('webhook-test-dialog'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('webhook-test-submit-btn'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('webhook-test-status')).toHaveTextContent(
        'Delivery succeeded',
      );
    });
    expect(screen.getByTestId('webhook-test-http-status')).toHaveTextContent('200');
    expect(screen.getByTestId('webhook-test-duration')).toHaveTextContent('42 ms');
    expect(toastSuccess).toHaveBeenCalledWith('Test delivery succeeded');
  });

  it('test dialog renders failure branch with error message', async () => {
    mockFetch({
      testResponse: {
        status: 'failure',
        httpStatus: 502,
        durationMs: 512,
        errorMessage: 'Bad gateway from receiver',
      },
    });
    render(<WebhooksTab />, { wrapper: createWrapper() });

    await waitFor(() => screen.getByTestId('webhook-row-wh_1'));
    fireEvent.click(screen.getByTestId('webhook-test-btn-wh_1'));

    await waitFor(() => screen.getByTestId('webhook-test-dialog'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('webhook-test-submit-btn'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('webhook-test-status')).toHaveTextContent(
        'Delivery failed',
      );
    });
    expect(screen.getByTestId('webhook-test-error-message')).toHaveTextContent(
      'Bad gateway from receiver',
    );
    expect(toastError).toHaveBeenCalledWith('Test delivery failed');
  });

  it('delivery history renders the table and expands a row body', async () => {
    mockFetch({
      deliveries: [
        {
          ...baseDelivery,
          id: 'del_a',
          attemptNumber: 1,
          status: 'success',
          responseBody: 'OK: processed',
        },
        {
          ...baseDelivery,
          id: 'del_b',
          attemptNumber: 2,
          status: 'failure',
          httpStatus: 500,
          responseBody: 'internal error trace',
          errorMessage: 'server returned 500',
        },
      ],
    });
    render(<WebhooksTab />, { wrapper: createWrapper() });

    await waitFor(() => screen.getByTestId('webhook-row-wh_1'));
    fireEvent.click(screen.getByTestId('webhook-history-btn-wh_1'));

    await waitFor(() => screen.getByTestId('webhook-history-table'));
    expect(screen.getByTestId('webhook-delivery-row-del_a')).toBeInTheDocument();
    expect(screen.getByTestId('webhook-delivery-row-del_b')).toBeInTheDocument();

    // Expand the failed row
    fireEvent.click(screen.getByTestId('webhook-delivery-row-del_b'));
    await waitFor(() => {
      expect(
        screen.getByTestId('webhook-delivery-details-del_b'),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId('webhook-delivery-body-del_b')).toHaveTextContent(
      'internal error trace',
    );
    expect(screen.getByTestId('webhook-delivery-error-del_b')).toHaveTextContent(
      'server returned 500',
    );
  });

  it('delete button confirms + submits DELETE and refetches', async () => {
    const fetchSpy = mockFetch();
    render(<WebhooksTab />, { wrapper: createWrapper() });

    await waitFor(() => screen.getByTestId('webhook-row-wh_1'));
    fireEvent.click(screen.getByTestId('webhook-delete-btn-wh_1'));

    await waitFor(() => screen.getByTestId('webhook-delete-dialog'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('webhook-delete-confirm-btn'));
    });

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith('Webhook deleted');
    });

    const deleteCall = fetchSpy.mock.calls.find((call) => {
      const url = typeof call[0] === 'string' ? call[0] : (call[0] as Request).url;
      const method = (call[1]?.method ?? '').toUpperCase();
      return url.endsWith('/admin/webhooks/wh_1') && method === 'DELETE';
    });
    expect(deleteCall).toBeDefined();
  });

  it('event-type multi-select exposes only the hard-coded catalogue', async () => {
    mockFetch();
    render(<WebhooksTab />, { wrapper: createWrapper() });

    await waitFor(() => screen.getByTestId('webhooks-tab'));
    fireEvent.click(screen.getByTestId('webhooks-new-btn'));

    const expected = [
      'page.created',
      'page.updated',
      'page.deleted',
      'sync.completed',
      'ai.quality.complete',
      'ai.summary.complete',
    ];
    for (const ev of expected) {
      expect(screen.getByTestId(`webhook-event-checkbox-${ev}`)).toBeInTheDocument();
    }
    // And no surprise extras.
    expect(
      screen.getByTestId('webhook-events-select').querySelectorAll('input[type="checkbox"]')
        .length,
    ).toBe(expected.length);
  });

  it('auto-generate secret produces a ≥16-char string', async () => {
    mockFetch();
    render(<WebhooksTab />, { wrapper: createWrapper() });

    await waitFor(() => screen.getByTestId('webhooks-tab'));
    fireEvent.click(screen.getByTestId('webhooks-new-btn'));

    const secretInput = screen.getByTestId('webhook-secret-input') as HTMLInputElement;
    expect(secretInput.value).toBe('');

    fireEvent.click(screen.getByTestId('webhook-secret-generate-btn'));

    await waitFor(() => {
      expect(secretInput.value.length).toBeGreaterThanOrEqual(16);
    });
    // base64url charset
    expect(secretInput.value).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('renders a "not licensed" notice when useEnterprise.isEnterprise is false', () => {
    mockIsEnterprise = false;
    // mockHasFeature stays permissive; we test the outer guard.
    render(<WebhooksTab />, { wrapper: createWrapper() });
    expect(screen.getByTestId('webhooks-not-licensed')).toBeInTheDocument();
    expect(screen.queryByTestId('webhooks-tab')).not.toBeInTheDocument();
  });

  it('renders the "not licensed" notice when webhook_push feature flag is absent', () => {
    mockIsEnterprise = true;
    mockHasFeature = (f) => f !== 'webhook_push';
    render(<WebhooksTab />, { wrapper: createWrapper() });
    expect(screen.getByTestId('webhooks-not-licensed')).toBeInTheDocument();
    expect(screen.queryByTestId('webhooks-tab')).not.toBeInTheDocument();
  });
});
