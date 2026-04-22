import { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Shield, Trash2, X, Loader2, Check, AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../shared/lib/api';

// --- Types ---

export interface PermissionDefinition {
  id: string;
  displayName: string;
  description: string;
  category: string;
  createdAt: string;
}

export interface CustomRole {
  id: number;
  name: string;
  displayName: string;
  description: string;
  isSystem: boolean;
  permissions: string[];
  createdAt: string;
  updatedAt: string;
}

interface RoleAssignment {
  id: number;
  spaceKey: string;
  principalType: 'user' | 'group';
  principalId: string;
  principalName: string | null;
  createdAt: string;
}

export interface CustomRoleEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing role to edit; null = create mode */
  editRole: CustomRole | null;
}

// --- Hooks ---

function usePermissionDefinitions() {
  return useQuery<PermissionDefinition[]>({
    queryKey: ['admin', 'permissions'],
    queryFn: () => apiFetch('/admin/permissions'),
    staleTime: 60_000,
  });
}

function useRoleAssignments(roleId: number | null) {
  return useQuery<RoleAssignment[]>({
    queryKey: ['admin', 'role-assignments', roleId],
    queryFn: () => apiFetch(`/admin/roles/${roleId}/assignments`),
    enabled: roleId !== null,
    staleTime: 30_000,
  });
}

// --- Validation ---

const SNAKE_CASE_REGEX = /^[a-z][a-z0-9_]*$/;

function validateRoleName(name: string): string | null {
  if (!name) return 'Role name is required';
  if (!SNAKE_CASE_REGEX.test(name)) return 'Must be lowercase snake_case (e.g. content_editor)';
  if (name.length > 100) return 'Maximum 100 characters';
  return null;
}

// --- Category display labels ---

const CATEGORY_LABELS: Record<string, string> = {
  pages: 'Pages',
  llm: 'LLM',
  sync: 'Sync',
  spaces: 'Spaces',
  admin: 'Admin',
};

function getCategoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category.charAt(0).toUpperCase() + category.slice(1);
}

// --- Component ---

