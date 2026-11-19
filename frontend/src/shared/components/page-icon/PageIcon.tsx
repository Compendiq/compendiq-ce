import { useEffect, useState } from 'react';
import type { PageIcon as PageIconValue } from '@compendiq/contracts';
import { getPageBrandIcon } from '@compendiq/contracts';
import { useAuthenticatedSrc } from '../../hooks/use-authenticated-src';
import { cn } from '../../lib/cn';
import { BrandMark } from './BrandMark';
import {
  getCachedPageLucideCatalog,
  loadPageLucideCatalog,
  type PageLucideCatalog,
} from './page-lucide-loader';

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
    return (
      <LazyLucidePageIcon
        value={icon.value}
        color={icon.color}
        filled={icon.filled}
        size={size}
        className={className}
      />
    );
  }

  if (icon.kind === 'brand') {
    const mark = getPageBrandIcon(icon.value);
    if (!mark) return null;
    return (
      <span
        aria-hidden="true"
        className={cn(
          'inline-flex shrink-0 items-center justify-center',
          !icon.color && 'text-foreground',
          dim.box,
          className,
        )}
        style={icon.color ? { color: icon.color } : undefined}
      >
        <BrandMark path={mark.path} size={dim.lucide} />
      </span>
    );
  }

  return <PageIconImage pageId={pageId} sha={icon.value} size={size} className={className} />;
}

function LazyLucidePageIcon({
  value,
  color,
  filled,
  size,
  className,
}: {
  value: string;
  color?: string | null;
  filled?: boolean;
  size: PageIconSize;
  className?: string;
}) {
  const [catalog, setCatalog] = useState<PageLucideCatalog | null>(getCachedPageLucideCatalog);

  useEffect(() => {
    if (catalog) return;
    let active = true;
    void loadPageLucideCatalog().then((loaded) => {
      if (active) setCatalog(loaded);
    });
    return () => {
      active = false;
    };
  }, [catalog]);

  const Glyph = catalog?.getPageLucideIcon(value);
  if (!Glyph) return null;
  const dim = SIZE[size];

  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center',
        !color && 'text-foreground',
        size === 'title' && 'page-icon-title',
        dim.box,
        className,
      )}
      style={color ? { color } : undefined}
    >
      <Glyph
        size={dim.lucide}
        strokeWidth={size === 'title' ? 1.5 : 2}
        fill={filled ? 'currentColor' : 'none'}
        className={cn(filled && 'page-icon-filled')}
      />
    </span>
  );
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
