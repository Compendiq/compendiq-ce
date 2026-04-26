import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Trash2, RefreshCw, Cpu, Tag, X, CheckSquare, Square, Shield } from 'lucide-react';
import { apiFetch } from '../../shared/lib/api';
import { cn } from '../../shared/lib/cn';
import { useEnterprise } from '../../shared/enterprise/use-enterprise';
import { BulkPagePermissionDialog } from './BulkPagePermissionDialog';

interface BulkResult {
  succeeded: number;
  failed: number;
  errors: string[];
}

interface BulkOperationsProps {
  selectedIds: string[];
  totalCount: number;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onClose: () => void;
}

export function BulkOperations({
  selectedIds,
  totalCount,
  onSelectAll,
  onDeselectAll,
  onClose,
}: BulkOperationsProps) {
  const queryClient = useQueryClient();
  const { hasFeature } = useEnterprise();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showTagPopover, setShowTagPopover] = useState(false);
  const [tagInput, setTagInput] = useState('');
  // 'replace' wipes the existing tag set and writes the input as the new
  // canonical set; 'add' / 'remove' are the legacy additive semantics.
  const [tagAction, setTagAction] = useState<'add' | 'remove' | 'replace'>('add');
  const [showPermissionDialog, setShowPermissionDialog] = useState(false);

  const bulkDelete = useMutation({
    mutationFn: () =>
      apiFetch<BulkResult>('/pages/bulk/delete', {
        method: 'POST',
        body: JSON.stringify({ ids: selectedIds }),
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['pages'], refetchType: 'none' });
      queryClient.invalidateQueries({ queryKey: ['spaces'], refetchType: 'none' });
      queryClient.refetchQueries({ queryKey: ['pages'] });
      queryClient.refetchQueries({ queryKey: ['spaces'] });
      toast.success(`Deleted ${data.succeeded} pages${data.failed > 0 ? `, ${data.failed} failed` : ''}`);
      onDeselectAll();
    },
    onError: (err) => toast.error(err.message),
  });

  const bulkSync = useMutation({
    mutationFn: () =>
      apiFetch<BulkResult>('/pages/bulk/sync', {
        method: 'POST',
        body: JSON.stringify({ ids: selectedIds }),
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['pages'], refetchType: 'none' });
      queryClient.refetchQueries({ queryKey: ['pages'] });
      toast.success(`Re-synced ${data.succeeded} pages${data.failed > 0 ? `, ${data.failed} failed` : ''}`);
    },
    onError: (err) => toast.error(err.message),
  });

  const bulkEmbed = useMutation({
    mutationFn: () =>
      apiFetch<BulkResult>('/pages/bulk/embed', {
        method: 'POST',
        body: JSON.stringify({ ids: selectedIds }),
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['embeddings'], refetchType: 'none' });
      queryClient.invalidateQueries({ queryKey: ['pages'], refetchType: 'none' });
      queryClient.refetchQueries({ queryKey: ['embeddings'] });
      queryClient.refetchQueries({ queryKey: ['pages'] });
      toast.success(`Queued ${data.succeeded} pages for re-embedding${data.failed > 0 ? `, ${data.failed} failed` : ''}`);
    },
    onError: (err) => {
      if (err.message.includes('already in progress')) {
        toast.info('Embedding is already in progress. Please wait for it to finish.');
      } else {
        toast.error(err.message);
      }
    },
  });

  const bulkTag = useMutation({
    mutationFn: (params: { addTags?: string[]; removeTags?: string[] }) =>
      apiFetch<BulkResult>('/pages/bulk/tag', {
        method: 'POST',
        body: JSON.stringify({ ids: selectedIds, ...params }),
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['pages'], refetchType: 'none' });
      queryClient.refetchQueries({ queryKey: ['pages'] });
      toast.success(`Updated tags on ${data.succeeded} pages${data.failed > 0 ? `, ${data.failed} failed` : ''}`);
      setShowTagPopover(false);
      setTagInput('');
    },
    onError: (err) => toast.error(err.message),
  });

  // Comma-separated tag input → trimmed, deduped, lowercased list.
  const parseTagsList = (s: string): string[] =>
    Array.from(
      new Set(
        s
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean),
      ),
    );

  const bulkReplaceTags = useMutation({
    mutationFn: (tags: string[]) =>
      apiFetch<BulkResult>('/pages/bulk/replace-tags', {
        method: 'POST',
        body: JSON.stringify({ ids: selectedIds, tags }),
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['pages'], refetchType: 'none' });
      queryClient.refetchQueries({ queryKey: ['pages'] });
      toast.success(
        `Replaced tags on ${data.succeeded} page${data.succeeded === 1 ? '' : 's'}${data.failed > 0 ? `, ${data.failed} failed` : ''}`,
      );
      setShowTagPopover(false);
      setTagInput('');
    },
    onError: (err) => toast.error(err.message),
  });

  function handleTagSubmit() {
    if (tagAction === 'replace') {
      const tags = parseTagsList(tagInput);
      // Empty input is a valid "wipe all tags" intent — confirm via prefix.
      bulkReplaceTags.mutate(tags);
      return;
    }
    const tag = tagInput.trim();
    if (!tag) return;
    if (tagAction === 'add') {
      bulkTag.mutate({ addTags: [tag] });
    } else {
      bulkTag.mutate({ removeTags: [tag] });
    }
  }

  const isLoading =
    bulkDelete.isPending ||
    bulkSync.isPending ||
    bulkEmbed.isPending ||
    bulkTag.isPending ||
    bulkReplaceTags.isPending;

  if (selectedIds.length === 0) return null;

  return (
    <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2" data-testid="bulk-operations-bar">
      <div className="glass-card flex items-center gap-3 rounded-2xl border border-border/60 bg-card/90 px-6 py-3 shadow-2xl backdrop-blur-xl">
        {/* Selection count */}
        <span className="text-sm font-medium" data-testid="selection-count">
          {selectedIds.length} page{selectedIds.length !== 1 ? 's' : ''} selected
        </span>

        <div className="mx-1 h-5 w-px bg-foreground/10" />

        {/* Select All / Deselect All */}
        <button
          onClick={selectedIds.length === totalCount ? onDeselectAll : onSelectAll}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          data-testid="select-toggle"
        >
          {selectedIds.length === totalCount ? (
            <>
              <Square size={14} />
              Deselect All
            </>
          ) : (
            <>
              <CheckSquare size={14} />
              Select All
            </>
          )}
        </button>

        <div className="mx-1 h-5 w-px bg-foreground/10" />

        {/* Action buttons */}
        <button
          onClick={() => bulkSync.mutate()}
          disabled={isLoading}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium hover:bg-foreground/5 disabled:opacity-50"
          title="Re-sync from Confluence"
          data-testid="bulk-sync-btn"
        >
          <RefreshCw size={14} className={cn(bulkSync.isPending && 'animate-spin')} />
          Re-sync
        </button>

        <button
          onClick={() => bulkEmbed.mutate()}
          disabled={isLoading}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium hover:bg-foreground/5 disabled:opacity-50"
          title="Re-embed for RAG"
          data-testid="bulk-embed-btn"
        >
          <Cpu size={14} />
          Re-embed
        </button>

        {/* Tag popover */}
        <div className="relative">
          <button
            onClick={() => setShowTagPopover(!showTagPopover)}
            disabled={isLoading}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium hover:bg-foreground/5 disabled:opacity-50"
            data-testid="bulk-tag-btn"
          >
            <Tag size={14} />
            Tag
          </button>

          {showTagPopover && (
            <div
              className="absolute bottom-full left-0 mb-2 w-72 rounded-xl border border-border/50 bg-card/95 p-3 shadow-xl backdrop-blur-xl"
              data-testid="tag-popover"
            >
              <div className="mb-2 flex gap-1.5">
                <button
                  onClick={() => setTagAction('add')}
                  className={cn(
                    'rounded px-2 py-1 text-xs font-medium transition-colors',
                    tagAction === 'add'
                      ? 'bg-primary/15 text-primary'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                  data-testid="tag-action-add"
                >
                  Add
                </button>
                <button
                  onClick={() => setTagAction('remove')}
                  className={cn(
                    'rounded px-2 py-1 text-xs font-medium transition-colors',
                    tagAction === 'remove'
                      ? 'bg-destructive/15 text-destructive'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                  data-testid="tag-action-remove"
                >
                  Remove
                </button>
                <button
                  onClick={() => setTagAction('replace')}
                  className={cn(
                    'rounded px-2 py-1 text-xs font-medium transition-colors',
                    tagAction === 'replace'
                      ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                  data-testid="tag-action-replace"
                  title="Replace the entire tag set on every selected page"
                >
                  Replace
                </button>
              </div>
              {tagAction === 'replace' && (
                <p className="mb-2 text-[11px] leading-tight text-amber-600 dark:text-amber-400">
                  Comma-separated. Existing tags on the selected pages will be wiped and replaced.
                </p>
              )}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleTagSubmit()}
                  placeholder={
                    tagAction === 'add'
                      ? 'Enter tag to add...'
                      : tagAction === 'remove'
                        ? 'Enter tag to remove...'
                        : 'tag-a, tag-b, tag-c'
                  }
                  className="flex-1 rounded-md bg-foreground/5 px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary"
                  data-testid="tag-input"
                />
                <button
                  onClick={handleTagSubmit}
                  disabled={
                    (tagAction !== 'replace' && !tagInput.trim()) ||
                    bulkTag.isPending ||
                    bulkReplaceTags.isPending
                  }
                  className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  data-testid="tag-submit"
                >
                  Apply
                </button>
              </div>
            </div>
          )}
        </div>

        {/* EE-gated bulk-permission action — only renders when the live
            license has BATCH_PAGE_OPERATIONS. CE deployments and EE
            without the feature hide the button entirely. */}
        {hasFeature('batch_page_operations') && (
          <button
            onClick={() => setShowPermissionDialog(true)}
            disabled={isLoading}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium hover:bg-foreground/5 disabled:opacity-50"
            title="Add or remove a permission across the selected pages"
            data-testid="bulk-permission-btn"
          >
            <Shield size={14} />
            Permission
          </button>
        )}

        {/* Delete with confirmation */}
        {showDeleteConfirm ? (
          <div className="flex items-center gap-2" data-testid="delete-confirm">
            <span className="text-xs text-destructive">Delete {selectedIds.length} pages?</span>
            <button
              onClick={() => {
                bulkDelete.mutate();
                setShowDeleteConfirm(false);
              }}
              disabled={isLoading}
              className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
              data-testid="delete-confirm-btn"
            >
              Confirm
            </button>
            <button
              onClick={() => setShowDeleteConfirm(false)}
              className="rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground"
              data-testid="delete-cancel-btn"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowDeleteConfirm(true)}
            disabled={isLoading}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
            data-testid="bulk-delete-btn"
          >
            <Trash2 size={14} />
            Delete
          </button>
        )}

        <div className="mx-1 h-5 w-px bg-foreground/10" />

        {/* Close */}
        <button
          onClick={onClose}
          className="rounded-lg p-1.5 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          data-testid="bulk-close-btn"
        >
          <X size={14} />
        </button>
      </div>

      <BulkPagePermissionDialog
        open={showPermissionDialog}
        onClose={() => setShowPermissionDialog(false)}
        selectedIds={selectedIds}
        onApplied={onDeselectAll}
      />
    </div>
  );
}
