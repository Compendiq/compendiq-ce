import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { LocationPicker } from './LocationPicker';

const mockTreeData = {
  items: [
    { id: 'root-1', spaceKey: 'DEV', title: 'Getting Started', parentId: null, labels: [], lastModifiedAt: '2026-03-01T00:00:00Z', embeddingDirty: false },
    { id: 'child-1', spaceKey: 'DEV', title: 'Installation', parentId: 'root-1', labels: [], lastModifiedAt: '2026-03-01T00:00:00Z', embeddingDirty: false },
    { id: 'child-2', spaceKey: 'DEV', title: 'Configuration', parentId: 'root-1', labels: [], lastModifiedAt: '2026-03-01T00:00:00Z', embeddingDirty: false },
    { id: 'root-2', spaceKey: 'DEV', title: 'API Reference', parentId: null, labels: [], lastModifiedAt: '2026-03-01T00:00:00Z', embeddingDirty: false },
  ],
  total: 4,
};

const mockSpaces = [
  { key: 'DEV', name: 'Development', homepageId: null, lastSynced: '2026-03-01T00:00:00Z', pageCount: 4 },
  { key: 'OPS', name: 'Operations', homepageId: null, lastSynced: '2026-03-01T00:00:00Z', pageCount: 2 },
];

vi.mock('../hooks/use-pages', () => ({
  usePageTree: () => ({ data: mockTreeData, isLoading: false }),
}));

vi.mock('../hooks/use-spaces', () => ({
  useSpaces: () => ({ data: mockSpaces }),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          {children}
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('LocationPicker', () => {
  const mockOnSelect = vi.fn();

  beforeEach(() => {
    mockOnSelect.mockClear();
  });

  it('renders with "Root" breadcrumb when no parent is selected', () => {
    render(
      <LocationPicker
        spaceKey="DEV"
        onSelect={mockOnSelect}
      />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByText('Root')).toBeInTheDocument();
    expect(screen.getByText('Development')).toBeInTheDocument();
  });

  it('renders breadcrumb trail when parentId is set', () => {
    render(
      <LocationPicker
        spaceKey="DEV"
        parentId="child-1"
        onSelect={mockOnSelect}
      />,
      { wrapper: createWrapper() },
    );
    // Should show Development > Getting Started > Installation
    expect(screen.getByText('Development')).toBeInTheDocument();
    expect(screen.getByText('Getting Started')).toBeInTheDocument();
    expect(screen.getByText('Installation')).toBeInTheDocument();
  });

  it('shows "Select a space first" when no spaceKey is provided', () => {
    render(
      <LocationPicker
        spaceKey=""
        onSelect={mockOnSelect}
      />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByText('Select a space first')).toBeInTheDocument();
  });

  it('disables the trigger when disabled prop is true', () => {
    render(
      <LocationPicker
        spaceKey="DEV"
        onSelect={mockOnSelect}
        disabled
      />,
      { wrapper: createWrapper() },
    );
    const trigger = screen.getByLabelText('Select page location');
    expect(trigger).toBeDisabled();
  });

  it('opens popover and shows search bar and root option on click', async () => {
    render(
      <LocationPicker
        spaceKey="DEV"
        onSelect={mockOnSelect}
      />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByLabelText('Select page location'));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search pages...')).toBeInTheDocument();
      expect(screen.getByText('Root level (no parent)')).toBeInTheDocument();
    });
  });

  it('shows page tree in popover', async () => {
    render(
      <LocationPicker
        spaceKey="DEV"
        onSelect={mockOnSelect}
      />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByLabelText('Select page location'));

    await waitFor(() => {
      expect(screen.getByText('Getting Started')).toBeInTheDocument();
      expect(screen.getByText('API Reference')).toBeInTheDocument();
    });
  });

  it('expands tree node on chevron click to reveal children', async () => {
    render(
      <LocationPicker
        spaceKey="DEV"
        onSelect={mockOnSelect}
      />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByLabelText('Select page location'));

    await waitFor(() => {
      expect(screen.getByText('Getting Started')).toBeInTheDocument();
    });

    // Children should not be visible yet
    expect(screen.queryByText('Installation')).not.toBeInTheDocument();

    // Click expand on Getting Started
    const expandBtns = screen.getAllByLabelText('Expand');
    fireEvent.click(expandBtns[0]);

    expect(screen.getByText('Installation')).toBeInTheDocument();
    expect(screen.getByText('Configuration')).toBeInTheDocument();
  });

  it('calls onSelect with correct data when Confirm is clicked', async () => {
    render(
      <LocationPicker
        spaceKey="DEV"
        onSelect={mockOnSelect}
      />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByLabelText('Select page location'));

    await waitFor(() => {
      expect(screen.getByText('API Reference')).toBeInTheDocument();
    });

    // Select a page
    fireEvent.click(screen.getByText('API Reference'));

    // Confirm
    fireEvent.click(screen.getByText('Confirm'));

    expect(mockOnSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceKey: 'DEV',
        parentId: 'root-2',
        breadcrumb: expect.arrayContaining(['Development', 'API Reference']),
      }),
    );
  });

  it('calls onSelect with no parentId when Root option is selected and confirmed', async () => {
    render(
      <LocationPicker
        spaceKey="DEV"
        parentId="root-1"
        onSelect={mockOnSelect}
      />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByLabelText('Select page location'));

    await waitFor(() => {
      expect(screen.getByText('Root level (no parent)')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Root level (no parent)'));
    fireEvent.click(screen.getByText('Confirm'));

    expect(mockOnSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceKey: 'DEV',
        parentId: undefined,
        breadcrumb: expect.arrayContaining(['Development', 'Root']),
      }),
    );
  });

  it('filters tree when search query is entered', async () => {
    render(
      <LocationPicker
        spaceKey="DEV"
        onSelect={mockOnSelect}
      />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByLabelText('Select page location'));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search pages...')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText('Search pages...');
    fireEvent.change(searchInput, { target: { value: 'install' } });

    // "Installation" should still be visible (matches search)
    // Its parent "Getting Started" should appear too (ancestor of match)
    await waitFor(() => {
      expect(screen.getByText('Installation')).toBeInTheDocument();
      expect(screen.getByText('Getting Started')).toBeInTheDocument();
    });

    // "API Reference" should be filtered out
    expect(screen.queryByText('API Reference')).not.toBeInTheDocument();
  });

  it('clears search when X button is clicked', async () => {
    render(
      <LocationPicker
        spaceKey="DEV"
        onSelect={mockOnSelect}
      />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByLabelText('Select page location'));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search pages...')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText('Search pages...');
    fireEvent.change(searchInput, { target: { value: 'install' } });

    const clearBtn = screen.getByLabelText('Clear search');
    fireEvent.click(clearBtn);

    expect(searchInput).toHaveValue('');
    // All items should be visible again
    expect(screen.getByText('Getting Started')).toBeInTheDocument();
    expect(screen.getByText('API Reference')).toBeInTheDocument();
  });

  it('excludes a page from the tree when excludePageId is set', async () => {
    render(
      <LocationPicker
        spaceKey="DEV"
        onSelect={mockOnSelect}
        excludePageId="root-2"
      />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByLabelText('Select page location'));

    await waitFor(() => {
      expect(screen.getByText('Getting Started')).toBeInTheDocument();
    });

    // "API Reference" (root-2) should be excluded
    expect(screen.queryByText('API Reference')).not.toBeInTheDocument();
  });
});
