import { cn } from '../lib/cn';

interface EmbeddingStatusBadgeProps {
  embeddingDirty: boolean;
  className?: string;
}

export function EmbeddingStatusBadge({ embeddingDirty, className }: EmbeddingStatusBadgeProps) {
  return (
    <span
      title={embeddingDirty ? 'Needs embedding — content has changed since last embedding' : 'Embedded — content is indexed for AI search'}
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        embeddingDirty
          ? 'bg-yellow-400/15 text-yellow-400'
          : 'bg-emerald-400/15 text-emerald-400',
        className,
      )}
    >
      {embeddingDirty ? 'Pending' : 'Embedded'}
    </span>
  );
}

export type { EmbeddingStatusBadgeProps };
