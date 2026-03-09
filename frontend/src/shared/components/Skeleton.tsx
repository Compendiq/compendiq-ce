import { cn } from '../lib/cn';

type SkeletonVariant = 'text' | 'card' | 'circle' | 'button';

interface SkeletonProps {
  variant?: SkeletonVariant;
  width?: string | number;
  height?: string | number;
  className?: string;
  count?: number;
}

const variantStyles: Record<SkeletonVariant, string> = {
  text: 'h-4 w-3/4',
  card: 'h-24 w-full',
  circle: 'h-10 w-10 rounded-full',
  button: 'h-9 w-24',
};

export function Skeleton({ variant = 'text', width, height, className, count = 1 }: SkeletonProps) {
  const style: React.CSSProperties = {};
  if (width) style.width = typeof width === 'number' ? `${width}px` : width;
  if (height) style.height = typeof height === 'number' ? `${height}px` : height;

  if (count > 1) {
    return (
      <div className="space-y-2">
        {Array.from({ length: count }).map((_, i) => (
          <div
            key={i}
            className={cn('skeleton', variantStyles[variant], className)}
            style={style}
            data-testid="skeleton"
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className={cn('skeleton', variantStyles[variant], className)}
      style={style}
      data-testid="skeleton"
    />
  );
}

/** Skeleton for stat cards on the dashboard */
export function SkeletonStatCard() {
  return (
    <div className="glass-card p-5">
      <div className="flex items-center gap-3">
        <div className="skeleton h-10 w-10 rounded-lg" />
        <div className="flex-1 space-y-2">
          <div className="skeleton h-3 w-16" />
          <div className="skeleton h-5 w-10" />
        </div>
      </div>
    </div>
  );
}

/** Skeleton for page list items */
export function SkeletonPageItem() {
  return (
    <div className="glass-card flex items-center gap-4 p-4">
      <div className="skeleton h-5 w-5 rounded" />
      <div className="flex-1 space-y-2">
        <div className="skeleton h-4 w-2/3" />
        <div className="skeleton h-3 w-1/3" />
      </div>
      <div className="skeleton h-5 w-16 rounded-full" />
    </div>
  );
}

/** Skeleton for settings form fields */
export function SkeletonFormFields() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="space-y-1.5">
          <div className="skeleton h-3 w-24" />
          <div className="skeleton h-9 w-full" />
        </div>
      ))}
      <div className="skeleton h-9 w-20 rounded-lg" />
    </div>
  );
}
