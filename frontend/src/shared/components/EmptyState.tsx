import type { LucideIcon } from 'lucide-react';
import { cn } from '../lib/cn';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('glass-card flex flex-col items-center justify-center py-16 text-center', className)}>
      <div className="mb-4 rounded-full bg-muted p-3">
        <Icon size={32} className="text-muted-foreground" />
      </div>
      <p className="text-lg font-medium" data-testid="empty-state-title">{title}</p>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      )}
      {action && (
        <button
          onClick={action.onClick}
          className="glass-button-primary mt-4"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
