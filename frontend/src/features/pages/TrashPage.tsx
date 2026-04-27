import { useNavigate } from 'react-router-dom';
import { m } from 'framer-motion';
import { ArrowLeft, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTrash, useRestorePage } from '../../shared/hooks/use-standalone';

export function TrashPage() {
  const navigate = useNavigate();
  const { data: trashData, isLoading } = useTrash();
  const restoreMutation = useRestorePage();

  const handleRestore = async (pageId: number) => {
    try {
      await restoreMutation.mutateAsync(pageId);
      toast.success('Page restored');
    } catch {
      toast.error('Failed to restore page');
    }
  };

  const daysUntilPurge = (autoPurgeAt: string) => {
    const now = new Date();
    const purge = new Date(autoPurgeAt);
    const diff = Math.ceil((purge.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    return Math.max(0, diff);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/')} className="nm-icon-button">
          <ArrowLeft size={18} />
        </button>
        <div>
          <h1 className="text-2xl font-bold">Trash</h1>
          <p className="text-sm text-muted-foreground">
            Deleted articles are automatically purged after 30 days
          </p>
        </div>
      </div>

      {/* Trash list */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="nm-card h-16 animate-pulse" />
          ))}
        </div>
      ) : !trashData?.items.length ? (
        <div className="nm-card flex flex-col items-center justify-center py-16 text-center" data-testid="trash-empty">
          <Trash2 size={48} className="mb-4 text-muted-foreground" />
          <p className="text-lg font-medium">No articles in trash</p>
          <p className="text-sm text-muted-foreground">
            Deleted standalone articles will appear here
          </p>
        </div>
      ) : (
        <div className="space-y-2" data-testid="trash-list">
          {trashData.items.map((item, i) => (
            <m.div
              key={item.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.03 }}
            >
              <div className="nm-card-interactive flex w-full items-center gap-4 p-4" data-testid={`trash-item-${item.id}`}>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{item.title}</p>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>Deleted {new Date(item.deletedAt).toLocaleDateString()}</span>
                    <span>by {item.deletedBy}</span>
                    <span className="text-orange-500">
                      {daysUntilPurge(item.autoPurgeAt)} days until auto-purge
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={() => handleRestore(item.id)}
                    disabled={restoreMutation.isPending}
                    className="flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-500 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
                    data-testid={`restore-btn-${item.id}`}
                  >
                    <RotateCcw size={14} /> Restore
                  </button>
                </div>
              </div>
            </m.div>
          ))}
        </div>
      )}
    </div>
  );
}
