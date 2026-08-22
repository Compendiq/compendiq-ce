import { useLayoutEffect, useRef, useState, useCallback } from 'react';
import { MessageSquarePlus, Send, Loader2 } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button } from '../Button';
import { isMac } from '../../lib/platform';

export interface CommentComposerProps {
  id?: string;
  quote?: string;
  initialValue?: string;
  onDraftChange?: (body: string) => void;
  onSubmit: (body: string) => void | Promise<void>;
  onClose: () => void;
  isSubmitting?: boolean;
  className?: string;
}

export function CommentComposer({
  id,
  quote,
  initialValue = '',
  onDraftChange,
  onSubmit,
  onClose,
  isSubmitting = false,
  className,
}: CommentComposerProps) {
  const [body, setBody] = useState(initialValue);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mac = isMac();

  const handleBodyChange = (newBody: string) => {
    setBody(newBody);
    onDraftChange?.(newBody);
  };

  useLayoutEffect(() => {
    textareaRef.current?.focus();
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

  const quoteId = id ? `${id}-quote` : 'comment-composer-quote';
  const hintId = id ? `${id}-hint` : 'comment-composer-hint';

  return (
    <div
      id={id}
      role="group"
      aria-label="Add note"
      aria-busy={isSubmitting}
      data-testid="inline-comment-composer"
      className={cn('flex flex-col gap-2.5 p-3 text-card-foreground', className)}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <MessageSquarePlus size={14} className="text-primary" />
          <span>Add Note</span>
        </div>
      </div>

      {/* Quoted selection snippet */}
      {quote && (
        <blockquote
          id={quoteId}
          data-testid="comment-composer-quote"
          className="rounded border-l-2 border-primary/70 bg-muted/40 px-2.5 py-1 text-[11px] italic text-muted-foreground line-clamp-2"
          title={quote}
        >
          &ldquo;{quote}&rdquo;
        </blockquote>
      )}

      {/* Input */}
      <textarea
        ref={textareaRef}
        autoFocus
        value={body}
        onChange={(e) => handleBodyChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type an editorial note…"
        rows={3}
        disabled={isSubmitting}
        aria-label="Note content"
        aria-describedby={cn(quote ? quoteId : undefined, hintId)}
        data-testid="inline-comment-input"
        className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
      />

      {/* Actions */}
      <div className="flex items-center justify-between pt-0.5">
        <span id={hintId} className="text-[11px] font-mono text-muted-foreground/80">
          Esc · {mac ? '⌘↵' : 'Ctrl+↵'}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50"
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
