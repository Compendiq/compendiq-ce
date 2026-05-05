import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Shield, X, AlertTriangle } from 'lucide-react';
import { apiFetch } from '../../shared/lib/api';
import { useEnterprise } from '../../shared/enterprise/use-enterprise';
import { cn } from '../../shared/lib/cn';

/**
 * EE-gated bulk-permission dialog (issue Compendiq/compendiq-ee#117).
 *
 * Pairs with the EE overlay route POST /api/admin/pages/bulk/permission.
 * Outer gate uses `hasFeature('batch_page_operations')` — CE deployments
 * and EE deployments without the feature render nothing, which keeps the
 * dialog from ever surfacing if a parent forgets to gate the trigger.
 *
 * The "this will flip inherit_perms=false on N pages" warning is mandatory
 * for add/replace per the plan §1.3 — admins must consciously opt into the
 * cascade because per-page ACEs are otherwise ignored against the inherited
 * space-level permission.
 */
type Action = 'add' | 'remove' | 'replace';
type PrincipalType = 'user' | 'group';
type Permission = 'read' | 'comment' | 'edit' | 'delete' | 'manage';

interface BulkPermissionResult {
  succeeded: number;
  failed: number;
  errors: string[];
  inheritFlippedPageIds: number[];
}

interface BulkPagePermissionDialogProps {
  open: boolean;
  onClose: () => void;
  /** Page ids the action will apply to. */
  selectedIds: string[];
  /** Called after a successful apply (e.g. to clear the selection). */
  onApplied?: () => void;
}

export function BulkPagePermissionDialog(props: BulkPagePermissionDialogProps) {
  const { hasFeature } = useEnterprise();
  if (!hasFeature('batch_page_operations')) {
    return null;
  }
  return <BulkPagePermissionDialogInner {...props} />;
}

function BulkPagePermissionDialogInner({
  open,
  onClose,
  selectedIds,
  onApplied,
}: BulkPagePermissionDialogProps) {
  const queryClient = useQueryClient();
  const [action, setAction] = useState<Action>('add');
  const [principalType, setPrincipalType] = useState<PrincipalType>('group');
  const [principalId, setPrincipalId] = useState('');
  const [permission, setPermission] = useState<Permission>('read');

  const apply = useMutation({
    mutationFn: () =>
      apiFetch<BulkPermissionResult>('/admin/pages/bulk/permission', {
        method: 'POST',
        body: JSON.stringify({
          ids: selectedIds,
          action,
          principal_type: principalType,
          principal_id: principalId.trim(),
          permission,
        }),
      }),
    onSuccess: (data) => {
      const flipped = data.inheritFlippedPageIds.length;
      const flipNote = flipped > 0 ? ` (inherit_perms flipped on ${flipped})` : '';
      toast.success(
        `${actionVerb(action, true)} permission on ${data.succeeded} page${data.succeeded === 1 ? '' : 's'}${flipNote}`,
      );
      queryClient.invalidateQueries({ queryKey: ['pages'], refetchType: 'none' });
      queryClient.refetchQueries({ queryKey: ['pages'] });
      onApplied?.();
      reset();
      onClose();
    },
    onError: (err: Error & { status?: number }) => {
      if (err.status === 404) {
        toast.error('Bulk page-permission requires the EE overlay to be deployed.');
        return;
      }
      toast.error(err.message);
    },
  });

  function reset() {
    setAction('add');
    setPrincipalType('group');
    setPrincipalId('');
    setPermission('read');
  }

  function handleClose() {
    if (apply.isPending) return;
    reset();
    onClose();
  }

  if (!open) return null;

  const principalTrim = principalId.trim();
  const canSubmit = principalTrim.length > 0 && selectedIds.length > 0 && !apply.isPending;
  const willFlipInherit = action === 'add' || action === 'replace';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={handleClose}
      data-testid="bulk-permission-dialog-overlay"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glass-card w-full max-w-md rounded-2xl border border-border/60 bg-card/95 p-6 shadow-2xl backdrop-blur-xl"
        data-testid="bulk-permission-dialog"
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield size={18} className="text-primary" />
            <h2 className="text-lg font-semibold">Bulk Page Permission</h2>
          </div>
          <button
            onClick={handleClose}
            disabled={apply.isPending}
            className="rounded-lg p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground disabled:opacity-50"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <p className="mb-4 text-sm text-muted-foreground">
          Apply a permission change to{' '}
          <span className="font-semibold text-foreground">{selectedIds.length}</span> selected
          page{selectedIds.length === 1 ? '' : 's'}.
        </p>

        {/* Action picker */}
        <div className="mb-3">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Action</label>
          <div className="flex gap-2">
            {(['add', 'remove', 'replace'] as Action[]).map((a) => (
              <button
                key={a}
                onClick={() => setAction(a)}
                disabled={apply.isPending}
                className={cn(
                  'flex-1 rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors',
                  action === a
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
                )}
                data-testid={`action-${a}`}
              >
                {a}
              </button>
            ))}
          </div>
        </div>

        {/* Principal type + id */}
        <div className="mb-3 grid grid-cols-3 gap-2">
          <div className="col-span-1">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Type</label>
            <select
              value={principalType}
              onChange={(e) => setPrincipalType(e.target.value as PrincipalType)}
              disabled={apply.isPending}
              className="w-full rounded-md bg-foreground/5 px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
              data-testid="principal-type"
            >
              <option value="group">Group</option>
              <option value="user">User</option>
            </select>
          </div>
          <div className="col-span-2">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              {principalType === 'user' ? 'User ID' : 'Group name'}
            </label>
            <input
              type="text"
              value={principalId}
              onChange={(e) => setPrincipalId(e.target.value)}
              disabled={apply.isPending}
              placeholder={principalType === 'user' ? 'e.g. alice' : 'e.g. executives'}
              className="w-full rounded-md bg-foreground/5 px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary"
              data-testid="principal-id"
            />
          </div>
        </div>

        {/* Permission picker */}
        <div className="mb-4">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Permission</label>
          <select
            value={permission}
            onChange={(e) => setPermission(e.target.value as Permission)}
            disabled={apply.isPending}
            className="w-full rounded-md bg-foreground/5 px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
            data-testid="permission"
          >
            <option value="read">read</option>
            <option value="comment">comment</option>
            <option value="edit">edit</option>
            <option value="delete">delete</option>
            <option value="manage">manage</option>
          </select>
        </div>

        {/* inherit_perms cascade warning */}
        {willFlipInherit && (
          <div
            className="mb-4 flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3"
            data-testid="inherit-warning"
          >
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-500" />
            <p className="text-xs text-foreground">
              Pages currently inheriting permissions from their space will have{' '}
              <code className="rounded bg-foreground/10 px-1">inherit_perms</code> flipped to{' '}
              <code className="rounded bg-foreground/10 px-1">false</code>. The page-level rule you
              add will then take effect; otherwise the inherited rule wins.
            </p>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex justify-end gap-2">
          <button
            onClick={handleClose}
            disabled={apply.isPending}
            className="rounded-md px-4 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
            data-testid="cancel-btn"
          >
            Cancel
          </button>
          <button
            onClick={() => apply.mutate()}
            disabled={!canSubmit}
            className="rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            data-testid="apply-btn"
          >
            {apply.isPending ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}

function actionVerb(a: Action, past: boolean): string {
  if (past) {
    return { add: 'Added', remove: 'Removed', replace: 'Replaced' }[a];
  }
  return { add: 'Add', remove: 'Remove', replace: 'Replace' }[a];
}
