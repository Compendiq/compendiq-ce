import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button } from '../Button';

interface CommentFormProps {
  /** Called with the comment body text when the user submits */
  onSubmit: (body: string) => void | Promise<void>;
  /** If true, shows a cancel button (used for inline reply forms) */
  onCancel?: () => void;
  /** Placeholder text for the textarea */
  placeholder?: string;
  /** Whether the form is currently submitting */
  isSubmitting?: boolean;
  /** Auto-focus the textarea on mount */
  autoFocus?: boolean;
  className?: string;
}

export function CommentForm({
  onSubmit,
  onCancel,
  placeholder = 'Write a comment...',
  isSubmitting = false,
  autoFocus = false,
  className,
}: CommentFormProps) {
  const [body, setBody] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [autoFocus]);

  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      const trimmed = body.trim();
      if (!trimmed || isSubmitting) return;

      try {
        const result = onSubmit(trimmed);
        if (result instanceof Promise) {
          await result;
        }
        setBody('');
      } catch {
        // Keep body in state so user doesn't lose their input on failure
      }
    },
    [body, isSubmitting, onSubmit],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSubmit();
    } else if (e.key === 'Escape' && onCancel) {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  return (
    <form onSubmit={handleSubmit} className={cn('space-y-2', className)} data-testid="comment-form">
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={placeholder}
        rows={3}
        disabled={isSubmitting}
        className="w-full resize-none rounded-lg border border-border-interactive bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground transition-colors focus:ring-1 focus:ring-primary focus:border-primary disabled:opacity-50"
        data-testid="comment-textarea"
      />
      <div className="flex items-center justify-end gap-2">
        {onCancel && (
          <Button
            type="button"
            onClick={onCancel}
            variant="ghost"
            size="sm"
            leftIcon={<X size={14} />}
            data-testid="comment-cancel"
          >
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          disabled={!body.trim() || isSubmitting}
          isLoading={isSubmitting}
          variant="primary"
          size="sm"
          leftIcon={!isSubmitting ? <Send size={14} /> : undefined}
          data-testid="comment-submit"
        >
          {isSubmitting ? 'Posting...' : 'Post'}
        </Button>
      </div>
    </form>
  );
}
