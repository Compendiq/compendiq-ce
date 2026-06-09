import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, CheckSquare, Square, Loader2, Trash2 } from 'lucide-react';
import { apiFetch } from '../../shared/lib/api';
import { cn } from '../../shared/lib/cn';
import { toast } from 'sonner';
import { SpaceHomePicker } from './SpaceHomePicker';

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
    if (
      window.confirm(
        `Remove "${name}"? This deletes its synced pages locally. It does NOT delete anything in Confluence.`,
      )
    ) {
      removeSpace.mutate(key);
    }
  };

  const handleSave = async () => {
    if (
      selected.size === 0 &&
      !window.confirm('Remove all synced spaces from your selection?')
    ) {
      return;
    }
    await onSave({ selectedSpaces: Array.from(selected) });
  };

  // Build merged list of spaces
  const allSpaces = mergeSpaces(availableSpaces ?? [], syncedSpaces ?? [], Array.from(selected));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Select which Confluence spaces to sync and monitor.
        </p>
        <button
          onClick={() => fetchSpaces()}
          disabled={loadingAvailable}
          className="nm-button-ghost px-3 py-1.5"
        >
          {loadingAvailable ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <RefreshCw size={14} />
          )}
          Fetch Spaces
        </button>
      </div>

      {/* Show space home content toggle */}
      <div className="flex items-center justify-between rounded-lg border border-border/50 bg-foreground/5 px-4 py-3">
        <div>
          <p className="text-sm font-medium">Show space home content</p>
          <p className="text-xs text-muted-foreground">
            When selecting a space, display its home page content instead of the page list.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={showSpaceHomeContent}
          onClick={() => onSave({ showSpaceHomeContent: !showSpaceHomeContent })}
          className={cn(
            'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            showSpaceHomeContent ? 'bg-action' : 'bg-foreground/20',
          )}
          data-testid="toggle-space-home-content"
        >
          <span
            className={cn(
              'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
              showSpaceHomeContent ? 'translate-x-5' : 'translate-x-0',
            )}
          />
        </button>
      </div>

      {/* Space list. Each row mixes a selection toggle (the whole row) with
          a per-space home picker (#379). Nested <button> inside <button>
          would be invalid HTML, so the row is a div with role=listitem
          plus an inner <button> for the toggle, and the home picker is a
          sibling that calls stopPropagation in its own click handler. */}
      {allSpaces.length > 0 ? (
        <div className="space-y-1.5" role="list" aria-label="Spaces list">
          {allSpaces.map((space) => {
            const isSelected = selected.has(space.key);
            return (
              <div
                key={space.key}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors',
                  isSelected
                    ? 'border-action/30 bg-action/10'
                    : 'border-border/50 bg-foreground/5 hover:bg-foreground/10',
                )}
                role="listitem"
              >
                <button
                  type="button"
                  onClick={() => toggleSpace(space.key)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 rounded-md"
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
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleRemoveSpace(space.key, space.name); }}
                    disabled={removeSpace.isPending}
                    aria-label={`Remove ${space.name}`}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                    title="Remove this space and its synced pages"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-lg border border-border/50 bg-foreground/5 py-8 text-center text-sm text-muted-foreground">
          Click "Fetch Spaces" to load available Confluence spaces.
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3">
        {/* #721: Save enabled at zero — admin may intentionally clear all spaces. */}
        <button
          onClick={handleSave}
          className="nm-button-primary"
        >
          Save Selection ({selected.size})
        </button>
        <button
          onClick={() => syncMutation.mutate()}
          disabled={selected.size === 0 || syncMutation.isPending}
          className="nm-button-ghost"
        >
          {syncMutation.isPending ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <RefreshCw size={14} />
          )}
          Sync Selected
        </button>
      </div>
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
