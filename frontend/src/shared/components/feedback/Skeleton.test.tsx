import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  Skeleton, SkeletonStatCard, SkeletonPageItem, SkeletonFormFields,
  SkeletonArticleCard, SkeletonKPICard, SkeletonChatMessage,
  PageViewSkeleton, SettingsSkeleton,
} from './Skeleton';

describe('Skeleton', () => {
  it('renders a single skeleton element by default', () => {
    render(<Skeleton />);
    expect(screen.getByTestId('skeleton')).toBeInTheDocument();
  });

  it('renders multiple skeleton elements with count', () => {
    render(<Skeleton count={3} />);
    expect(screen.getAllByTestId('skeleton')).toHaveLength(3);
  });

  it('applies text variant styles by default', () => {
    render(<Skeleton />);
    const el = screen.getByTestId('skeleton');
    expect(el.className).toContain('skeleton');
  });

  it('applies card variant styles', () => {
    render(<Skeleton variant="card" />);
    const el = screen.getByTestId('skeleton');
    expect(el.className).toContain('skeleton');
  });

  it('applies circle variant styles', () => {
    render(<Skeleton variant="circle" />);
    const el = screen.getByTestId('skeleton');
    expect(el.className).toContain('rounded-full');
  });

  it('applies custom className', () => {
    render(<Skeleton className="my-custom" />);
    const el = screen.getByTestId('skeleton');
    expect(el.className).toContain('my-custom');
  });

  it('applies custom width and height as style', () => {
    render(<Skeleton width={200} height={50} />);
    const el = screen.getByTestId('skeleton');
    expect(el.style.width).toBe('200px');
    expect(el.style.height).toBe('50px');
  });

  it('accepts string width/height', () => {
    render(<Skeleton width="100%" height="2rem" />);
    const el = screen.getByTestId('skeleton');
    expect(el.style.width).toBe('100%');
    expect(el.style.height).toBe('2rem');
  });
});

