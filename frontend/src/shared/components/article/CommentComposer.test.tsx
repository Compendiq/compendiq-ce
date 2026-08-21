import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommentComposer } from './CommentComposer';

describe('CommentComposer component', () => {
  it('renders quote snippet and placeholder', () => {
    render(
      <CommentComposer
        quote="Revenue increased by 20%"
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('comment-composer-quote')).toHaveTextContent('Revenue increased by 20%');
    expect(screen.getByTestId('inline-comment-input')).toBeInTheDocument();
    expect(screen.getByTestId('inline-comment-submit')).toBeDisabled();
  });

  it('submits on button click when body is non-empty', () => {
    const onSubmit = vi.fn();
    render(
      <CommentComposer
        quote="Selected phrase"
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );

    const input = screen.getByTestId('inline-comment-input');
    fireEvent.change(input, { target: { value: 'Needs source citation' } });

    expect(screen.getByTestId('inline-comment-submit')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('inline-comment-submit'));

    expect(onSubmit).toHaveBeenCalledWith('Needs source citation');
  });

  it('submits on Cmd+Enter / Ctrl+Enter', () => {
    const onSubmit = vi.fn();
    render(
      <CommentComposer
        quote="Selected phrase"
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );

    const input = screen.getByTestId('inline-comment-input');
    fireEvent.change(input, { target: { value: 'Quick note' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });

    expect(onSubmit).toHaveBeenCalledWith('Quick note');
  });

  it('calls onClose on Escape key', () => {
    const onClose = vi.fn();
    render(
      <CommentComposer
        quote="Selected phrase"
        onSubmit={vi.fn()}
        onClose={onClose}
      />,
    );

    const input = screen.getByTestId('inline-comment-input');
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose on Cancel button click', () => {
    const onClose = vi.fn();
    render(
      <CommentComposer
        quote="Selected phrase"
        onSubmit={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows submitting state and disables inputs', () => {
    render(
      <CommentComposer
        quote="Selected phrase"
        onSubmit={vi.fn()}
        onClose={vi.fn()}
        isSubmitting={true}
      />,
    );

    expect(screen.getByTestId('inline-comment-input')).toBeDisabled();
    expect(screen.getByTestId('inline-comment-submit')).toBeDisabled();
    expect(screen.getByText('Saving…')).toBeInTheDocument();
  });
});
