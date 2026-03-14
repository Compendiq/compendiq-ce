import { useState } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { MessageSquare, Check, RotateCcw, ChevronDown, ChevronUp } from 'lucide-react';
import { CommentForm } from './CommentForm';
import { cn } from '../../lib/cn';

export interface Comment {
  id: string;
  authorName: string;
  body: string;
  createdAt: string;
  resolved: boolean;
  parentId: string | null;
  replies?: Comment[];
}

interface CommentThreadProps {
  comment: Comment;
  onReply: (parentId: string, body: string) => void;
  onResolve: (commentId: string) => void;
  onUnresolve: (commentId: string) => void;
  isSubmittingReply?: boolean;
}

function formatRelativeTime(dateStr: string): string {
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
  isSubmittingReply = false,
}: CommentThreadProps) {
  const [showReplies, setShowReplies] = useState(!comment.resolved);
  const [showReplyForm, setShowReplyForm] = useState(false);
  const replies = comment.replies ?? [];

  const handleReply = (body: string) => {
    onReply(comment.id, body);
    setShowReplyForm(false);
  };

  return (
    <m.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        'rounded-lg border border-border/30 bg-foreground/[0.02] p-3',
        comment.resolved && 'opacity-60',
      )}
      data-testid={`comment-thread-${comment.id}`}
    >
      {/* Top-level comment */}
      <div className="flex items-start gap-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/20 text-xs font-medium text-primary">
          {comment.authorName.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{comment.authorName}</span>
            <span className="text-[11px] text-muted-foreground">
              {formatRelativeTime(comment.createdAt)}
            </span>
            {comment.resolved && (
              <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
                Resolved
              </span>
            )}
          </div>
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
            {comment.resolved ? (
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
                className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
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
            className="mt-3 space-y-2 overflow-hidden border-l-2 border-border/30 pl-4 ml-3"
          >
            {replies.map((reply) => (
              <div key={reply.id} className="flex items-start gap-2" data-testid={`reply-${reply.id}`}>
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
                  {reply.authorName.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium">{reply.authorName}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {formatRelativeTime(reply.createdAt)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-sm text-foreground/90 whitespace-pre-wrap">{reply.body}</p>
                </div>
              </div>
            ))}
          </m.div>
        )}
      </AnimatePresence>
    </m.div>
  );
}
