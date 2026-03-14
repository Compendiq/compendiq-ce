import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { m } from 'framer-motion';
import {
  Shield, Users, FolderOpen, Plus, Trash2,
  UserPlus, Loader2, Lock,
} from 'lucide-react';
import { apiFetch } from '../../shared/lib/api';
import { cn } from '../../shared/lib/cn';

type RbacTab = 'roles' | 'groups' | 'permissions';

// --- Types ---

interface RolePermission {
  id: string;
  name: string;
  description: string;
  permissions: string[];
}

interface Group {
  id: string;
  name: string;
  description: string;
  memberCount: number;
  members: Array<{ id: string; username: string }>;
}

interface SpacePermission {
  spaceKey: string;
  spaceName: string;
  assignments: Array<{
    targetType: 'group' | 'user';
    targetId: string;
    targetName: string;
    role: string;
  }>;
}

// --- Hooks ---

function useRoles() {
  return useQuery<RolePermission[]>({
    queryKey: ['admin', 'roles'],
    queryFn: () => apiFetch('/admin/roles'),
    staleTime: 60_000,
  });
}

function useGroups() {
  return useQuery<Group[]>({
    queryKey: ['admin', 'groups'],
    queryFn: () => apiFetch('/admin/groups'),
    staleTime: 30_000,
  });
}

function useCreateGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; description: string }) =>
      apiFetch('/admin/groups', { method: 'POST', body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'groups'] });
    },
  });
}

function useDeleteGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (groupId: string) =>
      apiFetch(`/admin/groups/${groupId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'groups'] });
    },
  });
}

function useAddGroupMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) =>
      apiFetch(`/admin/groups/${groupId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'groups'] });
    },
  });
}

function useRemoveGroupMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) =>
      apiFetch(`/admin/groups/${groupId}/members/${userId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'groups'] });
    },
  });
}

function useSpacePermissions(spaceKey: string | undefined) {
  return useQuery<SpacePermission>({
    queryKey: ['admin', 'space-permissions', spaceKey],
    queryFn: () => apiFetch(`/admin/spaces/${spaceKey}/permissions`),
    enabled: !!spaceKey,
    staleTime: 30_000,
  });
}

function useSpaces() {
  return useQuery<Array<{ key: string; name: string }>>({
    queryKey: ['spaces'],
    queryFn: () => apiFetch('/spaces'),
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
            <h3 className="font-medium">{role.name}</h3>
          </div>
          {role.description && (
            <p className="mt-1 text-sm text-muted-foreground">{role.description}</p>
          )}
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
  const createMutation = useCreateGroup();
  const deleteMutation = useDeleteGroup();
  const addMemberMutation = useAddGroupMember();
  const removeMemberMutation = useRemoveGroupMember();

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupDesc, setNewGroupDesc] = useState('');
  const [addMemberGroupId, setAddMemberGroupId] = useState<string | null>(null);
  const [newMemberUserId, setNewMemberUserId] = useState('');

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

  const handleAddMember = useCallback(() => {
    if (!addMemberGroupId || !newMemberUserId.trim()) return;
    addMemberMutation.mutate(
      { groupId: addMemberGroupId, userId: newMemberUserId.trim() },
      {
        onSuccess: () => {
          setNewMemberUserId('');
          setAddMemberGroupId(null);
        },
      },
    );
  }, [addMemberGroupId, newMemberUserId, addMemberMutation]);

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
                  onClick={() => setAddMemberGroupId(
                    addMemberGroupId === group.id ? null : group.id,
                  )}
                  className="flex items-center gap-1 rounded-md bg-foreground/5 px-2 py-1 text-xs hover:bg-foreground/10"
                  data-testid={`add-member-${group.id}`}
                >
                  <UserPlus size={12} />
                  Add
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

            {/* Add member form */}
            {addMemberGroupId === group.id && (
              <div className="mt-3 flex gap-2 border-t border-border/50 pt-3" data-testid={`add-member-form-${group.id}`}>
                <input
                  type="text"
                  value={newMemberUserId}
                  onChange={(e) => setNewMemberUserId(e.target.value)}
                  placeholder="User ID"
                  className="flex-1 rounded-md bg-foreground/5 px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
                  data-testid={`member-id-input-${group.id}`}
                  autoFocus
                />
                <button
                  onClick={handleAddMember}
                  disabled={!newMemberUserId.trim() || addMemberMutation.isPending}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  Add
                </button>
              </div>
            )}

            {/* Member list */}
            {group.members.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2 border-t border-border/50 pt-3">
                {group.members.map((member) => (
                  <span
                    key={member.id}
                    className="flex items-center gap-1 rounded-full bg-foreground/5 py-0.5 pl-2.5 pr-1 text-xs"
                  >
                    {member.username}
                    <button
                      onClick={() => removeMemberMutation.mutate({ groupId: group.id, userId: member.id })}
                      className="ml-0.5 rounded-full p-0.5 hover:bg-destructive/10 hover:text-destructive"
                      aria-label={`Remove ${member.username}`}
                      data-testid={`remove-member-${group.id}-${member.id}`}
                    >
                      <Trash2 size={10} />
                    </button>
                  </span>
                ))}
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
  const [selectedSpace, setSelectedSpace] = useState<string>('');
  const { data: permissions, isLoading } = useSpacePermissions(selectedSpace || undefined);

  return (
    <div className="space-y-4" data-testid="space-permissions">
      {/* Space selector */}
      <div className="flex items-center gap-3">
        <label className="text-sm text-muted-foreground">Select space:</label>
        <select
          value={selectedSpace}
          onChange={(e) => setSelectedSpace(e.target.value)}
          className="rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
          data-testid="space-selector"
        >
          <option value="">Choose a space...</option>
          {spaces?.map((s) => (
            <option key={s.key} value={s.key}>{s.name}</option>
          ))}
        </select>
      </div>

      {/* Permissions display */}
      {!selectedSpace ? (
        <div className="glass-card py-12 text-center text-sm text-muted-foreground">
          Select a space to view permissions
        </div>
      ) : isLoading ? (
        <div className="glass-card h-32 animate-pulse" />
      ) : !permissions?.assignments.length ? (
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
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {permissions.assignments.map((assignment, i) => (
                <tr key={`${assignment.targetType}-${assignment.targetId}-${i}`} className="hover:bg-foreground/5">
                  <td className="px-4 py-2.5">
                    <span className={cn(
                      'rounded px-2 py-0.5 text-xs font-medium',
                      assignment.targetType === 'group' ? 'bg-primary/10 text-primary' : 'bg-info/10 text-info',
                    )}>
                      {assignment.targetType === 'group' ? 'Group' : 'User'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">{assignment.targetName}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{assignment.role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
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
      <div>
        <h1 className="text-2xl font-bold">Access Control</h1>
        <p className="text-sm text-muted-foreground">
          Manage roles, groups, and space-level permissions
        </p>
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
