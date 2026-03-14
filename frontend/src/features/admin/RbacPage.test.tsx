import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domMax } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RbacPage } from './RbacPage';
import { useAuthStore } from '../../stores/auth-store';

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

const mockRoles = [
  {
    id: 'r1',
    name: 'Admin',
    description: 'Full system access',
    permissions: ['read', 'write', 'delete', 'admin'],
  },
  {
    id: 'r2',
    name: 'Editor',
    description: 'Can edit content',
    permissions: ['read', 'write'],
  },
];

const mockGroups = [
  {
    id: 'g1',
    name: 'Engineering',
    description: 'Engineering team',
    memberCount: 2,
    members: [
      { id: 'u1', username: 'alice' },
      { id: 'u2', username: 'bob' },
    ],
  },
];

const mockSpaces = [
  { key: 'DEV', name: 'Development' },
  { key: 'OPS', name: 'Operations' },
];

function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/admin/roles')) {
      return new Response(JSON.stringify(mockRoles), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/admin/groups') && !url.includes('/members')) {
      return new Response(JSON.stringify(mockGroups), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/spaces')) {
      return new Response(JSON.stringify(mockSpaces), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({}), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('RbacPage', () => {
  beforeEach(() => {
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

  it('renders the page heading', () => {
    mockFetch();
    render(<RbacPage />, { wrapper: createWrapper() });
    expect(screen.getByText('Access Control')).toBeInTheDocument();
  });

  it('renders all three tab buttons', () => {
    mockFetch();
    render(<RbacPage />, { wrapper: createWrapper() });
    expect(screen.getByTestId('rbac-tab-roles')).toBeInTheDocument();
    expect(screen.getByTestId('rbac-tab-groups')).toBeInTheDocument();
    expect(screen.getByTestId('rbac-tab-permissions')).toBeInTheDocument();
  });

  it('shows roles tab by default with role data', async () => {
    mockFetch();
    render(<RbacPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('roles-list')).toBeInTheDocument();
    });
    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.getByText('Editor')).toBeInTheDocument();
    expect(screen.getByText('Full system access')).toBeInTheDocument();
  });

  it('shows role permissions', async () => {
    mockFetch();
    render(<RbacPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('role-r1')).toBeInTheDocument();
    });
    // "read" appears in both Admin and Editor roles
    expect(screen.getAllByText('read').length).toBeGreaterThanOrEqual(2);
    // "admin" only appears in the Admin role permissions
    const roleR1 = screen.getByTestId('role-r1');
    expect(roleR1).toHaveTextContent('admin');
  });

  it('switches to groups tab and shows group data', async () => {
    mockFetch();
    render(<RbacPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('rbac-tab-groups'));

    await waitFor(() => {
      expect(screen.getByTestId('groups-list')).toBeInTheDocument();
    });
    expect(screen.getByText('Engineering')).toBeInTheDocument();
    expect(screen.getByText('(2 members)')).toBeInTheDocument();
  });

  it('shows member names in group', async () => {
    mockFetch();
    render(<RbacPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('rbac-tab-groups'));

    await waitFor(() => {
      expect(screen.getByText('alice')).toBeInTheDocument();
    });
    expect(screen.getByText('bob')).toBeInTheDocument();
  });

  it('shows create group form when button is clicked', async () => {
    mockFetch();
    render(<RbacPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('rbac-tab-groups'));

    await waitFor(() => {
      expect(screen.getByTestId('create-group-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('create-group-btn'));
    expect(screen.getByTestId('create-group-form')).toBeInTheDocument();
    expect(screen.getByTestId('group-name-input')).toBeInTheDocument();
  });

  it('switches to space permissions tab', () => {
    mockFetch();
    render(<RbacPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('rbac-tab-permissions'));

    expect(screen.getByTestId('space-permissions')).toBeInTheDocument();
    expect(screen.getByTestId('space-selector')).toBeInTheDocument();
  });
});
