import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { m } from 'framer-motion';
import { Pin, PinOff, Clock, User, ChevronDown, ChevronUp } from 'lucide-react';
import { toast } from 'sonner';
import { usePinnedPages, useUnpinPage } from '../../shared/hooks/use-pages';
import { COLLAPSED_PIN_COUNT, entranceDelay, staggerPosition } from './pinned-articles-layout';

export function PinnedArticlesSection() {
  const navigate = useNavigate();
  const { data: pinnedData } = usePinnedPages();
  const unpinMutation = useUnpinPage();
  // Ephemeral on purpose: the collapsed strip is the dashboard's default shape,
  // so every visit starts there and expanding is one keystroke away.
  const [expanded, setExpanded] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

  // Intentionally return null while loading rather than showing a skeleton —
  // collapsed the section is at most two rows, so any layout shift is minimal
  // and a skeleton flash would be more distracting than the brief shift.
  if (!pinnedData || pinnedData.items.length === 0) {
    return null;
  }

  const total = pinnedData.items.length;
  const overflow = total - COLLAPSED_PIN_COUNT;
  // Derived, not the raw flag: unpinning back below the cut-off unmounts the
  // toggle, and a latched `expanded` would then silently re-expand the section
  // the moment the count rose again, with nothing on screen having asked for it.
  const isExpanded = expanded && overflow > 0;
  const visiblePins = isExpanded ? pinnedData.items : pinnedData.items.slice(0, COLLAPSED_PIN_COUNT);

  const handleUnpin = (e: React.MouseEvent, pageId: string, title: string) => {
    e.stopPropagation();
    // The card carrying the focused button is about to unmount, which drops
    // focus to <body> and sends a keyboard user back to the top of the
    // document. Cheap to survive at eight cards; with the cap gone (#1130) it
    // can be a very long way back. Hand focus to the next unpin button, or to
    // the section itself when the last pin goes.
    const buttons = [...(sectionRef.current?.querySelectorAll<HTMLButtonElement>('[data-unpin]') ?? [])];
    const index = buttons.findIndex((b) => b.dataset.unpin === pageId);
    const successor = buttons[index + 1] ?? buttons[index - 1] ?? null;

    unpinMutation.mutate(pageId, {
      onSuccess: () => {
        toast.success(`Unpinned "${title}"`);
        // The successor may itself have unmounted by now (a refetch reordered
        // the list); falling back to the section keeps focus in place either way.
        if (successor?.isConnected) successor.focus();
        else sectionRef.current?.focus();
      },
      onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to unpin'),
    });
  };

  return (
    <section
      ref={sectionRef}
      // Focus target of last resort after an unpin; -1 keeps it out of the tab
      // order for everyone else.
      tabIndex={-1}
      aria-labelledby="pinned-pages-heading"
      data-testid="pinned-articles-section"
    >
      <div className="mb-3 flex items-center gap-2">
        <Pin size={16} className="text-action" aria-hidden="true" />
        <h2 id="pinned-pages-heading" className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Pinned Pages
        </h2>
        {/* Tabular figures so the count doesn't jitter as pins come and go.
            Full `text-muted-foreground`: at /70 this measured 3.4:1 on the card
            surface, under the 4.5:1 floor for text this size. */}
        <span
          className="font-mono text-xs tabular-nums text-muted-foreground"
          data-testid="pinned-count"
          aria-hidden="true"
        >
          {total}
        </span>
        {/* The badge alone reads as a naked number; give the count a sentence. */}
        <span className="sr-only">{total} pinned</span>
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
            transition={{ delay: entranceDelay(staggerPosition(i, isExpanded)) }}
          >
            {/* The card was wrapped in a `TiltCard` carrying `card-stack`: a 3D
                perspective rotation tracking the cursor, a drop-shadow that
                slid with it, and two offset ghost layers faking a stack of
                paper that rotated on hover. It is the same gesture the KPI
                tiles lost — the clearest surviving artefact of the retired
                neumorphic world, with no counterpart anywhere else in the app.
                The card below already carries the whole treatment; the wrapper
                was decoration on top of it. */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/pages/${item.id}`)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate(`/pages/${item.id}`); }}
              className="group relative flex h-full w-full cursor-pointer flex-col gap-2 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/45"
              data-testid={`pinned-card-${item.id}`}
            >
              {/* Unpin button */}
              <button
                onClick={(e) => handleUnpin(e, item.id, item.title)}
                className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                aria-label={`Unpin ${item.title}`}
                data-unpin={item.id}
                data-testid={`unpin-btn-${item.id}`}
              >
                <PinOff size={14} />
              </button>

              {/* Title */}
              <p className="line-clamp-2 pr-6 font-medium">{item.title}</p>

              {/* Metadata row */}
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
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
            </div>
          </m.div>
        ))}
      </div>

      {overflow > 0 && (
        <div className="mt-3 flex justify-center">
          <button
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={isExpanded}
            aria-controls="pinned-pages-grid"
            className="nm-button-ghost text-sm"
            data-testid="pinned-expand-toggle"
          >
            {isExpanded ? (
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
    </section>
  );
}
