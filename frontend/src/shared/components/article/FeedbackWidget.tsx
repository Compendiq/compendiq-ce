import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ThumbsUp, ThumbsDown, Send } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { cn } from '../../lib/cn';

interface FeedbackData {
  helpfulCount: number;
  unhelpfulCount: number;
  /** Current user's vote: 'helpful' | 'unhelpful' | null */
  userVote: 'helpful' | 'unhelpful' | null;
}

function useFeedback(pageId: string) {
  return useQuery<FeedbackData>({
    queryKey: ['pages', pageId, 'feedback'],
    queryFn: () => apiFetch(`/pages/${pageId}/feedback`),
    staleTime: 30_000,
  });
}

function useSubmitFeedback(pageId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { vote: 'helpful' | 'unhelpful'; comment?: string }) =>
      apiFetch(`/pages/${pageId}/feedback`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey: ['pages', pageId, 'feedback'] });
      const previous = queryClient.getQueryData<FeedbackData>(['pages', pageId, 'feedback']);

      queryClient.setQueryData<FeedbackData>(['pages', pageId, 'feedback'], (old) => {
        if (!old) return old;
        const wasHelpful = old.userVote === 'helpful';
        const wasUnhelpful = old.userVote === 'unhelpful';
        return {
          helpfulCount: old.helpfulCount
            + (payload.vote === 'helpful' ? 1 : 0)
            - (wasHelpful ? 1 : 0),
          unhelpfulCount: old.unhelpfulCount
            + (payload.vote === 'unhelpful' ? 1 : 0)
            - (wasUnhelpful ? 1 : 0),
          userVote: payload.vote,
        };
      });

      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['pages', pageId, 'feedback'], context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['pages', pageId, 'feedback'] });
    },
  });
}

interface FeedbackWidgetProps {
  pageId: string;
  className?: string;
}

export function FeedbackWidget({ pageId, className }: FeedbackWidgetProps) {
  const { data } = useFeedback(pageId);
  const submitMutation = useSubmitFeedback(pageId);

  const [showCommentField, setShowCommentField] = useState(false);
  const [comment, setComment] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const handleVote = (vote: 'helpful' | 'unhelpful') => {
    submitMutation.mutate({ vote });
    setSubmitted(true);

    if (vote === 'unhelpful') {
      setShowCommentField(true);
    } else {
      setShowCommentField(false);
    }
  };

  const handleSubmitComment = () => {
    if (!comment.trim()) return;
    submitMutation.mutate({ vote: 'unhelpful', comment: comment.trim() });
    setComment('');
    setShowCommentField(false);
  };

  const userVote = data?.userVote ?? null;
  const helpfulCount = data?.helpfulCount ?? 0;

  return (
    <div
      className={cn('glass-card p-4', className)}
      data-testid="feedback-widget"
    >
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Was this article helpful?</p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => handleVote('helpful')}
            disabled={submitMutation.isPending}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
              userVote === 'helpful'
                ? 'bg-success/15 text-success'
                : 'bg-foreground/5 text-muted-foreground hover:bg-success/10 hover:text-success',
            )}
            data-testid="feedback-helpful"
            aria-label="Helpful"
          >
            <ThumbsUp size={14} />
            Yes
          </button>
          <button
            onClick={() => handleVote('unhelpful')}
            disabled={submitMutation.isPending}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
              userVote === 'unhelpful'
                ? 'bg-destructive/15 text-destructive'
                : 'bg-foreground/5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
            )}
            data-testid="feedback-unhelpful"
            aria-label="Not helpful"
          >
            <ThumbsDown size={14} />
            No
          </button>
        </div>
      </div>

      {/* Vote count */}
      {helpfulCount > 0 && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="feedback-count">
          {helpfulCount} {helpfulCount === 1 ? 'person' : 'people'} found this helpful
        </p>
      )}

      {/* Thanks message */}
      {submitted && !showCommentField && (
        <p className="mt-2 text-xs text-success" data-testid="feedback-thanks">
          Thanks for your feedback!
        </p>
      )}

      {/* Comment field for negative feedback */}
      {showCommentField && (
        <div className="mt-3 space-y-2" data-testid="feedback-comment-section">
          <p className="text-xs text-muted-foreground">
            Thanks for your feedback! What could be improved?
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSubmitComment(); }}
              placeholder="Optional: describe what could be better..."
              className="flex-1 rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary"
              data-testid="feedback-comment-input"
            />
            <button
              onClick={handleSubmitComment}
              disabled={!comment.trim()}
              className="flex items-center gap-1 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              data-testid="feedback-comment-submit"
            >
              <Send size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
