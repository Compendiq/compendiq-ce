import { useState, useMemo, useCallback } from 'react';
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

function useComments(pageId: string) {
  return useQuery<Comment[]>({
    queryKey: ['comments', pageId],
    queryFn: () => apiFetch(`/pages/${pageId}/comments`),
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
      queryClient.invalidateQueries({ queryKey: ['comments', pageId] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to post comment'),
  });
}

function useResolveComment(pageId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ commentId, resolved }: { commentId: string; resolved: boolean }) =>
      apiFetch(`/pages/${pageId}/comments/${commentId}/resolve`, {
        method: 'PUT',
        body: JSON.stringify({ resolved }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['comments', pageId] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to update comment'),
  });
}

export function CommentsSidebar({ pageId, className }: CommentsSidebarProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showResolved, setShowResolved] = useState(false);

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
      replies: replyMap.get(tl.id) ?? [],
    }));
    return {
      unresolvedThreads: threads.filter((t) => !t.resolved),
      resolvedThreads: threads.filter((t) => t.resolved),
      totalCount: topLevel.length,
    };
  }, [comments]);

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
          'glass-card flex items-center gap-1.5 px-3 py-1.5 text-sm hover:bg-foreground/5 transition-colors',
          isOpen && 'bg-primary/10 text-primary',
        )}
        data-testid="comments-toggle"
        aria-label={isOpen ? 'Close comments' : 'Open comments'}
      >
        <MessageSquare size={16} />
        Comments
        {totalCount > 0 && (
          <span className="ml-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/20 px-1 text-[11px] font-medium text-primary">
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
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 300 }}
              className={cn(
                'fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-border/50 bg-card shadow-2xl',
                className,
              )}
              data-testid="comments-sidebar"
            >
              {/* Header */}
              <div className="flex shrink-0 items-center justify-between border-b border-border/50 px-4 py-3">
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
                  className="rounded-md p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground transition-colors"
                  aria-label="Close comments"
                  data-testid="comments-close"
                >
                  <X size={18} />
                </button>
              </div>

              {/* New comment form */}
              <div className="shrink-0 border-b border-border/50 px-4 py-3">
                <CommentForm
                  onSubmit={handleNewComment}
                  placeholder="Add a comment..."
                  isSubmitting={addComment.isPending}
                />
              </div>

              {/* Comments list */}
              <div className="flex-1 overflow-y-auto px-4 py-3">
                {isLoading ? (
                  <div className="space-y-3">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="glass-card h-24 animate-pulse" />
                    ))}
                  </div>
                ) : unresolvedThreads.length === 0 && resolvedThreads.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <MessageSquare size={32} className="mb-3 text-muted-foreground" />
                    <p className="text-sm font-medium">No comments yet</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Be the first to leave a comment
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
                        isSubmittingReply={addComment.isPending}
                      />
                    ))}

                    {/* Resolved threads toggle */}
                    {resolvedThreads.length > 0 && (
                      <div className="pt-2">
                        <button
                          onClick={() => setShowResolved((v) => !v)}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-foreground/5 transition-colors"
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
                                  isSubmittingReply={addComment.isPending}
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
