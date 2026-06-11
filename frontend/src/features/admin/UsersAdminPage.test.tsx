import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UsersAdminPage } from './UsersAdminPage';
import { useAuthStore } from '../../stores/auth-store';

// EE #116 — bulk UI is feature-gated. The default implementation here
// keeps `bulk_user_operations` off so the existing CE #304 tests
// describe the unchanged single-user CRUD path. Each test that asserts
// the bulk affordances flips the flag explicitly.
let mockHasFeature: (f: string) => boolean = () => false;
vi.mock('../../shared/enterprise/use-enterprise', () => ({
  useEnterprise: () => ({
    isEnterprise: false,
    hasFeature: (f: string) => mockHasFeature(f),
    ui: null,
    license: null,
    isLoading: false,
  }),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

const mockUsers = [
  {
    id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
    username: 'alice',
    email: 'alice@example.com',
    displayName: 'Alice',
    role: 'admin' as const,
    authProvider: 'local',
    deactivatedAt: null,
    deactivatedBy: null,
    deactivatedReason: null,
    createdAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
    username: 'bob',
    email: 'bob@example.com',
    displayName: null,
    role: 'user' as const,
    authProvider: 'local',
    deactivatedAt: '2026-04-22T10:00:00Z',
    deactivatedBy: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
    deactivatedReason: 'off-boarding',
    createdAt: '2026-01-02T00:00:00Z',
  },
];

// Mutable list returned by the fetch mock — tests can override before render
// (e.g. to simulate an instance where no user has an email address).
let mockUsersList: typeof mockUsers = mockUsers;

describe('UsersAdminPage', () => {
  beforeEach(() => {
    // Default: bulk feature OFF. Tests that need the bulk UI flip this
    // before render.
    mockHasFeature = () => false;
    mockUsersList = mockUsers;

    // Pretend we're logged in as alice so self-actions are hidden.
    useAuthStore.setState({
      user: {
        id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        username: 'alice',
        role: 'admin',
      },
      accessToken: 'tok',
    } as unknown as ReturnType<typeof useAuthStore.getState>);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.endsWith('/api/admin/users') && (input as Request).method !== 'POST') {
        return new Response(JSON.stringify({ users: mockUsersList }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the list with active + deactivated rows', async () => {
    render(<UsersAdminPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('alice')).toBeInTheDocument();
      expect(screen.getByText('bob')).toBeInTheDocument();
    });

    // Alice is active, bob is deactivated — status badges rendered
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('deactivated')).toBeInTheDocument();
  });

  it('hides Deactivate + Delete buttons for the current user (alice)', async () => {
    render(<UsersAdminPage />, { wrapper: createWrapper() });

    await waitFor(() => screen.getByText('alice'));

    // The current user's row shows "(you)" and no action buttons
    expect(screen.getByText('(you)')).toBeInTheDocument();

    // Bob (not current user, deactivated) shows Reactivate + Delete
    const reactivateButtons = screen.getAllByText('Reactivate');
    expect(reactivateButtons).toHaveLength(1);
    const deleteButtons = screen.getAllByText('Delete');
    expect(deleteButtons).toHaveLength(1);
  });

  it('opens the create dialog when Create user is clicked', async () => {
    render(<UsersAdminPage />, { wrapper: createWrapper() });

    await waitFor(() => screen.getByText('alice'));

    fireEvent.click(screen.getByText('Create user'));

    expect(screen.getByText('Create user', { selector: 'h3' })).toBeInTheDocument();
    // Cancel + Create submit buttons are rendered in the dialog
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.getByText('Create', { selector: 'button[type="submit"]' })).toBeInTheDocument();
  });

  it('delete opens a ConfirmDialog naming the user; confirming sends the DELETE', async () => {
    render(<UsersAdminPage />, { wrapper: createWrapper() });
    await waitFor(() => screen.getByText('bob'));

    fireEvent.click(screen.getByText('Delete'));

    // ConfirmDialog replaces native confirm() — user deletion really IS permanent.
    expect(await screen.findByText('Permanently delete "bob"?')).toBeInTheDocument();
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
    expect(screen.getByTestId('confirm-dialog-confirm')).toHaveTextContent('Delete user');

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

    await waitFor(() => {
      const deleteCall = vi
        .mocked(globalThis.fetch)
        .mock.calls.find(
          ([input, init]) =>
            String(input).includes('/api/admin/users/bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb') &&
            init?.method === 'DELETE',
        );
      expect(deleteCall).toBeDefined();
    });
    // Dialog closes after confirm
    await waitFor(() => {
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    });
  });

  it('cancelling the delete ConfirmDialog does not send a DELETE', async () => {
    render(<UsersAdminPage />, { wrapper: createWrapper() });
    await waitFor(() => screen.getByText('bob'));

    fireEvent.click(screen.getByText('Delete'));
    await screen.findByTestId('confirm-dialog');
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));

    await waitFor(() => {
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    });
    const deleteCall = vi
      .mocked(globalThis.fetch)
      .mock.calls.find(([, init]) => init?.method === 'DELETE');
    expect(deleteCall).toBeUndefined();
  });

  it('styles the role select with the design-system nm-select-md utility', async () => {
    render(<UsersAdminPage />, { wrapper: createWrapper() });
    await waitFor(() => screen.getByText('bob'));

    const roleSelect = screen.getByTestId(
      'user-role-select-bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
    );
    expect(roleSelect.tagName).toBe('SELECT');
    expect(roleSelect.className).toContain('nm-select-md');
    expect(roleSelect).toHaveValue('user');
  });

  it('shows the Email column when at least one user has an email', async () => {
    render(<UsersAdminPage />, { wrapper: createWrapper() });
    await waitFor(() => screen.getByText('alice'));

    expect(screen.getByText('Email')).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
  });

  it('hides the Email column entirely when no user has an email', async () => {
    mockUsersList = mockUsers.map((u) => ({ ...u, email: null })) as unknown as typeof mockUsers;
    render(<UsersAdminPage />, { wrapper: createWrapper() });
    await waitFor(() => screen.getByText('alice'));

    // Neither the header nor the "—" placeholder cells render.
    expect(screen.queryByText('Email')).not.toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  // ── EE #116 — bulk UI gating ───────────────────────────────────────────

  it('does not show bulk import or select checkboxes when feature is off', async () => {
    mockHasFeature = () => false;
    render(<UsersAdminPage />, { wrapper: createWrapper() });
    await waitFor(() => screen.getByText('alice'));

    expect(
      screen.queryByTestId('users-bulk-import-btn'),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('users-select-all')).not.toBeInTheDocument();
  });

  it('shows bulk import button + select-all checkbox when feature is on', async () => {
    mockHasFeature = (f: string) => f === 'bulk_user_operations';
    render(<UsersAdminPage />, { wrapper: createWrapper() });
    await waitFor(() => screen.getByText('alice'));

    expect(screen.getByTestId('users-bulk-import-btn')).toBeInTheDocument();
    expect(screen.getByTestId('users-select-all')).toBeInTheDocument();

    // Bulk-actions button only appears once a row is selected
    expect(
      screen.queryByTestId('users-bulk-action-btn'),
    ).not.toBeInTheDocument();
  });

  it('reveals the Bulk actions button after selecting a row (feature on)', async () => {
    mockHasFeature = (f: string) => f === 'bulk_user_operations';
    render(<UsersAdminPage />, { wrapper: createWrapper() });
    await waitFor(() => screen.getByText('alice'));

    // Bob is the non-current user, so his checkbox is rendered.
    const bobCheckbox = screen.getByTestId(
      'users-select-bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
    );
    fireEvent.click(bobCheckbox);

    expect(
      screen.getByTestId('users-bulk-action-btn'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('users-bulk-action-btn')).toHaveTextContent(
      'Bulk actions (1)',
    );
  });

  it('opens the bulk import modal when the Bulk import button is clicked', async () => {
    mockHasFeature = (f: string) => f === 'bulk_user_operations';
    render(<UsersAdminPage />, { wrapper: createWrapper() });
    await waitFor(() => screen.getByText('alice'));

    fireEvent.click(screen.getByTestId('users-bulk-import-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('bulk-import-modal')).toBeInTheDocument();
    });
  });
});
