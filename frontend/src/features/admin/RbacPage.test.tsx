import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RbacPage } from './RbacPage';
import { useAuthStore } from '../../stores/auth-store';

// ── Mock useEnterprise ─────────────────────────────────────────────────────────
// eslint-disable-next-line prefer-const
let mockHasFeature = (_f: string) => false;

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
        <MemoryRouter>
          <LazyMotion features={domAnimation}>
            {children}
          </LazyMotion>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

const mockRoles = [
  {
    id: 1,
    name: 'system_admin',
    displayName: 'System Administrator',
    isSystem: true,
    permissions: ['read', 'comment', 'edit', 'delete', 'manage', 'admin'],
    createdAt: '2024-01-01T00:00:00Z',
  },
  {
    id: 2,
    name: 'editor',
    displayName: 'Editor',
    isSystem: true,
    permissions: ['read', 'comment', 'edit', 'delete'],
    createdAt: '2024-01-01T00:00:00Z',
  },
];

const mockRolesWithCustom = [
  ...mockRoles,
  {
    id: 10,
    name: 'content_editor',
    displayName: 'Content Editor',
    isSystem: false,
    permissions: ['pages:read', 'pages:write'],
    createdAt: '2024-01-01T00:00:00Z',
  },
];

const mockPermissions = [
  { id: 'pages:read', displayName: 'Read Pages', description: 'View', category: 'pages', createdAt: '2024-01-01T00:00:00Z' },
  { id: 'pages:write', displayName: 'Write Pages', description: 'Edit', category: 'pages', createdAt: '2024-01-01T00:00:00Z' },
];

const mockGroups = [
  {
    id: 1,
    name: 'Engineering',
    description: 'Engineering team',
    source: 'local',
    memberCount: 2,
    createdAt: '2024-01-01T00:00:00Z',
  },
];

const mockGroupMembers = [
  { userId: 'u1', username: 'alice', source: 'manual', joinedAt: '2024-01-01T00:00:00Z' },
  { userId: 'u2', username: 'bob', source: 'manual', joinedAt: '2024-01-01T00:00:00Z' },
];

const mockSpaces = [
  { key: 'DEV', name: 'Development' },
  { key: 'OPS', name: 'Operations' },
];

const mockUsers = [
  { id: 'u1', username: 'alice', role: 'user', createdAt: '2024-01-01T00:00:00Z' },
  { id: 'u2', username: 'bob', role: 'user', createdAt: '2024-01-01T00:00:00Z' },
  { id: 'u3', username: 'admin', role: 'admin', createdAt: '2024-01-01T00:00:00Z' },
];

const mockSpaceRoles = [
  {
    id: 1,
    spaceKey: 'DEV',
    principalType: 'user',
    principalId: 'u1',
    principalName: 'alice',
    roleId: 2,
    roleName: 'editor',
    roleDisplayName: 'Editor',
    createdAt: '2024-01-01T00:00:00Z',
  },
];

function mockFetch(roles = mockRoles) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/admin/permissions')) {
      return new Response(JSON.stringify(mockPermissions), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/roles')) {
      return new Response(JSON.stringify(roles), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/groups/') && url.includes('/members')) {
      return new Response(JSON.stringify(mockGroupMembers), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/groups')) {
      return new Response(JSON.stringify(mockGroups), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/spaces/') && url.includes('/roles')) {
      return new Response(JSON.stringify(mockSpaceRoles), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/spaces')) {
      return new Response(JSON.stringify(mockSpaces), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/users')) {
      return new Response(JSON.stringify(mockUsers), {
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
    mockHasFeature = () => false;
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
    expect(screen.getByText('System Administrator')).toBeInTheDocument();
    expect(screen.getByText('Editor')).toBeInTheDocument();
  });

  it('shows role permissions', async () => {
    mockFetch();
    render(<RbacPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('role-1')).toBeInTheDocument();
    });
    // "read" appears in both roles
    expect(screen.getAllByText('read').length).toBeGreaterThanOrEqual(2);
    // "admin" only in system_admin role
    const roleR1 = screen.getByTestId('role-1');
    expect(roleR1).toHaveTextContent('admin');
  });

  it('shows system badge on system roles', async () => {
    mockFetch();
    render(<RbacPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('role-1')).toBeInTheDocument();
    });
    expect(screen.getAllByText('System').length).toBeGreaterThanOrEqual(1);
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

  it('shows admin badge for admin users', () => {
    mockFetch();
    render(<RbacPage />, { wrapper: createWrapper() });
    expect(screen.getByText('System Admin')).toBeInTheDocument();
  });

  it('does not show admin badge for regular users', () => {
    useAuthStore.getState().setAuth('test-token', {
      id: '2',
      username: 'user',
      role: 'user',
    });
    mockFetch();
    render(<RbacPage />, { wrapper: createWrapper() });
    expect(screen.queryByText('System Admin')).not.toBeInTheDocument();
  });

  // ── Custom role editor integration tests ───────────────────────────────────

  it('shows "Create Custom Role" button when advanced_rbac feature is enabled', async () => {
    mockHasFeature = () => true;
    mockFetch();
    render(<RbacPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('roles-list')).toBeInTheDocument();
    });
    expect(screen.getByTestId('create-custom-role-btn')).toBeInTheDocument();
  });

  it('hides "Create Custom Role" button when advanced_rbac feature is disabled', async () => {
    mockHasFeature = () => false;
    mockFetch();
    render(<RbacPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('roles-list')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('create-custom-role-btn')).not.toBeInTheDocument();
  });

  it('shows edit button on non-system roles when feature is enabled', async () => {
    mockHasFeature = () => true;
    mockFetch(mockRolesWithCustom);
    render(<RbacPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('role-10')).toBeInTheDocument();
    });
    expect(screen.getByTestId('edit-role-10')).toBeInTheDocument();
  });

  it('does not show edit button on system roles', async () => {
    mockHasFeature = () => true;
    mockFetch(mockRolesWithCustom);
    render(<RbacPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('role-1')).toBeInTheDocument();
    });
    // System roles (id 1, 2) should not have edit buttons
    expect(screen.queryByTestId('edit-role-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('edit-role-2')).not.toBeInTheDocument();
  });

  it('opens editor modal when "Create Custom Role" is clicked', async () => {
    mockHasFeature = () => true;
    mockFetch();
    render(<RbacPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('create-custom-role-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('create-custom-role-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('custom-role-editor')).toBeInTheDocument();
    });
    // The modal title and button both contain "Create Custom Role", verify the modal is open via testid
    expect(screen.getByTestId('role-name-input')).toBeInTheDocument();
  });
});
