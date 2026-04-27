import { useNavigate } from 'react-router-dom';
import { m } from 'framer-motion';
import { Pin, PinOff, Clock, User } from 'lucide-react';
import { toast } from 'sonner';
import { usePinnedPages, useUnpinPage } from '../../shared/hooks/use-pages';
import { TiltCard } from '../../shared/components/effects/TiltCard';

/** Maximum number of pinned articles displayed in the section (issue spec: 8). */
export const MAX_VISIBLE_PINS = 8;

export function PinnedArticlesSection() {
  const navigate = useNavigate();
  const { data: pinnedData } = usePinnedPages();
  const unpinMutation = useUnpinPage();

  // Intentionally return null while loading rather than showing a skeleton —
  // the section is small (max 8 cards) so any layout shift is minimal and
  // a skeleton flash would be more distracting than the brief shift.
  if (!pinnedData || pinnedData.items.length === 0) {
    return null;
  }

  const visiblePins = pinnedData.items.slice(0, MAX_VISIBLE_PINS);

  const handleUnpin = (e: React.MouseEvent, pageId: string, title: string) => {
    e.stopPropagation();
    unpinMutation.mutate(pageId, {
      onSuccess: () => toast.success(`Unpinned "${title}"`),
      onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to unpin'),
    });
  };

  return (
    <div data-testid="pinned-articles-section">
      <div className="mb-3 flex items-center gap-2">
        <Pin size={16} className="text-primary" />
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Pinned Articles
        </h2>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {visiblePins.map((item, i) => (
          <m.div
            key={item.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
          >
            <TiltCard className="card-stack" maxTilt={8} data-testid={`pinned-tilt-${item.id}`}>
              <div
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/pages/${item.id}`)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate(`/pages/${item.id}`); }}
                className="rounded-xl border border-border/40 bg-card/50 backdrop-blur-sm transition-all hover:border-primary/50 group relative flex w-full cursor-pointer flex-col gap-2 p-4 text-left"
                data-testid={`pinned-card-${item.id}`}
              >
              {/* Unpin button */}
              <button
                onClick={(e) => handleUnpin(e, item.id, item.title)}
                className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                aria-label={`Unpin ${item.title}`}
                data-testid={`unpin-btn-${item.id}`}
              >
                <PinOff size={14} />
              </button>

              {/* Title */}
              <p className="truncate pr-6 font-medium">{item.title}</p>

              {/* Metadata row */}
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                  {item.spaceKey}
                </span>
                {item.author && (
                  <span className="flex items-center gap-1">
                    <User size={10} /> {item.author}
                  </span>
                )}
                {item.lastModifiedAt && (
                  <span className="flex items-center gap-1">
                    <Clock size={10} /> {new Date(item.lastModifiedAt).toLocaleDateString()}
                  </span>
                )}
              </div>

              {/* Excerpt */}
              {item.excerpt && (
                <p className="line-clamp-2 text-xs text-muted-foreground">
                  {item.excerpt}
                </p>
              )}
              </div>
            </TiltCard>
          </m.div>
        ))}
      </div>
    </div>
  );
}
