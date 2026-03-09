import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Check, ChevronDown, ChevronRight, Clock } from 'lucide-react';
import { apiFetch } from '../../shared/lib/api';
import { cn } from '../../shared/lib/cn';

interface ErrorLogEntry {
  id: string;
  errorType: string;
  message: string;
  stack: string | null;
  context: Record<string, unknown>;
  userId: string | null;
  requestPath: string | null;
  correlationId: string | null;
  resolved: boolean;
  createdAt: string;
}

interface ErrorSummaryItem {
  errorType: string;
  count: number;
  lastOccurrence: string;
}

interface ErrorSummaryResponse {
  last24h: ErrorSummaryItem[];
  last7d: ErrorSummaryItem[];
  last30d: ErrorSummaryItem[];
  unresolvedCount: number;
}

interface PaginatedErrors {
  items: ErrorLogEntry[];
  total: number;
  page: number;
  limit: number;
}

export function ErrorDashboard() {
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterResolved, setFilterResolved] = useState<'all' | 'unresolved' | 'resolved'>('unresolved');
  const [currentPage, setCurrentPage] = useState(1);

  const { data: summary } = useQuery<ErrorSummaryResponse>({
    queryKey: ['admin', 'errors', 'summary'],
    queryFn: () => apiFetch('/admin/errors/summary'),
    refetchInterval: 30_000,
  });

  const { data: errors, isLoading } = useQuery<PaginatedErrors>({
    queryKey: ['admin', 'errors', filterResolved, currentPage],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('page', String(currentPage));
      params.set('limit', '20');
      if (filterResolved !== 'all') {
        params.set('resolved', filterResolved === 'resolved' ? 'true' : 'false');
      }
      return apiFetch(`/admin/errors?${params.toString()}`);
    },
  });

  const resolveError = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/admin/errors/${id}/resolve`, { method: 'PUT' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'errors'] });
      toast.success('Error marked as resolved');
    },
    onError: (err) => toast.error(err.message),
  });

  function formatTimeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  const totalErrors24h = summary?.last24h.reduce((sum, s) => sum + s.count, 0) ?? 0;
  const totalErrors7d = summary?.last7d.reduce((sum, s) => sum + s.count, 0) ?? 0;

  return (
    <div className="space-y-4" data-testid="error-dashboard">
      <div>
        <h3 className="text-lg font-medium">Error Monitor</h3>
        <p className="text-sm text-muted-foreground">
          Track and resolve application errors.
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border border-border/50 p-3">
          <p className="text-xs text-muted-foreground">Today</p>
          <p className={cn('text-2xl font-bold', totalErrors24h > 0 ? 'text-destructive' : 'text-success')} data-testid="errors-today">
            {totalErrors24h}
          </p>
        </div>
        <div className="rounded-lg border border-border/50 p-3">
          <p className="text-xs text-muted-foreground">This Week</p>
          <p className="text-2xl font-bold" data-testid="errors-week">{totalErrors7d}</p>
        </div>
        <div className="rounded-lg border border-border/50 p-3">
          <p className="text-xs text-muted-foreground">Unresolved</p>
          <p className={cn('text-2xl font-bold', (summary?.unresolvedCount ?? 0) > 0 ? 'text-warning' : 'text-success')} data-testid="errors-unresolved">
            {summary?.unresolvedCount ?? 0}
          </p>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2">
        {(['unresolved', 'all', 'resolved'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => { setFilterResolved(tab); setCurrentPage(1); }}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              filterResolved === tab
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
            data-testid={`filter-${tab}`}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Error list */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg bg-foreground/5" />
          ))}
        </div>
      ) : !errors?.items?.length ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          No errors found
        </div>
      ) : (
        <div className="space-y-1">
          {errors.items.map((error) => (
            <div
              key={error.id}
              className="rounded-lg border border-border/30 hover:border-border/50"
              data-testid={`error-row-${error.id}`}
            >
              {/* Error header */}
              <div
                className="flex cursor-pointer items-center gap-3 p-3"
                onClick={() => setExpandedId(expandedId === error.id ? null : error.id)}
              >
                {expandedId === error.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <AlertTriangle size={14} className={cn(error.resolved ? 'text-muted-foreground' : 'text-destructive')} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-foreground/5 px-1.5 py-0.5 text-xs font-mono">
                      {error.errorType}
                    </span>
                    <span className="truncate text-sm">{error.message}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    {error.requestPath && <span>{error.requestPath}</span>}
                    <span className="flex items-center gap-1">
                      <Clock size={10} />
                      {formatTimeAgo(error.createdAt)}
                    </span>
                  </div>
                </div>
                {!error.resolved && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      resolveError.mutate(error.id);
                    }}
                    disabled={resolveError.isPending}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-success hover:bg-success/10 disabled:opacity-50"
                    data-testid={`resolve-${error.id}`}
                  >
                    <Check size={12} />
                    Resolve
                  </button>
                )}
                {error.resolved && (
                  <span className="rounded-full bg-success/10 px-2 py-0.5 text-xs text-success">
                    Resolved
                  </span>
                )}
              </div>

              {/* Expanded stack trace */}
              {expandedId === error.id && (
                <div className="border-t border-border/30 p-3" data-testid={`error-detail-${error.id}`}>
                  {error.stack && (
                    <div className="mb-3">
                      <p className="mb-1 text-xs font-medium text-muted-foreground">Stack Trace</p>
                      <pre className="max-h-48 overflow-auto rounded-md bg-black/20 p-2 text-xs font-mono leading-relaxed">
                        {error.stack}
                      </pre>
                    </div>
                  )}
                  {error.correlationId && (
                    <p className="text-xs text-muted-foreground">
                      Correlation ID: <span className="font-mono">{error.correlationId}</span>
                    </p>
                  )}
                  {Object.keys(error.context).length > 0 && (
                    <div className="mt-2">
                      <p className="mb-1 text-xs font-medium text-muted-foreground">Context</p>
                      <pre className="rounded-md bg-black/20 p-2 text-xs font-mono">
                        {JSON.stringify(error.context, null, 2)}
                      </pre>
                    </div>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground">
                    {new Date(error.createdAt).toLocaleString()}
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {errors && errors.total > 20 && (
        <div className="flex items-center justify-center gap-2 text-sm">
          <button
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage <= 1}
            className="rounded px-2 py-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
          >
            Prev
          </button>
          <span className="text-muted-foreground">
            Page {currentPage} of {Math.ceil(errors.total / 20)}
          </span>
          <button
            onClick={() => setCurrentPage((p) => p + 1)}
            disabled={currentPage >= Math.ceil(errors.total / 20)}
            className="rounded px-2 py-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
