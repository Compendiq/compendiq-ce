import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UsersAdminPage } from './UsersAdminPage';
import { useAuthStore } from '../../stores/auth-store';

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

describe('UsersAdminPage', () => {
  beforeEach(() => {
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
        return new Response(JSON.stringify({ users: mockUsers }), {
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
});
