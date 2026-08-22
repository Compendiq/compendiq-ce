import { useState, useMemo, useCallback, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Plus, Loader2, AlertCircle, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../lib/api';
import { CommentForm } from './CommentForm';
import { CommentThread, type Comment } from './CommentThread';
import { cn } from '../../lib/cn';

export interface NotesInspectorPanelProps {
  pageId: string | undefined | null;
  className?: string;
  onJumpToAnchor?: (commentId: string) => void;
}

interface RawCommentsResponse {
  comments?: Comment[];
  total?: number;
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePageNotes(pageId: string | undefined | null) {
  return useQuery<Comment[]>({
    queryKey: ['comments', pageId],
    queryFn: async () => {
      if (!pageId) return [];
      const res = await apiFetch<Comment[] | RawCommentsResponse>(
        `/pages/${encodeURIComponent(pageId)}/comments?includeResolved=true`,
      );
      if (Array.isArray(res)) return res;
      if (res && Array.isArray(res.comments)) return res.comments;
      return [];
    },
    enabled: !!pageId,
  });
}

function useAddNote(pageId: string | undefined | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { body: string; parentId?: string }) => {
      if (!pageId) throw new Error('Cannot add notes to an unsaved page.');
      return apiFetch<Comment>(`/pages/${encodeURIComponent(pageId)}/comments`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      if (pageId) {
        void queryClient.invalidateQueries({ queryKey: ['comments', pageId] });
      }
      toast.success('Note added');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to post note'),
  });
}

function useResolveNote(pageId: string | undefined | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ commentId, resolved }: { commentId: string; resolved: boolean }) => {
      const action = resolved ? 'resolve' : 'unresolve';
      try {
        return await apiFetch(`/comments/${encodeURIComponent(commentId)}/${action}`, {
          method: 'POST',
        });
      } catch {
        if (pageId) {
          return await apiFetch(`/pages/${encodeURIComponent(pageId)}/comments/${encodeURIComponent(commentId)}/resolve`, {
            method: 'PUT',
            body: JSON.stringify({ resolved }),
          });
        }
      }
    },
    onSuccess: () => {
      if (pageId) {
        void queryClient.invalidateQueries({ queryKey: ['comments', pageId] });
      }
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to update note'),
  });
}

