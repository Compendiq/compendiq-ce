/**
 * Multi-select bulk-action dialog for the admin user list (EE #116).
 *
 * Trigger: the parent (`UsersAdminPage`) renders a "Bulk actions" button
 * once the user has selected one or more rows; clicking opens this
 * dialog with `selectedUserIds`.
 *
 * Action menu (one of):
 *   - change-role           → admin / user radio
 *   - deactivate            → optional reason textarea
 *   - reactivate
 *   - add-to-group          → group picker (free-text id)
 *   - remove-from-group     → group picker (free-text id)
 *
 * Submit: POST `/admin/users/bulk/action` with the union body shape from
 * `BulkUserBulkActionRequestSchema`. Confirmation summary shown before
 * the actual POST so an admin doesn't accidentally deactivate seven
 * users with a stray click.
 *
 * Same gating story as `BulkUserImportModal`: the whole component
 * returns null when the licence doesn't grant `bulk_user_operations`,
 * and falls back to a "requires Enterprise" message if the route 404s
 * (CE-only deployment with a stale licence cache, etc.).
 */

import { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { toast } from 'sonner';
import { AlertTriangle, Loader2, Users, X } from 'lucide-react';
import type {
  BulkUserAction,
  BulkUserBulkActionRequest,
} from '@compendiq/contracts';
import { useAuthStore } from '../../stores/auth-store';
import { useEnterprise } from '../../shared/enterprise/use-enterprise';
import { cn } from '../../shared/lib/cn';

// Local fetch helper — same shape as BulkUserImportModal so the 404-on-
// missing-overlay branch lights up consistently.
interface BackendErrorBody {
  error?: string;
  message?: string;
  detail?: string;
}

type FetchError = Error & {
  status?: number;
  body?: BackendErrorBody;
};

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const { accessToken } = useAuthStore.getState();
  const headers = new Headers(init?.headers);
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(`/api${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });
  if (!res.ok) {
    const body: BackendErrorBody = await res.json().catch(() => ({}));
    const err = new Error(
      body.message ?? body.error ?? res.statusText,
    ) as FetchError;
    err.status = res.status;
    err.body = body;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  if (res.headers.get('content-type')?.includes('application/json')) {
    return res.json();
  }
  return undefined as T;
}

// ── Action kinds ──────────────────────────────────────────────────────────

type ActionKind = BulkUserAction['type'];

const ACTION_LABELS: Record<ActionKind, string> = {
  'change-role': 'Change role',
  deactivate: 'Deactivate',
  reactivate: 'Reactivate',
  'add-to-group': 'Add to group',
  'remove-from-group': 'Remove from group',
};

interface UserBulkActionDialogProps {
  open: boolean;
  onClose: () => void;
  selectedUserIds: string[];
}

export function UserBulkActionDialog(props: UserBulkActionDialogProps) {
  const { hasFeature } = useEnterprise();
  if (!hasFeature('bulk_user_operations')) {
    return null;
  }
  return <UserBulkActionDialogInner {...props} />;
}

// ── Inner stateful body ───────────────────────────────────────────────────

function UserBulkActionDialogInner({
  open,
  onClose,
  selectedUserIds,
}: UserBulkActionDialogProps) {
  const queryClient = useQueryClient();

  const [actionKind, setActionKind] = useState<ActionKind>('change-role');
  const [role, setRole] = useState<'admin' | 'user'>('user');
  const [reason, setReason] = useState('');
  const [groupId, setGroupId] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isMissingOverlay, setIsMissingOverlay] = useState(false);

  const reset = useCallback(() => {
    setActionKind('change-role');
    setRole('user');
    setReason('');
    setGroupId('');
    setErrorMessage(null);
    setIsMissingOverlay(false);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  const buildAction = useCallback((): BulkUserAction => {
    switch (actionKind) {
      case 'change-role':
        return { type: 'change-role', role };
      case 'deactivate':
        return reason.trim()
          ? { type: 'deactivate', reason: reason.trim() }
          : { type: 'deactivate' };
      case 'reactivate':
        return { type: 'reactivate' };
      case 'add-to-group':
        return { type: 'add-to-group', groupId: groupId.trim() };
      case 'remove-from-group':
        return { type: 'remove-from-group', groupId: groupId.trim() };
    }
  }, [actionKind, role, reason, groupId]);

  const submitMutation = useMutation({
    mutationFn: (body: BulkUserBulkActionRequest) =>
      fetchJson<{ updated: number }>('/admin/users/bulk/action', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      toast.success(
        `Action applied to ${selectedUserIds.length} user${selectedUserIds.length === 1 ? '' : 's'}`,
      );
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      // Mirror the dual-key invalidation from BulkUserImportModal for
      // CE #304 compatibility.
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      handleClose();
    },
    onError: (err: FetchError) => {
      const missingOverlay = err.status === 404;
      setIsMissingOverlay(missingOverlay);
      setErrorMessage(
        missingOverlay
          ? 'Bulk user operations require Enterprise. Install the Enterprise overlay or contact your administrator.'
          : err.message || 'Bulk action failed',
      );
      toast.error(err.message || 'Bulk action failed');
    },
  });

  // ── Submit gate (per-action prerequisites) ─────────────────────────────
  const submitDisabled =
    submitMutation.isPending ||
    selectedUserIds.length === 0 ||
    ((actionKind === 'add-to-group' || actionKind === 'remove-from-group') &&
      groupId.trim().length === 0);

  const summarySentence = (() => {
    const n = selectedUserIds.length;
    const noun = `${n} user${n === 1 ? '' : 's'}`;
    switch (actionKind) {
      case 'change-role':
        return `You are about to change ${noun} to role "${role}".`;
      case 'deactivate':
        return `You are about to deactivate ${noun}.`;
      case 'reactivate':
        return `You are about to reactivate ${noun}.`;
      case 'add-to-group':
        return `You are about to add ${noun} to group "${groupId.trim() || '…'}".`;
      case 'remove-from-group':
        return `You are about to remove ${noun} from group "${groupId.trim() || '…'}".`;
    }
  })();

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) handleClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
          data-testid="bulk-action-overlay"
        />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border/60 bg-card/90 shadow-2xl backdrop-blur-xl outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 max-h-[85vh] overflow-y-auto',
          )}
          aria-describedby={undefined}
          data-testid="bulk-action-modal"
        >
          <div className="flex items-center justify-between border-b border-border/50 px-5 py-4">
            <Dialog.Title className="flex items-center gap-2 text-base font-semibold">
              <Users size={16} className="text-primary" />
              Bulk action ({selectedUserIds.length} selected)
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                aria-label="Close"
                data-testid="bulk-action-close"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <div className="space-y-4 p-5">
            {/* Action picker */}
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Action</span>
              <select
                className="w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm"
                value={actionKind}
                onChange={(e) => {
                  setActionKind(e.target.value as ActionKind);
                  setErrorMessage(null);
                  setIsMissingOverlay(false);
                }}
                data-testid="bulk-action-kind"
              >
                {(Object.keys(ACTION_LABELS) as ActionKind[]).map((k) => (
                  <option key={k} value={k}>
                    {ACTION_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>

            {/* Per-action body */}
            {actionKind === 'change-role' && (
              <fieldset
                className="space-y-2 rounded-md border border-border/40 p-3"
                data-testid="bulk-action-role"
              >
                <legend className="px-1 text-xs font-medium text-muted-foreground">
                  New role
                </legend>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="bulk-action-role"
                    checked={role === 'user'}
                    onChange={() => setRole('user')}
                    data-testid="bulk-action-role-user"
                  />
                  user
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="bulk-action-role"
                    checked={role === 'admin'}
                    onChange={() => setRole('admin')}
                    data-testid="bulk-action-role-admin"
                  />
                  admin
                </label>
              </fieldset>
            )}

            {actionKind === 'deactivate' && (
              <label
                className="block text-sm"
                data-testid="bulk-action-reason-wrapper"
              >
                <span className="mb-1 block font-medium">
                  Reason (optional)
                </span>
                <textarea
                  className="w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm"
                  rows={3}
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. off-boarding 2026-Q2"
                  data-testid="bulk-action-reason"
                />
              </label>
            )}

            {(actionKind === 'add-to-group' ||
              actionKind === 'remove-from-group') && (
              <label
                className="block text-sm"
                data-testid="bulk-action-group-wrapper"
              >
                <span className="mb-1 block font-medium">Group</span>
                <input
                  type="text"
                  className="w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm"
                  value={groupId}
                  onChange={(e) => setGroupId(e.target.value)}
                  placeholder="group id (UUID)"
                  data-testid="bulk-action-group"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Pick the group id from <a href="/settings/security/rbac" className="underline">Settings → RBAC → Groups</a>.
                </p>
              </label>
            )}

            {/* Confirmation summary */}
            <div
              className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100"
              data-testid="bulk-action-summary"
            >
              {summarySentence}
            </div>

            {errorMessage && (
              <div
                role="alert"
                className={cn(
                  'flex items-start gap-2 rounded-lg border p-3 text-sm',
                  isMissingOverlay
                    ? 'border-amber-500/40 bg-amber-500/10 text-amber-100'
                    : 'border-red-500/40 bg-red-500/10 text-red-100',
                )}
                data-testid={
                  isMissingOverlay
                    ? 'bulk-action-requires-enterprise'
                    : 'bulk-action-error'
                }
              >
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <div>{errorMessage}</div>
              </div>
            )}

            <div className="flex justify-end gap-2 border-t border-border/40 pt-4">
              <button
                type="button"
                onClick={handleClose}
                className="rounded-md border border-border/60 px-4 py-2 text-sm hover:bg-foreground/5"
                data-testid="bulk-action-cancel"
                disabled={submitMutation.isPending}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setErrorMessage(null);
                  setIsMissingOverlay(false);
                  submitMutation.mutate({
                    userIds: selectedUserIds,
                    action: buildAction(),
                  });
                }}
                disabled={submitDisabled}
                className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                data-testid="bulk-action-submit"
              >
                {submitMutation.isPending && (
                  <Loader2 size={14} className="animate-spin" />
                )}
                Apply
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
