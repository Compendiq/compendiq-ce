import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useMutation, useQueryClient, QueryClient } from '@tanstack/react-query';
import {
  Check,
  RotateCcw,
  Trash2,
  X,
  Quote,
  ExternalLink,
  Loader2,
  CornerDownRight,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../lib/api';
import { cn } from '../../lib/cn';
import type { Editor as EditorType } from '@tiptap/react';
import type { Comment } from './CommentThread';
import { formatRelativeTime } from './CommentThread';
import { getDraftNote } from './draft-notes-store';

export interface CommentPopoverProps {
  pageId?: string | null;
  editor?: EditorType | null;
  className?: string;
}

interface RawCommentsResponse {
  comments?: Comment[];
  total?: number;
}

interface AnchorRect {
  top: number;
  left: number;
  width: number;
  height: number;
  bottom: number;
  right: number;
}

const fallbackQueryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, gcTime: 0 },
  },
});

function usePageComments(pageId: string | undefined | null, queryClient: QueryClient | undefined) {
  return useQuery<Comment[]>(
    {
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
      enabled: Boolean(pageId && queryClient),
    },
    queryClient ?? fallbackQueryClient,
  );
}

function useAddReply(pageId: string | undefined | null, queryClient: QueryClient | undefined) {
  return useMutation(
    {
      mutationFn: async ({ parentId, body }: { parentId: string; body: string }) => {
        if (!pageId) throw new Error('Cannot reply to a draft note.');
        return await apiFetch<Comment>(`/pages/${encodeURIComponent(pageId)}/comments`, {
          method: 'POST',
          body: JSON.stringify({ body, parentId: Number(parentId) || parentId }),
        });
      },
      onSuccess: () => {
        if (pageId && queryClient) {
          void queryClient.invalidateQueries({ queryKey: ['comments', pageId] });
        }
        toast.success('Reply added');
      },
      onError: (err) => {
        toast.error(err instanceof Error ? err.message : 'Failed to post reply');
      },
    },
    queryClient ?? fallbackQueryClient,
  );
}

function useToggleResolveComment(pageId: string | undefined | null, queryClient: QueryClient | undefined) {
  return useMutation(
    {
      mutationFn: async ({ commentId, resolved }: { commentId: string; resolved: boolean }) => {
        const action = resolved ? 'resolve' : 'unresolve';
        try {
          return await apiFetch(`/comments/${encodeURIComponent(commentId)}/${action}`, {
            method: 'POST',
          });
        } catch {
          if (pageId) {
            return await apiFetch(
              `/pages/${encodeURIComponent(pageId)}/comments/${encodeURIComponent(commentId)}/resolve`,
              {
                method: 'PUT',
                body: JSON.stringify({ resolved }),
              },
            );
          }
        }
      },
      onSuccess: () => {
        if (pageId && queryClient) {
          void queryClient.invalidateQueries({ queryKey: ['comments', pageId] });
        }
      },
      onError: (err) => {
        toast.error(err instanceof Error ? err.message : 'Failed to update note');
      },
    },
    queryClient ?? fallbackQueryClient,
  );
}

/**
 * Inline floating popover for viewing, replying, resolving, or removing notes
 * directly where they are highlighted in the document.
 */
