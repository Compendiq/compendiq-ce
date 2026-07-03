import { AlertTriangle } from 'lucide-react';
import { cn } from '../../lib/cn';

interface ErrorStateProps {
  title?: string;
  description?: string;
  /** When provided, renders a Retry button that calls this handler. */
  onRetry?: () => void;
  className?: string;
  /** Test id for the outer container. */
  testId?: string;
  /** Test id for the Retry button. */
  retryTestId?: string;
}

/**
 * Shared error card with an optional Retry action. Used by data-heavy tabs
 * (LlmTab, SyncTab, ComplianceReportsTab) so a failed query surfaces a
 * distinct, actionable error state instead of an infinite loading skeleton
 * or a misleading empty result.
 */
export function ErrorState({
  title = 'Something went wrong',
  description,
  onRetry,
  className,
  testId,
  retryTestId,
}: ErrorStateProps) {
  return (
    <div
      className={cn(
        'nm-card flex flex-col items-center justify-center gap-3 py-12 text-center',
        className,
      )}
      role="alert"
      data-testid={testId}
    >
      <div className="rounded-full bg-destructive/10 p-3">
        <AlertTriangle size={28} className="text-destructive" />
      </div>
      <p className="text-base font-medium">{title}</p>
      {description && (
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      )}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="nm-button-ghost mt-1"
          data-testid={retryTestId}
        >
          Retry
        </button>
      )}
    </div>
  );
}
