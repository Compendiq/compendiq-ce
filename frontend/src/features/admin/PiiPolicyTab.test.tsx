/**
 * Tests for PiiPolicyTab (Compendiq/compendiq-ee#119, Phase I).
 *
 * Mirrors the AiReviewPolicyTab test scaffold (CE #341): a fetch
 * stub that emulates GET / PUT /api/admin/pii-policy, a mocked
 * useEnterprise hook for the feature gate, and a TanStack Query +
 * LazyMotion test wrapper.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LazyMotion, domMax } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PiiPolicyTab } from './PiiPolicyTab';
import { useAuthStore } from '../../stores/auth-store';
import type { PiiPolicy } from '@compendiq/contracts';

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

const samplePolicy: PiiPolicy = {
  enabled: true,
  confidenceThreshold: 0.8,
  llmJudgeMode: 'flagged-only',
  llmJudgeUsecase: 'quality',
  actions: {
    chat: 'flag-only',
    improve: 'redact-and-publish',
    summary: 'flag-only',
    generate: 'flag-only',
    auto_tag: 'off',
  },
  categoriesToFlag: [
    'PERSON',
    'EMAIL_ADDRESS',
    'IBAN',
    'DE_TAX_ID',
  ],
};

interface MockOptions {
  policy?: PiiPolicy;
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

      if (url.endsWith('/admin/pii-policy') && method === 'GET') {
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

      if (url.endsWith('/admin/pii-policy') && method === 'PUT') {
        if (opts.putStatus === 400) {
          return new Response(
            JSON.stringify({ error: 'BadRequest' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const body = init?.body
          ? JSON.parse(init.body as string)
          : null;
        return new Response(JSON.stringify({ policy: body?.policy }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('Not found', { status: 404 });
    });
}

describe('PiiPolicyTab', () => {
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
      hasFeature: (f: string) => f === 'pii_detection',
      license: null,
      refresh: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders an upgrade prompt when the licence does not grant pii_detection', () => {
    mockUseEnterprise.mockReturnValue({
      isEnterprise: false,
      hasFeature: () => false,
      license: null,
      refresh: vi.fn(),
    });
    const Wrapper = createWrapper();
    render(<PiiPolicyTab />, { wrapper: Wrapper });
    expect(
      screen.getByTestId('pii-policy-not-licensed'),
    ).toBeInTheDocument();
  });

  it('hydrates the form fields from the loaded policy', async () => {
    mockFetch({ policy: samplePolicy });
    const Wrapper = createWrapper();
    render(<PiiPolicyTab />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('pii-policy-tab')).toBeInTheDocument();
    });

    const enabledToggle = screen.getByTestId(
      'pii-policy-enabled-toggle',
    ) as HTMLInputElement;
    expect(enabledToggle.checked).toBe(true);

    const slider = screen.getByTestId(
      'pii-policy-threshold-slider',
    ) as HTMLInputElement;
    expect(slider.value).toBe('0.8');

    const flaggedRadio = screen.getByTestId(
      'pii-policy-llm-judge-radio-flagged-only',
    ) as HTMLInputElement;
    expect(flaggedRadio.checked).toBe(true);

    const improveRedact = screen.getByTestId(
      'pii-policy-action-improve-redact-and-publish',
    ) as HTMLInputElement;
    expect(improveRedact.checked).toBe(true);

    const personCheckbox = screen.getByTestId(
      'pii-policy-category-checkbox-PERSON',
    ) as HTMLInputElement;
    expect(personCheckbox.checked).toBe(true);

    // LOCATION not in samplePolicy.categoriesToFlag → unchecked
    const locationCheckbox = screen.getByTestId(
      'pii-policy-category-checkbox-LOCATION',
    ) as HTMLInputElement;
    expect(locationCheckbox.checked).toBe(false);
  });

  it('surfaces the EE-overlay-missing notice on a 404 from GET', async () => {
    mockFetch({ getStatus: 404 });
    const Wrapper = createWrapper();
    render(<PiiPolicyTab />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.getByTestId('pii-policy-overlay-missing'),
      ).toBeInTheDocument();
    });

    // Save button is force-disabled in this state.
    const saveBtn = screen.getByTestId(
      'pii-policy-save-btn',
    ) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });

  it('shows a generic error banner on a 500', async () => {
    mockFetch({ getStatus: 500 });
    const Wrapper = createWrapper();
    render(<PiiPolicyTab />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByTestId('pii-policy-error')).toBeInTheDocument();
    });
  });

  it('PUTs the policy with the wrapped { policy } body shape', async () => {
    const fetchSpy = mockFetch({ policy: samplePolicy });
    const Wrapper = createWrapper();
    render(<PiiPolicyTab />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('pii-policy-tab')).toBeInTheDocument();
    });

    // Toggle the chat action to dirty the form.
    fireEvent.click(
      screen.getByTestId('pii-policy-action-chat-redact-and-publish'),
    );

    const saveBtn = screen.getByTestId(
      'pii-policy-save-btn',
    ) as HTMLButtonElement;
    await waitFor(() => {
      expect(saveBtn.disabled).toBe(false);
    });

    fireEvent.click(saveBtn);

    await waitFor(() => {
      const putCall = fetchSpy.mock.calls.find(
        (c) =>
          ((c[1]?.method ?? 'GET') as string).toUpperCase() === 'PUT' &&
          ((c[0] as string) ?? '').endsWith('/admin/pii-policy'),
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall![1]!.body as string);
      // Wrapped under `policy` per the EE route contract.
      expect(body).toHaveProperty('policy');
      expect(body.policy.actions.chat).toBe('redact-and-publish');
      expect(body.policy.enabled).toBe(true);
      // Existing fields preserved.
      expect(body.policy.confidenceThreshold).toBe(0.8);
      expect(body.policy.llmJudgeMode).toBe('flagged-only');
    });
  });

  it('toggling a category check updates categoriesToFlag', async () => {
    const fetchSpy = mockFetch({ policy: samplePolicy });
    const Wrapper = createWrapper();
    render(<PiiPolicyTab />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.getByTestId('pii-policy-category-LOCATION'),
      ).toBeInTheDocument();
    });

    const locationCheckbox = screen.getByTestId(
      'pii-policy-category-checkbox-LOCATION',
    ) as HTMLInputElement;
    expect(locationCheckbox.checked).toBe(false);

    fireEvent.click(locationCheckbox);

    fireEvent.click(screen.getByTestId('pii-policy-save-btn'));

    await waitFor(() => {
      const putCall = fetchSpy.mock.calls.find(
        (c) =>
          ((c[1]?.method ?? 'GET') as string).toUpperCase() === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall![1]!.body as string);
      expect(body.policy.categoriesToFlag).toContain('LOCATION');
      // The previously-checked categories are still there too.
      expect(body.policy.categoriesToFlag).toContain('PERSON');
      expect(body.policy.categoriesToFlag).toContain('IBAN');
    });
  });

  it('threshold slider updates the displayed value and dirties the form', async () => {
    mockFetch({ policy: samplePolicy });
    const Wrapper = createWrapper();
    render(<PiiPolicyTab />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.getByTestId('pii-policy-threshold-slider'),
      ).toBeInTheDocument();
    });

    const slider = screen.getByTestId(
      'pii-policy-threshold-slider',
    ) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '0.50' } });

    expect(
      (
        screen.getByTestId('pii-policy-threshold-value') as HTMLOutputElement
      ).textContent,
    ).toBe('0.50');

    const saveBtn = screen.getByTestId(
      'pii-policy-save-btn',
    ) as HTMLButtonElement;
    await waitFor(() => {
      expect(saveBtn.disabled).toBe(false);
    });
  });

  it('llm judge usecase select is disabled when judge mode is off', async () => {
    mockFetch({
      policy: { ...samplePolicy, llmJudgeMode: 'off' },
    });
    const Wrapper = createWrapper();
    render(<PiiPolicyTab />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.getByTestId('pii-policy-llm-judge-usecase-select'),
      ).toBeInTheDocument();
    });
    const select = screen.getByTestId(
      'pii-policy-llm-judge-usecase-select',
    ) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });
});
