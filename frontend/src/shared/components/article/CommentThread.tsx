import { useState } from 'react';
import { m, AnimatePresence, useReducedMotion } from 'framer-motion';
import { MessageSquare, Check, RotateCcw, ChevronDown, ChevronUp, Quote } from 'lucide-react';
import { CommentForm } from './CommentForm';
import { cn } from '../../lib/cn';

export interface CommentAnchorData {
  text?: string;
  quote?: string;
  from?: number;
  to?: number;
  commentId?: string;
  [key: string]: unknown;
}

export interface Comment {
  id: string;
  authorName?: string;
  username?: string;
  body: string;
  bodyHtml?: string;
  createdAt: string;
  resolved?: boolean;
  isResolved?: boolean;
  parentId?: string | null;
  anchorType?: 'selection' | 'block' | null;
  anchorData?: CommentAnchorData | null;
  reactions?: Record<string, string[]>;
  replies?: Comment[];
}

interface CommentThreadProps {
  comment: Comment;
  onReply: (parentId: string, body: string) => void | Promise<void>;
  onResolve: (commentId: string) => void;
  onUnresolve: (commentId: string) => void;
  onJumpToAnchor?: (commentId: string) => void;
  isSubmittingReply?: boolean;
  isSelected?: boolean;
}

// eslint-disable-next-line react-refresh/only-export-components
export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

export function CommentThread({
  comment,
  onReply,
  onResolve,
  onUnresolve,
  onJumpToAnchor,
  isSubmittingReply = false,
  isSelected = false,
}: CommentThreadProps) {
  const isResolved = Boolean(comment.resolved ?? comment.isResolved);
  const [showReplies, setShowReplies] = useState(!isResolved);
  const [showReplyForm, setShowReplyForm] = useState(false);
  const replies = comment.replies ?? [];
  const author = comment.authorName ?? comment.username ?? 'Anonymous';
  const reduceEffects = useReducedMotion();

  const handleReply = async (body: string) => {
    try {
      const res = onReply(comment.id, body);
      if (res instanceof Promise) {
        await res;
      }
      setShowReplyForm(false);
    } catch {
      // Keep reply form open on error
    }
  };

  const actionBtnClass =
    'inline-flex h-7 items-center gap-1.5 rounded px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <m.div
      initial={reduceEffects ? { opacity: 0 } : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceEffects ? 0.05 : 0.15 }}
      className={cn(
        'rounded-lg border border-border bg-card p-3 text-card-foreground transition-colors',
        isResolved && 'border-border/60 bg-muted/20',
        isSelected && 'ring-2 ring-ring border-primary/50 bg-accent/30',
      )}
      data-testid={`comment-thread-${comment.id}`}
    >
      {/* Top-level comment */}
      <div className="flex items-start gap-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-foreground border border-border/50">
          {author.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{author}</span>
            <span className="text-[11px] text-muted-foreground">
              {formatRelativeTime(comment.createdAt)}
            </span>
            {isResolved && (
              <span className="rounded-full bg-muted border border-border/60 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                Resolved
              </span>
            )}
          </div>

          {/* Quoted selection snippet for inline comments */}
          {comment.anchorData?.quote && (
            <button
              type="button"
              onClick={() => onJumpToAnchor?.(comment.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onJumpToAnchor?.(comment.id);
                }
              }}
              className="my-1.5 flex w-full text-left cursor-pointer items-start gap-1.5 rounded border-l-2 border-border-interactive bg-muted/50 px-2 py-1 text-xs italic text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              title="Click to jump to highlighted text in article"
              aria-label={`Jump to highlighted text in article: "${comment.anchorData.quote}"`}
              data-testid={`comment-quote-${comment.id}`}
            >
              <Quote size={11} className="mt-0.5 shrink-0 opacity-70" />
              <span className="line-clamp-2">&ldquo;{comment.anchorData.quote}&rdquo;</span>
            </button>
          )}

          <p className={cn("mt-1 text-sm whitespace-pre-wrap break-words", isResolved ? "text-muted-foreground" : "text-foreground")}>{comment.body}</p>

          {/* Actions */}
          <div className="mt-2 flex items-center gap-1">
            <button
              type="button"
              onClick={() => setShowReplyForm((v) => !v)}
              aria-expanded={showReplyForm}
              aria-label={`Reply to note by ${author}`}
              className={actionBtnClass}
              data-testid={`reply-toggle-${comment.id}`}
            >
              <MessageSquare size={13} />
              <span>Reply</span>
            </button>
            {isResolved ? (
              <button
                type="button"
                onClick={() => onUnresolve(comment.id)}
                aria-label="Mark note as open"
                className={actionBtnClass}
                data-testid={`unresolve-${comment.id}`}
              >
                <RotateCcw size={13} />
                <span>Unresolve</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onResolve(comment.id)}
                aria-label="Mark note as resolved"
                className={actionBtnClass}
                data-testid={`resolve-${comment.id}`}
              >
                <Check size={13} />
                <span>Resolve</span>
              </button>
            )}
            {replies.length > 0 && (
              <button
                type="button"
                onClick={() => setShowReplies((v) => !v)}
                aria-expanded={showReplies}
                aria-label={`${showReplies ? 'Hide' : 'Show'} ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`}
                className={actionBtnClass}
                data-testid={`toggle-replies-${comment.id}`}
              >
                {showReplies ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                <span>{replies.length} {replies.length === 1 ? 'reply' : 'replies'}</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Reply form */}
      <AnimatePresence>
        {showReplyForm && (
          <m.div
            initial={reduceEffects ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduceEffects ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: reduceEffects ? 0.05 : 0.15 }}
            className="mt-3 overflow-hidden pl-9"
          >
            <CommentForm
              onSubmit={handleReply}
              onCancel={() => setShowReplyForm(false)}
              placeholder="Write a reply..."
              isSubmitting={isSubmittingReply}
              autoFocus
            />
          </m.div>
        )}
      </AnimatePresence>

      {/* Replies */}
      <AnimatePresence>
        {showReplies && replies.length > 0 && (
          <m.div
            initial={reduceEffects ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduceEffects ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: reduceEffects ? 0.05 : 0.15 }}
            className="mt-3 space-y-2 overflow-hidden border-l-2 border-border pl-4 ml-3"
          >
            {replies.map((reply) => {
              const replyAuthor = reply.authorName ?? reply.username ?? 'Anonymous';
              return (
                <div key={reply.id} className="flex items-start gap-2" data-testid={`reply-${reply.id}`}>
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-foreground border border-border/50">
                    {replyAuthor.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium">{replyAuthor}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {formatRelativeTime(reply.createdAt)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-sm text-foreground whitespace-pre-wrap break-words">{reply.body}</p>
                  </div>
                </div>
              );
            })}
          </m.div>
        )}
      </AnimatePresence>
    </m.div>
  );
}
