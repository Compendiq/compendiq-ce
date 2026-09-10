import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  /**
   * Weight of the primary action, default `primary` (#1402 phase 3).
   *
   * An empty state is usually the only thing on its surface, so a filled
   * accent there is free. It stops being free when a louder prompt already
   * owns the screen: on `/pages` the Getting Started checklist asks for the
   * same Confluence setup one block above, and the header's `New Page` is the
   * route's own primary action. Two filled Steel buttons for the same request
   * is the PAT-banner mistake (CLAUDE.md) in a new place — so the caller that
   * knows it is the second voice asks for `secondary` and keeps the accent
   * count at one.
   */
  actionTone?: 'primary' | 'secondary';
  secondaryAction?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, actionTone = 'primary', secondaryAction, className }: EmptyStateProps) {
  return (
    <div className={cn('nm-card flex flex-col items-center justify-center py-16 text-center', className)} data-testid="empty-state">
      <div className="mb-4 rounded-full bg-muted p-3">
        <Icon size={32} className="text-muted-foreground" />
      </div>
      <p className="text-lg font-medium" data-testid="empty-state-title">{title}</p>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      )}
      {(action || secondaryAction) && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
          {action && (
            <button
              type="button"
              onClick={action.onClick}
              className={actionTone === 'secondary' ? 'nm-button-secondary' : 'nm-button-primary'}
            >
              {action.label}
            </button>
          )}
          {secondaryAction && (
            <button
              type="button"
              onClick={secondaryAction.onClick}
              className="nm-button-secondary"
            >
              {secondaryAction.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