export function NotesInspectorPanel({
  pageId,
  className,
  onJumpToAnchor,
}: NotesInspectorPanelProps) {
  const [filter, setFilter] = useState<'open' | 'resolved'>('open');
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(null);
  const [showNewNoteForm, setShowNewNoteForm] = useState(false);

  const { data: comments, isLoading, isError, error, refetch } = usePageNotes(pageId);
  const addNote = useAddNote(pageId);
  const resolveNote = useResolveNote(pageId);

  const { unresolvedThreads, resolvedThreads } = useMemo(() => {
    if (!comments) return { unresolvedThreads: [], resolvedThreads: [] };
    const topLevel = comments.filter((c) => !c.parentId);
    const replyMap = new Map<string, Comment[]>();
    for (const c of comments) {
      if (c.parentId) {
        const existing = replyMap.get(String(c.parentId)) ?? [];
        existing.push(c);
        replyMap.set(String(c.parentId), existing);
      }
    }
    const threads = topLevel.map((tl) => ({
      ...tl,
      resolved: Boolean(tl.resolved ?? tl.isResolved),
      replies: (replyMap.get(String(tl.id)) ?? []).map((r) => ({
        ...r,
        resolved: Boolean(r.resolved ?? r.isResolved),
      })),
    }));
    return {
      unresolvedThreads: threads.filter((t) => !t.resolved),
      resolvedThreads: threads.filter((t) => t.resolved),
    };
  }, [comments]);

  const defaultJumpToAnchor = useCallback((commentId: string) => {
    if (typeof document === 'undefined') return;
    const el = document.querySelector(`[data-comment-id="${commentId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('comment-flash');
      setTimeout(() => el.classList.remove('comment-flash'), 1500);
    }
  }, []);

  const jump = onJumpToAnchor ?? defaultJumpToAnchor;

  // Listen to select events to highlight cards
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleSelect = (e: Event) => {
      const customEvent = e as CustomEvent<{ commentId: string }>;
      const targetId = customEvent.detail?.commentId;
      if (!targetId) return;
      setSelectedCommentId(targetId);

      const isResolved = resolvedThreads.some((t) => String(t.id) === String(targetId));
      if (isResolved) {
        setFilter('resolved');
      } else {
        setFilter('open');
      }

      setTimeout(() => {
        const card = document.querySelector(`[data-testid="comment-thread-${targetId}"]`);
        card?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 100);
    };

    window.addEventListener('compendiq:comment-select', handleSelect);
    window.addEventListener('compendiq:comment-open-sidebar', handleSelect);
    return () => {
      window.removeEventListener('compendiq:comment-select', handleSelect);
      window.removeEventListener('compendiq:comment-open-sidebar', handleSelect);
    };
  }, [resolvedThreads]);

  const handleNewNoteSubmit = useCallback(
    async (body: string) => {
      await addNote.mutateAsync({ body });
      setShowNewNoteForm(false);
    },
    [addNote],
  );

  const handleReply = useCallback(
    async (parentId: string, body: string) => {
      await addNote.mutateAsync({ body, parentId });
    },
    [addNote],
  );

  const handleResolve = useCallback(
    (commentId: string) => {
      resolveNote.mutate({ commentId, resolved: true });
    },
    [resolveNote],
  );

  const handleUnresolve = useCallback(
    (commentId: string) => {
      resolveNote.mutate({ commentId, resolved: false });
    },
    [resolveNote],
  );

  if (!pageId) {
    return (
      <div
        className={cn('flex min-h-0 flex-1 flex-col items-center justify-center p-6 text-center text-xs text-muted-foreground', className)}
        data-testid="notes-inspector-panel"
      >
        <MessageSquare size={28} className="text-muted-foreground/30 mb-2" />
        <p className="font-medium text-foreground/80 mb-1">Notes are available on saved pages</p>
        <p className="text-[11px] leading-relaxed">
          Save this page to create notes and collaborate with your team.
        </p>
      </div>
    );
  }

  const displayedThreads = filter === 'open' ? unresolvedThreads : resolvedThreads;

  return (
    <div
      className={cn('flex min-h-0 flex-1 flex-col overflow-hidden bg-card text-card-foreground', className)}
      data-testid="notes-inspector-panel"
    >
      {/* Header with Filters and Add Note button */}
      <div className="border-b border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <div role="tablist" aria-label="Filter notes by status" className="flex items-center gap-1 rounded-md bg-muted p-0.5 text-xs">
            <button
              type="button"
              role="tab"
              id="notes-tab-open"
              aria-selected={filter === 'open'}
              aria-controls="notes-threads-list"
              tabIndex={filter === 'open' ? 0 : -1}
              onClick={() => setFilter('open')}
              className={cn(
                'inline-flex h-7 items-center justify-center rounded px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                filter === 'open'
                  ? 'bg-card text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              data-testid="notes-filter-open"
            >
              Open ({unresolvedThreads.length})
            </button>
            <button
              type="button"
              role="tab"
              id="notes-tab-resolved"
              aria-selected={filter === 'resolved'}
              aria-controls="notes-threads-list"
              tabIndex={filter === 'resolved' ? 0 : -1}
              onClick={() => setFilter('resolved')}
              className={cn(
                'inline-flex h-7 items-center justify-center rounded px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                filter === 'resolved'
                  ? 'bg-card text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              data-testid="notes-filter-resolved"
            >
              Resolved ({resolvedThreads.length})
            </button>
          </div>

          <button
            type="button"
            onClick={() => setShowNewNoteForm((v) => !v)}
            aria-expanded={showNewNoteForm}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border-interactive bg-background px-2.5 text-xs font-medium text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="add-page-note-btn"
          >
            <Plus size={14} />
            <span>New note</span>
          </button>
        </div>

        {/* New Note Form */}
        {showNewNoteForm && (
          <div className="mt-3 rounded-lg border border-border bg-card p-2.5 shadow-xs">
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Add Page Note</div>
            <CommentForm
              onSubmit={handleNewNoteSubmit}
              onCancel={() => setShowNewNoteForm(false)}
              isSubmitting={addNote.isPending}
              autoFocus
              placeholder="Write a note about this page… (⌘Enter to post)"
            />
          </div>
        )}
      </div>

      {/* Threads List */}
      <div
        id="notes-threads-list"
        role="region"
        aria-label={filter === 'open' ? 'Open notes list' : 'Resolved notes list'}
        className="flex-1 overflow-y-auto p-3 space-y-3"
      >
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-12 text-xs text-muted-foreground">
            <Loader2 size={20} className="animate-spin text-primary mb-2" />
            <span>Loading notes…</span>
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center justify-center py-12 text-center text-xs text-muted-foreground px-4" role="alert">
            <AlertCircle size={24} className="text-destructive mb-2 opacity-80" />
            <p className="font-medium text-foreground mb-1">Failed to load notes</p>
            <p className="text-[11px] leading-relaxed mb-3">
              {error instanceof Error ? error.message : 'An error occurred while fetching page notes.'}
            </p>
            <button
              type="button"
              onClick={() => void refetch()}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <RotateCcw size={12} />
              <span>Retry</span>
            </button>
          </div>
        ) : displayedThreads.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center text-xs text-muted-foreground px-4">
            <MessageSquare size={28} className="text-muted-foreground/30 mb-2" />
            <p className="font-medium text-foreground/80 mb-1">
              {filter === 'open' ? 'No open notes' : 'No resolved notes'}
            </p>
            <p className="text-[11px] leading-relaxed">
              {filter === 'open'
                ? 'Highlight text in the editor to add an inline note, or click "New note" above.'
                : 'Resolved note threads will appear here.'}
            </p>
          </div>
        ) : (
          displayedThreads.map((thread) => (
            <CommentThread
              key={thread.id}
              comment={thread}
              onReply={handleReply}
              onResolve={handleResolve}
              onUnresolve={handleUnresolve}
              onJumpToAnchor={jump}
              isSubmittingReply={addNote.isPending}
              isSelected={String(thread.id) === String(selectedCommentId)}
            />
          ))
        )}
      </div>
    </div>
  );
}
