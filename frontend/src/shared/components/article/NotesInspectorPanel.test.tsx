import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotesInspectorPanel } from './NotesInspectorPanel';
import { CommentForm } from './CommentForm';
import { CommentThread, type Comment } from './CommentThread';

const mockComments: Comment[] = [
  {
    id: 'c-1',
    authorName: 'Alice',
    body: 'Great article!',
    createdAt: new Date().toISOString(),
    resolved: false,
    parentId: null,
    anchorData: {
      quote: 'Important section in article',
    },
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

function renderNotesPanel(pageId: string | null = 'page-1') {
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
    expect(screen.getByPlaceholderText(/Write a note about this page/)).toBeInTheDocument();
  });

  it('shows graceful fallback when pageId is null/unsaved', () => {
    renderNotesPanel(null);
    expect(screen.getByText('Notes are available on saved pages')).toBeInTheDocument();
  });

  it('renders error state on API failure and allows retry', async () => {
    mockApiFetch = vi.fn().mockRejectedValueOnce(new Error('Network error'));
    renderNotesPanel('page-err');

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText('Failed to load notes')).toBeInTheDocument();
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });

    mockApiFetch.mockResolvedValueOnce(mockComments);
    fireEvent.click(screen.getByText('Retry'));

    await waitFor(() => {
      expect(screen.getByText('Great article!')).toBeInTheDocument();
    });
  });
});

describe('CommentForm & CommentThread Keyboard & Resilience', () => {
  it('submits form via Cmd+Enter / Ctrl+Enter', async () => {
    const onSubmit = vi.fn();
    render(<CommentForm onSubmit={onSubmit} placeholder="Write a note..." />);

    const textarea = screen.getByTestId('comment-textarea');
    fireEvent.change(textarea, { target: { value: 'Keyboard submit test' } });

    // Meta+Enter (Mac Cmd+Enter)
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    expect(onSubmit).toHaveBeenCalledWith('Keyboard submit test');
  });

  it('cancels form via Escape key', () => {
    const onCancel = vi.fn();
    render(<CommentForm onSubmit={vi.fn()} onCancel={onCancel} />);

    const textarea = screen.getByTestId('comment-textarea');
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('preserves typed text on async submission failure (prevents data loss)', async () => {
    let rejectPromise: (err: Error) => void;
    const asyncSubmit = vi.fn().mockImplementation(() => {
      return new Promise<void>((_, reject) => {
        rejectPromise = reject;
      });
    });

    render(<CommentForm onSubmit={asyncSubmit} />);
    const textarea = screen.getByTestId('comment-textarea');
    fireEvent.change(textarea, { target: { value: 'Critical feedback that must not be lost' } });

    fireEvent.click(screen.getByTestId('comment-submit'));
    expect(asyncSubmit).toHaveBeenCalled();

    // Simulate async API rejection
    rejectPromise!(new Error('Server error'));
    await waitFor(() => {
      // Value is still in textarea
      expect(textarea).toHaveValue('Critical feedback that must not be lost');
    });
  });

  it('clears typed text when async submission succeeds', async () => {
    const asyncSubmit = vi.fn().mockResolvedValue(undefined);

    render(<CommentForm onSubmit={asyncSubmit} />);
    const textarea = screen.getByTestId('comment-textarea');
    fireEvent.change(textarea, { target: { value: 'Good note' } });

    fireEvent.click(screen.getByTestId('comment-submit'));
    await waitFor(() => {
      expect(textarea).toHaveValue('');
    });
  });

  it('allows keyboard navigation and activation for quote jump button', () => {
    const onJumpToAnchor = vi.fn();
    const commentWithQuote: Comment = {
      id: 'c-quote',
      authorName: 'Dan',
      body: 'Reviewing this snippet',
      createdAt: new Date().toISOString(),
      anchorData: { quote: 'Highlighted text from editor' },
    };

    render(
      <CommentThread
        comment={commentWithQuote}
        onReply={vi.fn()}
        onResolve={vi.fn()}
        onUnresolve={vi.fn()}
        onJumpToAnchor={onJumpToAnchor}
      />,
    );

    const quoteBtn = screen.getByTestId('comment-quote-c-quote');
    expect(quoteBtn.tagName).toBe('BUTTON');

    // Click
    fireEvent.click(quoteBtn);
    expect(onJumpToAnchor).toHaveBeenCalledWith('c-quote');

    // Enter key
    fireEvent.keyDown(quoteBtn, { key: 'Enter' });
    expect(onJumpToAnchor).toHaveBeenCalledTimes(2);

    // Space key
    fireEvent.keyDown(quoteBtn, { key: ' ' });
    expect(onJumpToAnchor).toHaveBeenCalledTimes(3);
  });
});
