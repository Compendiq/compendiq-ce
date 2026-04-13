import { useState, useRef, useEffect } from 'react';
import { Send, X } from 'lucide-react';
import { cn } from '../../lib/cn';

interface CommentFormProps {
  /** Called with the comment body text when the user submits */
  onSubmit: (body: string) => void;
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setBody('');
  };

  return (
    <form onSubmit={handleSubmit} className={cn('space-y-2', className)} data-testid="comment-form">
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder}
        rows={3}
        disabled={isSubmitting}
        className="w-full resize-none rounded-lg border border-border/50 bg-foreground/5 px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary disabled:opacity-50"
        data-testid="comment-textarea"
      />
      <div className="flex items-center justify-end gap-2">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="flex items-center gap-1 rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-foreground/5 transition-colors"
            data-testid="comment-cancel"
          >
            <X size={14} />
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={!body.trim() || isSubmitting}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          data-testid="comment-submit"
        >
          <Send size={14} />
          {isSubmitting ? 'Posting...' : 'Post'}
        </button>
      </div>
    </form>
  );
}
