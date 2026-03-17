import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domMax } from 'framer-motion';
import { AppLayout } from './AppLayout';

// Mock SidebarTreeView to isolate AppLayout tests
vi.mock('./SidebarTreeView', () => ({
  SidebarTreeView: ({ onNavigate: _onNavigate }: { onNavigate?: () => void }) => (
    <div data-testid="sidebar-tree-view">Tree Sidebar</div>
  ),
}));

vi.mock('./ArticleRightPane', () => ({
  ArticleRightPane: () => <div data-testid="article-right-pane">Article Right Pane</div>,
}));

vi.mock('./CommandPalette', () => ({
  CommandPalette: () => null,
}));

vi.mock('./ServiceStatus', () => ({
  ServiceStatus: () => null,
}));

vi.mock('./ThemeToggle', () => ({
  ThemeToggle: () => <div data-testid="theme-toggle" />,
}));

function createWrapper(initialPath = '/') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <LazyMotion features={domMax}>
            {children}
          </LazyMotion>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('AppLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom does not implement Element.scrollTo — stub it so the scroll-reset
    // useEffect in AppLayout does not throw
    Element.prototype.scrollTo = vi.fn();
  });

  it('renders header without nav pills (nav moved to sidebar)', () => {
    render(
      <AppLayout>
        <div>content</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    // Nav pills are no longer in the header — they live in SidebarTreeView
    const header = document.querySelector('header');
    expect(header).toBeTruthy();
    // "Graph" and "AI Assistant" should NOT be in the header anymore
    // (they're in the mocked sidebar which doesn't render them)
    expect(header!.querySelector('a[href="/graph"]')).toBeNull();
    expect(header!.querySelector('a[href="/ai"]')).toBeNull();
  });

  it('renders app logo in top header bar on all routes', () => {
    const { unmount } = render(
      <AppLayout>
        <div>content</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    // Logo SVG (role="img" with aria-label) is always in the top header bar
    expect(screen.getByRole('img', { name: 'AtlasMind' })).toBeInTheDocument();
    unmount();

    render(
      <AppLayout>
        <div>content</div>
      </AppLayout>,
      { wrapper: createWrapper('/ai') },
    );
    expect(screen.getByRole('img', { name: 'AtlasMind' })).toBeInTheDocument();
  });

  it('header spans full width above sidebar and content', () => {
    const { container } = render(
      <AppLayout>
        <div>content</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    // Root container should be flex-col (vertical stacking: header on top)
    const rootDiv = container.firstElementChild as HTMLElement;
    expect(rootDiv.className).toContain('flex-col');

    // Header should be a direct child of the root (not nested inside sidebar wrapper)
    const header = rootDiv.querySelector('header');
    expect(header).toBeTruthy();
    expect(header!.parentElement).toBe(rootDiv);
  });

  it('renders search button in top bar', () => {
    render(
      <AppLayout>
        <div>content</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    expect(screen.getByText('Search...')).toBeInTheDocument();
  });

  it('shows sidebar on all routes (always visible)', () => {
    // Pages route
    const { unmount } = render(
      <AppLayout>
        <div>page content</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    expect(screen.getByTestId('sidebar-tree-view')).toBeInTheDocument();
    unmount();

    // AI route — sidebar should now be visible here too
    const { unmount: unmount2 } = render(
      <AppLayout>
        <div>ai page</div>
      </AppLayout>,
      { wrapper: createWrapper('/ai') },
    );
    expect(screen.getByTestId('sidebar-tree-view')).toBeInTheDocument();
    unmount2();

    // Settings route — sidebar visible
    render(
      <AppLayout>
        <div>settings</div>
      </AppLayout>,
      { wrapper: createWrapper('/settings') },
    );
    expect(screen.getByTestId('sidebar-tree-view')).toBeInTheDocument();
  });

  it('shows tree sidebar on /pages/:id route', () => {
    render(
      <AppLayout>
        <div>page detail</div>
      </AppLayout>,
      { wrapper: createWrapper('/pages/123') },
    );
    expect(screen.getByTestId('sidebar-tree-view')).toBeInTheDocument();
  });

  it('renders children content', () => {
    render(
      <AppLayout>
        <div>test content here</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    expect(screen.getByText('test content here')).toBeInTheDocument();
  });

  it('shows article right pane on /pages/:id route', () => {
    render(
      <AppLayout>
        <div>article</div>
      </AppLayout>,
      { wrapper: createWrapper('/pages/123') },
    );
    expect(screen.getByTestId('article-right-pane')).toBeInTheDocument();
  });

  it('hides article right pane on non-article routes', () => {
    render(
      <AppLayout>
        <div>ai page</div>
      </AppLayout>,
      { wrapper: createWrapper('/ai') },
    );
    expect(screen.queryByTestId('article-right-pane')).not.toBeInTheDocument();
  });

  it('hides article right pane on root route', () => {
    render(
      <AppLayout>
        <div>pages</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    expect(screen.queryByTestId('article-right-pane')).not.toBeInTheDocument();
  });

  it('has exactly one scroll container (data-scroll-container) to prevent duplicate scrollbars', () => {
    const { container } = render(
      <AppLayout>
        <div>content</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    const scrollContainers = container.querySelectorAll('[data-scroll-container]');
    expect(scrollContainers).toHaveLength(1);

    const scrollEl = scrollContainers[0] as HTMLElement;
    expect(scrollEl.className).toContain('overflow-y-auto');
  });

  it('root layout container prevents outer scrolling with overflow-hidden', () => {
    const { container } = render(
      <AppLayout>
        <div>content</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    // The outermost div should clip overflow to prevent body-level scrollbar
    const rootDiv = container.firstElementChild as HTMLElement;
    expect(rootDiv.className).toContain('overflow-hidden');
    expect(rootDiv.className).toContain('h-screen');
  });

  it('panel wrapper uses uniform p-3 padding', () => {
    render(
      <AppLayout>
        <div>content</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    const panelWrapper = screen.getByTestId('panel-wrapper');
    expect(panelWrapper.className).toContain('p-3');
  });

  it('has mobile sidebar toggle button', () => {
    render(
      <AppLayout>
        <div>content</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    expect(screen.getByLabelText('Toggle sidebar')).toBeInTheDocument();
  });
});
