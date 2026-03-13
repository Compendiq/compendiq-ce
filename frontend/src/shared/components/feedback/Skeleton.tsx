import { cn } from '../../lib/cn';

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

/** Content-aware skeleton: article card (title bar + 2 meta chips + 3 excerpt lines) */
export function SkeletonArticleCard() {
  return (
    <div className="glass-card p-4 skeleton-article-card" data-testid="skeleton-article-card">
      <div className="skeleton skeleton-title h-4 w-[70%] mb-3" />
      <div className="flex gap-2 mb-3">
        <div className="skeleton h-3 w-14 rounded-full" />
        <div className="skeleton h-3 w-14 rounded-full" />
      </div>
      <div className="space-y-1.5">
        <div className="skeleton h-2.5 w-full" />
        <div className="skeleton h-2.5 w-[92%]" />
        <div className="skeleton h-2.5 w-[60%]" />
      </div>
    </div>
  );
}

/** Content-aware skeleton: KPI card (label + number + icon) */
export function SkeletonKPICard() {
  return (
    <div className="glass-card p-4 skeleton-kpi-card" data-testid="skeleton-kpi-card">
      <div className="skeleton h-8 w-8 rounded-lg shrink-0" />
      <div className="min-w-0">
        <div className="skeleton h-2.5 w-16 mb-1.5" />
        <div className="skeleton h-[1.125rem] w-10" />
      </div>
    </div>
  );
}

/** Content-aware skeleton: chat message (avatar circle + bubble with text lines) */
export function SkeletonChatMessage() {
  return (
    <div className="flex gap-3 skeleton-chat-message" data-testid="skeleton-chat-message">
      <div className="skeleton h-8 w-8 rounded-full shrink-0" />
      <div className="flex-1 rounded-lg bg-foreground/5 p-3 space-y-1.5">
        <div className="skeleton h-2.5 w-[85%]" />
        <div className="skeleton h-2.5 w-[65%]" />
        <div className="skeleton h-2.5 w-[40%]" />
      </div>
    </div>
  );
}

/** Skeleton for page view: toolbar + metadata bar + article content area */
export function PageViewSkeleton() {
  return (
    <div className="space-y-4" data-testid="page-view-skeleton">
      {/* Toolbar: back button + title + action buttons */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="skeleton h-8 w-8 rounded" />
          <div className="skeleton h-6 w-1/3" />
        </div>
        <div className="flex shrink-0 gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="skeleton h-8 w-20 rounded-lg" />
          ))}
        </div>
      </div>

      {/* Metadata bar: space badge + freshness + author + date + version */}
      <div className="glass-card flex flex-wrap items-center gap-4 px-4 py-3">
        <div className="skeleton h-5 w-12 rounded" />
        <div className="skeleton h-5 w-20 rounded-full" />
        <div className="skeleton h-4 w-24" />
        <div className="skeleton h-4 w-32" />
        <div className="skeleton h-4 w-8" />
      </div>

      {/* Content area + sidebar */}
      <div className="flex gap-4">
        {/* Main content */}
        <div className="glass-card flex-1 p-6 space-y-4">
          {/* Heading */}
          <div className="skeleton h-7 w-2/5 mb-2" />
          {/* Paragraph lines */}
          <div className="space-y-2">
            <div className="skeleton h-4 w-full" />
            <div className="skeleton h-4 w-[95%]" />
            <div className="skeleton h-4 w-[88%]" />
          </div>
          {/* Subheading */}
          <div className="skeleton h-5 w-1/4 mt-4" />
          {/* More paragraph lines */}
          <div className="space-y-2">
            <div className="skeleton h-4 w-full" />
            <div className="skeleton h-4 w-[90%]" />
            <div className="skeleton h-4 w-[75%]" />
            <div className="skeleton h-4 w-[60%]" />
          </div>
          {/* Another subheading */}
          <div className="skeleton h-5 w-1/3 mt-4" />
          {/* Final paragraph */}
          <div className="space-y-2">
            <div className="skeleton h-4 w-full" />
            <div className="skeleton h-4 w-[82%]" />
          </div>
        </div>

        {/* Sidebar (table of contents) - hidden on small screens */}
        <div className="hidden w-64 shrink-0 lg:block space-y-3">
          <div className="skeleton h-4 w-32 mb-4" />
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="skeleton h-3 ml-0" style={{ width: `${70 + Math.round(Math.sin(i) * 20)}%` }} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Skeleton for settings page: tabs bar + form content */
export function SettingsSkeleton() {
  return (
    <div data-testid="settings-skeleton">
      <div className="skeleton h-7 w-32 mb-6" />
      <div className="glass-card">
        {/* Tab bar */}
        <div className="flex border-b border-border/50 gap-1 px-2 py-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="skeleton h-8 w-20 rounded" />
          ))}
        </div>
        {/* Form content */}
        <div className="p-6">
          <SkeletonFormFields />
        </div>
      </div>
    </div>
  );
}