export function CustomRoleEditor({ open, onOpenChange, editRole }: CustomRoleEditorProps) {
  const queryClient = useQueryClient();
  const isEditMode = editRole !== null;

  // --- Form state ---
  const [roleName, setRoleName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedPermissions, setSelectedPermissions] = useState<Set<string>>(new Set());
  const [nameError, setNameError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<'edit' | 'assignments'>('edit');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // --- Data fetching ---
  const { data: permissions, isLoading: permissionsLoading } = usePermissionDefinitions();
  const { data: assignments } = useRoleAssignments(isEditMode ? editRole.id : null);

  // --- Reset form when modal opens or editRole changes ---
  useEffect(() => {
    if (open) {
      if (editRole) {
        setRoleName(editRole.name);
        setDisplayName(editRole.displayName);
        setDescription(editRole.description ?? '');
        setSelectedPermissions(new Set(editRole.permissions));
        setActiveSection('edit');
      } else {
        setRoleName('');
        setDisplayName('');
        setDescription('');
        setSelectedPermissions(new Set());
        setActiveSection('edit');
      }
      setNameError(null);
      setShowDeleteConfirm(false);
    }
  }, [open, editRole]);

  // --- Permission grouping ---
  const grouped = useMemo(() => {
    if (!permissions) return {};
    const groups: Record<string, PermissionDefinition[]> = {};
    for (const perm of permissions) {
      const cat = perm.category || 'other';
      (groups[cat] ??= []).push(perm);
    }
    return groups;
  }, [permissions]);

  // --- Mutations ---

  const createMutation = useMutation({
    mutationFn: (body: { name: string; displayName: string; description: string; permissions: string[] }) =>
      apiFetch('/admin/roles', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      // Dual invalidation: CE roles list + EE custom roles list
      queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'custom-roles'] });
      toast.success('Custom role created');
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...body }: { id: number; displayName: string; description: string; permissions: string[] }) =>
      apiFetch(`/admin/roles/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'custom-roles'] });
      toast.success('Role updated');
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/admin/roles/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'custom-roles'] });
      toast.success('Role deleted');
      onOpenChange(false);
    },
    onError: (err: Error) => {
      // Backend returns 409 when role is still assigned to spaces
      toast.error(
        err.message.includes('409') || err.message.toLowerCase().includes('assigned')
          ? 'Role is still assigned to spaces. Remove assignments first.'
          : err.message,
      );
    },
  });

  // --- Handlers ---

  const handleNameChange = (value: string) => {
    setRoleName(value);
    setNameError(validateRoleName(value));
  };

  const togglePermission = (permId: string) => {
    setSelectedPermissions((prev) => {
      const next = new Set(prev);
      if (next.has(permId)) {
        next.delete(permId);
      } else {
        next.add(permId);
      }
      return next;
    });
  };

  const handleSubmit = () => {
    if (!isEditMode) {
      const error = validateRoleName(roleName);
      if (error) {
        setNameError(error);
        return;
      }
    }
    if (selectedPermissions.size === 0) return;

    if (isEditMode) {
      updateMutation.mutate({
        id: editRole.id,
        displayName,
        description,
        permissions: [...selectedPermissions],
      });
    } else {
      createMutation.mutate({
        name: roleName,
        displayName,
        description,
        permissions: [...selectedPermissions],
      });
    }
  };

  const handleDelete = () => {
    if (!editRole) return;
    deleteMutation.mutate(editRole.id);
  };

  const isPending = createMutation.isPending || updateMutation.isPending || deleteMutation.isPending;
  const canSubmit = selectedPermissions.size > 0 && !isPending && (isEditMode || !nameError);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
          data-testid="custom-role-editor-overlay"
        />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border/60 bg-card/90 shadow-2xl backdrop-blur-xl outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] max-h-[85vh] overflow-y-auto"
          aria-describedby={undefined}
          data-testid="custom-role-editor"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border/50 px-5 py-4">
            <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-foreground">
              <Shield size={18} className="text-primary" />
              {isEditMode ? `Edit Role: ${editRole.displayName}` : 'Create Custom Role'}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                aria-label="Close"
                data-testid="close-editor-btn"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          {/* Sub-tabs (edit mode only) */}
          {isEditMode && (
            <div className="flex gap-1 border-b border-border/50 px-5 py-2">
              <button
                onClick={() => setActiveSection('edit')}
                className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                  activeSection === 'edit'
                    ? 'bg-primary/15 text-primary font-medium'
                    : 'text-muted-foreground hover:bg-foreground/5'
                }`}
                data-testid="tab-permissions"
              >
                Permissions
              </button>
              <button
                onClick={() => setActiveSection('assignments')}
                className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                  activeSection === 'assignments'
                    ? 'bg-primary/15 text-primary font-medium'
                    : 'text-muted-foreground hover:bg-foreground/5'
                }`}
                data-testid="tab-assignments"
              >
                Assignments
              </button>
            </div>
          )}

          {/* Content */}
          <div className="p-5 space-y-5">
            {activeSection === 'edit' ? (
              <>
                {/* Role name */}
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    Role Name (snake_case)
                  </label>
                  <input
                    type="text"
                    value={roleName}
                    onChange={(e) => handleNameChange(e.target.value)}
                    placeholder="e.g. content_editor"
                    disabled={isEditMode}
                    className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
                    data-testid="role-name-input"
                  />
                  {nameError && (
                    <p className="mt-1 text-xs text-destructive" data-testid="name-error">
                      {nameError}
                    </p>
                  )}
                </div>

                {/* Display name */}
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    Display Name
                  </label>
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="e.g. Content Editor"
                    className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                    data-testid="display-name-input"
                  />
                </div>

                {/* Description */}
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    Description
                  </label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Optional description for this role"
                    rows={2}
                    className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary resize-none"
                    data-testid="description-input"
                  />
                </div>

                {/* Permissions grouped by category */}
                <div>
                  <label className="mb-2 block text-xs font-medium text-muted-foreground">
                    Permissions
                  </label>
                  {permissionsLoading ? (
                    <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                      <Loader2 size={14} className="animate-spin" />
                      Loading permissions...
                    </div>
                  ) : (
                    <div className="space-y-4" data-testid="permission-groups">
                      {Object.entries(grouped).map(([category, perms]) => (
                        <div key={category} data-testid={`permission-group-${category}`}>
                          <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                            {getCategoryLabel(category)}
                          </h4>
                          <div className="space-y-1.5">
                            {perms.map((perm) => (
                              <label
                                key={perm.id}
                                className="flex items-start gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-foreground/3 cursor-pointer"
                                data-testid={`permission-${perm.id}`}
                              >
                                <input
                                  type="checkbox"
                                  checked={selectedPermissions.has(perm.id)}
                                  onChange={() => togglePermission(perm.id)}
                                  className="mt-0.5 h-4 w-4 rounded border-border accent-primary"
                                  data-testid={`checkbox-${perm.id}`}
                                />
                                <div>
                                  <div className="text-sm font-medium">{perm.displayName}</div>
                                  <div className="text-xs text-muted-foreground">{perm.description}</div>
                                </div>
                              </label>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : (
              /* Assignments tab (edit mode only) */
              <div data-testid="assignments-content">
                <p className="mb-3 text-xs text-muted-foreground">
                  Role assignments are managed via the Space Permissions tab. Below is a read-only view of current assignments for this role.
                </p>
                {!assignments?.length ? (
                  <div className="rounded-lg bg-foreground/5 py-8 text-center text-sm text-muted-foreground">
                    No assignments for this role
                  </div>
                ) : (
                  <div className="rounded-lg border border-border/50 overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                          <th className="px-4 py-2.5 font-medium">Space</th>
                          <th className="px-4 py-2.5 font-medium">Type</th>
                          <th className="px-4 py-2.5 font-medium">Principal</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/30">
                        {assignments.map((a) => (
                          <tr key={a.id} className="hover:bg-foreground/5" data-testid={`assignment-row-${a.id}`}>
                            <td className="px-4 py-2">{a.spaceKey}</td>
                            <td className="px-4 py-2">
                              <span className={`rounded px-2 py-0.5 text-xs font-medium ${
                                a.principalType === 'group' ? 'bg-primary/10 text-primary' : 'bg-blue-500/10 text-blue-500'
                              }`}>
                                {a.principalType === 'group' ? 'Group' : 'User'}
                              </span>
                            </td>
                            <td className="px-4 py-2">{a.principalName ?? a.principalId}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-border/50 px-5 py-4">
            <div>
              {isEditMode && !showDeleteConfirm && (
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="flex items-center gap-1.5 rounded-md bg-destructive/10 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/20"
                  data-testid="delete-role-btn"
                >
                  <Trash2 size={14} />
                  Delete Role
                </button>
              )}
              {isEditMode && showDeleteConfirm && (
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1 text-xs text-destructive">
                    <AlertTriangle size={12} />
                    Delete this role?
                  </span>
                  <button
                    onClick={handleDelete}
                    disabled={deleteMutation.isPending}
                    className="flex items-center gap-1 rounded-md bg-destructive px-2.5 py-1 text-xs text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
                    data-testid="confirm-delete-btn"
                  >
                    {deleteMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                    Confirm
                  </button>
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    className="rounded-md bg-foreground/5 px-2.5 py-1 text-xs hover:bg-foreground/10"
                    data-testid="cancel-delete-btn"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Dialog.Close asChild>
                <button className="rounded-md bg-foreground/5 px-4 py-2 text-sm hover:bg-foreground/10">
                  Cancel
                </button>
              </Dialog.Close>
              {activeSection === 'edit' && (
                <button
                  onClick={handleSubmit}
                  disabled={!canSubmit}
                  className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  data-testid="submit-role-btn"
                >
                  {isPending && <Loader2 size={14} className="animate-spin" />}
                  {isEditMode ? 'Save' : 'Create'}
                </button>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
