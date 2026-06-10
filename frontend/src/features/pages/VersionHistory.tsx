import { useState, useEffect, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, m } from 'framer-motion';
import { History, Eye, GitCompare, Sparkles, Loader2, X, RotateCcw, AlertTriangle, Info } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { toast } from 'sonner';
import type {
  PageVersionsResponse,
  PageVersionDetail,
} from '@compendiq/contracts';
import { apiFetch, ApiError } from '../../shared/lib/api';
import { DiffView } from '../../shared/components/article/DiffView';
import { cn } from '../../shared/lib/cn';
import { useIsLightTheme } from '../../shared/hooks/use-is-light-theme';

// Response/type shapes are the single source of truth in @compendiq/contracts
// (PageVersionsResponseSchema / PageVersionDetailSchema). Don't re-declare them.
type VersionsResponse = PageVersionsResponse;

interface SemanticDiffResponse {
  diff: string;
  v1: number;
  v2: number;
  pageId: string;
}

function useVersionHistory(pageId: string | undefined, enabled: boolean) {
  return useQuery<VersionsResponse>({
    queryKey: ['pages', pageId, 'versions'],
    queryFn: () => apiFetch(`/pages/${pageId}/versions`),
    enabled: !!pageId && enabled,
    staleTime: 5 * 60 * 1000,
  });
}

function useVersionDetail(pageId: string | undefined, version: number | null) {
  return useQuery<PageVersionDetail>({
    queryKey: ['pages', pageId, 'versions', version],
    queryFn: () => apiFetch(`/pages/${pageId}/versions/${version}`),
    enabled: !!pageId && version !== null,
  });
}

interface RestoreResponse {
  id: number;
  title: string;
  version: number;
  restoredFrom: number;
  source: string;
  pushedToConfluence: boolean;
}

interface VersionHistoryProps {
  pageId: string;
  currentBodyText?: string;
  model?: string;
  /**
   * Custom trigger renderer. Receives the dialog's `open` state so callers can
   * reflect it (e.g. active styling). When omitted, a default `nm-card` button
   * is rendered. Used by `ArticleRightPane` to style the trigger as a glass
   * action button matching the other right-pane actions.
   */
  renderTrigger?: (open: boolean) => ReactNode;
}

/**
 * Format the timestamp for a version row.
 *
 * - Real Confluence edit time: shown directly as locale string.
 * - Synced-only (no Confluence editedAt): prefixed with "Synced " so the user
 *   knows it's the local sync time, not the author's edit time (#724).
 * - Neither: nothing shown.
 */
function formatVersionTime(editedAt: string | null, syncedAt: string | null): string {
  if (editedAt) return new Date(editedAt).toLocaleString();
  if (syncedAt) return `Synced ${new Date(syncedAt).toLocaleString()}`;
  return '';
}

