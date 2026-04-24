/**
 * Settings → Users admin page (#304).
 *
 * Distinct from `RbacPage` (which manages role assignment and space/group
 * memberships). This page owns the user *lifecycle*: create, edit metadata,
 * deactivate / reactivate, delete.
 */

import { useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiFetch } from '../../shared/lib/api';
import type { AdminUser, AdminUserRole } from '@compendiq/contracts';
import { useAuthStore } from '../../stores/auth-store';
import { useEnterprise } from '../../shared/enterprise/use-enterprise';
import { BulkUserImportModal } from './BulkUserImportModal';
import { UserBulkActionDialog } from './UserBulkActionDialog';

interface AdminUserListResponse {
  users: AdminUser[];
}

interface CreateUserResponse {
  user: AdminUser;
  temporaryPassword?: string;
}

export function UsersAdminPage() {
  const queryClient = useQueryClient();
  const currentUserId = useAuthStore((s) => s.user?.id);
  const { hasFeature } = useEnterprise();
  // EE #116: bulk import + multi-select bulk actions are gated by the
  // `bulk_user_operations` feature flag. The whole UI degrades to the
  // CE #304 single-user CRUD when the flag is off — no bulk button, no
  // checkboxes, no behaviour change.
  const bulkEnabled = hasFeature('bulk_user_operations');
  const [showCreate, setShowCreate] = useState(false);
  const [lastTempPassword, setLastTempPassword] = useState<{ username: string; password: string } | null>(null);
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [showBulkAction, setShowBulkAction] = useState(false);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());

  const { data, isLoading } = useQuery<AdminUserListResponse>({
    queryKey: ['admin', 'users'],
    queryFn: () => apiFetch<AdminUserListResponse>('/admin/users'),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });

  const deactivate = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/admin/users/${id}/deactivate`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => {
      toast.success('User deactivated');
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const reactivate = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/admin/users/${id}/reactivate`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => {
      toast.success('User reactivated');
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiFetch(`/admin/users/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('User deleted');
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: AdminUserRole }) =>
      apiFetch(`/admin/users/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ role }),
      }),
    onSuccess: () => {
      toast.success('Role updated');
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const createUser = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch<CreateUserResponse>('/admin/users', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: (resp) => {
      toast.success(`User ${resp.user.username} created`);
      if (resp.temporaryPassword) {
        setLastTempPassword({ username: resp.user.username, password: resp.temporaryPassword });
      }
      setShowCreate(false);
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Multi-select helpers (EE #116). Selection is keyed by user id so it
  // survives a list refetch — re-pruning out stale ids is cheap.
  // The current user is excluded from select-all so an admin can never
  // accidentally bulk-deactivate themselves with a single header click.
  const selectableIds = useMemo(
    () =>
      (data?.users ?? [])
        .filter((u) => u.id !== currentUserId)
        .map((u) => u.id),
    [data?.users, currentUserId],
  );
  const allSelected =
    selectableIds.length > 0 &&
    selectableIds.every((id) => selectedUserIds.has(id));
  const someSelected = selectedUserIds.size > 0;

  const toggleSelect = (id: string) => {
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) {
      setSelectedUserIds(new Set(selectableIds));
    } else {
      setSelectedUserIds(new Set());
    }
  };

  const clearSelection = () => setSelectedUserIds(new Set());

  return (
    <section className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-[-0.01em]">Users</h2>
          <p className="text-sm text-muted-foreground">
            Lifecycle management for user accounts. Role assignment and space permissions live under{' '}
            <a className="underline" href="/settings/security/rbac">RBAC</a>.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {bulkEnabled && someSelected && (
            <button
              type="button"
              onClick={() => setShowBulkAction(true)}
              className="rounded-md border border-border/60 px-4 py-2 text-sm font-medium hover:bg-foreground/5"
              data-testid="users-bulk-action-btn"
            >
              Bulk actions ({selectedUserIds.size})
            </button>
          )}
          {bulkEnabled && (
            <button
              type="button"
              onClick={() => setShowBulkImport(true)}
              className="rounded-md border border-border/60 px-4 py-2 text-sm font-medium hover:bg-foreground/5"
              data-testid="users-bulk-import-btn"
            >
              Bulk import
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Create user
          </button>
        </div>
      </header>

      {lastTempPassword && (
        <div className="rounded-md border border-yellow-300 bg-yellow-50 p-3 text-sm dark:bg-yellow-900/20">
          <p className="font-semibold text-yellow-900 dark:text-yellow-200">
            Temporary password for {lastTempPassword.username}
          </p>
          <p className="mt-1 font-mono text-yellow-900 dark:text-yellow-100">{lastTempPassword.password}</p>
          <p className="mt-2 text-xs text-yellow-800 dark:text-yellow-200">
            Share this with the user over a secure channel. It will not be shown again. Ask the user to change it immediately after first login.
          </p>
          <button
            type="button"
            className="mt-2 text-xs underline"
            onClick={() => setLastTempPassword(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {isLoading && <p className="text-sm text-muted-foreground">Loading users…</p>}

      {data?.users && (
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide">
              <tr>
                {bulkEnabled && (
                  <th className="w-10 p-3">
                    <input
                      type="checkbox"
                      aria-label="Select all users"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      data-testid="users-select-all"
                    />
                  </th>
                )}
                <th className="p-3">Username</th>
                <th className="p-3">Email</th>
                <th className="p-3">Role</th>
                <th className="p-3">Status</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id} className="border-t">
                  {bulkEnabled && (
                    <td className="p-3">
                      {u.id !== currentUserId && (
                        <input
                          type="checkbox"
                          aria-label={`Select user ${u.username}`}
                          checked={selectedUserIds.has(u.id)}
                          onChange={() => toggleSelect(u.id)}
                          data-testid={`users-select-${u.id}`}
                        />
                      )}
                    </td>
                  )}
                  <td className="p-3">
                    <div className="font-medium">{u.username}</div>
                    {u.displayName && <div className="text-xs text-muted-foreground">{u.displayName}</div>}
                  </td>
                  <td className="p-3 text-muted-foreground">{u.email ?? '—'}</td>
                  <td className="p-3">
                    <select
                      className="rounded-md border bg-background px-2 py-1 text-xs"
                      value={u.role}
                      disabled={u.id === currentUserId || updateRole.isPending}
                      onChange={(e) =>
                        updateRole.mutate({ id: u.id, role: e.target.value as AdminUserRole })
                      }
                    >
                      <option value="user">user</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td className="p-3">
                    {u.deactivatedAt ? (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-200">
                        deactivated
                      </span>
                    ) : (
                      <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-800 dark:bg-green-900/30 dark:text-green-200">
                        active
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-right space-x-2">
                    {u.id === currentUserId && (
                      <span className="text-xs text-muted-foreground">(you)</span>
                    )}
                    {u.id !== currentUserId && !u.deactivatedAt && (
                      <button
                        type="button"
                        className="text-xs text-yellow-700 underline dark:text-yellow-400"
                        onClick={() => deactivate.mutate(u.id)}
                        disabled={deactivate.isPending}
                      >
                        Deactivate
                      </button>
                    )}
                    {u.deactivatedAt && (
                      <button
                        type="button"
                        className="text-xs text-green-700 underline dark:text-green-400"
                        onClick={() => reactivate.mutate(u.id)}
                        disabled={reactivate.isPending}
                      >
                        Reactivate
                      </button>
                    )}
                    {u.id !== currentUserId && (
                      <button
                        type="button"
                        className="text-xs text-red-700 underline dark:text-red-400"
                        onClick={() => {
                          if (window.confirm(`Permanently delete "${u.username}"? This cannot be undone.`)) {
                            remove.mutate(u.id);
                          }
                        }}
                        disabled={remove.isPending}
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <UserCreateDialog
          onClose={() => setShowCreate(false)}
          onSubmit={(body) => createUser.mutate(body)}
          isSubmitting={createUser.isPending}
        />
      )}

      {/* EE #116 — bulk import. Components self-gate on hasFeature so a
          missing flag short-circuits to null even if `bulkEnabled` flips
          stale between license refreshes. */}
      <BulkUserImportModal
        open={showBulkImport}
        onClose={() => setShowBulkImport(false)}
      />
      <UserBulkActionDialog
        open={showBulkAction}
        onClose={() => {
          setShowBulkAction(false);
          // Selection is preserved if the dialog was cancelled, but
          // cleared on a successful submit (the dialog handles the
          // close + the queryInvalidate; the selection clear is local).
          // We clear on close to keep the state simple — operators can
          // re-select after seeing the refreshed list.
          clearSelection();
        }}
        selectedUserIds={Array.from(selectedUserIds)}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Create dialog — inline to keep this a single-file panel per the CE convention.
// ---------------------------------------------------------------------------

interface UserCreateDialogProps {
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
  isSubmitting: boolean;
}

function UserCreateDialog({ onClose, onSubmit, isSubmitting }: UserCreateDialogProps) {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<AdminUserRole>('user');
  const [mode, setMode] = useState<'password' | 'invitation'>('password');
  const [password, setPassword] = useState('');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = {
      username: username.trim(),
      role,
    };
    if (email.trim()) body.email = email.trim();
    if (displayName.trim()) body.displayName = displayName.trim();
    if (mode === 'password') {
      body.password = password;
    } else {
      body.sendInvitation = true;
    }
    onSubmit(body);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md space-y-4 rounded-md bg-background p-6 shadow-lg"
      >
        <h3 className="text-lg font-semibold">Create user</h3>
        <div className="space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Username</span>
            <input
              required
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              minLength={3}
              maxLength={50}
              pattern="[a-zA-Z0-9_.\-]+"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Email (optional)</span>
            <input
              type="email"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Display name (optional)</span>
            <input
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={100}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Role</span>
            <select
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={role}
              onChange={(e) => setRole(e.target.value as AdminUserRole)}
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </label>
          <fieldset className="space-y-2 rounded-md border p-3">
            <legend className="text-xs font-medium text-muted-foreground">Initial credentials</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                checked={mode === 'password'}
                onChange={() => setMode('password')}
              />
              Set an initial password
            </label>
            {mode === 'password' && (
              <input
                type="text"
                className="w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required={mode === 'password'}
                minLength={8}
                maxLength={200}
                placeholder="min 8 characters"
              />
            )}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                checked={mode === 'invitation'}
                onChange={() => setMode('invitation')}
              />
              Send invitation email (requires SMTP + email address)
            </label>
            {mode === 'invitation' && !email.trim() && (
              <p className="text-xs text-yellow-700 dark:text-yellow-400">
                Without an email address the temp password will be shown to you after create, and no email is sent.
              </p>
            )}
          </fieldset>
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-4 py-2 text-sm"
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
