import { useId, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import type { PageFreezeHistoryEntry } from '@compendiq/contracts';
import { useFreezeHistory } from '../../hooks/use-page-lifecycle';

/**
 * Retained freeze/thaw evidence for one article (#277), as a disclosure under
 * the Document lifecycle section.
 *
 * Every baseline is an immutable historical object: a thaw unlocks the live
 * article and changes nothing here, and a second freeze at the same version
 * is a NEW baseline. So this list is append-only from the reader's point of
 * view, and it is the only surface on the article that shows a baseline the
 * page is no longer sitting on.
 *
 * Three claims are kept apart, exactly as in the section above it:
 *
 *   - who performed the transition (`actorName`, a server-held immutable
 *     display snapshot that survives deleting the user);
 *   - whether the baseline was an authenticated approval or one person's
 *     assertion (`provenance`);
 *   - names the freezing person TYPED (`reportedSignatories`), which are
 *     labelled as reported and never as agreement collected from them.
 *
 * It is a record, not a pipeline state, so the whole thing is neutral ink.
 */
function formatWhen(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function HistoryRow({ entry }: { entry: PageFreezeHistoryEntry }) {
  return (
    <li className="border-t border-border py-2 first:border-t-0" data-testid="baseline-history-entry">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium text-foreground/85">
          {entry.action === 'freeze' ? `Frozen at v${entry.version}` : `Thawed from v${entry.version}`}
        </span>
        <span className="shrink-0 text-muted-foreground">{formatWhen(entry.createdAt)}</span>
      </div>
      <p className="mt-0.5 text-muted-foreground">
        {/* `actorId === null` is a deleted user. The server keeps the display
            name it recorded at the time; replacing it with "Unknown" here
            would destroy evidence the backend deliberately retained. */}
        {entry.provenance === 'authenticated_approval'
          ? `Authenticated approval — recorded by ${entry.actorName}`
          : `Recorded by ${entry.actorName}`}
      </p>
      <p className="mt-0.5 text-foreground/85">{entry.reason}</p>
      {entry.reportedSignatories.length > 0 && (
        <div className="mt-1" data-testid="baseline-history-signatories">
          <p className="text-muted-foreground">
            Reported signatories: {entry.reportedSignatories.map((s) => s.displayName).join(', ')}
          </p>
          <p className="text-[11px] text-muted-foreground">
            Entered by the person who froze this article. Not verified agreement from those people.
          </p>
        </div>
      )}
      {entry.reportedReference && (
        // Deliberately text, never a link: a free-text reference is not a URL,
        // and rendering one as an anchor invites a navigation the server never
        // validated.
        <p className="mt-0.5 text-muted-foreground" data-testid="baseline-history-reference">
          Reference: {entry.reportedReference}
        </p>
      )}
      <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
        Manifest {entry.manifestDigest.slice(0, 12)}…
      </p>
    </li>
  );
}

export function PageBaselineHistory({ pageId }: { pageId: string }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const history = useFreezeHistory(pageId, open);

  const entries = useMemo(
    () => (history.data ?? []).flatMap((page) => page.entries),
    [history.data],
  );

  return (
    <div className="mt-3" data-testid="baseline-history">
      <button
        type="button"
        className="nm-button-ghost inline-flex h-8 items-center gap-1.5 px-2 text-xs"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((prev) => !prev)}
        data-testid="baseline-history-toggle"
      >
        {open
          ? <ChevronDown size={12} className="shrink-0 opacity-70" aria-hidden="true" />
          : <ChevronRight size={12} className="shrink-0 opacity-70" aria-hidden="true" />}
        <span>Baseline history</span>
      </button>

      <div id={listId} hidden={!open}>
        {open && (
          <>
            {history.isPending && (
              <p className="mt-1.5 text-xs text-muted-foreground" data-testid="baseline-history-loading">
                Reading the retained history…
              </p>
            )}
            {/* A failed read is a failure, never an empty history: the two
                send a reader to opposite conclusions about whether this
                article was ever frozen. */}
            {history.isError && (
              <p className="mt-1.5 text-xs text-destructive" data-testid="baseline-history-error">
                The freeze history could not be read. Nothing has been lost — try again.
              </p>
            )}
            {!history.isPending && !history.isError && entries.length === 0 && (
              <p className="mt-1.5 text-xs text-muted-foreground" data-testid="baseline-history-empty">
                This article has no freeze history.
              </p>
            )}
            {entries.length > 0 && (
              <ul className="mt-1.5 text-xs" data-testid="baseline-history-list">
                {entries.map((entry) => <HistoryRow key={entry.id} entry={entry} />)}
              </ul>
            )}
            {history.hasNextPage && (
              <button
                type="button"
                className="nm-button-ghost mt-1.5 inline-flex h-8 items-center gap-1.5 px-2 text-xs"
                aria-disabled={history.isFetchingNextPage}
                onClick={() => {
                  if (history.isFetchingNextPage) return;
                  void history.fetchNextPage();
                }}
                data-testid="baseline-history-more"
              >
                {history.isFetchingNextPage && (
                  <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                )}
                <span>{history.isFetchingNextPage ? 'Loading…' : 'Show more'}</span>
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
