import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, CheckSquare, Square, Loader2 } from 'lucide-react';
import { apiFetch } from '../../shared/lib/api';
import { cn } from '../../shared/lib/cn';
import { toast } from 'sonner';

interface AvailableSpace {
  key: string;
  name: string;
  type: string;
}

interface SyncedSpace {
  key: string;
  name: string;
  lastSynced: string;
  pageCount: number;
}

interface SpacesTabProps {
  selectedSpaces?: string[];
  showSpaceHomeContent?: boolean;
  onSave: (values: Record<string, unknown>) => void;
}

const EMPTY_SPACES: string[] = [];

export function SpacesTab({ selectedSpaces: initialSelected = EMPTY_SPACES, showSpaceHomeContent = true, onSave }: SpacesTabProps) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set(initialSelected));

  // Stabilize the array reference for the effect dependency
  const stableSelected = useMemo(
    () => initialSelected,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(initialSelected)],
  );

  // Sync selected state when prop changes
  useEffect(() => {
    setSelected(new Set(stableSelected));
  }, [stableSelected]);

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
    mutationFn: () => apiFetch('/sync', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      toast.success('Sync started');
    },
    onError: (err) => toast.error(err.message),
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

  const handleSave = () => {
    onSave({ selectedSpaces: Array.from(selected) });
  };

  // Build merged list of spaces
  const allSpaces = mergeSpaces(availableSpaces ?? [], syncedSpaces ?? []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Select which Confluence spaces to sync and monitor.
        </p>
        <button
          onClick={() => fetchSpaces()}
          disabled={loadingAvailable}
          className="flex items-center gap-1.5 rounded-md border border-border/50 px-3 py-1.5 text-sm hover:bg-foreground/5 disabled:opacity-50"
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
            showSpaceHomeContent ? 'bg-primary' : 'bg-foreground/20',
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

      {/* Space list */}
      {allSpaces.length > 0 ? (
        <div className="space-y-1.5" role="list" aria-label="Spaces list">
          {allSpaces.map((space) => {
            const isSelected = selected.has(space.key);
            return (
              <button
                key={space.key}
                onClick={() => toggleSpace(space.key)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors',
                  isSelected
                    ? 'border-primary/30 bg-primary/10'
                    : 'border-border/50 bg-foreground/5 hover:bg-foreground/10',
                )}
                role="listitem"
              >
                {isSelected ? (
                  <CheckSquare size={18} className="shrink-0 text-primary" />
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
        <button
          onClick={handleSave}
          disabled={selected.size === 0}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Save Selection ({selected.size})
        </button>
        <button
          onClick={() => syncMutation.mutate()}
          disabled={selected.size === 0 || syncMutation.isPending}
          className="flex items-center gap-1.5 rounded-md border border-border/50 px-4 py-2 text-sm hover:bg-foreground/5 disabled:opacity-50"
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

function mergeSpaces(available: AvailableSpace[], synced: SyncedSpace[]) {
  const syncedMap = new Map(synced.map((s) => [s.key, s]));
  const merged: Array<{
    key: string;
    name: string;
    lastSynced?: string;
    pageCount?: number;
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
      });
    }
  }

  return merged;
}
