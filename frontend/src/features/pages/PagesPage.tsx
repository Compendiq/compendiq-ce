import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { m } from 'framer-motion';
import { Search, FileText, Plus, RefreshCw, ChevronLeft, ChevronRight, FolderOpen, List, GitBranch } from 'lucide-react';
import { usePages, usePageTree } from '../../shared/hooks/use-pages';
import { useSpaces, useSync, useSyncStatus } from '../../shared/hooks/use-spaces';
import { FreshnessBadge } from '../../shared/components/FreshnessBadge';
import { BulkOperations } from './BulkOperations';
import { PageTreeView } from './PageTreeView';
import { cn } from '../../shared/lib/cn';

export function PagesPage() {
  const navigate = useNavigate();
  const [spaceKey, setSpaceKey] = useState<string>('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<'title' | 'modified' | 'author'>('modified');
  const [viewMode, setViewMode] = useState<'list' | 'tree'>('tree');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const { data: spaces } = useSpaces();
  const { data: pagesData, isLoading } = usePages({
    spaceKey: spaceKey || undefined,
    search: search || undefined,
    page,
    sort,
  });
  const { data: treeData, isLoading: isTreeLoading } = usePageTree({
    spaceKey: spaceKey || undefined,
  });
  const syncMutation = useSync();
  const { data: syncStatus } = useSyncStatus();

  const toggleSelection = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    if (pagesData?.items) {
      setSelectedIds(new Set(pagesData.items.map((p) => p.id)));
    }
  }, [pagesData]);

  const deselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Pages</h1>
          <p className="text-sm text-muted-foreground">
            Browse and manage your Confluence knowledge base
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => syncMutation.mutate()}
            disabled={syncStatus?.status === 'syncing'}
            className="glass-card flex items-center gap-2 px-4 py-2 text-sm hover:bg-white/5 disabled:opacity-50"
          >
            <RefreshCw size={16} className={cn(syncStatus?.status === 'syncing' && 'animate-spin')} />
            {syncStatus?.status === 'syncing' ? 'Syncing...' : 'Sync'}
          </button>
          <button
            onClick={() => navigate('/pages/new')}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus size={16} />
            New Page
          </button>
        </div>
      </div>

      {/* Sync progress */}
      {syncStatus?.status === 'syncing' && syncStatus.progress && (
        <div className="glass-card p-3">
          <div className="flex items-center justify-between text-sm">
            <span>Syncing {syncStatus.progress.space}...</span>
            <span>{syncStatus.progress.current}/{syncStatus.progress.total}</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${(syncStatus.progress.current / syncStatus.progress.total) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="glass-card flex flex-wrap items-center gap-3 p-4">
        {viewMode === 'list' && (
          <div className="relative flex-1 min-w-48">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search pages..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="w-full rounded-md bg-white/5 py-2 pl-10 pr-4 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary"
            />
          </div>
        )}

        <select
          value={spaceKey}
          onChange={(e) => { setSpaceKey(e.target.value); setPage(1); }}
          className="rounded-md bg-white/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="">All Spaces</option>
          {spaces?.map((s) => (
            <option key={s.key} value={s.key}>{s.name}</option>
          ))}
        </select>

        {viewMode === 'list' && (
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
            className="rounded-md bg-white/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="modified">Last Modified</option>
            <option value="title">Title</option>
            <option value="author">Author</option>
          </select>
        )}

        {/* View toggle */}
        <div className="flex rounded-md border border-white/10">
          <button
            onClick={() => setViewMode('list')}
            className={cn(
              'flex items-center gap-1 rounded-l-md px-2.5 py-2 text-sm transition-colors',
              viewMode === 'list'
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-white/5',
            )}
            title="List view"
          >
            <List size={14} />
          </button>
          <button
            onClick={() => setViewMode('tree')}
            className={cn(
              'flex items-center gap-1 rounded-r-md px-2.5 py-2 text-sm transition-colors',
              viewMode === 'tree'
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-white/5',
            )}
            title="Tree view"
          >
            <GitBranch size={14} />
          </button>
        </div>
      </div>

      {/* Page list */}
      {viewMode === 'tree' ? (
        isTreeLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="glass-card h-16 animate-pulse" />
            ))}
          </div>
        ) : !treeData?.items.length ? (
          <div className="glass-card flex flex-col items-center justify-center py-16 text-center">
            <FolderOpen size={48} className="mb-4 text-muted-foreground" />
            <p className="text-lg font-medium">No pages found</p>
            <p className="text-sm text-muted-foreground">
              Sync your Confluence spaces to see pages here
            </p>
          </div>
        ) : (
          <PageTreeView pages={treeData.items} />
        )
      ) : isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="glass-card h-16 animate-pulse" />
          ))}
        </div>
      ) : !pagesData?.items.length ? (
        <div className="glass-card flex flex-col items-center justify-center py-16 text-center">
          <FolderOpen size={48} className="mb-4 text-muted-foreground" />
          <p className="text-lg font-medium">No pages found</p>
          <p className="text-sm text-muted-foreground">
            {search ? 'Try a different search term' : 'Sync your Confluence spaces to see pages here'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {pagesData.items.map((pageItem, i) => (
            <m.div
              key={pageItem.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.03 }}
            >
              <div
                className={cn(
                  'glass-card-hover flex w-full items-center gap-4 p-4 text-left',
                  selectedIds.has(pageItem.id) && 'border-primary/40 bg-primary/5',
                )}
              >
                {/* Checkbox for bulk selection */}
                <button
                  onClick={(e) => toggleSelection(pageItem.id, e)}
                  className="shrink-0 flex h-5 w-5 items-center justify-center rounded border border-white/20 hover:border-primary/50"
                  data-testid={`checkbox-${pageItem.id}`}
                  aria-label={`Select ${pageItem.title}`}
                >
                  {selectedIds.has(pageItem.id) && (
                    <div className="h-3 w-3 rounded-sm bg-primary" />
                  )}
                </button>

                <button
                  onClick={() => navigate(`/pages/${pageItem.id}`)}
                  className="flex min-w-0 flex-1 items-center gap-4"
                >
                  <FileText size={20} className="shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{pageItem.title}</p>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{pageItem.spaceKey}</span>
                      {pageItem.author && <span>{pageItem.author}</span>}
                      {pageItem.lastModifiedAt && (
                        <span>{new Date(pageItem.lastModifiedAt).toLocaleDateString()}</span>
                      )}
                    </div>
                  </div>
                  {pageItem.lastModifiedAt && (
                    <FreshnessBadge lastModified={pageItem.lastModifiedAt} />
                  )}
                  {pageItem.labels.length > 0 && (
                    <div className="flex gap-1">
                      {pageItem.labels.slice(0, 3).map((label) => (
                        <span key={label} className="rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">
                          {label}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
              </div>
            </m.div>
          ))}
        </div>
      )}

      {/* Pagination (list view only) */}
      {viewMode === 'list' && pagesData && pagesData.totalPages > 1 && (
        <div className="flex items-center justify-center gap-4">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="glass-card p-2 disabled:opacity-30"
          >
            <ChevronLeft size={18} />
          </button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {pagesData.totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(pagesData.totalPages, p + 1))}
            disabled={page >= pagesData.totalPages}
            className="glass-card p-2 disabled:opacity-30"
          >
            <ChevronRight size={18} />
          </button>
        </div>
      )}

      {/* Bulk Operations Bar */}
      <BulkOperations
        selectedIds={[...selectedIds]}
        totalCount={pagesData?.items.length ?? 0}
        onSelectAll={selectAll}
        onDeselectAll={deselectAll}
        onClose={deselectAll}
      />
    </div>
  );
}
