import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { m, AnimatePresence } from 'framer-motion';
import { ArrowLeft, RotateCcw, Trash2, Search, X, CheckSquare, Square } from 'lucide-react';
import { toast } from 'sonner';
import { useTrash, useRestorePage } from '../../shared/hooks/use-standalone';
import { HeaderHost } from '../../shared/components/layout/header-slot';
import { Button, IconButton } from '../../shared/components/Button';

export function TrashPage() {
  const navigate = useNavigate();
  const { data: trashData, isLoading } = useTrash();
  const restoreMutation = useRestorePage();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkRestoring, setIsBulkRestoring] = useState(false);

  const items = trashData?.items ?? [];

  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return items;
    const query = searchQuery.toLowerCase().trim();
    return items.filter((item) => item.title.toLowerCase().includes(query));
  }, [items, searchQuery]);

  const handleRestore = async (pageId: string) => {
    try {
      await restoreMutation.mutateAsync(pageId);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(pageId);
        return next;
      });
      toast.success('Page restored');
    } catch {
      toast.error('Failed to restore page');
    }
  };

  const handleBulkRestore = async () => {
    if (selectedIds.size === 0) return;
    setIsBulkRestoring(true);
    const ids = Array.from(selectedIds);
    try {
      await Promise.all(ids.map((id) => restoreMutation.mutateAsync(id)));
      toast.success(`Restored ${ids.length} ${ids.length === 1 ? 'page' : 'pages'}`);
      setSelectedIds(new Set());
    } catch {
      toast.error('Failed to restore some pages');
    } finally {
      setIsBulkRestoring(false);
    }
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredItems.length && filteredItems.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredItems.map((item) => item.id)));
    }
  };

  const toggleSelectItem = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const daysUntilPurge = (autoPurgeAt: string) => {
    const now = new Date();
    const purge = new Date(autoPurgeAt);
    const diff = Math.ceil((purge.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    return Math.max(0, diff);
  };

  const allFilteredSelected =
    filteredItems.length > 0 && selectedIds.size === filteredItems.length;

  return (
    <div className="space-y-6">
      <HeaderHost fallbackClassName="flex items-center gap-3">
        <IconButton onClick={() => navigate('/')} label="Back to Pages" icon={<ArrowLeft size={18} />} />
        <h1 className="text-[15px] font-semibold sm:text-lg">Trash</h1>
      </HeaderHost>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Deleted pages are automatically purged 30 days after deletion
        </p>

        {items.length > 0 && (
          <div className="relative w-full sm:w-64">
            <Search
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              type="text"
              placeholder="Search trash…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="nm-input h-9 w-full pl-9 pr-8 text-sm"
              data-testid="trash-search-input"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X size={14} />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Trash list */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="nm-card h-16 animate-pulse" />
          ))}
        </div>
      ) : !items.length ? (
        <div className="nm-card flex flex-col items-center justify-center py-16 text-center" data-testid="trash-empty">
          <Trash2 size={48} className="mb-4 text-muted-foreground" />
          <p className="text-lg font-medium">No pages in trash</p>
          <p className="text-sm text-muted-foreground">
            Deleted local pages will appear here
          </p>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="nm-card flex flex-col items-center justify-center py-12 text-center" data-testid="trash-no-match">
          <p className="text-sm font-medium text-foreground">No matching deleted pages</p>
          <p className="mt-1 text-xs text-muted-foreground">Try clearing the search filter</p>
        </div>
      ) : (
        <div className="space-y-3" data-testid="trash-list">
          <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
            <button
              type="button"
              onClick={toggleSelectAll}
              className="flex items-center gap-2 font-medium hover:text-foreground"
              data-testid="trash-select-all"
            >
              {allFilteredSelected ? (
                <CheckSquare size={16} className="text-action" />
              ) : (
                <Square size={16} />
              )}
              <span>Select all ({filteredItems.length})</span>
            </button>
          </div>

          <div className="space-y-2">
            {filteredItems.map((item, i) => {
              const isSelected = selectedIds.has(item.id);
              return (
                <m.div
                  key={item.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.03 }}
                >
                  <div
                    className={`nm-card-interactive flex w-full items-center gap-4 p-4 transition-colors ${
                      isSelected ? 'border-primary/50 bg-primary/[0.03]' : ''
                    }`}
                    data-testid={`trash-item-${item.id}`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSelectItem(item.id)}
                      aria-label={`Select ${item.title}`}
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                      data-testid={`trash-checkbox-${item.id}`}
                    >
                      {isSelected ? (
                        <CheckSquare size={18} className="text-action" />
                      ) : (
                        <Square size={18} />
                      )}
                    </button>

                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{item.title}</p>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>Deleted {new Date(item.deletedAt).toLocaleDateString()}</span>
                        <span>by {item.deletedBy}</span>
                        <span className="text-warning">
                          {daysUntilPurge(item.autoPurgeAt)} days until auto-purge
                        </span>
                      </div>
                    </div>

                    <div className="flex shrink-0 gap-2">
                      <Button
                        onClick={() => handleRestore(item.id)}
                        disabled={restoreMutation.isPending || isBulkRestoring}
                        isLoading={restoreMutation.isPending && !isBulkRestoring}
                        variant="secondary"
                        size="sm"
                        leftIcon={!restoreMutation.isPending ? <RotateCcw size={14} /> : undefined}
                        data-testid={`restore-btn-${item.id}`}
                      >
                        Restore
                      </Button>
                    </div>
                  </div>
                </m.div>
              );
            })}
          </div>
        </div>
      )}

      {/* Floating Bulk Action Bar */}
      <AnimatePresence>
        {selectedIds.size > 0 && (
          <m.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2 nm-card-elevated flex items-center gap-3 rounded-2xl px-4 py-2.5 shadow-overlay border border-border"
            data-testid="trash-bulk-bar"
          >
            <span className="text-xs font-medium text-foreground" data-testid="trash-bulk-count">
                {selectedIds.size} {selectedIds.size === 1 ? 'page' : 'pages'} selected
              </span>

              <div className="h-4 w-px bg-border" />

              <Button
                onClick={handleBulkRestore}
                disabled={isBulkRestoring}
                isLoading={isBulkRestoring}
                variant="primary"
                size="sm"
                leftIcon={!isBulkRestoring ? <RotateCcw size={14} /> : undefined}
                data-testid="trash-bulk-restore-btn"
              >
                Restore Selected
              </Button>

              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                aria-label="Clear selection"
                className="text-muted-foreground hover:text-foreground"
                data-testid="trash-bulk-clear-btn"
              >
                <X size={16} />
              </button>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
