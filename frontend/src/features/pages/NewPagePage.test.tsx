import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { NewPagePage } from './NewPagePage';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockCreateMutateAsync = vi.fn();
vi.mock('../../shared/hooks/use-pages', () => ({
  useCreatePage: () => ({
    mutateAsync: mockCreateMutateAsync,
    isPending: false,
  }),
  usePageTree: () => ({
    data: {
      items: [
        { id: 'page-1', spaceKey: 'DEV', title: 'Getting Started', parentId: null, labels: [], lastModifiedAt: '2026-03-01T00:00:00Z', embeddingDirty: false },
        { id: 'page-2', spaceKey: 'DEV', title: 'Installation', parentId: 'page-1', labels: [], lastModifiedAt: '2026-03-01T00:00:00Z', embeddingDirty: false },
      ],
      total: 2,
    },
    isLoading: false,
  }),
}));

vi.mock('../../shared/hooks/use-spaces', () => ({
  useSpaces: () => ({
    data: [
      { key: 'DEV', name: 'Development', homepageId: null, lastSynced: '2026-03-01T00:00:00Z', pageCount: 10 },
      { key: 'OPS', name: 'Operations', homepageId: null, lastSynced: '2026-03-01T00:00:00Z', pageCount: 5 },
    ],
  }),
}));

vi.mock('../../shared/hooks/use-standalone', () => ({
  useTemplates: () => ({ data: { items: [] }, isLoading: false }),
  useUseTemplate: () => ({ mutateAsync: vi.fn() }),
  useImportMarkdown: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// Mock Editor to avoid complex TipTap setup
vi.mock('../../shared/components/article/Editor', () => ({
  Editor: ({ onChange }: { content: string; onChange: (html: string) => void; placeholder: string; draftKey: string }) => (
    <textarea
      data-testid="mock-editor"
      onChange={(e) => onChange(e.target.value)}
    />
  ),
  clearDraft: vi.fn(),
}));

vi.mock('../../shared/components/feedback/FeatureErrorBoundary', () => ({
  FeatureErrorBoundary: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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

describe('NewPagePage', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockCreateMutateAsync.mockClear();
  });

  it('renders the New Page title and form fields', () => {
    render(<NewPagePage />, { wrapper: createWrapper() });
    expect(screen.getByText('New Page')).toBeInTheDocument();
    expect(screen.getByTestId('title-input')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Untitled page')).toBeInTheDocument();
  });

  it('shows article type toggle defaulting to Local Article', () => {
    render(<NewPagePage />, { wrapper: createWrapper() });
    expect(screen.getByTestId('article-type-local')).toBeInTheDocument();
    expect(screen.getByTestId('article-type-confluence')).toBeInTheDocument();
  });

  it('shows space selector when Confluence article type is selected', () => {
    render(<NewPagePage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('article-type-confluence'));
    expect(screen.getByTestId('space-selector')).toBeInTheDocument();
  });

  it('shows location picker when a Confluence space is selected', async () => {
    render(<NewPagePage />, { wrapper: createWrapper() });

    // Switch to Confluence mode
    fireEvent.click(screen.getByTestId('article-type-confluence'));

    // Select a space
    const spaceSelect = screen.getByTestId('space-selector');
    fireEvent.change(spaceSelect, { target: { value: 'DEV' } });

    // Location picker section should appear
    await waitFor(() => {
      expect(screen.getByTestId('location-picker-section')).toBeInTheDocument();
    });
  });

  it('does not show location picker when no space is selected', () => {
    render(<NewPagePage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('article-type-confluence'));
    expect(screen.queryByTestId('location-picker-section')).not.toBeInTheDocument();
  });

  it('shows location picker for local articles', () => {
    render(<NewPagePage />, { wrapper: createWrapper() });
    // Default is local - location picker should show for organizing local pages
    expect(screen.getByTestId('location-picker-section')).toBeInTheDocument();
  });

  it('creates a page with parentId when location is selected', async () => {
    mockCreateMutateAsync.mockResolvedValueOnce({ id: 'new-page-id', title: 'Child', version: 1 });

    render(<NewPagePage />, { wrapper: createWrapper() });

    // Switch to Confluence mode and select space
    fireEvent.click(screen.getByTestId('article-type-confluence'));
    fireEvent.change(screen.getByTestId('space-selector'), { target: { value: 'DEV' } });

    // Wait for location picker
    await waitFor(() => {
      expect(screen.getByTestId('location-picker-section')).toBeInTheDocument();
    });

    // Open the location picker
    fireEvent.click(screen.getByLabelText('Select page location'));

    // Wait for tree to render
    await waitFor(() => {
      expect(screen.getByText('Getting Started')).toBeInTheDocument();
    });

    // Select "Getting Started" as parent
    fireEvent.click(screen.getByText('Getting Started'));
    fireEvent.click(screen.getByText('Confirm'));

    // Fill in title
    fireEvent.change(screen.getByPlaceholderText('Untitled page'), { target: { value: 'Child Page' } });

    // Add editor content
    fireEvent.change(screen.getByTestId('mock-editor'), { target: { value: '<p>Content</p>' } });

    // Create the page
    fireEvent.click(screen.getByText('Create Page'));

    await waitFor(() => {
      expect(mockCreateMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          spaceKey: 'DEV',
          title: 'Child Page',
          parentId: 'page-1',
        }),
      );
    });
  });

  it('resets parentId when space changes', async () => {
    render(<NewPagePage />, { wrapper: createWrapper() });

    // Switch to Confluence
    fireEvent.click(screen.getByTestId('article-type-confluence'));

    // Select DEV space
    fireEvent.change(screen.getByTestId('space-selector'), { target: { value: 'DEV' } });

    await waitFor(() => {
      expect(screen.getByTestId('location-picker-section')).toBeInTheDocument();
    });

    // Open picker, select a parent
    fireEvent.click(screen.getByLabelText('Select page location'));
    await waitFor(() => {
      expect(screen.getByText('Getting Started')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Getting Started'));
    fireEvent.click(screen.getByText('Confirm'));

    // Now change the space
    fireEvent.change(screen.getByTestId('space-selector'), { target: { value: 'OPS' } });

    // The breadcrumb should reset to Root level
    await waitFor(() => {
      expect(screen.getByText('Root')).toBeInTheDocument();
    });
  });
});
