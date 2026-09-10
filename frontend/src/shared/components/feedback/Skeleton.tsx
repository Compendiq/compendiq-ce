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
    <div className="nm-card p-5">
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
    <div className="nm-card flex items-center gap-4 p-4">
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
    <div className="nm-card p-4 skeleton-article-card" data-testid="skeleton-article-card">
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
    <div className="nm-card p-4 skeleton-kpi-card" data-testid="skeleton-kpi-card">
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

/**
 * Mirrors PageViewPage's real column, not the carded three-column layout it
 * replaced (#P2): a 48px sticky strip (provenance chips left, action buttons
 * right — no `nm-card`, ADR-010's flat surfaces), then title, tags, the AI
 * Summary card, and body prose at the article's own measure. There is no
 * right-hand table-of-contents column here — that content now lives in
 * `ArticleRightPane`, a separate panel entirely, not part of this route's
 * own loading state. Every page navigation used to promise this skeleton's
 * layout and deliver a different one, producing a visible jump on the app's
 * most frequent transition.
 */
export function PageViewSkeleton() {
  return (
    <div data-testid="page-view-skeleton">
      {/* Context strip: provenance chips + action buttons, same 48px bar as
          PageViewPage's real `min-h-[calc(3rem-1px)]` strip. */}
      <div className="mx-auto flex min-h-[calc(3rem-1px)] max-w-[1248px] flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-b border-border px-9 py-2 sm:px-16">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <div className="skeleton h-4 w-10 rounded" />
          <div className="skeleton h-5 w-16 rounded-full" />
          <div className="skeleton h-5 w-14 rounded-full" />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="skeleton h-7 w-20 rounded-md" />
          ))}
        </div>
      </div>

      <div className="mx-auto max-w-[1200px] px-5 pb-16 pt-4 sm:px-10">
        {/* Title */}
        <div className="skeleton mb-4 h-9 w-3/5 rounded sm:h-10" />

        {/* Tags */}
        <div className="mb-10 flex flex-wrap items-center gap-2">
          <div className="skeleton h-6 w-16 rounded-full" />
          <div className="skeleton h-6 w-20 rounded-full" />
        </div>

        {/* AI Summary card */}
        <div className="mb-6 space-y-2 rounded-lg border border-border p-4">
          <div className="skeleton h-4 w-24 rounded" />
          <div className="skeleton h-4 w-full rounded" />
          <div className="skeleton h-4 w-[92%] rounded" />
          <div className="skeleton h-4 w-[70%] rounded" />
        </div>

        {/* Body prose */}
        <div className="space-y-2">
          <div className="skeleton h-4 w-full" />
          <div className="skeleton h-4 w-[95%]" />
          <div className="skeleton h-4 w-[88%]" />
        </div>
        <div className="skeleton mt-6 h-5 w-1/4" />
        <div className="mt-2 space-y-2">
          <div className="skeleton h-4 w-full" />
          <div className="skeleton h-4 w-[90%]" />
          <div className="skeleton h-4 w-[75%]" />
          <div className="skeleton h-4 w-[60%]" />
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
      <div className="nm-card">
        {/* Tab bar */}
        <div className="flex border-b border-border gap-1 px-2 py-2">
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
