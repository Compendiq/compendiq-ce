import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CommentPopover } from './CommentPopover';
import type { Comment } from './CommentThread';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { CommentMark } from './comment-extension';

// Mock apiFetch
const mockApiFetch = vi.fn();
vi.mock('../../lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

const mockComments: Comment[] = [
  {
    id: '101',
    authorName: 'Simon',
    body: 'Please verify this fact with engineering.',
    createdAt: new Date(Date.now() - 3600_000).toISOString(), // 1h ago
    resolved: false,
    anchorType: 'selection',
    anchorData: {
      quote: 'The quick brown fox',
      text: 'The quick brown fox',
    },
  },
  {
    id: '102',
    authorName: 'Alice',
    body: 'This section was approved.',
    createdAt: new Date(Date.now() - 7200_000).toISOString(),
    resolved: true,
    anchorType: 'selection',
    anchorData: {
      quote: 'jumps over the lazy dog',
    },
  },
  {
    id: '201',
    parentId: '101',
    authorName: 'Bob',
    body: 'Checked with team, looks good.',
    createdAt: new Date(Date.now() - 1800_000).toISOString(),
    resolved: false,
  },
];

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('CommentPopover', () => {
  let editor: Editor;

  beforeEach(() => {
    mockApiFetch.mockResolvedValue(mockComments);
    editor = new Editor({
      extensions: [StarterKit, CommentMark],
      content: '<p>The quick brown fox jumps over the lazy dog.</p>',
    });
  });

  afterEach(() => {
    editor.destroy();
    vi.clearAllMocks();
  });

  it('renders nothing by default when closed', () => {
    render(<CommentPopover pageId="42" editor={editor} />, { wrapper: createWrapper() });
    expect(screen.queryByTestId('comment-popover-content')).not.toBeInTheDocument();
  });

  it('opens and displays note details when compendiq:comment-select event is fired', async () => {
    render(<CommentPopover pageId="42" editor={editor} />, { wrapper: createWrapper() });

    act(() => {
      window.dispatchEvent(
        new CustomEvent('compendiq:comment-select', {
          detail: {
            commentId: '101',
            rect: { top: 100, left: 100, width: 50, height: 20 },
          },
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText('Simon')).toBeInTheDocument();
    });

    expect(screen.getByText('Please verify this fact with engineering.')).toBeInTheDocument();
    expect(screen.getByTestId('popover-comment-quote')).toHaveTextContent('The quick brown fox');
  });

  it('shows replies for threaded notes', async () => {
    render(<CommentPopover pageId="42" editor={editor} />, { wrapper: createWrapper() });

    act(() => {
      window.dispatchEvent(
        new CustomEvent('compendiq:comment-select', {
          detail: {
            commentId: '101',
            rect: { top: 100, left: 100, width: 50, height: 20 },
          },
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText('Bob')).toBeInTheDocument();
    });

    expect(screen.getByTestId('popover-reply-201')).toBeInTheDocument();
    expect(screen.getByText('Checked with team, looks good.')).toBeInTheDocument();
  });

  it('displays resolved badge and unresolve button for resolved notes', async () => {
    render(<CommentPopover pageId="42" editor={editor} />, { wrapper: createWrapper() });

    act(() => {
      window.dispatchEvent(
        new CustomEvent('compendiq:comment-select', {
          detail: {
            commentId: '102',
            rect: { top: 100, left: 100, width: 50, height: 20 },
          },
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('popover-resolved-badge')).toBeInTheDocument();
    });

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /unresolve/i })).toBeInTheDocument();
  });

  it('handles resolving a note and calls resolveCommentMark on editor', async () => {
    editor.commands.setTextSelection({ from: 1, to: 10 });
    editor.commands.setComment({ commentId: '101' });
    expect(editor.getHTML()).not.toContain('comment-resolved');

    mockApiFetch.mockResolvedValueOnce(mockComments).mockResolvedValueOnce({ ok: true });

    render(<CommentPopover pageId="42" editor={editor} />, { wrapper: createWrapper() });

    act(() => {
      window.dispatchEvent(
        new CustomEvent('compendiq:comment-select', {
          detail: {
            commentId: '101',
            rect: { top: 100, left: 100, width: 50, height: 20 },
          },
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('popover-resolve-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('popover-resolve-btn'));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/comments/101/resolve', { method: 'POST' });
    });
    expect(editor.getHTML()).toContain('comment-resolved');
  });

  it('allows removing the note mark highlight in editor', async () => {
    editor.commands.setTextSelection({ from: 1, to: 10 });
    editor.commands.setComment({ commentId: '101' });
    expect(editor.getHTML()).toContain('data-comment-id="101"');

    render(<CommentPopover pageId="42" editor={editor} />, { wrapper: createWrapper() });

    act(() => {
      window.dispatchEvent(
        new CustomEvent('compendiq:comment-select', {
          detail: {
            commentId: '101',
            rect: { top: 100, left: 100, width: 50, height: 20 },
          },
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('popover-remove-highlight-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('popover-remove-highlight-btn'));

    expect(editor.getHTML()).not.toContain('data-comment-id="101"');
    expect(screen.queryByTestId('comment-popover-content')).not.toBeInTheDocument();
  });

  it('allows posting an inline reply', async () => {
    mockApiFetch.mockResolvedValueOnce(mockComments).mockResolvedValueOnce({
      id: '202',
      parentId: '101',
      authorName: 'You',
      body: 'Replying inline',
      createdAt: new Date().toISOString(),
    });

    render(<CommentPopover pageId="42" editor={editor} />, { wrapper: createWrapper() });

    act(() => {
      window.dispatchEvent(
        new CustomEvent('compendiq:comment-select', {
          detail: {
            commentId: '101',
            rect: { top: 100, left: 100, width: 50, height: 20 },
          },
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('popover-reply-toggle-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('popover-reply-toggle-btn'));
    expect(screen.getByTestId('popover-reply-input')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('popover-reply-input'), {
      target: { value: 'Replying inline' },
    });

    fireEvent.click(screen.getByTestId('popover-reply-submit-btn'));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/pages/42/comments', {
        method: 'POST',
        body: JSON.stringify({ body: 'Replying inline', parentId: 101 }),
      });
    });
  });

  it('handles local draft note', async () => {
    render(<CommentPopover pageId="42" editor={editor} />, { wrapper: createWrapper() });

    act(() => {
      window.dispatchEvent(
        new CustomEvent('compendiq:comment-select', {
          detail: {
            commentId: 'local-12345',
            rect: { top: 100, left: 100, width: 50, height: 20 },
          },
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText('Draft')).toBeInTheDocument();
    });
    expect(screen.getByText(/Local draft note/i)).toBeInTheDocument();
    expect(screen.getByTestId('popover-remove-highlight-btn')).toBeInTheDocument();
  });

  it('dispatches compendiq:comment-open-sidebar on clicking Sidebar button', async () => {
    const sidebarSpy = vi.fn();
    window.addEventListener('compendiq:comment-open-sidebar', sidebarSpy);

    render(<CommentPopover pageId="42" editor={editor} />, { wrapper: createWrapper() });

    act(() => {
      window.dispatchEvent(
        new CustomEvent('compendiq:comment-select', {
          detail: {
            commentId: '101',
            rect: { top: 100, left: 100, width: 50, height: 20 },
          },
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('popover-open-sidebar-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('popover-open-sidebar-btn'));

    expect(sidebarSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { commentId: '101' },
      }),
    );
    expect(screen.queryByTestId('comment-popover-content')).not.toBeInTheDocument();

    window.removeEventListener('compendiq:comment-open-sidebar', sidebarSpy);
  });

  it('closes popover on close button click', async () => {
    render(<CommentPopover pageId="42" editor={editor} />, { wrapper: createWrapper() });

    act(() => {
      window.dispatchEvent(
        new CustomEvent('compendiq:comment-select', {
          detail: {
            commentId: '101',
            rect: { top: 100, left: 100, width: 50, height: 20 },
          },
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('popover-close-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('popover-close-btn'));
    expect(screen.queryByTestId('comment-popover-content')).not.toBeInTheDocument();
  });
});
