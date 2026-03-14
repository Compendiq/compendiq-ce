import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Breadcrumb } from './Breadcrumb';

// Mock the breadcrumb hook
const mockBreadcrumbData = {
  spaceKey: 'DEV',
  spaceName: 'Development',
  ancestors: [
    { id: 100, title: 'Getting Started' },
  ],
  current: { id: 200, title: 'Installation Guide' },
};

let breadcrumbEnabled = false;

vi.mock('../../hooks/use-standalone', () => ({
  usePageBreadcrumb: (pageId: string | undefined) => ({
    data: breadcrumbEnabled && pageId ? mockBreadcrumbData : undefined,
    isLoading: false,
  }),
}));

function renderAt(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Breadcrumb />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Breadcrumb', () => {
  beforeEach(() => {
    breadcrumbEnabled = false;
  });

  it('shows Pages on root path with nav wrapper', () => {
    renderAt('/');
    expect(screen.getByText('Pages')).toBeInTheDocument();
    expect(screen.getByLabelText('Breadcrumb')).toBeInTheDocument();
  });

  it('shows Pages breadcrumb', () => {
    renderAt('/pages');
    expect(screen.getByText('Pages')).toBeInTheDocument();
  });

  it('shows nested breadcrumb for new page', () => {
    renderAt('/pages/new');
    expect(screen.getByText('Pages')).toBeInTheDocument();
    expect(screen.getByText('New Page')).toBeInTheDocument();
  });

  it('shows Settings breadcrumb', () => {
    renderAt('/settings');
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('shows AI Assistant breadcrumb', () => {
    renderAt('/ai');
    expect(screen.getByText('AI Assistant')).toBeInTheDocument();
  });

  it('has a home link on non-root paths', () => {
    renderAt('/pages');
    const nav = screen.getByLabelText('Breadcrumb');
    expect(nav).toBeInTheDocument();
  });

  it('shows New Space breadcrumb', () => {
    renderAt('/spaces/new');
    expect(screen.getByText('New Space')).toBeInTheDocument();
  });

  describe('hierarchy-aware breadcrumb', () => {
    beforeEach(() => {
      breadcrumbEnabled = true;
    });

    it('shows space name, ancestors, and current page for page routes', () => {
      renderAt('/pages/200');
      expect(screen.getByText('Development')).toBeInTheDocument();
      expect(screen.getByText('Getting Started')).toBeInTheDocument();
      expect(screen.getByText('Installation Guide')).toBeInTheDocument();
    });

    it('ancestor links navigate to ancestor pages', () => {
      renderAt('/pages/200');
      const ancestorLink = screen.getByText('Getting Started');
      expect(ancestorLink.closest('a')).toHaveAttribute('href', '/pages/100');
    });

    it('current page is not a link', () => {
      renderAt('/pages/200');
      const current = screen.getByText('Installation Guide');
      expect(current.closest('a')).toBeNull();
    });
  });
});
