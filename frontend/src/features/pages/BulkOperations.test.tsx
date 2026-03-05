import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { BulkOperations } from './BulkOperations';

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

describe('BulkOperations', () => {
  const defaultProps = {
    selectedIds: ['page-1', 'page-2'],
    totalCount: 10,
    onSelectAll: vi.fn(),
    onDeselectAll: vi.fn(),
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ succeeded: 2, failed: 0, errors: [] }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when no pages are selected', () => {
    const { container } = render(
      <BulkOperations {...defaultProps} selectedIds={[]} />,
      { wrapper: createWrapper() },
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders the bulk operations bar when pages are selected', () => {
    render(<BulkOperations {...defaultProps} />, { wrapper: createWrapper() });

    expect(screen.getByTestId('bulk-operations-bar')).toBeInTheDocument();
    expect(screen.getByTestId('selection-count')).toHaveTextContent('2 pages selected');
  });

  it('shows singular form for single selection', () => {
    render(
      <BulkOperations {...defaultProps} selectedIds={['page-1']} />,
      { wrapper: createWrapper() },
    );

    expect(screen.getByTestId('selection-count')).toHaveTextContent('1 page selected');
  });

  it('calls onSelectAll when Select All is clicked', () => {
    render(<BulkOperations {...defaultProps} />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByTestId('select-toggle'));
    expect(defaultProps.onSelectAll).toHaveBeenCalled();
  });

  it('calls onDeselectAll when all are selected and Deselect All is clicked', () => {
    render(
      <BulkOperations {...defaultProps} selectedIds={Array.from({ length: 10 }, (_, i) => `page-${i}`)} totalCount={10} />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByTestId('select-toggle'));
    expect(defaultProps.onDeselectAll).toHaveBeenCalled();
  });

  it('shows delete confirmation dialog on delete click', () => {
    render(<BulkOperations {...defaultProps} />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByTestId('bulk-delete-btn'));
    expect(screen.getByTestId('delete-confirm')).toBeInTheDocument();
    expect(screen.getByText('Delete 2 pages?')).toBeInTheDocument();
  });

  it('hides delete confirmation on cancel', () => {
    render(<BulkOperations {...defaultProps} />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByTestId('bulk-delete-btn'));
    expect(screen.getByTestId('delete-confirm')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('delete-cancel-btn'));
    expect(screen.queryByTestId('delete-confirm')).not.toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    render(<BulkOperations {...defaultProps} />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByTestId('bulk-close-btn'));
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('shows tag popover when Tag button is clicked', () => {
    render(<BulkOperations {...defaultProps} />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByTestId('bulk-tag-btn'));
    expect(screen.getByTestId('tag-popover')).toBeInTheDocument();
    expect(screen.getByTestId('tag-input')).toBeInTheDocument();
  });

  it('has all action buttons', () => {
    render(<BulkOperations {...defaultProps} />, { wrapper: createWrapper() });

    expect(screen.getByTestId('bulk-sync-btn')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-embed-btn')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-tag-btn')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-delete-btn')).toBeInTheDocument();
  });
});
