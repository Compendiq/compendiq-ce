import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotesInspectorPanel } from './NotesInspectorPanel';
import type { Comment } from './CommentThread';

const mockComments: Comment[] = [
  {
    id: 'c-1',
    authorName: 'Alice',
    body: 'Great article!',
    createdAt: new Date().toISOString(),
    resolved: false,
    parentId: null,
  },
  {
    id: 'c-2',
    authorName: 'Bob',
    body: 'Needs some clarification.',
    createdAt: new Date().toISOString(),
    resolved: true,
    parentId: null,
  },
  {
    id: 'r-1',
    authorName: 'Charlie',
    body: 'I agree!',
    createdAt: new Date().toISOString(),
    resolved: false,
    parentId: 'c-1',
  },
];

let mockApiFetch: ReturnType<typeof vi.fn>;

vi.mock('../../lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

function renderNotesPanel(pageId = 'page-1') {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <NotesInspectorPanel pageId={pageId} />
    </QueryClientProvider>,
  );
}

describe('NotesInspectorPanel', () => {
  beforeEach(() => {
    mockApiFetch = vi.fn().mockResolvedValue(mockComments);
  });

  it('renders open and resolved filter tabs', async () => {
    renderNotesPanel();
    await waitFor(() => {
      expect(screen.getByTestId('notes-filter-open')).toHaveTextContent('Open (1)');
      expect(screen.getByTestId('notes-filter-resolved')).toHaveTextContent('Resolved (1)');
    });
  });

  it('renders open note threads by default', async () => {
    renderNotesPanel();
    await waitFor(() => {
      expect(screen.getByText('Great article!')).toBeInTheDocument();
      expect(screen.queryByText('Needs some clarification.')).not.toBeInTheDocument();
    });
  });

  it('switches to resolved note threads when resolved filter is clicked', async () => {
    renderNotesPanel();
    await waitFor(() => {
      expect(screen.getByTestId('notes-filter-resolved')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('notes-filter-resolved'));
    await waitFor(() => {
      expect(screen.getByText('Needs some clarification.')).toBeInTheDocument();
      expect(screen.queryByText('Great article!')).not.toBeInTheDocument();
    });
  });

  it('toggles new note composer form', async () => {
    renderNotesPanel();
    await waitFor(() => {
      expect(screen.getByTestId('add-page-note-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('add-page-note-btn'));
    expect(screen.getByPlaceholderText('Write a note about this page…')).toBeInTheDocument();
  });
});
