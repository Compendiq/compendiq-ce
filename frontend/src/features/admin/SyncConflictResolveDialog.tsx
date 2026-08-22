/**
 * SyncConflictResolveDialog — Radix Dialog wrapping a `DiffView` for a
 * pending sync conflict (Compendiq/compendiq-ee#118 Phase D).
 *
 * Three actions:
 *   - "Keep local"    → POST /api/admin/sync-conflicts/:id/resolve { resolution: 'local' }
 *   - "Take Confluence" → POST /api/admin/sync-conflicts/:id/resolve { resolution: 'remote' }
 *   - "Cancel"        → close without resolving
 *
 * The diff is rendered using the existing `DiffView` component (the same
 * one the AI improvement flow uses) which uses `diff` v8 word-level
 * diffing under the hood. We pass `body_text` rather than `body_html` to
 * the diff so admins see semantic changes, not HTML attribute reshuffling
 * (which would trigger spurious red/green spans from things like
 * data-attribute reordering by the converter).
 */

import { useMutation } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { toast } from 'sonner';
import { Check, X } from 'lucide-react';
import { DiffView } from '../../shared/components/article/DiffView';
import { fetchJson } from '../../shared/lib/fetch-json';
import { Button } from '../../shared/components/Button';
import type { SyncConflict } from './SyncConflictsPage';

interface ResolveBody {
  resolution: 'local' | 'remote';
}

interface BackendErrorBody {
  error?: string;
  message?: string;
}

type FetchError = Error & { status?: number; body?: BackendErrorBody };

interface Props {
  conflict: SyncConflict;
  onClose: () => void;
  onResolved: () => void;
}

export function SyncConflictResolveDialog({ conflict, onClose, onResolved }: Props) {
  const resolveMutation = useMutation({
    mutationFn: (body: ResolveBody) =>
      fetchJson<void>(`/admin/sync-conflicts/${conflict.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: (_data, variables) => {
      toast.success(
        variables.resolution === 'local'
          ? 'Kept local edits'
          : 'Took Confluence version',
      );
      onResolved();
    },
    onError: (err: FetchError) => {
      toast.error(`Failed to resolve: ${err.message}`);
    },
  });

  const isPending = resolveMutation.isPending;

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open && !isPending) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 grid h-[85vh] w-[95vw] max-w-5xl -translate-x-1/2 -translate-y-1/2 grid-rows-[auto_1fr_auto] overflow-hidden nm-card-elevated"
          data-testid="sync-conflict-resolve-dialog"
        >
          <div className="flex items-start justify-between border-b border-border p-4">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="truncate text-base font-semibold">
                Resolve conflict — {conflict.pageTitle}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-muted-foreground">
                <span className="font-mono">{conflict.spaceKey}</span>
                {' · '}pending Confluence v{conflict.pendingConfluenceVersion}
                {' · '}detected {new Date(conflict.detectedAt).toLocaleString()}
              </Dialog.Description>
            </div>
            <Dialog.Close
              className="nm-icon-button"
              disabled={isPending}
              data-testid="sync-conflict-resolve-close-btn"
              aria-label="Close"
            >
              <X size={16} />
            </Dialog.Close>
          </div>

          <div className="overflow-auto p-4">
            <p className="mb-3 text-xs text-muted-foreground">
              Local content is on the left; the queued Confluence version is
              on the right. Compare the two and pick which to keep.
            </p>
            <DiffView
              original={conflict.localBodyText}
              improved={conflict.pendingBodyText}
            />
          </div>

          {/* Footer actions */}
          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
            <Button
              onClick={onClose}
              disabled={isPending}
              variant="ghost"
              data-testid="sync-conflict-resolve-cancel-btn"
            >
              Cancel
            </Button>
            <Button
              onClick={() => resolveMutation.mutate({ resolution: 'local' })}
              disabled={isPending}
              isLoading={isPending}
              variant="secondary"
              leftIcon={!isPending ? <Check size={14} /> : undefined}
              data-testid="sync-conflict-resolve-keep-local-btn"
            >
              Keep local
            </Button>
            <Button
              onClick={() => resolveMutation.mutate({ resolution: 'remote' })}
              disabled={isPending}
              isLoading={isPending}
              variant="primary"
              leftIcon={!isPending ? <Check size={14} /> : undefined}
              data-testid="sync-conflict-resolve-take-remote-btn"
            >
              Take Confluence
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
