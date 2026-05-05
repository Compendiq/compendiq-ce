/**
 * Tests for AiReviewPolicyTab (Compendiq/compendiq-ee#120).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LazyMotion, domMax } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AiReviewPolicyTab } from './AiReviewPolicyTab';
import { useAuthStore } from '../../stores/auth-store';
import type { AiReviewPolicy } from '@compendiq/contracts';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const mockUseEnterprise = vi.fn();
vi.mock('../../shared/enterprise/use-enterprise', () => ({
  useEnterprise: () => mockUseEnterprise(),
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
        <LazyMotion features={domMax}>{children}</LazyMotion>
      </QueryClientProvider>
    );
  };
}

const samplePolicy: AiReviewPolicy = {
  enabled: true,
  default_mode: 'review-required',
  per_action_overrides: { auto_tag: 'auto-publish' },
  expire_after_days: 30,
};

interface MockOptions {
  policy?: AiReviewPolicy;
  getStatus?: 404 | 500;
  putStatus?: 200 | 400;
}

function mockFetch(opts: MockOptions = {}) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = (
        init?.method ??
        (input as Request)?.method ??
        'GET'
      ).toUpperCase();

      if (url.endsWith('/admin/ai-review/policy') && method === 'GET') {
        if (opts.getStatus === 404) {
          return new Response(JSON.stringify({ error: 'not_found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (opts.getStatus === 500) {
          return new Response(JSON.stringify({ message: 'boom' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({ policy: opts.policy ?? samplePolicy }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      if (url.endsWith('/admin/ai-review/policy') && method === 'PUT') {
        if (opts.putStatus === 400) {
          return new Response(
            JSON.stringify({ error: 'BadRequest' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const body = init?.body
          ? JSON.parse(init.body as string)
          : null;
        return new Response(JSON.stringify({ policy: body }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('Not found', { status: 404 });
    });
}

describe('AiReviewPolicyTab', () => {
  beforeEach(() => {
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'admin',
      email: 'admin@test',
      role: 'admin',
      displayName: null,
      isActive: true,
    });
    mockUseEnterprise.mockReturnValue({
      isEnterprise: true,
      hasFeature: (f: string) => f === 'ai_output_review',
      license: null,
      refresh: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders an upgrade prompt when the licence does not grant the feature', () => {
    mockUseEnterprise.mockReturnValue({
      isEnterprise: false,
      hasFeature: () => false,
      license: null,
      refresh: vi.fn(),
    });
    const Wrapper = createWrapper();
    render(<AiReviewPolicyTab />, { wrapper: Wrapper });
    expect(
      screen.getByTestId('ai-review-policy-not-licensed'),
    ).toBeInTheDocument();
  });

  it('hydrates the form from the loaded policy', async () => {
    mockFetch({ policy: samplePolicy });
    const Wrapper = createWrapper();
    render(<AiReviewPolicyTab />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.getByTestId('ai-review-policy-tab'),
      ).toBeInTheDocument();
    });

    const enabledToggle = screen.getByTestId(
      'ai-review-policy-enabled-toggle',
    ) as HTMLInputElement;
    expect(enabledToggle.checked).toBe(true);

    const reviewRequiredRadio = screen.getByTestId(
      'ai-review-policy-default-mode-radio-review-required',
    ) as HTMLInputElement;
    expect(reviewRequiredRadio.checked).toBe(true);

    const autoTagSelect = screen.getByTestId(
      'ai-review-policy-override-select-auto_tag',
    ) as HTMLSelectElement;
    expect(autoTagSelect.value).toBe('auto-publish');

    const expireDays = screen.getByTestId(
      'ai-review-policy-expire-days-input',
    ) as HTMLInputElement;
    expect(expireDays.value).toBe('30');
  });

  it('shows an EE-overlay-missing notice on 404', async () => {
    mockFetch({ getStatus: 404 });
    const Wrapper = createWrapper();
    render(<AiReviewPolicyTab />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(
        screen.getByTestId('ai-review-policy-overlay-missing'),
      ).toBeInTheDocument();
    });
    // Save button is disabled in this state.
    const saveBtn = screen.getByTestId(
      'ai-review-policy-save-btn',
    ) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });

  it('shows a generic error banner on 500', async () => {
    mockFetch({ getStatus: 500 });
    const Wrapper = createWrapper();
    render(<AiReviewPolicyTab />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByTestId('ai-review-policy-error')).toBeInTheDocument();
    });
  });

  it('disables Save until the form is dirty, then PUTs the new policy', async () => {
    const fetchSpy = mockFetch({ policy: samplePolicy });
    const Wrapper = createWrapper();
    render(<AiReviewPolicyTab />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.getByTestId('ai-review-policy-tab'),
      ).toBeInTheDocument();
    });

    const saveBtn = screen.getByTestId(
      'ai-review-policy-save-btn',
    ) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    // Toggle default mode to dirty the form.
    fireEvent.click(
      screen.getByTestId(
        'ai-review-policy-default-mode-radio-auto-publish',
      ),
    );

    await waitFor(() => {
      expect(saveBtn.disabled).toBe(false);
    });

    fireEvent.click(saveBtn);

    await waitFor(() => {
      const putCall = fetchSpy.mock.calls.find(
        (c) =>
          ((c[1]?.method ?? 'GET') as string).toUpperCase() === 'PUT' &&
          ((c[0] as string) ?? '').endsWith('/admin/ai-review/policy'),
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall![1]!.body as string);
      expect(body.default_mode).toBe('auto-publish');
      expect(body.enabled).toBe(true);
      expect(body.expire_after_days).toBe(30);
    });
  });

  it('lets the admin override a per-action mode', async () => {
    const fetchSpy = mockFetch({ policy: samplePolicy });
    const Wrapper = createWrapper();
    render(<AiReviewPolicyTab />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.getByTestId('ai-review-policy-override-row-improve'),
      ).toBeInTheDocument();
    });

    const select = screen.getByTestId(
      'ai-review-policy-override-select-improve',
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'auto-publish' } });

    fireEvent.click(screen.getByTestId('ai-review-policy-save-btn'));

    await waitFor(() => {
      const putCall = fetchSpy.mock.calls.find(
        (c) =>
          ((c[1]?.method ?? 'GET') as string).toUpperCase() === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall![1]!.body as string);
      expect(body.per_action_overrides.improve).toBe('auto-publish');
      // Existing override preserved.
      expect(body.per_action_overrides.auto_tag).toBe('auto-publish');
    });
  });

  it('lets the admin clear an override (Inherit default)', async () => {
    const fetchSpy = mockFetch({ policy: samplePolicy });
    const Wrapper = createWrapper();
    render(<AiReviewPolicyTab />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.getByTestId(
          'ai-review-policy-override-select-auto_tag',
        ),
      ).toBeInTheDocument();
    });

    const select = screen.getByTestId(
      'ai-review-policy-override-select-auto_tag',
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '' } });

    fireEvent.click(screen.getByTestId('ai-review-policy-save-btn'));

    await waitFor(() => {
      const putCall = fetchSpy.mock.calls.find(
        (c) =>
          ((c[1]?.method ?? 'GET') as string).toUpperCase() === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall![1]!.body as string);
      expect(body.per_action_overrides.auto_tag).toBeUndefined();
    });
  });

  it('clamps expire_after_days into the 1..365 range', async () => {
    mockFetch({ policy: samplePolicy });
    const Wrapper = createWrapper();
    render(<AiReviewPolicyTab />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.getByTestId('ai-review-policy-expire-days-input'),
      ).toBeInTheDocument();
    });

    const input = screen.getByTestId(
      'ai-review-policy-expire-days-input',
    ) as HTMLInputElement;

    fireEvent.change(input, { target: { value: '999' } });
    expect(input.value).toBe('365');

    fireEvent.change(input, { target: { value: '0' } });
    expect(input.value).toBe('1');
  });
});
