import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { LabelManager } from './LabelManager';

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

const mockLabels = [
  { name: 'architecture', pageCount: 5 },
  { name: 'howto', pageCount: 12 },
  { name: 'troubleshooting', pageCount: 3 },
];

describe('LabelManager', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockLabels), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the label manager', async () => {
    render(<LabelManager />, { wrapper: createWrapper() });

    expect(screen.getByTestId('label-manager')).toBeInTheDocument();
    expect(screen.getByText('Label Manager')).toBeInTheDocument();
  });

  it('shows labels with page counts', async () => {
    render(<LabelManager />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('architecture')).toBeInTheDocument();
      expect(screen.getByText('12')).toBeInTheDocument();
    });
  });

  it('filters labels by search', async () => {
    render(<LabelManager />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('architecture')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('label-search'), { target: { value: 'howto' } });

    expect(screen.getByText('howto')).toBeInTheDocument();
    expect(screen.queryByText('architecture')).not.toBeInTheDocument();
  });

  it('shows rename input when edit button is clicked', async () => {
    render(<LabelManager />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('rename-architecture')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('rename-architecture'));

    expect(screen.getByTestId('rename-input')).toBeInTheDocument();
    expect(screen.getByTestId('rename-input')).toHaveValue('architecture');
  });

  it('shows delete confirmation when delete button is clicked', async () => {
    render(<LabelManager />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('delete-architecture')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('delete-architecture'));

    expect(screen.getByTestId('delete-confirm-architecture')).toBeInTheDocument();
  });

  it('shows merge dialog when merge button is clicked', async () => {
    render(<LabelManager />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('merge-architecture')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('merge-architecture'));

    expect(screen.getByTestId('merge-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('merge-target-select')).toBeInTheDocument();
  });

  it('shows label count summary', async () => {
    render(<LabelManager />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('3 labels across all pages')).toBeInTheDocument();
    });
  });

  it('shows empty state when no labels exist', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([]), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    render(<LabelManager />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('No labels found across any pages')).toBeInTheDocument();
    });
  });
});
