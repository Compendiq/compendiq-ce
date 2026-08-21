import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { m } from 'framer-motion';
import { Pin, PinOff, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { usePinPage, usePinnedPages, useUnpinPage } from '../../shared/hooks/use-pages';
import { COLLAPSED_PIN_COUNT, entranceDelay, staggerPosition } from './pinned-articles-layout';
import { PageIcon } from '../../shared/components/page-icon/PageIcon';
import { cn } from '../../shared/lib/cn';

export function PinnedArticlesSection() {
  const { data: pinnedData } = usePinnedPages();
  const pinMutation = usePinPage();
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
  // An empty cue on every visit costs a band before the list and teaches
  // nothing the Pin action on the article does not already say. Hide the
  // section until there is something to jump back to.
  if (total === 0) {
    return null;
  }
  const overflow = total - COLLAPSED_PIN_COUNT;
  // Derived, not the raw flag: unpinning back below the cut-off unmounts the
  // toggle, and a latched `expanded` would then silently re-expand the section
  // the moment the count rose again, with nothing on screen having asked for it.
  const isExpanded = expanded && overflow > 0;
  const visiblePins = isExpanded ? pinnedData.items : pinnedData.items.slice(0, COLLAPSED_PIN_COUNT);

  const handleUnpin = (pageId: string, title: string) => {
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
        toast.success(`Unpinned "${title}"`, {
          action: {
            label: 'Undo',
            onClick: () => pinMutation.mutate(pageId, {
              onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not restore pin'),
            }),
          },
        });
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
      className="border-y border-border py-2"
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 px-1">
        <span className="flex size-6 items-center justify-center text-muted-foreground">
          <Pin size={14} aria-hidden="true" />
        </span>
        <h2 id="pinned-pages-heading" className="text-sm font-semibold text-foreground">
          Pinned pages
        </h2>
        <span
          className="font-mono text-xs tabular-nums text-muted-foreground"
          data-testid="pinned-count"
          aria-hidden="true"
        >
          {total}
        </span>
        <span className="sr-only">{total} pinned</span>
      </div>
      <div
        id="pinned-pages-grid"
        className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4"
      >
        {visiblePins.map((item, i) => (
          <m.div
            key={item.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: entranceDelay(staggerPosition(i, isExpanded)) }}
          >
            <div
              className="group flex min-h-[56px] w-full items-center gap-2 rounded-lg border border-border/70 bg-card px-2.5 py-2 text-left transition-colors hover:border-border hover:bg-accent focus-within:border-border focus-within:bg-accent"
              data-testid={`pinned-card-${item.id}`}
            >
              <Link
                to={`/pages/${item.id}`}
                onKeyDown={(e) => {
                  if (e.key === ' ') {
                    e.preventDefault();
                    e.currentTarget.click();
                  }
                }}
                className="nm-focus-ring min-w-0 flex-1 text-foreground no-underline"
              >
                <p className="flex min-w-0 items-center gap-1.5 truncate text-[13px] font-medium">
                  {item.icon && <PageIcon icon={item.icon} pageId={item.id} size="row" />}
                  <span className="min-w-0 truncate" title={item.title}>{item.title}</span>
                </p>
                {(item.spaceKey && item.spaceKey !== '__local__') || item.lastModifiedAt ? (
                  <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                    {item.spaceKey && item.spaceKey !== '__local__' && <span>{item.spaceKey}</span>}
                    {item.spaceKey && item.spaceKey !== '__local__' && item.lastModifiedAt && <span aria-hidden="true">·</span>}
                    {item.lastModifiedAt && <span>Updated {new Date(item.lastModifiedAt).toLocaleDateString()}</span>}
                  </p>
                ) : null}
              </Link>
              <button
                type="button"
                onClick={() => handleUnpin(item.id, item.title)}
                className="nm-icon-button shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100"
                aria-label={`Unpin ${item.title}`}
                data-unpin={item.id}
                data-testid={`unpin-btn-${item.id}`}
              >
                <PinOff size={14} />
              </button>
            </div>
          </m.div>
        ))}
      </div>

      {overflow > 0 && (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={isExpanded}
            aria-controls="pinned-pages-grid"
            className="library-search-select flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            data-testid="pinned-expand-toggle"
          >
            <span>{isExpanded ? 'Show fewer' : `Show ${overflow} more`}</span>
            <ChevronDown
              size={12}
              className={cn('shrink-0 transition-transform', isExpanded && 'rotate-180')}
              aria-hidden="true"
            />
          </button>
        </div>
      )}
    </section>
  );
}