describe('SkeletonStatCard', () => {
  it('renders skeleton elements inside a nm-card', () => {
    const { container } = render(<SkeletonStatCard />);
    expect(container.querySelector('.nm-card')).toBeInTheDocument();
    expect(container.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
  });
});

describe('SkeletonPageItem', () => {
  it('renders skeleton elements inside a nm-card', () => {
    const { container } = render(<SkeletonPageItem />);
    expect(container.querySelector('.nm-card')).toBeInTheDocument();
    expect(container.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
  });
});

describe('SkeletonFormFields', () => {
  it('renders multiple skeleton form field groups', () => {
    const { container } = render(<SkeletonFormFields />);
    expect(container.querySelectorAll('.skeleton').length).toBeGreaterThanOrEqual(4);
  });
});

describe('SkeletonArticleCard', () => {
  it('renders with correct test id', () => {
    render(<SkeletonArticleCard />);
    expect(screen.getByTestId('skeleton-article-card')).toBeInTheDocument();
  });

  it('renders inside a nm-card', () => {
    const { container } = render(<SkeletonArticleCard />);
    expect(container.querySelector('.nm-card')).toBeInTheDocument();
  });

  it('renders title, meta chips, and excerpt line skeletons', () => {
    const { container } = render(<SkeletonArticleCard />);
    // Title (1) + 2 meta chips + 3 excerpt lines = 6 skeleton elements
    expect(container.querySelectorAll('.skeleton').length).toBe(6);
  });
});

describe('SkeletonKPICard', () => {
  it('renders with correct test id', () => {
    render(<SkeletonKPICard />);
    expect(screen.getByTestId('skeleton-kpi-card')).toBeInTheDocument();
  });

  it('renders inside a nm-card', () => {
    const { container } = render(<SkeletonKPICard />);
    expect(container.querySelector('.nm-card')).toBeInTheDocument();
  });

  it('renders icon, label, and number skeletons', () => {
    const { container } = render(<SkeletonKPICard />);
    // Icon (1) + label (1) + number (1) = 3 skeleton elements
    expect(container.querySelectorAll('.skeleton').length).toBe(3);
  });
});

describe('SkeletonChatMessage', () => {
  it('renders with correct test id', () => {
    render(<SkeletonChatMessage />);
    expect(screen.getByTestId('skeleton-chat-message')).toBeInTheDocument();
  });

  it('renders avatar and text line skeletons', () => {
    const { container } = render(<SkeletonChatMessage />);
    // Avatar (1) + 3 text lines = 4 skeleton elements
    expect(container.querySelectorAll('.skeleton').length).toBe(4);
  });

  it('has a rounded-full avatar skeleton', () => {
    const { container } = render(<SkeletonChatMessage />);
    expect(container.querySelector('.rounded-full.skeleton')).toBeInTheDocument();
  });
});

describe('PageViewSkeleton', () => {
  it('renders with correct test id', () => {
    render(<PageViewSkeleton />);
    expect(screen.getByTestId('page-view-skeleton')).toBeInTheDocument();
  });

  it('renders a context-strip skeleton mirroring the real 48px bar, not a toolbar row', () => {
    const { container } = render(<PageViewSkeleton />);
    // Provenance chips (3) + action buttons (3) = 6, in the same
    // `min-h-[calc(3rem-1px)]` strip PageViewPage's real header uses.
    const strip = container.querySelector('[data-testid="page-view-skeleton"] > div:first-child');
    expect(strip?.className).toContain('min-h-[calc(3rem-1px)]');
    expect(strip!.querySelectorAll('.skeleton').length).toBe(6);
  });

  it('never renders an nm-card — the current layout is flat, not carded (#P2)', () => {
    // PageViewSkeleton used to wrap its metadata bar and content in `nm-card`,
    // a layout PageViewPage stopped rendering; a card-shaped loading state
    // for a flat page produced a visible jump on every navigation.
    const { container } = render(<PageViewSkeleton />);
    expect(container.querySelectorAll('.nm-card').length).toBe(0);
  });

  it('renders title, tags, AI Summary card and body prose skeleton lines', () => {
    const { container } = render(<PageViewSkeleton />);
    const allSkeletons = container.querySelectorAll('.skeleton');
    expect(allSkeletons.length).toBeGreaterThanOrEqual(15);
  });

  it('does not render a right-hand table-of-contents column — that is ArticleRightPane, a separate panel', () => {
    // The old skeleton hardcoded a 256px (`w-64`) inner TOC sidebar that no
    // longer exists on this route; the outline now lives entirely inside
    // ArticleRightPane, out of this component's scope.
    const { container } = render(<PageViewSkeleton />);
    expect(container.querySelector('.w-64')).not.toBeInTheDocument();
  });
});

describe('SettingsSkeleton', () => {
  it('renders with correct test id', () => {
    render(<SettingsSkeleton />);
    expect(screen.getByTestId('settings-skeleton')).toBeInTheDocument();
  });

  it('renders tab bar skeletons', () => {
    const { container } = render(<SettingsSkeleton />);
    // Tab bar: 5 tab skeletons
    const tabBar = container.querySelector('.border-b');
    expect(tabBar).toBeInTheDocument();
    const tabSkeletons = tabBar!.querySelectorAll('.skeleton');
    expect(tabSkeletons.length).toBe(5);
  });

  it('renders form fields inside a nm-card', () => {
    const { container } = render(<SettingsSkeleton />);
    const glassCard = container.querySelector('.nm-card');
    expect(glassCard).toBeInTheDocument();
    // Form fields: 3 label+input pairs (6) + 1 submit button = 7
    const formSkeletons = glassCard!.querySelector('.p-6')!.querySelectorAll('.skeleton');
    expect(formSkeletons.length).toBeGreaterThanOrEqual(4);
  });

  it('renders a page title skeleton', () => {
    const { container } = render(<SettingsSkeleton />);
    // First child should be the title skeleton (h-7 w-32)
    const titleSkeleton = container.querySelector('[data-testid="settings-skeleton"] > .skeleton');
    expect(titleSkeleton).toBeInTheDocument();
  });
});
