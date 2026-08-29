import { useState, useEffect } from 'react';
import * as Switch from '@radix-ui/react-switch';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, CheckSquare, Square, Trash2, Search, X } from 'lucide-react';
import { apiFetch } from '../../shared/lib/api';
import { cn } from '../../shared/lib/cn';
import { toast } from 'sonner';
import { ConfirmDialog } from '../../shared/components/ConfirmDialog';
import { SpaceHomePicker } from './SpaceHomePicker';
import { Button, IconButton } from '../../shared/components/Button';

interface AvailableSpace {
  key: string;
  name: string;
  type: string;
}

interface SyncedSpace {
  key: string;
  name: string;
  lastSynced: string | null;
  pageCount: number;
  /** #352: resolved home (custom override OR Confluence default). */
  homepageId?: string | null;
  /** #352: raw custom override (null when falling back to Confluence default). */
  customHomePageId?: number | null;
}

interface SpacesTabProps {
  selectedSpaces?: string[];
  showSpaceHomeContent?: boolean;
  onSave: (values: Record<string, unknown>) => Promise<unknown>;
}

const EMPTY_SPACES: string[] = [];

export function SpacesTab({ selectedSpaces: initialSelected = EMPTY_SPACES, showSpaceHomeContent = true, onSave }: SpacesTabProps) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set(initialSelected));
  // Space awaiting remove confirmation (#721; ConfirmDialog replaces native confirm()).
  const [pendingRemove, setPendingRemove] = useState<{ key: string; name: string } | null>(null);
  // Guard for saving an empty selection (#721).
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  // Re-sync local selection when the incoming prop's *contents* change. Keying
  // the effect on a primitive (its JSON serialization) means it only re-runs on real
  // content changes — not on every render that produces a new array identity —
  // and reconstructing from that key keeps the dependency list honest.
  const initialSelectedKey = JSON.stringify(initialSelected);
  useEffect(() => {
    setSelected(new Set(JSON.parse(initialSelectedKey) as string[]));
  }, [initialSelectedKey]);

  const { data: availableSpaces, isLoading: loadingAvailable, refetch: fetchSpaces } = useQuery<AvailableSpace[]>({
    queryKey: ['spaces', 'available'],
    queryFn: () => apiFetch('/spaces/available'),
    enabled: false,
  });

  const { data: syncedSpaces } = useQuery<SyncedSpace[]>({
    queryKey: ['spaces'],
    queryFn: () => apiFetch('/spaces'),
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      await onSave({ selectedSpaces: Array.from(selected) });
      return apiFetch('/sync', { method: 'POST' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      toast.success('Sync started');
    },
    onError: (err) => toast.error(err.message),
  });

  // #721: Permanently remove a synced Confluence space and purge its local
  // pages. Admin-only on the backend. Read-only against Confluence.
  const removeSpace = useMutation({
    mutationFn: (key: string) =>
      apiFetch(`/spaces/${encodeURIComponent(key)}`, { method: 'DELETE' }),
    onSuccess: (_d, key) => {
      setSelected((prev) => {
        const n = new Set(prev);
        n.delete(key);
        return n;
      });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      toast.success('Space removed — its synced pages were deleted locally');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to remove space'),
  });

  const toggleSpace = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const handleRemoveSpace = (key: string, name: string) => {
    setPendingRemove({ key, name });
  };

  const handleSave = async () => {
    if (selected.size === 0) {
      setConfirmClearOpen(true);
      return;
    }
    await onSave({ selectedSpaces: Array.from(selected) });
  };

  // Build merged list of spaces
  const allSpaces = mergeSpaces(availableSpaces ?? [], syncedSpaces ?? [], Array.from(selected));

  /**
   * Local filter over the merged list (#1402 phase 3).
   *
   * `GET /spaces/available` returns every space the PAT can read — dozens to
   * hundreds on a real Data Center instance — and this list was a flat
   * unfiltered `.map()`, so picking three known spaces meant scrolling the
   * whole estate. Key as well as name, because the key is what people quote to
   * each other. Local state only: no request, no URL param — a lookup inside
   * one settings panel is not a shareable view, and `selected` is deliberately
   * untouched, so filtering hides rows without deselecting them.
   */
  const [spaceFilter, setSpaceFilter] = useState('');
  const needle = spaceFilter.trim().toLowerCase();
  const visibleSpaces = allSpaces.filter(
    (space) =>
      space.name.toLowerCase().includes(needle) || space.key.toLowerCase().includes(needle),
  );

  /**
   * How many rows the filter is hiding — said out loud, and said on screen.
   *
   * `selected` is deliberately untouched by filtering, which is right and was
   * silent: `Save Selection (12)` sat under a single visible row with nothing
   * explaining the other eleven. The count strip is the same recipe the
   * Library uses for its own filtered lists (`browse-results-context` /
   * `search-results-context` in `PagesPage`), and it only renders while a
   * filter is active — an unfiltered list counting itself is noise.
   *
   * The announcer is a sibling of the input and always mounted, only its text
   * changing, for the reason `PagesPage`'s `filters-live-announcer` is: a live
   * region that first appears alongside its own content can go unannounced.
   * The visible strip and the zero-match block therefore carry no role.
   */
  const filterActive = needle.length > 0;
  const filterSummary = filterActive
    ? `Showing ${visibleSpaces.length} of ${allSpaces.length} spaces`
    : '';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Select which Confluence spaces to sync and monitor.
        </p>
        <Button
          onClick={() => fetchSpaces()}
          disabled={loadingAvailable}
          isLoading={loadingAvailable}
          variant="secondary"
          size="sm"
          leftIcon={!loadingAvailable ? <RefreshCw size={14} /> : undefined}
        >
          Fetch Spaces
        </Button>
      </div>

      {/* Show space home content toggle */}
      <div className="flex items-center justify-between rounded-lg border border-border bg-foreground/5 px-4 py-3">
        <div>
          <label htmlFor="toggle-space-home-content" className="cursor-pointer text-sm font-medium">
            Show space home content
          </label>
          <p className="text-xs text-muted-foreground">
            When selecting a space, display its home page content instead of the page list.
          </p>
        </div>
        <Switch.Root
          id="toggle-space-home-content"
          checked={showSpaceHomeContent}
          onCheckedChange={(checked) => onSave({ showSpaceHomeContent: checked })}
          aria-label="Show space home content"
          data-testid="toggle-space-home-content"
          className="relative h-5 w-9 shrink-0 rounded-full bg-foreground/10 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring data-[state=checked]:bg-action"
        >
          <Switch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-4" />
        </Switch.Root>
      </div>

      {/* Filter — only once there is a list to narrow. */}
      {allSpaces.length > 0 && (
        <div className="space-y-1.5">
          <div className="relative flex items-center">
            <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2.5 text-muted-foreground" />
            <input
              type="text"
              value={spaceFilter}
              onChange={(e) => setSpaceFilter(e.target.value)}
              placeholder="Filter spaces by name or key…"
              aria-label="Filter spaces"
              data-testid="space-filter-input"
              className="nm-input pl-8 pr-8"
            />
            {spaceFilter && (
              <button
                type="button"
                onClick={() => setSpaceFilter('')}
                aria-label="Clear space filter"
                // The repo's icon-button recipe: a 24x24 target inside the
                // input's existing `pr-8` reserve (WCAG 2.2 SC 2.5.8), wearing
                // `--color-ring` rather than the UA outline. Nothing moves.
                className="nm-icon-button absolute right-1 h-6 w-6"
                data-testid="space-filter-clear"
              >
                <X size={13} />
              </button>
            )}
          </div>
          {/* Always mounted, text-only changes — the one thing the filter
              says out loud. */}
          <span
            role="status"
            aria-live="polite"
            className="sr-only"
            data-testid="space-filter-announcer"
          >
            {filterSummary}
          </span>
          {filterActive && (
            <p className="text-xs text-muted-foreground" data-testid="space-filter-count">
              {filterSummary}
            </p>
          )}
        </div>
      )}

      {/* Space list. Each row mixes a selection toggle (the whole row) with
          a per-space home picker (#379). Nested <button> inside <button>
          would be invalid HTML, so the row is a div with role=listitem
          plus an inner <button> for the toggle, and the home picker is a
          sibling that calls stopPropagation in its own click handler. */}
      {visibleSpaces.length > 0 ? (
        <div className="space-y-1.5" role="list" aria-label="Spaces list">
          {visibleSpaces.map((space) => {
            const isSelected = selected.has(space.key);
            return (
              <div
                key={space.key}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors',
                  isSelected
                    ? 'border-action/30 bg-action/10'
                    : 'border-border bg-foreground/5 hover:bg-foreground/10',
                )}
                role="listitem"
              >
                <button
                  type="button"
                  onClick={() => toggleSpace(space.key)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
                  aria-pressed={isSelected}
                  aria-label={`${isSelected ? 'Deselect' : 'Select'} ${space.name}`}
                >
                  {isSelected ? (
                    <CheckSquare size={18} className="shrink-0 text-action" />
                  ) : (
                    <Square size={18} className="shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{space.name}</p>
                    <p className="text-xs text-muted-foreground">{space.key}</p>
                  </div>
                  {space.lastSynced && (
                    <div className="text-right text-xs text-muted-foreground">
                      <p>{space.pageCount} pages</p>
                      <p>Synced: {new Date(space.lastSynced).toLocaleDateString()}</p>
                    </div>
                  )}
                </button>
                {/* #379: home picker only renders for synced spaces — an
                    unsynced space has no pages locally to choose from. */}
                {space.lastSynced && (
                  <SpaceHomePicker
                    spaceKey={space.key}
                    resolvedHomePageId={space.homepageId ?? null}
                    customHomePageId={space.customHomePageId ?? null}
                  />
                )}
                {/* #721: Remove action — only shown for synced spaces. */}
                {space.lastSynced && (
                  <IconButton
                    onClick={(e) => { e.stopPropagation(); handleRemoveSpace(space.key, space.name); }}
                    disabled={removeSpace.isPending}
                    variant="destructive-ghost"
                    size="icon-sm"
                    label={`Remove ${space.name}`}
                    title="Remove this space and its synced pages"
                    icon={<Trash2 size={14} />}
                  />
                )}
              </div>
            );
          })}
        </div>
      ) : allSpaces.length > 0 ? (
        /* The list is loaded — the filter is what emptied it, so say that
           rather than sending the user back to Fetch Spaces (#1402). No role
           here: the always-mounted announcer beside the input owns the speech.
           The reset lives IN the block too, because the only other one is an
           unlabelled 24x24 icon ~70px up and out of the reader's eye line. */
        <div
          className="rounded-lg border border-border bg-foreground/5 py-8 text-center text-sm text-muted-foreground"
          data-testid="space-filter-empty"
        >
          <p>No spaces match "{spaceFilter.trim()}"</p>
          <button
            type="button"
            onClick={() => setSpaceFilter('')}
            className="nm-button-ghost mt-3 h-8 px-2.5 text-xs"
            data-testid="space-filter-empty-clear"
          >
            Clear filter
          </button>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-foreground/5 py-8 text-center text-sm text-muted-foreground">
          Click "Fetch Spaces" to load available Confluence spaces.
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3">
        {/* #721: Save enabled at zero — admin may intentionally clear all spaces. */}
        <Button
          onClick={handleSave}
          variant="primary"
          size="sm"
        >
          Save Selection ({selected.size})
        </Button>
        <Button
          onClick={() => syncMutation.mutate()}
          disabled={selected.size === 0 || syncMutation.isPending}
          isLoading={syncMutation.isPending}
          variant="secondary"
          size="sm"
          leftIcon={!syncMutation.isPending ? <RefreshCw size={14} /> : undefined}
        >
          Sync Selected
        </Button>
      </div>

      {/* #721 remove confirmation. Copy mirrors the backend reality
          (DELETE /spaces/:key → unsyncSpace): the local purge is permanent —
          pages cascade-delete their embeddings and version history, cached
          attachments are removed — but Confluence itself is read-only here
          and the space can be synced again later. */}
      <ConfirmDialog
        open={pendingRemove !== null}
        title={`Remove "${pendingRemove?.name ?? ''}" from Compendiq?`}
        description="This permanently deletes its synced pages, embeddings and version history stored in Compendiq. Nothing is deleted in Confluence — you can sync the space again later."
        confirmLabel="Remove space"
        destructive
        onConfirm={() => {
          if (pendingRemove) removeSpace.mutate(pendingRemove.key);
          setPendingRemove(null);
        }}
        onCancel={() => setPendingRemove(null)}
      />

      {/* Empty-selection save guard. Saving [] only clears the sync selection
          (settings.ts removes the per-space editor assignments) — already
          synced pages are NOT deleted, so the copy must not claim they are. */}
      <ConfirmDialog
        open={confirmClearOpen}
        title="Remove all spaces from your selection?"
        description="Saving an empty selection stops syncing every space for you. Already-synced pages are not deleted; re-select a space to resume syncing it."
        confirmLabel="Save empty selection"
        onConfirm={() => {
          setConfirmClearOpen(false);
          void onSave({ selectedSpaces: [] });
        }}
        onCancel={() => setConfirmClearOpen(false)}
      />
    </div>
  );
}

function mergeSpaces(available: AvailableSpace[], synced: SyncedSpace[], selectedKeys: string[]) {
  const syncedMap = new Map(synced.map((s) => [s.key, s]));
  const merged: Array<{
    key: string;
    name: string;
    lastSynced?: string | null;
    pageCount?: number;
    homepageId?: string | null;
    customHomePageId?: number | null;
  }> = [];
  const seen = new Set<string>();

  // Add all available spaces
  for (const space of available) {
    const syncInfo = syncedMap.get(space.key);
    merged.push({
      key: space.key,
      name: space.name,
      lastSynced: syncInfo?.lastSynced,
      pageCount: syncInfo?.pageCount,
      homepageId: syncInfo?.homepageId ?? null,
      customHomePageId: syncInfo?.customHomePageId ?? null,
    });
    seen.add(space.key);
  }

  // Add synced-only spaces (not in available)
  for (const space of synced) {
    if (!seen.has(space.key)) {
      merged.push({
        key: space.key,
        name: space.name,
        lastSynced: space.lastSynced,
        pageCount: space.pageCount,
        homepageId: space.homepageId ?? null,
        customHomePageId: space.customHomePageId ?? null,
      });
      seen.add(space.key);
    }
  }

  for (const key of selectedKeys) {
    if (key.startsWith('_') || seen.has(key)) {
      continue;
    }

    merged.push({
      key,
      name: key,
    });
    seen.add(key);
  }

  return merged;
}
