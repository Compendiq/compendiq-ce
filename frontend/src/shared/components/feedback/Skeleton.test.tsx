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

  it('renders toolbar skeleton with back button and title placeholders', () => {
    const { container } = render(<PageViewSkeleton />);
    // Toolbar row: back button (1) + title (1) + 4 action buttons = 6
    const toolbarSkeletons = container.querySelectorAll('[data-testid="page-view-skeleton"] > div:first-child .skeleton');
    expect(toolbarSkeletons.length).toBe(6);
  });

  it('renders metadata bar inside a nm-card', () => {
    const { container } = render(<PageViewSkeleton />);
    const glassCards = container.querySelectorAll('.nm-card');
    // Metadata bar (1) + content area (1) = at least 2 glass-cards
    expect(glassCards.length).toBeGreaterThanOrEqual(2);
  });

  it('renders content area with heading and paragraph skeleton lines', () => {
    const { container } = render(<PageViewSkeleton />);
    // Total skeleton elements should be substantial (toolbar + metadata + content + sidebar)
    const allSkeletons = container.querySelectorAll('.skeleton');
    expect(allSkeletons.length).toBeGreaterThanOrEqual(20);
  });

  it('renders sidebar skeleton for table of contents', () => {
    const { container } = render(<PageViewSkeleton />);
    // Sidebar has lg:block class (hidden on small screens)
    const sidebar = container.querySelector('.lg\\:block');
    expect(sidebar).toBeInTheDocument();
    const sidebarSkeletons = sidebar!.querySelectorAll('.skeleton');
    expect(sidebarSkeletons.length).toBeGreaterThanOrEqual(3);
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
