import { useState, useMemo, useCallback, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { m, AnimatePresence } from 'framer-motion';
import { MessageSquare, X, Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../lib/api';
import { CommentForm } from './CommentForm';
import { CommentThread, type Comment } from './CommentThread';
import { cn } from '../../lib/cn';

interface CommentsSidebarProps {
  pageId: string;
  className?: string;
}

interface RawCommentsResponse {
  comments?: Comment[];
  total?: number;
}

function useComments(pageId: string) {
  return useQuery<Comment[]>({
    queryKey: ['comments', pageId],
    queryFn: async () => {
      const res = await apiFetch<Comment[] | RawCommentsResponse>(`/pages/${pageId}/comments`);
      if (Array.isArray(res)) return res;
      if (res && Array.isArray(res.comments)) return res.comments;
      return [];
    },
    enabled: !!pageId,
  });
}

function useAddComment(pageId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { body: string; parentId?: string }) =>
      apiFetch<Comment>(`/pages/${pageId}/comments`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['comments', pageId] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to post comment'),
  });
}

function useResolveComment(pageId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ commentId, resolved }: { commentId: string; resolved: boolean }) => {
      const action = resolved ? 'resolve' : 'unresolve';
      try {
        return await apiFetch(`/comments/${commentId}/${action}`, {
          method: 'POST',
        });
      } catch {
        // Fallback for legacy route mocks
        return await apiFetch(`/pages/${pageId}/comments/${commentId}/resolve`, {
          method: 'PUT',
          body: JSON.stringify({ resolved }),
        });
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['comments', pageId] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to update comment'),
  });
}

