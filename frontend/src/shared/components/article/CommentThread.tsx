import { useState } from 'react';
import { m, AnimatePresence } from 'framer-motion';
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
  onReply: (parentId: string, body: string) => void;
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

  const handleReply = (body: string) => {
    onReply(comment.id, body);
    setShowReplyForm(false);
  };

  return (
    <m.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        'rounded-lg border border-border bg-foreground/[0.02] p-3 transition-colors',
        isResolved && 'opacity-60',
        isSelected && 'ring-2 ring-primary bg-primary/[0.04]',
      )}
      data-testid={`comment-thread-${comment.id}`}
    >
      {/* Top-level comment */}
      <div className="flex items-start gap-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-action text-xs font-medium text-action-foreground">
          {author.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{author}</span>
            <span className="text-[11px] text-muted-foreground">
              {formatRelativeTime(comment.createdAt)}
            </span>
            {isResolved && (
              <span className="rounded-full bg-success/15 px-1.5 py-0.5 text-[11px] font-medium text-success">
                Resolved
              </span>
            )}
          </div>

          {/* Quoted selection snippet for inline comments */}
          {comment.anchorData?.quote && (
            <div
              onClick={() => onJumpToAnchor?.(comment.id)}
              className="my-1.5 flex cursor-pointer items-start gap-1 rounded border-l-2 border-primary/70 bg-muted/40 px-2 py-1 text-xs italic text-muted-foreground transition-colors hover:bg-muted/70"
              title="Click to jump to highlighted text in article"
              data-testid={`comment-quote-${comment.id}`}
            >
              <Quote size={11} className="mt-0.5 shrink-0 opacity-70" />
              <span className="line-clamp-2">&ldquo;{comment.anchorData.quote}&rdquo;</span>
            </div>
          )}

          <p className="mt-1 text-sm text-foreground/90 whitespace-pre-wrap">{comment.body}</p>

          {/* Actions */}
          <div className="mt-2 flex items-center gap-3">
            <button
              onClick={() => setShowReplyForm((v) => !v)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              data-testid={`reply-toggle-${comment.id}`}
            >
              <MessageSquare size={12} />
              Reply
            </button>
            {isResolved ? (
              <button
                onClick={() => onUnresolve(comment.id)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                data-testid={`unresolve-${comment.id}`}
              >
                <RotateCcw size={12} />
                Unresolve
              </button>
            ) : (
              <button
                onClick={() => onResolve(comment.id)}
                className="flex items-center gap-1 text-xs text-success hover:text-success transition-colors"
                data-testid={`resolve-${comment.id}`}
              >
                <Check size={12} />
                Resolve
              </button>
            )}
            {replies.length > 0 && (
              <button
                onClick={() => setShowReplies((v) => !v)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                data-testid={`toggle-replies-${comment.id}`}
              >
                {showReplies ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Reply form */}
      <AnimatePresence>
        {showReplyForm && (
          <m.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
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
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="mt-3 space-y-2 overflow-hidden border-l-2 border-border pl-4 ml-3"
          >
            {replies.map((reply) => {
              const replyAuthor = reply.authorName ?? reply.username ?? 'Anonymous';
              return (
                <div key={reply.id} className="flex items-start gap-2" data-testid={`reply-${reply.id}`}>
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
                    {replyAuthor.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium">{replyAuthor}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {formatRelativeTime(reply.createdAt)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-sm text-foreground/90 whitespace-pre-wrap">{reply.body}</p>
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
