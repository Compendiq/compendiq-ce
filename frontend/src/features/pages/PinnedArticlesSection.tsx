import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { m } from 'framer-motion';
import { Pin, PinOff, Clock, User, ChevronDown, ChevronUp } from 'lucide-react';
import { toast } from 'sonner';
import { usePinnedPages, useUnpinPage } from '../../shared/hooks/use-pages';
import { TiltCard } from '../../shared/components/effects/TiltCard';
import { COLLAPSED_PIN_COUNT, entranceDelay } from './pinned-articles-layout';

export function PinnedArticlesSection() {
  const navigate = useNavigate();
  const { data: pinnedData } = usePinnedPages();
  const unpinMutation = useUnpinPage();
  // Ephemeral on purpose: the collapsed strip is the dashboard's default shape,
  // so every visit starts there and expanding is one keystroke away.
  const [expanded, setExpanded] = useState(false);

  // Intentionally return null while loading rather than showing a skeleton —
  // collapsed the section is at most two rows, so any layout shift is minimal
  // and a skeleton flash would be more distracting than the brief shift.
  if (!pinnedData || pinnedData.items.length === 0) {
    return null;
  }

  const total = pinnedData.items.length;
  const overflow = total - COLLAPSED_PIN_COUNT;
  const visiblePins = expanded ? pinnedData.items : pinnedData.items.slice(0, COLLAPSED_PIN_COUNT);

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
        <Pin size={16} className="text-action" />
        <h2 id="pinned-pages-heading" className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Pinned Pages
        </h2>
        {/* Tabular figures so the count doesn't jitter as pins come and go. */}
        <span
          className="font-mono text-xs tabular-nums text-muted-foreground/70"
          data-testid="pinned-count"
        >
          {total}
        </span>
      </div>
      <div
        id="pinned-pages-grid"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
      >
        {visiblePins.map((item, i) => (
          <m.div
            key={item.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: entranceDelay(i) }}
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
                <span className="rounded bg-[#ececea] px-1.5 py-0.5 text-[#4a4a48] dark:bg-[#2a2925] dark:text-[#c5bea9]">
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

      {overflow > 0 && (
        <div className="mt-3 flex justify-center">
          <button
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={expanded}
            aria-controls="pinned-pages-grid"
            className="nm-button-ghost text-sm"
            data-testid="pinned-expand-toggle"
          >
            {expanded ? (
              <>
                <ChevronUp size={14} /> Show fewer
              </>
            ) : (
              <>
                <ChevronDown size={14} /> Show {overflow} more
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
