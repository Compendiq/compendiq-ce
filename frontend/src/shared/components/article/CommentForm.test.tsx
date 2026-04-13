import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommentForm } from './CommentForm';

describe('CommentForm', () => {
  it('renders textarea and submit button', () => {
    render(<CommentForm onSubmit={vi.fn()} />);
    expect(screen.getByTestId('comment-textarea')).toBeInTheDocument();
    expect(screen.getByTestId('comment-submit')).toBeInTheDocument();
  });

  it('renders default placeholder text', () => {
    render(<CommentForm onSubmit={vi.fn()} />);
    expect(screen.getByPlaceholderText('Write a comment...')).toBeInTheDocument();
  });

  it('renders custom placeholder text', () => {
    render(<CommentForm onSubmit={vi.fn()} placeholder="Write a reply..." />);
    expect(screen.getByPlaceholderText('Write a reply...')).toBeInTheDocument();
  });

  it('submit button is disabled when textarea is empty', () => {
    render(<CommentForm onSubmit={vi.fn()} />);
    expect(screen.getByTestId('comment-submit')).toBeDisabled();
  });

  it('submit button is enabled when textarea has content', () => {
    render(<CommentForm onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByTestId('comment-textarea'), { target: { value: 'Hello' } });
    expect(screen.getByTestId('comment-submit')).not.toBeDisabled();
  });

  it('calls onSubmit with trimmed body and clears textarea', () => {
    const onSubmit = vi.fn();
    render(<CommentForm onSubmit={onSubmit} />);
    const textarea = screen.getByTestId('comment-textarea');
    fireEvent.change(textarea, { target: { value: '  Hello world  ' } });
    fireEvent.submit(screen.getByTestId('comment-form'));
    expect(onSubmit).toHaveBeenCalledWith('Hello world');
    expect(textarea).toHaveValue('');
  });

  it('does not call onSubmit when body is only whitespace', () => {
    const onSubmit = vi.fn();
    render(<CommentForm onSubmit={onSubmit} />);
    fireEvent.change(screen.getByTestId('comment-textarea'), { target: { value: '   ' } });
    fireEvent.submit(screen.getByTestId('comment-form'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('renders cancel button when onCancel is provided', () => {
    render(<CommentForm onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId('comment-cancel')).toBeInTheDocument();
  });

  it('does not render cancel button when onCancel is not provided', () => {
    render(<CommentForm onSubmit={vi.fn()} />);
    expect(screen.queryByTestId('comment-cancel')).not.toBeInTheDocument();
  });

  it('calls onCancel when cancel button is clicked', () => {
    const onCancel = vi.fn();
    render(<CommentForm onSubmit={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('comment-cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('shows "Posting..." when isSubmitting is true', () => {
    render(<CommentForm onSubmit={vi.fn()} isSubmitting />);
    expect(screen.getByText('Posting...')).toBeInTheDocument();
  });

  it('disables textarea and submit when isSubmitting', () => {
    render(<CommentForm onSubmit={vi.fn()} isSubmitting />);
    expect(screen.getByTestId('comment-textarea')).toBeDisabled();
  });
});
