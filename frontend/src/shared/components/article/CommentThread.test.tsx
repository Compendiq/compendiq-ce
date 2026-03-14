import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommentThread, type Comment } from './CommentThread';

// Mock framer-motion
vi.mock('framer-motion', () => ({
  m: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const baseComment: Comment = {
  id: 'c-1',
  authorName: 'Alice',
  body: 'This looks great!',
  createdAt: new Date().toISOString(),
  resolved: false,
  parentId: null,
  replies: [],
};

const commentWithReplies: Comment = {
  ...baseComment,
  replies: [
    {
      id: 'r-1',
      authorName: 'Bob',
      body: 'Thanks for the feedback!',
      createdAt: new Date().toISOString(),
      resolved: false,
      parentId: 'c-1',
    },
    {
      id: 'r-2',
      authorName: 'Charlie',
      body: 'Agreed!',
      createdAt: new Date().toISOString(),
      resolved: false,
      parentId: 'c-1',
    },
  ],
};

describe('CommentThread', () => {
  it('renders author name and body', () => {
    render(
      <CommentThread
        comment={baseComment}
        onReply={vi.fn()}
        onResolve={vi.fn()}
        onUnresolve={vi.fn()}
      />,
    );
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('This looks great!')).toBeInTheDocument();
  });

  it('renders author avatar initial', () => {
    render(
      <CommentThread
        comment={baseComment}
        onReply={vi.fn()}
        onResolve={vi.fn()}
        onUnresolve={vi.fn()}
      />,
    );
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('shows Resolve button for unresolved comments', () => {
    render(
      <CommentThread
        comment={baseComment}
        onReply={vi.fn()}
        onResolve={vi.fn()}
        onUnresolve={vi.fn()}
      />,
    );
    expect(screen.getByTestId('resolve-c-1')).toBeInTheDocument();
  });

  it('shows Unresolve button for resolved comments', () => {
    const resolved = { ...baseComment, resolved: true };
    render(
      <CommentThread
        comment={resolved}
        onReply={vi.fn()}
        onResolve={vi.fn()}
        onUnresolve={vi.fn()}
      />,
    );
    expect(screen.getByTestId('unresolve-c-1')).toBeInTheDocument();
  });

  it('shows Resolved badge for resolved comments', () => {
    const resolved = { ...baseComment, resolved: true };
    render(
      <CommentThread
        comment={resolved}
        onReply={vi.fn()}
        onResolve={vi.fn()}
        onUnresolve={vi.fn()}
      />,
    );
    expect(screen.getByText('Resolved')).toBeInTheDocument();
  });

  it('calls onResolve when Resolve is clicked', () => {
    const onResolve = vi.fn();
    render(
      <CommentThread
        comment={baseComment}
        onReply={vi.fn()}
        onResolve={onResolve}
        onUnresolve={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('resolve-c-1'));
    expect(onResolve).toHaveBeenCalledWith('c-1');
  });

  it('calls onUnresolve when Unresolve is clicked', () => {
    const onUnresolve = vi.fn();
    const resolved = { ...baseComment, resolved: true };
    render(
      <CommentThread
        comment={resolved}
        onReply={vi.fn()}
        onResolve={vi.fn()}
        onUnresolve={onUnresolve}
      />,
    );
    fireEvent.click(screen.getByTestId('unresolve-c-1'));
    expect(onUnresolve).toHaveBeenCalledWith('c-1');
  });

  it('shows reply count when there are replies', () => {
    render(
      <CommentThread
        comment={commentWithReplies}
        onReply={vi.fn()}
        onResolve={vi.fn()}
        onUnresolve={vi.fn()}
      />,
    );
    expect(screen.getByTestId('toggle-replies-c-1')).toHaveTextContent('2 replies');
  });

  it('shows singular reply text for one reply', () => {
    const singleReply = { ...baseComment, replies: [commentWithReplies.replies![0]] };
    render(
      <CommentThread
        comment={singleReply}
        onReply={vi.fn()}
        onResolve={vi.fn()}
        onUnresolve={vi.fn()}
      />,
    );
    expect(screen.getByTestId('toggle-replies-c-1')).toHaveTextContent('1 reply');
  });

  it('renders replies when expanded', () => {
    render(
      <CommentThread
        comment={commentWithReplies}
        onReply={vi.fn()}
        onResolve={vi.fn()}
        onUnresolve={vi.fn()}
      />,
    );
    expect(screen.getByTestId('reply-r-1')).toBeInTheDocument();
    expect(screen.getByText('Thanks for the feedback!')).toBeInTheDocument();
  });

  it('shows reply form when Reply button is clicked', () => {
    render(
      <CommentThread
        comment={baseComment}
        onReply={vi.fn()}
        onResolve={vi.fn()}
        onUnresolve={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('reply-toggle-c-1'));
    expect(screen.getByPlaceholderText('Write a reply...')).toBeInTheDocument();
  });

  it('has correct test id', () => {
    render(
      <CommentThread
        comment={baseComment}
        onReply={vi.fn()}
        onResolve={vi.fn()}
        onUnresolve={vi.fn()}
      />,
    );
    expect(screen.getByTestId('comment-thread-c-1')).toBeInTheDocument();
  });
});
