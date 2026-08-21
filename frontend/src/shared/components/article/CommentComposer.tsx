import { useEffect, useRef, useState, useCallback } from 'react';
import { MessageSquarePlus, X, Send, Loader2 } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button } from '../Button';

export interface CommentComposerProps {
  id?: string;
  quote?: string;
  onSubmit: (body: string) => void | Promise<void>;
  onClose: () => void;
  isSubmitting?: boolean;
  className?: string;
}

export function CommentComposer({
  id,
  quote,
  onSubmit,
  onClose,
  isSubmitting = false,
  className,
}: CommentComposerProps) {
  const [body, setBody] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Focus textarea on mount
    const timer = setTimeout(() => {
      textareaRef.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmed = body.trim();
    if (!trimmed || isSubmitting) return;
    void onSubmit(trimmed);
  }, [body, isSubmitting, onSubmit]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      id={id}
      data-testid="inline-comment-composer"
      className={cn('flex flex-col gap-2 p-3 text-card-foreground', className)}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <MessageSquarePlus size={14} className="text-primary" />
          <span>Add Note / Comment</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close composer"
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X size={14} />
        </button>
      </div>

      {/* Quoted selection snippet */}
      {quote && (
        <div
          data-testid="comment-composer-quote"
          className="rounded border-l-2 border-primary/70 bg-muted/40 px-2 py-1 text-[11px] italic text-muted-foreground line-clamp-2"
          title={quote}
        >
          &ldquo;{quote}&rdquo;
        </div>
      )}

      {/* Input */}
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Add an editorial note or comment… (Cmd+Enter to send)"
        rows={3}
        disabled={isSubmitting}
        data-testid="inline-comment-input"
        className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
      />

      {/* Actions */}
      <div className="flex items-center justify-between pt-1">
        <span className="text-[11px] text-muted-foreground">
          Esc to cancel · ⌘+Enter to save
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <Button
            type="button"
            size="sm"
            variant="primary"
            onClick={handleSubmit}
            disabled={!body.trim() || isSubmitting}
            data-testid="inline-comment-submit"
            className="h-7 gap-1 px-2.5 text-xs"
            leftIcon={
              isSubmitting ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Send size={12} />
              )
            }
          >
            {isSubmitting ? 'Saving…' : 'Add note'}
          </Button>
        </div>
      </div>
    </div>
  );
}
