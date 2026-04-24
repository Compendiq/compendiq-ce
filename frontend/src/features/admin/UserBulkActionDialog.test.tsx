import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UserBulkActionDialog } from './UserBulkActionDialog';
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
let mockHasFeature: (f: string) => boolean = () => true;
vi.mock('../../shared/enterprise/use-enterprise', () => ({
  useEnterprise: () => ({
    isEnterprise: true,
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
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

interface MockOptions {
  status?: number;
  body?: unknown;
  captured?: { current: { url: string; init?: RequestInit } | null };
}

function mockFetch(options: MockOptions = {}) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.includes('/admin/users/bulk/action') && method === 'POST') {
        if (options.captured) {
          options.captured.current = { url, init };
        }
        if (options.status && options.status >= 400) {
          return new Response(
            JSON.stringify(options.body ?? { error: 'action_failed' }),
            {
              status: options.status,
              headers: { 'Content-Type': 'application/json' },
            },
          );
        }
        return new Response(JSON.stringify(options.body ?? { updated: 3 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('Not found', { status: 404 });
    });
}

const SAMPLE_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];

describe('UserBulkActionDialog', () => {
  beforeEach(() => {
    useAuthStore.getState().setAuth('test-token', {
      id: 'me',
      username: 'admin',
      role: 'admin',
    });
    mockHasFeature = () => true;
    toastSuccess.mockClear();
    toastError.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('returns null when bulk_user_operations feature is not licensed', () => {
    mockHasFeature = () => false;
    const { container } = render(
      <UserBulkActionDialog
        open={true}
        onClose={() => {}}
        selectedUserIds={SAMPLE_IDS}
      />,
      { wrapper: createWrapper() },
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('bulk-action-modal')).not.toBeInTheDocument();
  });

  it('renders the action picker with all five action kinds', () => {
    render(
      <UserBulkActionDialog
        open={true}
        onClose={() => {}}
        selectedUserIds={SAMPLE_IDS}
      />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByTestId('bulk-action-modal')).toBeInTheDocument();

    const select = screen.getByTestId('bulk-action-kind') as HTMLSelectElement;
    const optionTexts = Array.from(select.options).map((o) => o.text);
    expect(optionTexts).toEqual([
      'Change role',
      'Deactivate',
      'Reactivate',
      'Add to group',
      'Remove from group',
    ]);

    // Initial summary mentions the count
    expect(screen.getByTestId('bulk-action-summary')).toHaveTextContent(
      '3 users',
    );
  });

  it('submits change-role with the correct body shape', async () => {
    const captured: { current: { url: string; init?: RequestInit } | null } = {
      current: null,
    };
    mockFetch({ captured });

    render(
      <UserBulkActionDialog
        open={true}
        onClose={() => {}}
        selectedUserIds={SAMPLE_IDS}
      />,
      { wrapper: createWrapper() },
    );

    // Pick admin
    fireEvent.click(screen.getByTestId('bulk-action-role-admin'));

    fireEvent.click(screen.getByTestId('bulk-action-submit'));

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith(
        'Action applied to 3 users',
      );
    });

    expect(captured.current).not.toBeNull();
    const sent = JSON.parse(captured.current!.init!.body as string);
    expect(sent.userIds).toEqual(SAMPLE_IDS);
    expect(sent.action).toEqual({ type: 'change-role', role: 'admin' });
  });

  it('submits deactivate with optional reason text', async () => {
    const captured: { current: { url: string; init?: RequestInit } | null } = {
      current: null,
    };
    mockFetch({ captured });

    render(
      <UserBulkActionDialog
        open={true}
        onClose={() => {}}
        selectedUserIds={SAMPLE_IDS}
      />,
      { wrapper: createWrapper() },
    );

    fireEvent.change(screen.getByTestId('bulk-action-kind'), {
      target: { value: 'deactivate' },
    });
    fireEvent.change(screen.getByTestId('bulk-action-reason'), {
      target: { value: 'off-boarding 2026-Q2' },
    });
    fireEvent.click(screen.getByTestId('bulk-action-submit'));

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalled();
    });

    const sent = JSON.parse(captured.current!.init!.body as string);
    expect(sent.action).toEqual({
      type: 'deactivate',
      reason: 'off-boarding 2026-Q2',
    });
  });

  it('submits add-to-group with the group id', async () => {
    const captured: { current: { url: string; init?: RequestInit } | null } = {
      current: null,
    };
    mockFetch({ captured });

    render(
      <UserBulkActionDialog
        open={true}
        onClose={() => {}}
        selectedUserIds={SAMPLE_IDS}
      />,
      { wrapper: createWrapper() },
    );

    fireEvent.change(screen.getByTestId('bulk-action-kind'), {
      target: { value: 'add-to-group' },
    });
    fireEvent.change(screen.getByTestId('bulk-action-group'), {
      target: { value: 'group-eng' },
    });
    fireEvent.click(screen.getByTestId('bulk-action-submit'));

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalled();
    });
    const sent = JSON.parse(captured.current!.init!.body as string);
    expect(sent.action).toEqual({
      type: 'add-to-group',
      groupId: 'group-eng',
    });
  });

  it('shows inline error on 400 and surfaces the message', async () => {
    mockFetch({
      status: 400,
      body: { error: 'invalid_group', message: 'Group not found' },
    });

    render(
      <UserBulkActionDialog
        open={true}
        onClose={() => {}}
        selectedUserIds={SAMPLE_IDS}
      />,
      { wrapper: createWrapper() },
    );

    fireEvent.change(screen.getByTestId('bulk-action-kind'), {
      target: { value: 'add-to-group' },
    });
    fireEvent.change(screen.getByTestId('bulk-action-group'), {
      target: { value: 'group-eng' },
    });
    fireEvent.click(screen.getByTestId('bulk-action-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('bulk-action-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('bulk-action-error')).toHaveTextContent(
      'Group not found',
    );
    expect(toastError).toHaveBeenCalled();
  });

  it('shows "requires Enterprise" branch on 404 (overlay not deployed)', async () => {
    mockFetch({ status: 404, body: { error: 'route_not_found' } });

    render(
      <UserBulkActionDialog
        open={true}
        onClose={() => {}}
        selectedUserIds={SAMPLE_IDS}
      />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByTestId('bulk-action-submit'));

    await waitFor(() => {
      expect(
        screen.getByTestId('bulk-action-requires-enterprise'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('bulk-action-requires-enterprise'),
    ).toHaveTextContent('require Enterprise');
  });

  it('disables submit when add-to-group has no group id', () => {
    render(
      <UserBulkActionDialog
        open={true}
        onClose={() => {}}
        selectedUserIds={SAMPLE_IDS}
      />,
      { wrapper: createWrapper() },
    );

    fireEvent.change(screen.getByTestId('bulk-action-kind'), {
      target: { value: 'add-to-group' },
    });
    expect(screen.getByTestId('bulk-action-submit')).toBeDisabled();

    fireEvent.change(screen.getByTestId('bulk-action-group'), {
      target: { value: 'g1' },
    });
    expect(screen.getByTestId('bulk-action-submit')).not.toBeDisabled();
  });
});
