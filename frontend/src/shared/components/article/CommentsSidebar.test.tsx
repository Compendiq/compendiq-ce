import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CommentsSidebar } from './CommentsSidebar';
import type { Comment } from './CommentThread';

// Mock framer-motion
vi.mock('framer-motion', () => ({
  m: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    aside: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => <aside {...props}>{children}</aside>,
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

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

function renderSidebar(pageId = 'page-1') {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CommentsSidebar pageId={pageId} />
    </QueryClientProvider>,
  );
}

describe('CommentsSidebar', () => {
  beforeEach(() => {
    mockApiFetch = vi.fn().mockResolvedValue(mockComments);
  });

  it('renders toggle button', () => {
    renderSidebar();
    expect(screen.getByTestId('comments-toggle')).toBeInTheDocument();
    expect(screen.getByText('Comments')).toBeInTheDocument();
  });

  it('opens sidebar panel when toggle is clicked', async () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId('comments-toggle'));
    await vi.waitFor(() => {
      expect(screen.getByTestId('comments-sidebar')).toBeInTheDocument();
    });
  });

  it('shows comment count on toggle button', async () => {
    renderSidebar();
    // Wait for the query to resolve and show count
    await vi.waitFor(() => {
      // 2 top-level comments (c-1 and c-2, r-1 is a reply)
      expect(screen.getByText('2')).toBeInTheDocument();
    });
  });

  it('shows comment form in sidebar', async () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId('comments-toggle'));
    await vi.waitFor(() => {
      expect(screen.getByTestId('comment-form')).toBeInTheDocument();
    });
  });

  it('closes sidebar when close button is clicked', async () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId('comments-toggle'));
    await vi.waitFor(() => {
      expect(screen.getByTestId('comments-sidebar')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('comments-close'));
    expect(screen.queryByTestId('comments-sidebar')).not.toBeInTheDocument();
  });

  it('renders unresolved threads after loading', async () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId('comments-toggle'));
    await vi.waitFor(() => {
      expect(screen.getByText('Great article!')).toBeInTheDocument();
    });
  });

  it('hides resolved threads by default and shows toggle', async () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId('comments-toggle'));
    await vi.waitFor(() => {
      expect(screen.getByTestId('show-resolved-toggle')).toBeInTheDocument();
    });
    expect(screen.getByTestId('show-resolved-toggle')).toHaveTextContent('Show 1 resolved thread');
  });

  it('shows resolved threads when toggle is clicked', async () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId('comments-toggle'));
    await vi.waitFor(() => {
      expect(screen.getByTestId('show-resolved-toggle')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('show-resolved-toggle'));
    expect(screen.getByText('Needs some clarification.')).toBeInTheDocument();
  });

  it('shows empty state when no comments exist', async () => {
    mockApiFetch = vi.fn().mockResolvedValue([]);
    renderSidebar();
    fireEvent.click(screen.getByTestId('comments-toggle'));
    await vi.waitFor(() => {
      expect(screen.getByText('No comments yet')).toBeInTheDocument();
    });
  });
});
