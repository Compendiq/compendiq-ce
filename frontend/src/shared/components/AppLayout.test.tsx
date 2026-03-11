import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domMax } from 'framer-motion';
import { AppLayout } from './AppLayout';

// Mock SidebarTreeView to isolate AppLayout tests
vi.mock('./SidebarTreeView', () => ({
  SidebarTreeView: () => <div data-testid="sidebar-tree-view">Tree Sidebar</div>,
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

vi.mock('./AuroraBackground', () => ({
  AuroraBackground: () => <div data-testid="aurora-background" />,
}));

vi.mock('./NoiseOverlay', () => ({
  NoiseOverlay: () => null,
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

  it('renders top navigation with nav items (no Settings or Dashboard)', () => {
    render(
      <AppLayout>
        <div>content</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    // "Pages" appears in both nav and breadcrumb on root route
    expect(screen.getAllByText('Pages').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('AI Assistant')).toBeInTheDocument();
    // Settings moved to UserMenu, Dashboard merged into Pages
    expect(screen.queryByText('Settings')).not.toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  });

  it('renders app logo in sidebar on pages route', () => {
    render(
      <AppLayout>
        <div>content</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    // Logo is inside the sidebar (mocked) on pages routes, not in the top bar
    expect(screen.queryByText('AI KB Creator')).not.toBeInTheDocument();
  });

  it('renders app logo in top bar when sidebar is hidden', () => {
    render(
      <AppLayout>
        <div>content</div>
      </AppLayout>,
      { wrapper: createWrapper('/ai') },
    );
    expect(screen.getByText('AI KB Creator')).toBeInTheDocument();
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

  it('shows tree sidebar on root route (pages view)', () => {
    render(
      <AppLayout>
        <div>page content</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
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

  it('hides tree sidebar on /ai route', () => {
    render(
      <AppLayout>
        <div>ai page</div>
      </AppLayout>,
      { wrapper: createWrapper('/ai') },
    );
    expect(screen.queryByTestId('sidebar-tree-view')).not.toBeInTheDocument();
  });

  it('hides tree sidebar on /settings route', () => {
    render(
      <AppLayout>
        <div>settings</div>
      </AppLayout>,
      { wrapper: createWrapper('/settings') },
    );
    expect(screen.queryByTestId('sidebar-tree-view')).not.toBeInTheDocument();
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
});