export function CommentsSidebar({ pageId, className }: CommentsSidebarProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(null);

  const { data: comments, isLoading } = useComments(pageId);
  const addComment = useAddComment(pageId);
  const resolveComment = useResolveComment(pageId);

  const { unresolvedThreads, resolvedThreads, totalCount } = useMemo(() => {
    if (!comments) return { unresolvedThreads: [], resolvedThreads: [], totalCount: 0 };
    // Build threads: top-level comments with nested replies
    const topLevel = comments.filter((c) => !c.parentId);
    const replyMap = new Map<string, Comment[]>();
    for (const c of comments) {
      if (c.parentId) {
        const existing = replyMap.get(c.parentId) ?? [];
        existing.push(c);
        replyMap.set(c.parentId, existing);
      }
    }
    const threads = topLevel.map((tl) => ({
      ...tl,
      resolved: Boolean(tl.resolved ?? tl.isResolved),
      replies: (replyMap.get(tl.id) ?? []).map((r) => ({
        ...r,
        resolved: Boolean(r.resolved ?? r.isResolved),
      })),
    }));
    return {
      unresolvedThreads: threads.filter((t) => !t.resolved),
      resolvedThreads: threads.filter((t) => t.resolved),
      totalCount: topLevel.length,
    };
  }, [comments]);

  // Jump from comment thread card to inline mark in article editor/viewer
  const handleJumpToAnchor = useCallback((commentId: string) => {
    if (typeof document === 'undefined') return;
    const el = document.querySelector(`[data-comment-id="${commentId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('comment-flash');
      setTimeout(() => el.classList.remove('comment-flash'), 1500);
    }
  }, []);

  // Listen to global selection clicks on inline marks in editor/viewer
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleCommentSelect = (e: Event) => {
      const customEvent = e as CustomEvent<{ commentId: string }>;
      const targetId = customEvent.detail?.commentId;
      if (!targetId) return;

      setIsOpen(true);
      setSelectedCommentId(targetId);

      // Check if target comment is in resolved list, if so auto-expand resolved
      const isResolvedComment = resolvedThreads.some((t) => t.id === targetId);
      if (isResolvedComment) {
        setShowResolved(true);
      }

      setTimeout(() => {
        const card = document.querySelector(`[data-testid="comment-thread-${targetId}"]`);
        card?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 100);
    };

    window.addEventListener('compendiq:comment-select', handleCommentSelect);
    return () => window.removeEventListener('compendiq:comment-select', handleCommentSelect);
  }, [resolvedThreads]);

  const handleNewComment = useCallback(
    (body: string) => {
      addComment.mutate({ body });
    },
    [addComment],
  );

  const handleReply = useCallback(
    (parentId: string, body: string) => {
      addComment.mutate({ body, parentId });
    },
    [addComment],
  );

  const handleResolve = useCallback(
    (commentId: string) => {
      resolveComment.mutate({ commentId, resolved: true });
    },
    [resolveComment],
  );

  const handleUnresolve = useCallback(
    (commentId: string) => {
      resolveComment.mutate({ commentId, resolved: false });
    },
    [resolveComment],
  );

  return (
    <>
      {/* Toggle button */}
      <button
        onClick={() => setIsOpen((v) => !v)}
        className={cn(
          'nm-card flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors',
          isOpen ? 'nm-pill-active text-action' : 'nm-card-hover',
        )}
        data-testid="comments-toggle"
        aria-label={isOpen ? 'Close comments' : 'Open comments'}
      >
        <MessageSquare size={16} />
        Comments
        {totalCount > 0 && (
          <span className="ml-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-action/20 px-1 text-[11px] font-medium text-action">
            {totalCount}
          </span>
        )}
      </button>

      {/* Slide-out panel */}
      <AnimatePresence>
        {isOpen && (
          <>
            {/* Backdrop (mobile) */}
            <m.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsOpen(false)}
              className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm lg:hidden"
            />

            {/* Panel */}
            <m.aside
              initial={{ x: '100%', opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: '100%', opacity: 0 }}
              transition={{ type: 'spring', damping: 30, stiffness: 300 }}
              className={cn(
                'fixed right-2 top-2 bottom-2 z-50 flex w-full max-w-md flex-col nm-sidebar shadow-[var(--shadow-overlay)]',
                className,
              )}
              data-testid="comments-sidebar"
            >
              {/* Header */}
              <div className="flex shrink-0 items-center justify-between px-4 py-3">
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                  <MessageSquare size={16} />
                  Comments
                  {totalCount > 0 && (
                    <span className="text-xs font-normal text-muted-foreground">
                      ({totalCount})
                    </span>
                  )}
                </h2>
                <button
                  onClick={() => setIsOpen(false)}
                  className="rounded-lg p-1 text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground transition-colors"
                  aria-label="Close comments"
                  data-testid="comments-close"
                >
                  <X size={18} />
                </button>
              </div>

              {/* Divider */}
              <div className="mx-4 h-px bg-[var(--glass-sidebar-divider)]" />

              {/* New comment form */}
              <div className="shrink-0 px-4 py-3">
                <CommentForm
                  onSubmit={handleNewComment}
                  placeholder="Add a comment..."
                  isSubmitting={addComment.isPending}
                />
              </div>

              {/* Divider */}
              <div className="mx-4 h-px bg-[var(--glass-sidebar-divider)]" />

              {/* Comments list */}
              <div className="flex-1 overflow-y-auto px-4 py-3 scroll-mask">
                {isLoading ? (
                  <div className="space-y-3">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="nm-card h-24 animate-pulse" />
                    ))}
                  </div>
                ) : unresolvedThreads.length === 0 && resolvedThreads.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <MessageSquare size={32} className="mb-3 text-muted-foreground" />
                    <p className="text-sm font-medium">No comments yet</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Be the first to leave a comment or note
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {/* Unresolved threads */}
                    {unresolvedThreads.map((thread) => (
                      <CommentThread
                        key={thread.id}
                        comment={thread}
                        onReply={handleReply}
                        onResolve={handleResolve}
                        onUnresolve={handleUnresolve}
                        onJumpToAnchor={handleJumpToAnchor}
                        isSubmittingReply={addComment.isPending}
                        isSelected={selectedCommentId === thread.id}
                      />
                    ))}

                    {/* Resolved threads toggle */}
                    {resolvedThreads.length > 0 && (
                      <div className="pt-2">
                        <button
                          onClick={() => setShowResolved((v) => !v)}
                          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-[var(--glass-pill-hover)] transition-colors"
                          data-testid="show-resolved-toggle"
                        >
                          {showResolved ? <EyeOff size={12} /> : <Eye size={12} />}
                          {showResolved ? 'Hide' : 'Show'} {resolvedThreads.length} resolved{' '}
                          {resolvedThreads.length === 1 ? 'thread' : 'threads'}
                        </button>
                        <AnimatePresence>
                          {showResolved && (
                            <m.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              className="mt-2 space-y-3 overflow-hidden"
                            >
                              {resolvedThreads.map((thread) => (
                                <CommentThread
                                  key={thread.id}
                                  comment={thread}
                                  onReply={handleReply}
                                  onResolve={handleResolve}
                                  onUnresolve={handleUnresolve}
                                  onJumpToAnchor={handleJumpToAnchor}
                                  isSubmittingReply={addComment.isPending}
                                  isSelected={selectedCommentId === thread.id}
                                />
                              ))}
                            </m.div>
                          )}
                        </AnimatePresence>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </m.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
