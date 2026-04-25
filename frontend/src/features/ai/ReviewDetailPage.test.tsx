/**
 * Tests for ReviewDetailPage (Compendiq/compendiq-ee#120).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { LazyMotion, domMax } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReviewDetailPage } from './ReviewDetailPage';
import { useAuthStore } from '../../stores/auth-store';
import type { AiReviewDetail } from '@compendiq/contracts';

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

const REVIEW_ID = '11111111-1111-4111-8111-111111111111';

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
        <MemoryRouter initialEntries={[`/settings/ai-reviews/${REVIEW_ID}`]}>
          <LazyMotion features={domMax}>
            <Routes>
              <Route
                path="/settings/ai-reviews/:id"
                element={<>{children}</>}
              />
              <Route
                path="/settings/ai/ai-reviews"
                element={<div data-testid="navigated-to-queue" />}
              />
            </Routes>
          </LazyMotion>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

const sampleDetail: AiReviewDetail = {
  id: REVIEW_ID,
  page_id: 42,
  action_type: 'improve',
  proposed_content:
    'Hello world.\nThis paragraph has been improved by the AI.\nNew sentence added.',
  proposed_html:
    '<p>Hello world.</p><p>This paragraph has been improved by the AI.</p>',
  authored_by: '22222222-2222-4222-8222-222222222222',
  authored_at: '2026-04-23T12:00:00Z',
  status: 'pending',
  reviewed_by: null,
  reviewed_at: null,
  review_notes: null,
  edited_content: null,
  pii_findings_id: null,
  expires_at: '2026-05-23T12:00:00Z',
  page_title: 'Onboarding runbook',
  current_body_html: '<p>Hello world.</p><p>Original paragraph.</p>',
  current_body_text: 'Hello world.\nOriginal paragraph.',
};

interface MockOptions {
  detail?: AiReviewDetail | null;
  getStatus?: 200 | 404 | 500;
  approveStatus?: 200 | 409 | 500;
  rejectStatus?: 200 | 500;
  editStatus?: 200 | 500;
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

      if (url.endsWith(`/ai-reviews/${REVIEW_ID}`) && method === 'GET') {
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
          JSON.stringify({ review: opts.detail ?? sampleDetail }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      if (
        url.endsWith(`/ai-reviews/${REVIEW_ID}/approve`) &&
        method === 'POST'
      ) {
        const status = opts.approveStatus ?? 200;
        if (status === 409) {
          return new Response(
            JSON.stringify({ error: 'Conflict', message: 'already actioned' }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (status === 500) {
          return new Response(JSON.stringify({ message: 'boom' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (
        url.endsWith(`/ai-reviews/${REVIEW_ID}/reject`) &&
        method === 'POST'
      ) {
        const status = opts.rejectStatus ?? 200;
        if (status === 500) {
          return new Response(JSON.stringify({ message: 'boom' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (
        url.endsWith(`/ai-reviews/${REVIEW_ID}/edit-and-approve`) &&
        method === 'POST'
      ) {
        const status = opts.editStatus ?? 200;
        if (status === 500) {
          return new Response(JSON.stringify({ message: 'boom' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('Not found', { status: 404 });
    });
}

describe('ReviewDetailPage', () => {
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
    render(<ReviewDetailPage />, { wrapper: Wrapper });
    expect(
      screen.getByTestId('ai-review-detail-not-licensed'),
    ).toBeInTheDocument();
  });

  it('renders the page title, action type, and pending status', async () => {
    mockFetch({ detail: sampleDetail });
    const Wrapper = createWrapper();
    render(<ReviewDetailPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.getByTestId('ai-review-detail-page'),
      ).toBeInTheDocument();
    });
    expect(screen.getByText('Onboarding runbook')).toBeInTheDocument();
    expect(screen.getByText('Improve')).toBeInTheDocument();
    expect(screen.getByTestId('ai-review-detail-status')).toHaveTextContent(
      'pending',
    );
  });

  it('renders the side-by-side text diff by default', async () => {
    mockFetch({ detail: sampleDetail });
    const Wrapper = createWrapper();
    render(<ReviewDetailPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.getByTestId('ai-review-detail-text-diff'),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId('ai-review-detail-html-pair'),
    ).not.toBeInTheDocument();
  });

  it('toggles into the HTML view', async () => {
    mockFetch({ detail: sampleDetail });
    const Wrapper = createWrapper();
    render(<ReviewDetailPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.getByTestId('ai-review-detail-html-toggle'),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('ai-review-detail-html-toggle'));

    await waitFor(() => {
      expect(
        screen.getByTestId('ai-review-detail-html-pair'),
      ).toBeInTheDocument();
    });
  });

  it('shows the EE-overlay-missing notice on 404', async () => {
    mockFetch({ getStatus: 404 });
    const Wrapper = createWrapper();
    render(<ReviewDetailPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.getByTestId('ai-review-detail-overlay-missing'),
      ).toBeInTheDocument();
    });
  });

  it('shows a generic error banner on 500', async () => {
    mockFetch({ getStatus: 500 });
    const Wrapper = createWrapper();
    render(<ReviewDetailPage />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(
        screen.getByTestId('ai-review-detail-error'),
      ).toBeInTheDocument();
    });
  });

  it('shows the PII flag when pii_findings_id is set', async () => {
    mockFetch({
      detail: {
        ...sampleDetail,
        pii_findings_id: '99999999-9999-4999-8999-999999999999',
      },
    });
    const Wrapper = createWrapper();
    render(<ReviewDetailPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.getByTestId('ai-review-detail-pii-flag'),
      ).toBeInTheDocument();
    });
  });

  it('hides action buttons for non-pending reviews', async () => {
    mockFetch({
      detail: {
        ...sampleDetail,
        status: 'approved',
        review_notes: 'Looks good',
        reviewed_at: '2026-04-23T12:30:00Z',
        reviewed_by: '33333333-3333-4333-8333-333333333333',
      },
    });
    const Wrapper = createWrapper();
    render(<ReviewDetailPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.getByTestId('ai-review-detail-page'),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId('ai-review-detail-actions'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId('ai-review-detail-existing-notes'),
    ).toHaveTextContent('Looks good');
  });

  it('approves the review and navigates back to the queue', async () => {
    const fetchSpy = mockFetch({ detail: sampleDetail });
    const Wrapper = createWrapper();
    render(<ReviewDetailPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.getByTestId('ai-review-detail-approve-btn'),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('ai-review-detail-approve-btn'));

    await waitFor(() => {
      const approveCall = fetchSpy.mock.calls.find((c) => {
        const url = typeof c[0] === 'string' ? c[0] : (c[0] as Request).url;
        return url.endsWith(`/ai-reviews/${REVIEW_ID}/approve`);
      });
      expect(approveCall).toBeDefined();
    });

    await waitFor(() => {
      expect(screen.getByTestId('navigated-to-queue')).toBeInTheDocument();
    });
  });

  it('opens the reject dialog and submits with notes', async () => {
    const fetchSpy = mockFetch({ detail: sampleDetail });
    const Wrapper = createWrapper();
    render(<ReviewDetailPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.getByTestId('ai-review-detail-reject-btn'),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('ai-review-detail-reject-btn'));

    await waitFor(() => {
      expect(
        screen.getByTestId('ai-review-detail-reject-dialog'),
      ).toBeInTheDocument();
    });

    fireEvent.change(
      screen.getByTestId('ai-review-detail-reject-notes'),
      { target: { value: 'Inaccurate technical detail' } },
    );

    fireEvent.click(
      screen.getByTestId('ai-review-detail-reject-confirm-btn'),
    );

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find((c) => {
        const url = typeof c[0] === 'string' ? c[0] : (c[0] as Request).url;
        return url.endsWith(`/ai-reviews/${REVIEW_ID}/reject`);
      });
      expect(call).toBeDefined();
      const body = JSON.parse(call![1]!.body as string);
      expect(body.notes).toBe('Inaccurate technical detail');
    });

    await waitFor(() => {
      expect(screen.getByTestId('navigated-to-queue')).toBeInTheDocument();
    });
  });

  it('rejects without notes when the textarea is empty (no notes field on wire)', async () => {
    const fetchSpy = mockFetch({ detail: sampleDetail });
    const Wrapper = createWrapper();
    render(<ReviewDetailPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.getByTestId('ai-review-detail-reject-btn'),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('ai-review-detail-reject-btn'));
    await waitFor(() => {
      expect(
        screen.getByTestId('ai-review-detail-reject-confirm-btn'),
      ).toBeInTheDocument();
    });

    fireEvent.click(
      screen.getByTestId('ai-review-detail-reject-confirm-btn'),
    );

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find((c) => {
        const url = typeof c[0] === 'string' ? c[0] : (c[0] as Request).url;
        return url.endsWith(`/ai-reviews/${REVIEW_ID}/reject`);
      });
      expect(call).toBeDefined();
      const body = JSON.parse(call![1]!.body as string);
      expect(body.notes).toBeUndefined();
    });
  });

  it('opens the edit dialog with the proposed content pre-loaded', async () => {
    mockFetch({ detail: sampleDetail });
    const Wrapper = createWrapper();
    render(<ReviewDetailPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.getByTestId('ai-review-detail-edit-btn'),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('ai-review-detail-edit-btn'));

    await waitFor(() => {
      expect(
        screen.getByTestId('ai-review-detail-edit-dialog'),
      ).toBeInTheDocument();
    });

    const textarea = screen.getByTestId(
      'ai-review-detail-edit-textarea',
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe(sampleDetail.proposed_content);
  });

  it('submits edit-and-approve with the edited content', async () => {
    const fetchSpy = mockFetch({ detail: sampleDetail });
    const Wrapper = createWrapper();
    render(<ReviewDetailPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.getByTestId('ai-review-detail-edit-btn'),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('ai-review-detail-edit-btn'));

    await waitFor(() => {
      expect(
        screen.getByTestId('ai-review-detail-edit-textarea'),
      ).toBeInTheDocument();
    });

    fireEvent.change(
      screen.getByTestId('ai-review-detail-edit-textarea'),
      { target: { value: 'Reviewer-edited final body.' } },
    );
    fireEvent.change(
      screen.getByTestId('ai-review-detail-edit-notes'),
      { target: { value: 'Tightened wording.' } },
    );

    fireEvent.click(screen.getByTestId('ai-review-detail-edit-confirm-btn'));

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find((c) => {
        const url = typeof c[0] === 'string' ? c[0] : (c[0] as Request).url;
        return url.endsWith(`/ai-reviews/${REVIEW_ID}/edit-and-approve`);
      });
      expect(call).toBeDefined();
      const body = JSON.parse(call![1]!.body as string);
      expect(body.editedContent).toBe('Reviewer-edited final body.');
      expect(body.notes).toBe('Tightened wording.');
    });
  });
});
