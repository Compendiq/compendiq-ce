import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { m } from 'framer-motion';
import {
  Shield, Users, FolderOpen, Plus, Trash2,
  UserPlus, Loader2, Lock, ShieldCheck,
} from 'lucide-react';
import { apiFetch } from '../../shared/lib/api';
import { cn } from '../../shared/lib/cn';
import { useAuthStore } from '../../stores/auth-store';

type RbacTab = 'roles' | 'groups' | 'permissions';

// --- Types ---

interface Role {
  id: number;
  name: string;
  displayName: string;
  isSystem: boolean;
  permissions: string[];
  createdAt: string;
}

interface Group {
  id: number;
  name: string;
  description: string | null;
  source: string;
  memberCount: number;
  createdAt: string;
}

interface GroupMember {
  userId: string;
  username: string;
  source: string;
  joinedAt: string;
}

interface SpaceRoleAssignment {
  id: number;
  spaceKey: string;
  principalType: 'user' | 'group';
  principalId: string;
  principalName: string | null;
  roleId: number;
  roleName: string;
  roleDisplayName: string;
  createdAt: string;
}

interface UserInfo {
  id: string;
  username: string;
  role: string;
  createdAt: string;
}

// --- Hooks ---

function useRoles() {
  return useQuery<Role[]>({
    queryKey: ['admin', 'roles'],
    queryFn: () => apiFetch('/roles'),
    staleTime: 60_000,
  });
}

function useGroups() {
  return useQuery<Group[]>({
    queryKey: ['admin', 'groups'],
    queryFn: () => apiFetch('/groups'),
    staleTime: 30_000,
  });
}

function useGroupMembers(groupId: number | null) {
  return useQuery<GroupMember[]>({
    queryKey: ['admin', 'group-members', groupId],
    queryFn: () => apiFetch(`/groups/${groupId}/members`),
    enabled: groupId !== null,
    staleTime: 30_000,
  });
}

function useCreateGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; description: string }) =>
      apiFetch('/groups', { method: 'POST', body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'groups'] });
    },
  });
}

function useDeleteGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (groupId: number) =>
      apiFetch(`/groups/${groupId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'groups'] });
    },
  });
}

function useAddGroupMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, userId }: { groupId: number; userId: string }) =>
      apiFetch(`/groups/${groupId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId }),
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'groups'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'group-members', variables.groupId] });
    },
  });
}

function useRemoveGroupMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, userId }: { groupId: number; userId: string }) =>
      apiFetch(`/groups/${groupId}/members/${userId}`, {
        method: 'DELETE',
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'groups'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'group-members', variables.groupId] });
    },
  });
}

function useSpaceRoles(spaceKey: string | undefined) {
  return useQuery<SpaceRoleAssignment[]>({
    queryKey: ['admin', 'space-roles', spaceKey],
    queryFn: () => apiFetch(`/spaces/${spaceKey}/roles`),
    enabled: !!spaceKey,
    staleTime: 30_000,
  });
}

function useAssignSpaceRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ spaceKey, ...body }: { spaceKey: string; principalType: string; principalId: string; roleId: number }) =>
      apiFetch(`/spaces/${spaceKey}/roles`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'space-roles', variables.spaceKey] });
    },
  });
}

function useRemoveSpaceRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ spaceKey, assignmentId }: { spaceKey: string; assignmentId: number }) =>
      apiFetch(`/spaces/${spaceKey}/roles/${assignmentId}`, {
        method: 'DELETE',
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'space-roles', variables.spaceKey] });
    },
  });
}

function useSpaces() {
  return useQuery<Array<{ key: string; name: string }>>({
    queryKey: ['spaces'],
    queryFn: () => apiFetch('/spaces'),
    staleTime: 60_000,
  });
}

function useUsers() {
  return useQuery<UserInfo[]>({
    queryKey: ['admin', 'users'],
    queryFn: () => apiFetch('/users'),
    staleTime: 60_000,
  });
}

// --- Tab components ---

