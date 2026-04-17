import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CustomRoleEditor } from './CustomRoleEditor';
import type { CustomRole } from './CustomRoleEditor';
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

// ── Mock data ──────────────────────────────────────────────────────────────────

const mockPermissions = [
  { id: 'pages:read', displayName: 'Read Pages', description: 'View pages and their content', category: 'pages', createdAt: '2024-01-01T00:00:00Z' },
  { id: 'pages:write', displayName: 'Write Pages', description: 'Edit pages', category: 'pages', createdAt: '2024-01-01T00:00:00Z' },
  { id: 'llm:query', displayName: 'Query LLM', description: 'Send queries to AI', category: 'llm', createdAt: '2024-01-01T00:00:00Z' },
  { id: 'admin:settings', displayName: 'Manage Settings', description: 'Admin settings', category: 'admin', createdAt: '2024-01-01T00:00:00Z' },
];

const mockRole: CustomRole = {
  id: 10,
  name: 'content_editor',
  displayName: 'Content Editor',
  description: 'Can edit pages',
  isSystem: false,
  permissions: ['pages:read', 'pages:write'],
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

const mockAssignments = [
  { id: 1, spaceKey: 'DEV', principalType: 'user' as const, principalId: 'u1', principalName: 'alice', createdAt: '2024-01-01T00:00:00Z' },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

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

function mockFetch(overrides?: {
  permissions?: typeof mockPermissions;
  assignments?: typeof mockAssignments;
}) {
  const perms = overrides?.permissions ?? mockPermissions;
  const assigns = overrides?.assignments ?? mockAssignments;

  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = init?.method ?? (typeof input !== 'string' ? (input as Request).method : 'GET');

    // POST /admin/roles (create)
    if (url.includes('/admin/roles') && method === 'POST') {
      return new Response(JSON.stringify({ id: 99, name: 'new_role' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // PUT /admin/roles/:id (update)
    if (url.match(/\/admin\/roles\/\d+$/) && method === 'PUT') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // DELETE /admin/roles/:id (delete)
    if (url.match(/\/admin\/roles\/\d+$/) && method === 'DELETE') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // GET /admin/roles/:id/assignments
    if (url.match(/\/admin\/roles\/\d+\/assignments/)) {
      return new Response(JSON.stringify(assigns), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // GET /admin/permissions
    if (url.includes('/admin/permissions')) {
      return new Response(JSON.stringify(perms), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Fallback for refresh token etc.
    return new Response(JSON.stringify({}), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('CustomRoleEditor', () => {
  beforeEach(() => {
    mockHasFeature = () => true;
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

  // 1. Create mode renders with empty form
  it('renders create mode with empty form when editRole is null', async () => {
    mockFetch();
    render(
      <CustomRoleEditor open={true} onOpenChange={() => {}} editRole={null} />,
      { wrapper: createWrapper() },
    );

    expect(screen.getByText('Create Custom Role')).toBeInTheDocument();
    expect(screen.getByTestId('role-name-input')).toHaveValue('');
    expect(screen.getByTestId('display-name-input')).toHaveValue('');
    expect(screen.getByTestId('description-input')).toHaveValue('');
    expect(screen.getByTestId('submit-role-btn')).toHaveTextContent('Create');
  });

  // 2. Edit mode renders with pre-populated form
  it('renders edit mode with pre-populated form when editRole is provided', async () => {
    mockFetch();
    render(
      <CustomRoleEditor open={true} onOpenChange={() => {}} editRole={mockRole} />,
      { wrapper: createWrapper() },
    );

    expect(screen.getByText('Edit Role: Content Editor')).toBeInTheDocument();
    expect(screen.getByTestId('role-name-input')).toHaveValue('content_editor');
    expect(screen.getByTestId('role-name-input')).toBeDisabled();
    expect(screen.getByTestId('display-name-input')).toHaveValue('Content Editor');
    expect(screen.getByTestId('description-input')).toHaveValue('Can edit pages');
    expect(screen.getByTestId('submit-role-btn')).toHaveTextContent('Save');
  });

  // 3. Groups permissions by category
  it('groups permissions by category with correct headers', async () => {
    mockFetch();
    render(
      <CustomRoleEditor open={true} onOpenChange={() => {}} editRole={null} />,
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(screen.getByTestId('permission-groups')).toBeInTheDocument();
    });

    expect(screen.getByTestId('permission-group-pages')).toBeInTheDocument();
    expect(screen.getByTestId('permission-group-llm')).toBeInTheDocument();
    expect(screen.getByTestId('permission-group-admin')).toBeInTheDocument();
    expect(screen.getByText('Pages')).toBeInTheDocument();
    expect(screen.getByText('LLM')).toBeInTheDocument();
    expect(screen.getByText('Admin')).toBeInTheDocument();
  });

  // 4. Validates snake_case role name inline
  it('validates snake_case role name inline', async () => {
    mockFetch();
    render(
      <CustomRoleEditor open={true} onOpenChange={() => {}} editRole={null} />,
      { wrapper: createWrapper() },
    );

    const nameInput = screen.getByTestId('role-name-input');

    // Invalid input shows error
    fireEvent.change(nameInput, { target: { value: 'Content Editor' } });
    expect(screen.getByTestId('name-error')).toHaveTextContent('Must be lowercase snake_case');

    // Valid input clears error
    fireEvent.change(nameInput, { target: { value: 'content_editor' } });
    expect(screen.queryByTestId('name-error')).not.toBeInTheDocument();
  });

  // 5. Disables Create button when no permissions are selected
  it('disables Create button when no permissions are selected', () => {
    mockFetch();
    render(
      <CustomRoleEditor open={true} onOpenChange={() => {}} editRole={null} />,
      { wrapper: createWrapper() },
    );

    expect(screen.getByTestId('submit-role-btn')).toBeDisabled();
  });

  // 6. Submits POST on create
  it('submits POST with correct body on create', async () => {
    const fetchSpy = mockFetch();
    render(
      <CustomRoleEditor open={true} onOpenChange={() => {}} editRole={null} />,
      { wrapper: createWrapper() },
    );

    // Wait for permissions to load
    await waitFor(() => {
      expect(screen.getByTestId('permission-groups')).toBeInTheDocument();
    });

    // Fill form
    fireEvent.change(screen.getByTestId('role-name-input'), { target: { value: 'test_role' } });
    fireEvent.change(screen.getByTestId('display-name-input'), { target: { value: 'Test Role' } });
    fireEvent.change(screen.getByTestId('description-input'), { target: { value: 'A test role' } });

    // Select a permission
    fireEvent.click(screen.getByTestId('checkbox-pages:read'));

    // Submit
    fireEvent.click(screen.getByTestId('submit-role-btn'));

    await waitFor(() => {
      const postCalls = fetchSpy.mock.calls.filter(
        ([, opts]) => opts && typeof opts === 'object' && 'method' in opts && (opts as RequestInit).method === 'POST',
      );
      const adminRolePost = postCalls.find(([url]) =>
        (typeof url === 'string' ? url : '').includes('/admin/roles'),
      );
      expect(adminRolePost).toBeDefined();
      const body = JSON.parse((adminRolePost![1] as RequestInit).body as string);
      expect(body.name).toBe('test_role');
      expect(body.displayName).toBe('Test Role');
      expect(body.description).toBe('A test role');
      expect(body.permissions).toEqual(['pages:read']);
    });
  });

  // 7. Submits PUT on edit
  it('submits PUT with correct body on edit', async () => {
    const fetchSpy = mockFetch();
    render(
      <CustomRoleEditor open={true} onOpenChange={() => {}} editRole={mockRole} />,
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(screen.getByTestId('permission-groups')).toBeInTheDocument();
    });

    // Modify display name
    fireEvent.change(screen.getByTestId('display-name-input'), { target: { value: 'Updated Editor' } });

    // Submit
    fireEvent.click(screen.getByTestId('submit-role-btn'));

    await waitFor(() => {
      const putCalls = fetchSpy.mock.calls.filter(
        ([, opts]) => opts && typeof opts === 'object' && 'method' in opts && (opts as RequestInit).method === 'PUT',
      );
      expect(putCalls.length).toBeGreaterThanOrEqual(1);
      const body = JSON.parse((putCalls[0][1] as RequestInit).body as string);
      expect(body.displayName).toBe('Updated Editor');
      expect(body.permissions).toContain('pages:read');
      expect(body.permissions).toContain('pages:write');
      // Name is not in the PUT body (read-only in edit mode)
      expect(body.name).toBeUndefined();
    });
  });

  // 8. Delete button in edit mode, not in create mode
  it('shows delete button in edit mode but not in create mode', () => {
    mockFetch();
    const { unmount } = render(
      <CustomRoleEditor open={true} onOpenChange={() => {}} editRole={null} />,
      { wrapper: createWrapper() },
    );
    expect(screen.queryByTestId('delete-role-btn')).not.toBeInTheDocument();
    unmount();

    render(
      <CustomRoleEditor open={true} onOpenChange={() => {}} editRole={mockRole} />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByTestId('delete-role-btn')).toBeInTheDocument();
  });

  // 9. DELETE mutation fires on delete confirmation
  it('fires DELETE mutation on delete confirmation', async () => {
    const fetchSpy = mockFetch();
    render(
      <CustomRoleEditor open={true} onOpenChange={() => {}} editRole={mockRole} />,
      { wrapper: createWrapper() },
    );

    // Click delete
    fireEvent.click(screen.getByTestId('delete-role-btn'));

    // Confirm
    expect(screen.getByTestId('confirm-delete-btn')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-delete-btn'));

    await waitFor(() => {
      const deleteCalls = fetchSpy.mock.calls.filter(
        ([, opts]) => opts && typeof opts === 'object' && 'method' in opts && (opts as RequestInit).method === 'DELETE',
      );
      expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
      expect(typeof deleteCalls[0][0] === 'string' ? deleteCalls[0][0] : '').toContain('/admin/roles/10');
    });
  });

  // 10. Shows assignments tab in edit mode
  it('shows assignments tab in edit mode', async () => {
    mockFetch();
    render(
      <CustomRoleEditor open={true} onOpenChange={() => {}} editRole={mockRole} />,
      { wrapper: createWrapper() },
    );

    expect(screen.getByTestId('tab-assignments')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('tab-assignments'));

    await waitFor(() => {
      expect(screen.getByTestId('assignments-content')).toBeInTheDocument();
    });
  });

  // 11. No assignments tab in create mode
  it('does not show assignments tab in create mode', () => {
    mockFetch();
    render(
      <CustomRoleEditor open={true} onOpenChange={() => {}} editRole={null} />,
      { wrapper: createWrapper() },
    );

    expect(screen.queryByTestId('tab-assignments')).not.toBeInTheDocument();
  });

  // 12. Pre-checks permissions in edit mode
  it('pre-checks permissions matching the editRole', async () => {
    mockFetch();
    render(
      <CustomRoleEditor open={true} onOpenChange={() => {}} editRole={mockRole} />,
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(screen.getByTestId('permission-groups')).toBeInTheDocument();
    });

    // pages:read and pages:write should be checked (from mockRole.permissions)
    expect(screen.getByTestId('checkbox-pages:read')).toBeChecked();
    expect(screen.getByTestId('checkbox-pages:write')).toBeChecked();
    // llm:query should not be checked
    expect(screen.getByTestId('checkbox-llm:query')).not.toBeChecked();
  });
});
