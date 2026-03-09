import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { m, AnimatePresence } from 'framer-motion';
import { History, ChevronRight, Eye, GitCompare, Sparkles, Loader2, X } from 'lucide-react';
import { apiFetch } from '../../shared/lib/api';
import { DiffView } from '../../shared/components/DiffView';
import { cn } from '../../shared/lib/cn';
import { useIsLightTheme } from '../../shared/hooks/use-is-light-theme';

interface PageVersionSummary {
  versionNumber: number;
  title: string;
  syncedAt: string;
  isCurrent: boolean;
}

interface PageVersionDetail {
  confluenceId: string;
  versionNumber: number;
  title: string;
  bodyHtml: string | null;
  bodyText: string | null;
  isCurrent: boolean;
}

interface VersionsResponse {
  versions: PageVersionSummary[];
  pageId: string;
}

interface SemanticDiffResponse {
  diff: string;
  v1: number;
  v2: number;
  pageId: string;
}

function useVersionHistory(pageId: string | undefined) {
  return useQuery<VersionsResponse>({
    queryKey: ['pages', pageId, 'versions'],
    queryFn: () => apiFetch(`/pages/${pageId}/versions`),
    enabled: !!pageId,
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

interface VersionHistoryProps {
  pageId: string;
  currentBodyText?: string;
  model: string;
}

export function VersionHistory({ pageId, currentBodyText: _currentBodyText, model }: VersionHistoryProps) {
  const isLight = useIsLightTheme();
  const [expanded, setExpanded] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [compareVersions, setCompareVersions] = useState<[number, number] | null>(null);
  const [showSemanticDiff, setShowSemanticDiff] = useState(false);

  const { data: versionsData, isLoading } = useVersionHistory(expanded ? pageId : undefined);
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

  const handleCompare = (v1: number, v2: number) => {
    setCompareVersions([v1, v2]);
    setShowSemanticDiff(false);
  };

  const handleSemanticDiff = (v1: number, v2: number) => {
    setShowSemanticDiff(true);
    semanticDiffMutation.mutate({ v1, v2 });
  };

  return (
    <m.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass-card overflow-hidden"
    >
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-foreground/5 transition-colors"
      >
        <div className="flex items-center gap-2">
          <History size={16} className="text-primary" />
          <h3 className="text-sm font-semibold">Version History</h3>
          {versions.length > 0 && (
            <span className="rounded bg-foreground/5 px-1.5 py-0.5 text-xs text-muted-foreground">
              {versions.length}
            </span>
          )}
        </div>
        <ChevronRight
          size={14}
          className={cn(
            'text-muted-foreground transition-transform',
            expanded && 'rotate-90',
          )}
        />
      </button>

      {/* Version timeline */}
      <AnimatePresence>
        {expanded && (
          <m.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            className="overflow-hidden border-t border-border/50"
          >
            {isLoading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
                <Loader2 size={14} className="animate-spin" />
                <span className="text-sm">Loading versions...</span>
              </div>
            ) : versions.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                No version history available. Versions are saved during sync.
              </div>
            ) : (
              <div className="max-h-72 overflow-y-auto">
                {versions.map((version, i) => (
                  <div
                    key={`${version.versionNumber}-${version.isCurrent}`}
                    className={cn(
                      'flex items-center gap-3 px-4 py-2.5',
                      i !== versions.length - 1 && 'border-b border-border/30',
                      selectedVersion === version.versionNumber && 'bg-primary/5',
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
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {version.title} - {new Date(version.syncedAt).toLocaleString()}
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
                            onClick={() => handleCompare(version.versionNumber, versions[i + 1].versionNumber)}
                            className="rounded p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                            title="Compare with previous version"
                          >
                            <GitCompare size={12} />
                          </button>
                          <button
                            onClick={() => handleSemanticDiff(versions[i + 1].versionNumber, version.versionNumber)}
                            className="rounded p-1 text-muted-foreground hover:bg-foreground/5 hover:text-primary"
                            title="AI semantic diff with previous version"
                          >
                            <Sparkles size={12} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Version preview */}
            {selectedVersionData && (
              <div className="border-t border-border/50 p-4">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-medium text-muted-foreground">
                    Version {selectedVersionData.versionNumber} Preview
                  </h4>
                  <button
                    onClick={() => setSelectedVersion(null)}
                    className="rounded p-1 text-muted-foreground hover:bg-foreground/5"
                  >
                    <X size={12} />
                  </button>
                </div>
                <div className={cn('prose max-h-48 overflow-y-auto text-xs', !isLight && 'prose-invert')}>
                  <pre className="whitespace-pre-wrap text-xs text-muted-foreground">
                    {selectedVersionData.bodyText ?? 'No content available'}
                  </pre>
                </div>
              </div>
            )}

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
          </m.div>
        )}
      </AnimatePresence>
    </m.div>
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
