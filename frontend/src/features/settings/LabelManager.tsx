import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Search, Edit2, Trash2, Merge, Check, X } from 'lucide-react';
import { apiFetch } from '../../shared/lib/api';


interface LabelInfo {
  name: string;
  pageCount: number;
}

export function LabelManager() {
  const queryClient = useQueryClient();
  const [searchFilter, setSearchFilter] = useState('');
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [mergeSource, setMergeSource] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState('');

  const { data: labels, isLoading } = useQuery<LabelInfo[]>({
    queryKey: ['admin', 'labels'],
    queryFn: () => apiFetch('/admin/labels'),
  });

  const renameLabel = useMutation({
    mutationFn: ({ oldName, newName }: { oldName: string; newName: string }) =>
      apiFetch<{ affectedPages: number }>('/admin/labels/rename', {
        method: 'PUT',
        body: JSON.stringify({ oldName, newName }),
      }),
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'labels'] });
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      toast.success(`Renamed "${variables.oldName}" to "${variables.newName}" (${data.affectedPages} pages)`);
      setEditingLabel(null);
      setEditValue('');
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteLabel = useMutation({
    mutationFn: (name: string) =>
      apiFetch<{ affectedPages: number }>(`/admin/labels/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      }),
    onSuccess: (data, name) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'labels'] });
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      toast.success(`Removed "${name}" from ${data.affectedPages} pages`);
      setDeleteConfirm(null);
    },
    onError: (err) => toast.error(err.message),
  });

  const filteredLabels = useMemo(() => {
    if (!labels) return [];
    if (!searchFilter.trim()) return labels;
    const lowerFilter = searchFilter.toLowerCase();
    return labels.filter((l) => l.name.toLowerCase().includes(lowerFilter));
  }, [labels, searchFilter]);

  function startEdit(name: string) {
    setEditingLabel(name);
    setEditValue(name);
  }

  function handleRename() {
    if (!editingLabel || !editValue.trim() || editValue === editingLabel) return;
    renameLabel.mutate({ oldName: editingLabel, newName: editValue.trim() });
  }

  function handleMerge() {
    if (!mergeSource || !mergeTarget.trim() || mergeSource === mergeTarget) return;
    // Merge = rename source to target
    renameLabel.mutate({ oldName: mergeSource, newName: mergeTarget.trim() });
    setMergeSource(null);
    setMergeTarget('');
  }

  return (
    <div className="space-y-4" data-testid="label-manager">
      <div>
        <h3 className="text-lg font-medium">Label Manager</h3>
        <p className="text-sm text-muted-foreground">
          Manage labels across all pages. Rename, delete, or merge labels globally.
        </p>
      </div>

      {/* Search bar */}
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          placeholder="Filter labels..."
          value={searchFilter}
          onChange={(e) => setSearchFilter(e.target.value)}
          className="w-full rounded-md bg-white/5 py-2 pl-10 pr-4 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary"
          data-testid="label-search"
        />
      </div>

      {/* Merge dialog */}
      {mergeSource && (
        <div className="rounded-lg border border-white/10 bg-white/5 p-3" data-testid="merge-dialog">
          <p className="mb-2 text-sm">
            Merge <span className="font-medium text-primary">{mergeSource}</span> into:
          </p>
          <div className="flex gap-2">
            <select
              value={mergeTarget}
              onChange={(e) => setMergeTarget(e.target.value)}
              className="flex-1 rounded-md bg-white/5 px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
              data-testid="merge-target-select"
            >
              <option value="">Select target label...</option>
              {labels
                ?.filter((l) => l.name !== mergeSource)
                .map((l) => (
                  <option key={l.name} value={l.name}>
                    {l.name} ({l.pageCount} pages)
                  </option>
                ))}
            </select>
            <button
              onClick={handleMerge}
              disabled={!mergeTarget || renameLabel.isPending}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              data-testid="merge-confirm-btn"
            >
              Merge
            </button>
            <button
              onClick={() => { setMergeSource(null); setMergeTarget(''); }}
              className="rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Labels table */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-white/5" />
          ))}
        </div>
      ) : filteredLabels.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          {labels?.length === 0 ? 'No labels found across any pages' : 'No labels match your filter'}
        </div>
      ) : (
        <div className="rounded-lg border border-white/10">
          {/* Header */}
          <div className="flex items-center border-b border-white/10 px-4 py-2 text-xs font-medium text-muted-foreground">
            <span className="flex-1">Label Name</span>
            <span className="w-24 text-right">Pages</span>
            <span className="w-36 text-right">Actions</span>
          </div>

          {/* Rows */}
          {filteredLabels.map((label) => (
            <div
              key={label.name}
              className="flex items-center border-b border-white/5 px-4 py-2.5 last:border-b-0 hover:bg-white/[0.02]"
              data-testid={`label-row-${label.name}`}
            >
              {editingLabel === label.name ? (
                <div className="flex flex-1 items-center gap-2">
                  <input
                    type="text"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRename();
                      if (e.key === 'Escape') setEditingLabel(null);
                    }}
                    className="flex-1 rounded bg-white/5 px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-primary"
                    data-testid="rename-input"
                    autoFocus
                  />
                  <button
                    onClick={handleRename}
                    disabled={renameLabel.isPending || !editValue.trim() || editValue === editingLabel}
                    className="rounded p-1 text-success hover:bg-success/10 disabled:opacity-50"
                    data-testid="rename-confirm-btn"
                  >
                    <Check size={14} />
                  </button>
                  <button
                    onClick={() => setEditingLabel(null)}
                    className="rounded p-1 text-muted-foreground hover:bg-white/5"
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <>
                  <span className="flex-1 text-sm">{label.name}</span>
                  <span className="w-24 text-right text-sm text-muted-foreground">{label.pageCount}</span>
                  <div className="flex w-36 items-center justify-end gap-1">
                    <button
                      onClick={() => startEdit(label.name)}
                      className="rounded p-1.5 text-muted-foreground hover:bg-white/5 hover:text-foreground"
                      title="Rename"
                      data-testid={`rename-${label.name}`}
                    >
                      <Edit2 size={14} />
                    </button>
                    <button
                      onClick={() => setMergeSource(label.name)}
                      className="rounded p-1.5 text-muted-foreground hover:bg-white/5 hover:text-foreground"
                      title="Merge into another label"
                      data-testid={`merge-${label.name}`}
                    >
                      <Merge size={14} />
                    </button>
                    {deleteConfirm === label.name ? (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => deleteLabel.mutate(label.name)}
                          disabled={deleteLabel.isPending}
                          className="rounded bg-destructive px-2 py-1 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
                          data-testid={`delete-confirm-${label.name}`}
                        >
                          Delete
                        </button>
                        <button
                          onClick={() => setDeleteConfirm(null)}
                          className="rounded px-1 py-1 text-xs text-muted-foreground"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setDeleteConfirm(label.name)}
                        className="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        title="Delete"
                        data-testid={`delete-${label.name}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Summary */}
      {labels && labels.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {labels.length} label{labels.length !== 1 ? 's' : ''} across all pages
        </p>
      )}
    </div>
  );
}