export function VersionHistory({ pageId, currentBodyText: _currentBodyText, model, renderTrigger }: VersionHistoryProps) {
  const isLight = useIsLightTheme();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [compareVersions, setCompareVersions] = useState<[number, number] | null>(null);
  const [showSemanticDiff, setShowSemanticDiff] = useState(false);

  const { data: versionsData, isLoading, isError, error, refetch } = useVersionHistory(pageId, open);
  const { data: selectedVersionData } = useVersionDetail(
    pageId,
    selectedVersion,
  );

  const semanticDiffMutation = useMutation({
    mutationFn: ({ v1, v2 }: { v1: number; v2: number }) =>
      apiFetch<SemanticDiffResponse>(`/pages/${pageId}/versions/semantic-diff`, {
        method: 'POST',
        body: JSON.stringify({ v1, v2, model }),
      }),
  });

  const versions = versionsData?.versions ?? [];
  const currentVersionNumber = versions.find((v) => v.isCurrent)?.versionNumber;
  // #763: non-ok backfill means the historical Confluence import never ran or
  // failed — the list still renders, but with a hint that it may be incomplete.
  const backfillStatus = versionsData?.backfillStatus;
  const backfillNotice =
    backfillStatus === 'skipped_no_credentials' || backfillStatus === 'failed'
      ? versionsData?.backfillDetail ??
        (backfillStatus === 'skipped_no_credentials'
          ? 'Historical versions could not be imported: no Confluence credentials are configured for your account. Add your PAT in Settings → Confluence.'
          : 'Importing historical versions from Confluence failed — the list below may be incomplete.')
      : null;

  const restoreMutation = useMutation({
    mutationFn: ({ version, expected }: { version: number; expected?: number }) =>
      apiFetch<RestoreResponse>(`/pages/${pageId}/versions/${version}/restore`, {
        method: 'POST',
        body: JSON.stringify(expected !== undefined ? { version: expected } : {}),
      }),
    onSuccess: async (result) => {
      // Refresh the article content and its version timeline so the restored
      // content (a new version) shows immediately.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['pages', pageId] }),
        queryClient.invalidateQueries({ queryKey: ['pages', pageId, 'versions'] }),
      ]);
      toast.success(
        result.pushedToConfluence
          ? `Restored v${result.restoredFrom} as v${result.version} (pushed to Confluence).`
          : `Restored v${result.restoredFrom} as new version v${result.version}.`,
      );
      setSelectedVersion(null);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to restore version.');
    },
  });

  const handleRestore = (version: number) => {
    if (restoreMutation.isPending) return;
    if (!window.confirm(
      `Restore v${version}? This creates a new version containing the old content. ` +
      `The current version stays in history.`,
    )) {
      return;
    }
    restoreMutation.mutate({ version, expected: currentVersionNumber });
  };

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setSelectedVersion(null);
      setCompareVersions(null);
      setShowSemanticDiff(false);
    }
  }, [open]);

  const handleCompare = (v1: number, v2: number) => {
    setCompareVersions([v1, v2]);
    setShowSemanticDiff(false);
  };

  const handleSemanticDiff = (v1: number, v2: number) => {
    setShowSemanticDiff(true);
    semanticDiffMutation.mutate({ v1, v2 });
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        {renderTrigger ? (
          renderTrigger(open)
        ) : (
          <button
            className="nm-card flex items-center gap-1.5 px-3 py-1.5 text-sm hover:bg-foreground/5"
            title="Version history"
          >
            <History size={14} />
            History
          </button>
        )}
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 nm-card overflow-hidden shadow-xl max-h-[85vh] flex flex-col"
          aria-describedby={undefined}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border/50 px-5 py-4">
            <div className="flex items-center gap-2">
              <History size={16} className="text-action" />
              <Dialog.Title className="font-semibold">Version History</Dialog.Title>
              {versions.length > 0 && (
                <span className="rounded bg-foreground/5 px-1.5 py-0.5 text-xs text-muted-foreground">
                  {versions.length}
                </span>
              )}
            </div>
            <Dialog.Close asChild>
              <button
                className="rounded p-1 text-muted-foreground hover:bg-foreground/5"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          {/* Body (scrollable) */}
          <div className="flex-1 overflow-y-auto">
            {isLoading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
                <Loader2 size={14} className="animate-spin" />
                <span className="text-sm">Loading versions...</span>
              </div>
            ) : isError && !versionsData ? (
              /* #763: a failed request is NOT an empty history — surface the
                 backend reason (401/403/500) instead of the empty state. Only
                 when nothing is loaded yet: TanStack Query retains the previous
                 data on a failed refetch, so transient background failures
                 (e.g. the invalidation after a restore) fall through to the
                 inline notice below instead of replacing the rendered list. */
              <div className="flex flex-col items-center gap-2 px-5 py-6 text-center">
                <div className="flex items-center gap-2 text-destructive">
                  <AlertTriangle size={14} />
                  <span className="text-sm font-medium">Failed to load version history.</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {error instanceof ApiError
                    ? `${error.message} (HTTP ${error.statusCode})`
                    : error instanceof Error
                      ? error.message
                      : 'Unknown error'}
                </p>
                <button
                  onClick={() => void refetch()}
                  className="nm-card mt-1 px-3 py-1.5 text-xs hover:bg-foreground/5"
                >
                  Retry
                </button>
              </div>
            ) : (
              <>
              {isError && (
                /* Background refetch failed but data is loaded — keep the list. */
                <div className="flex items-center gap-2 border-b border-border/50 bg-destructive/10 px-5 py-2.5 text-xs text-muted-foreground">
                  <AlertTriangle size={12} className="shrink-0 text-destructive" />
                  <span>Could not refresh version history &mdash; showing the last loaded versions.</span>
                  <button
                    onClick={() => void refetch()}
                    className="ml-auto shrink-0 rounded px-2 py-0.5 font-medium text-foreground hover:bg-foreground/5"
                  >
                    Retry
                  </button>
                </div>
              )}
              {versions.length === 0 ? (
              <div className="px-5 py-6 text-center text-sm text-muted-foreground">
                No version history available yet. Historical versions are imported
                from Confluence when this dialog opens — importing them requires a
                Confluence PAT (Settings &rarr; Confluence).
              </div>
              ) : (
              <>
              {backfillNotice && (
                <div className="flex items-start gap-2 border-b border-border/50 bg-warning/10 px-5 py-2.5 text-xs text-muted-foreground">
                  <Info size={12} className="mt-0.5 shrink-0 text-warning" />
                  <span>{backfillNotice}</span>
                </div>
              )}
              <div className="max-h-72 overflow-y-auto">
                {versions.map((version, i) => (
                  <div
                    key={`${version.versionNumber}-${version.isCurrent}`}
                    className={cn(
                      'flex items-center gap-3 px-5 py-2.5',
                      i !== versions.length - 1 && 'border-b border-border/30',
                      selectedVersion === version.versionNumber && 'bg-action/5',
                    )}
                  >
                    {/* Timeline dot */}
                    <div className="flex flex-col items-center">
                      <div
                        className={cn(
                          'h-2.5 w-2.5 rounded-full',
                          version.isCurrent ? 'bg-success' : 'bg-foreground/20',
                        )}
                      />
                      {i < versions.length - 1 && (
                        <div className="mt-1 h-4 w-px bg-foreground/10" />
                      )}
                    </div>

                    {/* Version info */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">v{version.versionNumber}</span>
                        {version.isCurrent && (
                          <span className="rounded bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success">
                            Current
                          </span>
                        )}
                        {version.author && (
                          <span className="text-[10px] text-muted-foreground">{version.author}</span>
                        )}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {version.title}
                        {version.message && (
                          <span className="ml-1 italic">&mdash; {version.message}</span>
                        )}
                        {(() => {
                          const ts = formatVersionTime(version.editedAt, version.syncedAt);
                          return ts ? ` - ${ts}` : null;
                        })()}
                      </p>
                    </div>

                    {/* Actions */}
                    <div className="flex shrink-0 gap-1">
                      <button
                        onClick={() => setSelectedVersion(
                          selectedVersion === version.versionNumber ? null : version.versionNumber,
                        )}
                        className="rounded p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                        title="Preview version"
                      >
                        <Eye size={12} />
                      </button>
                      {i < versions.length - 1 && (
                        <>
                          <button
                            onClick={() => handleCompare(version.versionNumber, versions[i + 1]!.versionNumber)}
                            className="rounded p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                            title="Compare with previous version"
                          >
                            <GitCompare size={12} />
                          </button>
                          <button
                            onClick={() => handleSemanticDiff(versions[i + 1]!.versionNumber, version.versionNumber)}
                            className="rounded p-1 text-muted-foreground hover:bg-foreground/5 hover:text-action"
                            title="AI semantic diff with previous version"
                          >
                            <Sparkles size={12} />
                          </button>
                        </>
                      )}
                      {!version.isCurrent && (
                        <button
                          onClick={() => handleRestore(version.versionNumber)}
                          disabled={restoreMutation.isPending}
                          className="rounded p-1 text-muted-foreground hover:bg-foreground/5 hover:text-primary disabled:opacity-40"
                          title="Restore this version"
                        >
                          {restoreMutation.isPending && restoreMutation.variables?.version === version.versionNumber ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <RotateCcw size={12} />
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              </>
              )}
              </>
            )}

            {/* Version preview */}
            <AnimatePresence>
              {selectedVersionData && (
                <m.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden border-t border-border/50"
                >
                  <div className="p-4">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-xs font-medium text-muted-foreground">
                        Version {selectedVersionData.versionNumber} Preview
                        {selectedVersionData.author && (
                          <span className="ml-1 font-normal">by {selectedVersionData.author}</span>
                        )}
                      </h4>
                      <div className="flex items-center gap-1">
                        {!selectedVersionData.isCurrent && (
                          <button
                            onClick={() => handleRestore(selectedVersionData.versionNumber)}
                            disabled={restoreMutation.isPending}
                            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-primary hover:bg-primary/10 disabled:opacity-40"
                            title="Restore this version"
                          >
                            {restoreMutation.isPending ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <RotateCcw size={12} />
                            )}
                            Restore this version
                          </button>
                        )}
                        <button
                          onClick={() => setSelectedVersion(null)}
                          className="rounded p-1 text-muted-foreground hover:bg-foreground/5"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    </div>
                    {selectedVersionData.message && (
                      <p className="mb-2 text-xs italic text-muted-foreground">
                        &ldquo;{selectedVersionData.message}&rdquo;
                      </p>
                    )}
                    <div className={cn('prose max-h-48 overflow-y-auto text-xs', !isLight && 'prose-invert')}>
                      <pre className="whitespace-pre-wrap text-xs text-muted-foreground">
                        {selectedVersionData.bodyText ?? 'No content available'}
                      </pre>
                    </div>
                  </div>
                </m.div>
              )}
            </AnimatePresence>

            {/* Text diff comparison */}
            {compareVersions && !showSemanticDiff && (
              <CompareView
                pageId={pageId}
                v1={compareVersions[0]}
                v2={compareVersions[1]}
                onClose={() => setCompareVersions(null)}
              />
            )}

            {/* Semantic diff */}
            {showSemanticDiff && (
              <div className="border-t border-border/50 p-4">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                    <Sparkles size={12} className="text-primary" />
                    AI Semantic Diff
                  </h4>
                  <button
                    onClick={() => { setShowSemanticDiff(false); setCompareVersions(null); }}
                    className="rounded p-1 text-muted-foreground hover:bg-foreground/5"
                  >
                    <X size={12} />
                  </button>
                </div>
                {semanticDiffMutation.isPending ? (
                  <div className="flex items-center justify-center gap-2 py-4 text-muted-foreground">
                    <Loader2 size={14} className="animate-spin" />
                    <span className="text-sm">Analyzing changes with AI...</span>
                  </div>
                ) : semanticDiffMutation.isError ? (
                  <p className="text-sm text-destructive">
                    Failed to generate semantic diff.
                  </p>
                ) : semanticDiffMutation.data ? (
                  <div className={cn('prose max-h-48 overflow-y-auto text-sm', !isLight && 'prose-invert')}>
                    <pre className="whitespace-pre-wrap text-xs">{semanticDiffMutation.data.diff}</pre>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Side-by-side text comparison of two versions.
 */
function CompareView({
  pageId,
  v1,
  v2,
  onClose,
}: {
  pageId: string;
  v1: number;
  v2: number;
  onClose: () => void;
}) {
  const { data: version1 } = useVersionDetail(pageId, v1);
  const { data: version2 } = useVersionDetail(pageId, v2);

  if (!version1 || !version2) {
    return (
      <div className="border-t border-border/50 p-4">
        <div className="flex items-center justify-center gap-2 py-4 text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          <span className="text-sm">Loading versions for comparison...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-border/50">
      <div className="flex items-center justify-between px-4 py-2">
        <h4 className="text-xs font-medium text-muted-foreground">
          Comparing v{v1} vs v{v2}
        </h4>
        <button
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:bg-foreground/5"
        >
          <X size={12} />
        </button>
      </div>
      <DiffView
        original={version1.bodyText ?? ''}
        improved={version2.bodyText ?? ''}
      />
    </div>
  );
}
