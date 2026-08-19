import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { m } from 'framer-motion';
import { Pin, PinOff, ChevronDown, ChevronUp } from 'lucide-react';
import { toast } from 'sonner';
import { usePinnedPages, useUnpinPage } from '../../shared/hooks/use-pages';
import { COLLAPSED_PIN_COUNT, entranceDelay, staggerPosition } from './pinned-articles-layout';
import { PageIcon } from '../../shared/components/page-icon/PageIcon';

const EMPTY_CUE = 'Pin a page from the article to jump back here.';

export function PinnedArticlesSection() {
  const { data: pinnedData } = usePinnedPages();
  const unpinMutation = useUnpinPage();
  // Ephemeral on purpose: the collapsed strip is the dashboard's default shape,
  // so every visit starts there and expanding is one keystroke away.
  const [expanded, setExpanded] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

  // Stay null while the first fetch is in flight so an empty cue does not
  // flash over a list that is about to arrive.
  if (!pinnedData) {
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
    e.preventDefault();
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
      <div className="mb-2 flex items-center gap-2">
        <Pin size={14} className="text-muted-foreground" aria-hidden="true" />
        <h2 id="pinned-pages-heading" className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Pinned
        </h2>
        {total > 0 && (
          <>
            <span
              className="font-mono text-xs tabular-nums text-muted-foreground"
              data-testid="pinned-count"
              aria-hidden="true"
            >
              {total}
            </span>
            <span className="sr-only">{total} pinned</span>
          </>
        )}
      </div>
      {total === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="pinned-empty-cue">
          {EMPTY_CUE}
        </p>
      ) : (
      <>
      <div
        id="pinned-pages-grid"
        className="grid grid-cols-1 gap-x-1 gap-y-0.5 sm:grid-cols-2 xl:grid-cols-4"
      >
        {visiblePins.map((item, i) => (
          <m.div
            key={item.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: entranceDelay(staggerPosition(i, isExpanded)) }}
          >
            <Link
              to={`/pages/${item.id}`}
              onKeyDown={(e) => {
                if (e.key === ' ') {
                  e.preventDefault();
                  e.currentTarget.click();
                }
              }}
              className="nm-focus-ring group flex w-full cursor-pointer items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-foreground no-underline transition-colors hover:bg-accent forced-colors:border-border-interactive"
              data-testid={`pinned-card-${item.id}`}
            >
              <div className="min-w-0 flex-1">
                <p className="flex min-w-0 items-center gap-1.5 truncate text-[13px] font-medium">
                  {item.icon && <PageIcon icon={item.icon} pageId={item.id} size="row" />}
                  <span className="min-w-0 truncate">{item.title}</span>
                </p>
                {item.spaceKey && item.spaceKey !== '__local__' && (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{item.spaceKey}</p>
                )}
              </div>
              <button
                type="button"
                onClick={(e) => handleUnpin(e, item.id, item.title)}
                className="nm-icon-button shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100"
                aria-label={`Unpin ${item.title}`}
                data-unpin={item.id}
                data-testid={`unpin-btn-${item.id}`}
              >
                <PinOff size={14} />
              </button>
            </Link>
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
      </>
      )}
    </section>
  );
}
