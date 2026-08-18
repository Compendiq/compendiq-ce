import type { PageIcon as PageIconValue } from '@compendiq/contracts';
import { useAuthenticatedSrc } from '../../hooks/use-authenticated-src';
import { cn } from '../../lib/cn';
import { getPageLucideIcon } from './page-lucide-icons';

export type PageIconSize = 'row' | 'title';

const SIZE: Record<PageIconSize, { box: string; lucide: number; emoji: string }> = {
  row: { box: 'size-4', lucide: 14, emoji: 'text-[14px] leading-none' },
  // Matches the article h1 first line (3xl/4xl, leading 1.2) so the mark
  // can sit to the left of the title instead of stacked above it.
  title: { box: 'size-9', lucide: 28, emoji: 'text-[32px] leading-none' },
};

function pageIconImageUrl(pageId: string | number, sha: string): string {
  return `/api/pages/${pageId}/icon-image?v=${encodeURIComponent(sha)}`;
}

export function PageIcon({
  icon,
  pageId,
  size = 'row',
  className,
}: {
  icon: PageIconValue | null | undefined;
  pageId: string | number;
  size?: PageIconSize;
  className?: string;
}) {
  if (!icon) return null;
  const dim = SIZE[size];

  if (icon.kind === 'emoji') {
    return (
      <span
        aria-hidden="true"
        className={cn('inline-flex shrink-0 items-center justify-center', dim.box, dim.emoji, className)}
      >
        {icon.value}
      </span>
    );
  }

  if (icon.kind === 'lucide') {
    const Glyph = getPageLucideIcon(icon.value);
    if (!Glyph) return null;
    return (
      <span
        aria-hidden="true"
        className={cn('inline-flex shrink-0 items-center justify-center text-foreground', dim.box, className)}
      >
        <Glyph size={dim.lucide} strokeWidth={size === 'title' ? 1.5 : 2} />
      </span>
    );
  }

  return <PageIconImage pageId={pageId} sha={icon.value} size={size} className={className} />;
}

function PageIconImage({
  pageId,
  sha,
  size,
  className,
}: {
  pageId: string | number;
  sha: string;
  size: PageIconSize;
  className?: string;
}) {
  const { blobSrc, error } = useAuthenticatedSrc(pageIconImageUrl(pageId, sha));
  if (error || !blobSrc) return null;
  return (
    <img
      src={blobSrc}
      alt=""
      aria-hidden="true"
      className={cn('shrink-0 rounded-md object-cover', SIZE[size].box, className)}
    />
  );
}