function RolesTab() {
  const { data: roles, isLoading } = useRoles();

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="glass-card h-20 animate-pulse" />
        ))}
      </div>
    );
  }

  if (!roles?.length) {
    return (
      <div className="glass-card py-12 text-center text-sm text-muted-foreground">
        No roles configured
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="roles-list">
      {roles.map((role, i) => (
        <m.div
          key={role.id}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.05 }}
          className="glass-card p-4"
          data-testid={`role-${role.id}`}
        >
          <div className="flex items-center gap-2">
            <Lock size={14} className="text-primary" />
            <h3 className="font-medium">{role.displayName}</h3>
            {role.isSystem && (
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                System
              </span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {role.permissions.map((perm) => (
              <span
                key={perm}
                className="rounded bg-foreground/5 px-2 py-0.5 text-xs text-muted-foreground"
              >
                {perm}
              </span>
            ))}
          </div>
        </m.div>
      ))}
    </div>
  );
}

function GroupsTab() {
  const { data: groups, isLoading } = useGroups();
  const { data: users } = useUsers();
  const createMutation = useCreateGroup();
  const deleteMutation = useDeleteGroup();
  const addMemberMutation = useAddGroupMember();
  const removeMemberMutation = useRemoveGroupMember();

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupDesc, setNewGroupDesc] = useState('');
  const [expandedGroupId, setExpandedGroupId] = useState<number | null>(null);
  const [selectedUserId, setSelectedUserId] = useState('');

  const { data: groupMembers } = useGroupMembers(expandedGroupId);

  const handleCreateGroup = useCallback(() => {
    if (!newGroupName.trim()) return;
    createMutation.mutate(
      { name: newGroupName.trim(), description: newGroupDesc.trim() },
      {
        onSuccess: () => {
          setShowCreateForm(false);
          setNewGroupName('');
          setNewGroupDesc('');
        },
      },
    );
  }, [newGroupName, newGroupDesc, createMutation]);

  const handleAddMember = useCallback((groupId: number) => {
    if (!selectedUserId) return;
    addMemberMutation.mutate(
      { groupId, userId: selectedUserId },
      {
        onSuccess: () => {
          setSelectedUserId('');
        },
      },
    );
  }, [selectedUserId, addMemberMutation]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="glass-card h-24 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="groups-list">
      {/* Create group button */}
      {!showCreateForm ? (
        <button
          onClick={() => setShowCreateForm(true)}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          data-testid="create-group-btn"
        >
          <Plus size={16} />
          New Group
        </button>
      ) : (
        <div className="glass-card p-4 space-y-3" data-testid="create-group-form">
          <input
            type="text"
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            placeholder="Group name"
            className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            data-testid="group-name-input"
            autoFocus
          />
          <input
            type="text"
            value={newGroupDesc}
            onChange={(e) => setNewGroupDesc(e.target.value)}
            placeholder="Description (optional)"
            className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            data-testid="group-desc-input"
          />
          <div className="flex gap-2">
            <button
              onClick={handleCreateGroup}
              disabled={!newGroupName.trim() || createMutation.isPending}
              className="flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              data-testid="submit-group"
            >
              {createMutation.isPending && <Loader2 size={14} className="animate-spin" />}
              Create
            </button>
            <button
              onClick={() => setShowCreateForm(false)}
              className="rounded-md bg-foreground/5 px-3 py-1.5 text-sm hover:bg-foreground/10"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Groups list */}
      {!groups?.length ? (
        <div className="glass-card py-12 text-center text-sm text-muted-foreground">
          No groups created yet
        </div>
      ) : (
        groups.map((group, i) => (
          <m.div
            key={group.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
            className="glass-card p-4"
            data-testid={`group-${group.id}`}
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <Users size={14} className="text-primary" />
                  <h3 className="font-medium">{group.name}</h3>
                  <span className="text-xs text-muted-foreground">
                    ({group.memberCount} {group.memberCount === 1 ? 'member' : 'members'})
                  </span>
                </div>
                {group.description && (
                  <p className="mt-0.5 text-sm text-muted-foreground">{group.description}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setExpandedGroupId(
                    expandedGroupId === group.id ? null : group.id,
                  )}
                  className="flex items-center gap-1 rounded-md bg-foreground/5 px-2 py-1 text-xs hover:bg-foreground/10"
                  data-testid={`toggle-members-${group.id}`}
                >
                  <UserPlus size={12} />
                  {expandedGroupId === group.id ? 'Hide' : 'Members'}
                </button>
                <button
                  onClick={() => deleteMutation.mutate(group.id)}
                  disabled={deleteMutation.isPending}
                  className="flex items-center gap-1 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive hover:bg-destructive/20 disabled:opacity-50"
                  data-testid={`delete-group-${group.id}`}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>

            {/* Members section (expandable) */}
            {expandedGroupId === group.id && (
              <div className="mt-3 border-t border-border/50 pt-3 space-y-3">
                {/* Add member form */}
                <div className="flex gap-2" data-testid={`add-member-form-${group.id}`}>
                  <select
                    value={selectedUserId}
                    onChange={(e) => setSelectedUserId(e.target.value)}
                    className="flex-1 rounded-md bg-foreground/5 px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
                    data-testid={`member-select-${group.id}`}
                  >
                    <option value="">Select user...</option>
                    {users?.filter((u) => !groupMembers?.some((m) => m.userId === u.id))
                      .map((u) => (
                        <option key={u.id} value={u.id}>{u.username}</option>
                      ))}
                  </select>
                  <button
                    onClick={() => handleAddMember(group.id)}
                    disabled={!selectedUserId || addMemberMutation.isPending}
                    className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    data-testid={`add-member-btn-${group.id}`}
                  >
                    Add
                  </button>
                </div>

                {/* Member list */}
                {groupMembers && groupMembers.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {groupMembers.map((member) => (
                      <span
                        key={member.userId}
                        className="flex items-center gap-1 rounded-full bg-foreground/5 py-0.5 pl-2.5 pr-1 text-xs"
                      >
                        {member.username}
                        <button
                          onClick={() => removeMemberMutation.mutate({ groupId: group.id, userId: member.userId })}
                          className="ml-0.5 rounded-full p-0.5 hover:bg-destructive/10 hover:text-destructive"
                          aria-label={`Remove ${member.username}`}
                          data-testid={`remove-member-${group.id}-${member.userId}`}
                        >
                          <Trash2 size={10} />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No members yet</p>
                )}
              </div>
            )}
          </m.div>
        ))
      )}
    </div>
  );
}

function SpacePermissionsTab() {
  const { data: spaces } = useSpaces();
  const { data: roles } = useRoles();
  const { data: users } = useUsers();
  const { data: groups } = useGroups();

  const [selectedSpace, setSelectedSpace] = useState<string>('');
  const { data: assignments, isLoading } = useSpaceRoles(selectedSpace || undefined);

  const assignMutation = useAssignSpaceRole();
  const removeMutation = useRemoveSpaceRole();

  const [showAssignForm, setShowAssignForm] = useState(false);
  const [principalType, setPrincipalType] = useState<'user' | 'group'>('user');
  const [principalId, setPrincipalId] = useState('');
  const [roleId, setRoleId] = useState<number>(0);

  const handleAssign = useCallback(() => {
    if (!selectedSpace || !principalId || !roleId) return;
    assignMutation.mutate(
      { spaceKey: selectedSpace, principalType, principalId, roleId },
      {
        onSuccess: () => {
          setShowAssignForm(false);
          setPrincipalId('');
          setRoleId(0);
        },
      },
    );
  }, [selectedSpace, principalType, principalId, roleId, assignMutation]);

  return (
    <div className="space-y-4" data-testid="space-permissions">
      {/* Space selector */}
      <div className="flex items-center gap-3">
        <label className="text-sm text-muted-foreground">Select space:</label>
        <select
          value={selectedSpace}
          onChange={(e) => { setSelectedSpace(e.target.value); setShowAssignForm(false); }}
          className="rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
          data-testid="space-selector"
        >
          <option value="">Choose a space...</option>
          {spaces?.map((s) => (
            <option key={s.key} value={s.key}>{s.name} ({s.key})</option>
          ))}
        </select>
      </div>

      {/* Permissions display */}
      {!selectedSpace ? (
        <div className="glass-card py-12 text-center text-sm text-muted-foreground">
          Select a space to view and manage permissions
        </div>
      ) : isLoading ? (
        <div className="glass-card h-32 animate-pulse" />
      ) : (
        <div className="space-y-4">
          {/* Add assignment button */}
          {!showAssignForm ? (
            <button
              onClick={() => setShowAssignForm(true)}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              data-testid="add-assignment-btn"
            >
              <Plus size={16} />
              Assign Role
            </button>
          ) : (
            <div className="glass-card p-4 space-y-3" data-testid="assign-role-form">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Type</label>
                  <select
                    value={principalType}
                    onChange={(e) => { setPrincipalType(e.target.value as 'user' | 'group'); setPrincipalId(''); }}
                    className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                    data-testid="principal-type-select"
                  >
                    <option value="user">User</option>
                    <option value="group">Group</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">
                    {principalType === 'user' ? 'User' : 'Group'}
                  </label>
                  <select
                    value={principalId}
                    onChange={(e) => setPrincipalId(e.target.value)}
                    className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                    data-testid="principal-select"
                  >
                    <option value="">Select...</option>
                    {principalType === 'user'
                      ? users?.map((u) => <option key={u.id} value={u.id}>{u.username}</option>)
                      : groups?.map((g) => <option key={g.id} value={String(g.id)}>{g.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Role</label>
                  <select
                    value={roleId}
                    onChange={(e) => setRoleId(Number(e.target.value))}
                    className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                    data-testid="role-select"
                  >
                    <option value={0}>Select role...</option>
                    {roles?.filter((r) => r.name !== 'system_admin').map((r) => (
                      <option key={r.id} value={r.id}>{r.displayName}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleAssign}
                  disabled={!principalId || !roleId || assignMutation.isPending}
                  className="flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  data-testid="submit-assignment"
                >
                  {assignMutation.isPending && <Loader2 size={14} className="animate-spin" />}
                  Assign
                </button>
                <button
                  onClick={() => setShowAssignForm(false)}
                  className="rounded-md bg-foreground/5 px-3 py-1.5 text-sm hover:bg-foreground/10"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Assignments table */}
          {!assignments?.length ? (
            <div className="glass-card py-12 text-center text-sm text-muted-foreground">
              No permissions configured for this space
            </div>
          ) : (
            <div className="glass-card overflow-hidden" data-testid="permissions-list">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Type</th>
                    <th className="px-4 py-3 font-medium">Name</th>
                    <th className="px-4 py-3 font-medium">Role</th>
                    <th className="px-4 py-3 font-medium w-16"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {assignments.map((assignment) => (
                    <tr key={assignment.id} className="hover:bg-foreground/5" data-testid={`assignment-${assignment.id}`}>
                      <td className="px-4 py-2.5">
                        <span className={cn(
                          'rounded px-2 py-0.5 text-xs font-medium',
                          assignment.principalType === 'group' ? 'bg-primary/10 text-primary' : 'bg-info/10 text-info',
                        )}>
                          {assignment.principalType === 'group' ? 'Group' : 'User'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">{assignment.principalName ?? assignment.principalId}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{assignment.roleDisplayName}</td>
                      <td className="px-4 py-2.5">
                        <button
                          onClick={() => removeMutation.mutate({ spaceKey: selectedSpace, assignmentId: assignment.id })}
                          disabled={removeMutation.isPending}
                          className="rounded-md p-1 text-destructive/70 hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                          aria-label="Remove assignment"
                          data-testid={`remove-assignment-${assignment.id}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- System Admin Badge ---

function AdminBadge() {
  const user = useAuthStore((s) => s.user);

  if (user?.role !== 'admin') return null;

  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
      <ShieldCheck size={12} />
      System Admin
    </span>
  );
}

// --- Main page ---

const TAB_CONFIG: Array<{ key: RbacTab; label: string; icon: typeof Shield }> = [
  { key: 'roles', label: 'Roles', icon: Shield },
  { key: 'groups', label: 'Groups', icon: Users },
  { key: 'permissions', label: 'Space Permissions', icon: FolderOpen },
];

export function RbacPage() {
  const [activeTab, setActiveTab] = useState<RbacTab>('roles');

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Access Control</h1>
          <p className="text-sm text-muted-foreground">
            Manage roles, groups, and space-level permissions
          </p>
        </div>
        <AdminBadge />
      </div>

      {/* Tabs */}
      <div className="glass-card p-1.5">
        <div className="flex gap-1">
          {TAB_CONFIG.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-4 py-2 text-sm transition-colors',
                activeTab === key
                  ? 'bg-primary/15 text-primary font-medium'
                  : 'text-muted-foreground hover:bg-foreground/5',
              )}
              data-testid={`rbac-tab-${key}`}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      {activeTab === 'roles' && <RolesTab />}
      {activeTab === 'groups' && <GroupsTab />}
      {activeTab === 'permissions' && <SpacePermissionsTab />}
    </div>
  );
}
