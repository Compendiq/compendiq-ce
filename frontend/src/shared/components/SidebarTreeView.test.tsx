import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SidebarTreeView } from './SidebarTreeView';
import { useUiStore } from '../../stores/ui-store';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockTreeData = {
  items: [
    { id: 'root-1', spaceKey: 'DEV', title: 'Getting Started', parentId: null, labels: [], lastModifiedAt: '2026-03-01T00:00:00Z' },
    { id: 'child-1', spaceKey: 'DEV', title: 'Installation', parentId: 'root-1', labels: [], lastModifiedAt: '2026-03-01T00:00:00Z' },
    { id: 'child-2', spaceKey: 'DEV', title: 'Configuration', parentId: 'root-1', labels: [], lastModifiedAt: '2026-03-01T00:00:00Z' },
    { id: 'root-2', spaceKey: 'DEV', title: 'API Reference', parentId: null, labels: [], lastModifiedAt: '2026-03-01T00:00:00Z' },
  ],
  total: 4,
};

const mockSpaces = [
  { key: 'DEV', name: 'Development', lastSynced: '2026-03-01T00:00:00Z', pageCount: 4 },
  { key: 'OPS', name: 'Operations', lastSynced: '2026-03-01T00:00:00Z', pageCount: 2 },
];

vi.mock('../hooks/use-pages', () => ({
  usePageTree: () => ({ data: mockTreeData, isLoading: false }),
}));

vi.mock('../hooks/use-spaces', () => ({
  useSpaces: () => ({ data: mockSpaces }),
}));

function createWrapper(initialPath = '/pages') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          {children}
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('SidebarTreeView', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    useUiStore.setState({
      treeSidebarCollapsed: false,
      treeSidebarSpaceKey: undefined,
    });
  });

  it('renders the Page Tree header', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    expect(screen.getByText('Page Tree')).toBeInTheDocument();
  });

  it('renders root pages', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    expect(screen.getByText('Getting Started')).toBeInTheDocument();
    expect(screen.getByText('API Reference')).toBeInTheDocument();
  });

  it('children are hidden by default', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    expect(screen.queryByText('Installation')).not.toBeInTheDocument();
  });

  it('expands node on chevron click to reveal children', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    const expandBtn = screen.getAllByLabelText('Expand')[0];
    fireEvent.click(expandBtn);
    expect(screen.getByText('Installation')).toBeInTheDocument();
    expect(screen.getByText('Configuration')).toBeInTheDocument();
  });

  it('navigates to page on click', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByText('API Reference'));
    expect(mockNavigate).toHaveBeenCalledWith('/pages/root-2');
  });

  it('shows collapsed state when treeSidebarCollapsed is true', () => {
    useUiStore.setState({ treeSidebarCollapsed: true });
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    expect(screen.queryByText('Page Tree')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Expand tree sidebar')).toBeInTheDocument();
  });

  it('shows space selector with All Spaces default', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    expect(screen.getByText('All Spaces')).toBeInTheDocument();
  });

  it('shows page count in footer', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    expect(screen.getByText('4 pages')).toBeInTheDocument();
  });

  it('opens space dropdown and shows space options', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByText('All Spaces'));
    expect(screen.getByText('Development')).toBeInTheDocument();
    expect(screen.getByText('Operations')).toBeInTheDocument();
  });
});