export function CommentPopover({ pageId, editor, className }: CommentPopoverProps) {
  const [open, setOpen] = useState(false);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [anchorRect, setAnchorRect] = useState<AnchorRect | null>(null);
  const [showReplyForm, setShowReplyForm] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [showRepliesList, setShowRepliesList] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  let queryClient: QueryClient | undefined;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    queryClient = useQueryClient();
  } catch {
    queryClient = undefined;
  }

  const { data: comments, isLoading } = usePageComments(pageId, queryClient);
  const addReply = useAddReply(pageId, queryClient);
  const toggleResolve = useToggleResolveComment(pageId, queryClient);

  // Match the active comment from query data
  const { activeComment, replies } = useMemo(() => {
    if (!activeCommentId || !comments) return { activeComment: null, replies: [] };
    const comment = comments.find((c) => String(c.id) === String(activeCommentId)) ?? null;
    const commentReplies = comments.filter((c) => String(c.parentId) === String(activeCommentId));
    return { activeComment: comment, replies: commentReplies };
  }, [activeCommentId, comments]);

  const openForElement = useCallback((targetId: string, element: HTMLElement | null, fallbackRect?: Partial<AnchorRect>) => {
    let rect: AnchorRect | null = null;
    if (element) {
      const domRect = element.getBoundingClientRect();
      rect = {
        top: domRect.top,
        left: domRect.left,
        bottom: domRect.bottom,
        right: domRect.right,
        width: domRect.width,
        height: domRect.height,
      };
    } else if (fallbackRect && fallbackRect.top != null && fallbackRect.left != null) {
      rect = {
        top: fallbackRect.top,
        left: fallbackRect.left,
        bottom: fallbackRect.bottom ?? (fallbackRect.top + (fallbackRect.height ?? 20)),
        right: fallbackRect.right ?? (fallbackRect.left + (fallbackRect.width ?? 50)),
        width: fallbackRect.width ?? 50,
        height: fallbackRect.height ?? 20,
      };
    } else if (typeof document !== 'undefined') {
      const el = document.querySelector(`[data-comment-id="${targetId}"]`) as HTMLElement | null;
      if (el) {
        const domRect = el.getBoundingClientRect();
        rect = {
          top: domRect.top,
          left: domRect.left,
          bottom: domRect.bottom,
          right: domRect.right,
          width: domRect.width,
          height: domRect.height,
        };
      }
    }

    if (rect) {
      setAnchorRect(rect);
    }
    setActiveCommentId(targetId);
    setShowReplyForm(false);
    setReplyText('');
    setOpen(true);
  }, []);

  // Listen to selection events dispatched by clicking marked text
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleSelect = (e: Event) => {
      const customEvent = e as CustomEvent<{
        commentId: string;
        targetElement?: HTMLElement | null;
        rect?: Partial<AnchorRect>;
      }>;
      const targetId = customEvent.detail?.commentId;
      if (!targetId) return;
      openForElement(targetId, customEvent.detail?.targetElement ?? null, customEvent.detail?.rect);
    };

    // Native document click handler fallback to catch clicks on any [data-comment-id]
    const handleDocumentClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const commentEl = target?.closest('[data-comment-id]') as HTMLElement | null;
      if (!commentEl) return;
      const commentId = commentEl.getAttribute('data-comment-id');
      if (commentId) {
        openForElement(commentId, commentEl);
      }
    };

    window.addEventListener('compendiq:comment-select', handleSelect);
    document.addEventListener('click', handleDocumentClick, true);
    return () => {
      window.removeEventListener('compendiq:comment-select', handleSelect);
      document.removeEventListener('click', handleDocumentClick, true);
    };
  }, [openForElement]);

  // Click outside to dismiss popover
  useEffect(() => {
    if (!open) return;
    const handleOutside = (e: MouseEvent | TouchEvent) => {
      const target = e.target as HTMLElement | null;
      if (popoverRef.current && popoverRef.current.contains(target)) return;
      if (target?.closest('[data-comment-id]')) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('touchstart', handleOutside);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('touchstart', handleOutside);
    };
  }, [open]);

  // Escape key to dismiss
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  const isDraftNote = Boolean(activeCommentId && (activeCommentId.startsWith('local-') || !pageId));
  const draftNote = isDraftNote && activeCommentId ? getDraftNote(activeCommentId) : undefined;
  const effectiveComment =
    activeComment ??
    (draftNote
      ? ({
          id: draftNote.id,
          body: draftNote.body,
          authorName: draftNote.authorName ?? 'You (Draft)',
          createdAt: draftNote.createdAt,
          anchorData: draftNote.anchorData,
          resolved: draftNote.resolved,
        } as Comment)
      : undefined);

  const isResolved = Boolean(effectiveComment?.resolved ?? effectiveComment?.isResolved);
  const author = effectiveComment?.authorName ?? effectiveComment?.username ?? 'Note';

  const handleReplySubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!activeCommentId || !replyText.trim() || addReply.isPending) return;
      try {
        await addReply.mutateAsync({ parentId: activeCommentId, body: replyText.trim() });
        setReplyText('');
        setShowReplyForm(false);
      } catch {
        // error handled by mutation
      }
    },
    [activeCommentId, replyText, addReply],
  );

  const handleToggleResolve = useCallback(async () => {
    if (!activeCommentId) return;
    const nextResolved = !isResolved;
    try {
      if (!isDraftNote) {
        await toggleResolve.mutateAsync({ commentId: activeCommentId, resolved: nextResolved });
      }
      // Update TipTap mark if editor instance is present
      if (editor && !editor.isDestroyed) {
        editor.commands.resolveCommentMark({ commentId: activeCommentId, resolved: nextResolved });
      }
      toast.success(nextResolved ? 'Note marked resolved' : 'Note marked unresolved');
    } catch {
      // error handled by mutation
    }
  }, [activeCommentId, isResolved, isDraftNote, toggleResolve, editor]);

  const handleRemoveHighlight = useCallback(() => {
    if (activeCommentId && editor && !editor.isDestroyed) {
      editor.commands.unsetCommentMark({ commentId: activeCommentId });
      toast.success('Note highlight removed');
    }
    setOpen(false);
  }, [activeCommentId, editor]);

  const handleOpenInSidebar = useCallback(() => {
    if (typeof window !== 'undefined' && activeCommentId) {
      window.dispatchEvent(
        new CustomEvent('compendiq:comment-open-sidebar', {
          detail: { commentId: activeCommentId },
        }),
      );
    }
    setOpen(false);
  }, [activeCommentId]);

  if (!open || !anchorRect || typeof document === 'undefined') return null;

  // Viewport-bounded coordinate calculation
  const popoverWidth = 336;
  const maxLeft = typeof window !== 'undefined' ? window.innerWidth - popoverWidth - 16 : 400;
  const left = Math.max(16, Math.min(maxLeft, anchorRect.left));
  const top = anchorRect.bottom + 8;

  const content = (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Note details"
      data-testid="comment-popover-content"
      style={{
        position: 'fixed',
        top: `${Math.max(12, top)}px`,
        left: `${left}px`,
      }}
      className={cn(
        'z-50 w-84 max-w-[calc(100vw-24px)] rounded-lg border border-border bg-card p-3 text-card-foreground nm-card-elevated',
        'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 duration-100',
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-action text-xs font-semibold text-action-foreground">
            {author.charAt(0).toUpperCase()}
          </div>
          <span className="truncate text-xs font-semibold text-foreground">{author}</span>
          {activeComment?.createdAt && (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {formatRelativeTime(activeComment.createdAt)}
            </span>
          )}
          {isResolved && (
            <span
              data-testid="popover-resolved-badge"
              className="rounded-full bg-success/15 px-1.5 py-0.5 text-[11px] font-medium text-success"
            >
              Resolved
            </span>
          )}
          {isDraftNote && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              Draft
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close note popover"
          data-testid="popover-close-btn"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      {/* Loading state */}
      {isLoading && !activeComment && !isDraftNote ? (
        <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
          <Loader2 size={14} className="animate-spin text-primary" />
          <span>Loading note…</span>
        </div>
      ) : null}

      {/* Quoted highlight snippet */}
      {effectiveComment?.anchorData?.quote && (
        <div
          className="mt-2 flex items-start gap-1 rounded border-l-2 border-primary/70 bg-muted/40 px-2 py-1 text-xs italic text-muted-foreground"
          data-testid="popover-comment-quote"
        >
          <Quote size={11} className="mt-0.5 shrink-0 opacity-70" />
          <span className="line-clamp-2">&ldquo;{effectiveComment.anchorData.quote}&rdquo;</span>
        </div>
      )}

      {/* Note content */}
      <div className="py-2.5">
        {effectiveComment ? (
          <div>
            <p
              className="text-xs text-foreground/90 whitespace-pre-wrap leading-relaxed"
              data-testid="popover-comment-body"
            >
              {effectiveComment.body}
            </p>
            {isDraftNote && (
              <span className="mt-1 inline-block text-[11px] text-muted-foreground font-mono">
                (Unsaved draft note)
              </span>
            )}
          </div>
        ) : isDraftNote ? (
          <p className="text-xs text-muted-foreground italic">
            Local draft note. Will sync to the server when you save the page.
          </p>
        ) : (
          !isLoading && (
            <p className="text-xs text-muted-foreground italic">
              Note details unavailable or removed.
            </p>
          )
        )}
      </div>

      {/* Existing replies */}
      {replies.length > 0 && (
        <div className="space-y-2 border-t border-border/50 pt-2 mb-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-muted-foreground">
              Replies ({replies.length})
            </span>
            <button
              type="button"
              onClick={() => setShowRepliesList((v) => !v)}
              className="text-[11px] text-primary hover:underline"
            >
              {showRepliesList ? 'Hide' : 'Show'}
            </button>
          </div>

          {showRepliesList &&
            replies.map((reply) => {
              const replyAuthor = reply.authorName ?? reply.username ?? 'Anonymous';
              return (
                <div
                  key={reply.id}
                  className="rounded bg-muted/30 p-2 text-xs"
                  data-testid={`popover-reply-${reply.id}`}
                >
                  <div className="flex items-center justify-between gap-1 text-[11px] text-muted-foreground mb-1">
                    <span className="font-medium text-foreground">{replyAuthor}</span>
                    <span>{formatRelativeTime(reply.createdAt)}</span>
                  </div>
                  <p className="text-foreground/90 whitespace-pre-wrap">{reply.body}</p>
                </div>
              );
            })}
        </div>
      )}

      {/* Inline reply form */}
      {showReplyForm && (
        <form onSubmit={handleReplySubmit} className="border-t border-border/50 pt-2 mb-2">
          <textarea
            ref={textareaRef}
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void handleReplySubmit();
              } else if (e.key === 'Escape') {
                setShowReplyForm(false);
              }
              e.stopPropagation();
            }}
            placeholder="Write a reply… (Cmd+Enter to send)"
            rows={2}
            className="w-full rounded border border-border bg-background p-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            autoFocus
            data-testid="popover-reply-input"
          />
          <div className="mt-1.5 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setShowReplyForm(false)}
              className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!replyText.trim() || addReply.isPending}
              className="rounded bg-action px-2.5 py-1 text-xs font-medium text-action-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
              data-testid="popover-reply-submit-btn"
            >
              {addReply.isPending ? 'Sending…' : 'Reply'}
            </button>
          </div>
        </form>
      )}

      {/* Action buttons footer */}
      <div className="flex flex-wrap items-center justify-between gap-1 border-t border-border/60 pt-2 text-xs">
        <div className="flex items-center gap-1">
          {!showReplyForm && !isDraftNote && (
            <button
              type="button"
              onClick={() => {
                setShowReplyForm(true);
                setTimeout(() => textareaRef.current?.focus(), 50);
              }}
              className="flex items-center gap-1 rounded px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              data-testid="popover-reply-toggle-btn"
            >
              <CornerDownRight size={12} />
              <span>Reply</span>
            </button>
          )}

          {activeComment && (
            <button
              type="button"
              onClick={handleToggleResolve}
              disabled={toggleResolve.isPending}
              className={cn(
                'flex items-center gap-1 rounded px-2 py-1 transition-colors',
                isResolved
                  ? 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  : 'text-success hover:bg-success/10',
              )}
              data-testid="popover-resolve-btn"
            >
              {isResolved ? (
                <>
                  <RotateCcw size={12} />
                  <span>Unresolve</span>
                </>
              ) : (
                <>
                  <Check size={12} />
                  <span>Resolve</span>
                </>
              )}
            </button>
          )}
        </div>

        <div className="flex items-center gap-1">
          {/* In editor mode: Remove highlight / Unmark */}
          {editor && (
            <button
              type="button"
              onClick={handleRemoveHighlight}
              className="flex items-center gap-1 rounded px-2 py-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
              title="Remove note highlight from document"
              data-testid="popover-remove-highlight-btn"
            >
              <Trash2 size={12} />
              <span>Remove mark</span>
            </button>
          )}

          {/* View in inspector panel */}
          {pageId && (
            <button
              type="button"
              onClick={handleOpenInSidebar}
              className="flex items-center gap-1 rounded px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              title="Open page notes inspector"
              data-testid="popover-open-sidebar-btn"
            >
              <ExternalLink size={12} />
              <span>All notes</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
