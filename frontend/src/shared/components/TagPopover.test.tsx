import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { TagPopover } from './TagPopover';

afterEach(cleanup);

const defaultProps = {
  tags: ['react', 'typescript'],
  onAddTag: vi.fn(),
  onRemoveTag: vi.fn(),
  suggestions: ['react', 'typescript', 'javascript'],
};

describe('TagPopover', () => {
  /**
   * The control has a stable accessible name; the count remains visible chip
   * content and is asserted separately so the two responsibilities stay clear.
   */
  it('renders the chip as an action when the page has no tags', () => {
    render(<TagPopover {...defaultProps} tags={[]} />);
    const trigger = screen.getByRole('button', { name: 'Tags' });
    expect(trigger).toHaveTextContent('Add tags');
  });

  it('renders the chip with a singular count for one tag', () => {
    render(<TagPopover {...defaultProps} tags={['react']} />);
    const trigger = screen.getByRole('button', { name: 'Tags' });
    expect(trigger).toHaveTextContent('1 tag');
  });

  it('renders the chip with the tag count as its accessible name', () => {
    render(<TagPopover {...defaultProps} />);
    const trigger = screen.getByRole('button', { name: 'Tags' });
    expect(trigger).toHaveTextContent('2 tags');
  });

  it('keeps the editor closed until the chip is used', () => {
    render(<TagPopover {...defaultProps} />);
    expect(screen.queryByTestId('tag-editor')).not.toBeInTheDocument();
  });

  it('opens the editor on click', async () => {
    render(<TagPopover {...defaultProps} />);

    fireEvent.click(screen.getByTestId('tag-popover-trigger'));

    await waitFor(() => expect(screen.getByTestId('tag-editor')).toBeInTheDocument());
    expect(screen.getByText('react')).toBeInTheDocument();
    expect(screen.getByText('typescript')).toBeInTheDocument();
  });

  /**
   * The chip is the only route to tagging in edit mode now, so it has to be
   * reachable without a pointer — and it gets that from being a real `<button>`
   * of `type="button"`, which the user agent activates on Enter and Space.
   *
   * Asserted structurally rather than by firing Enter, because jsdom does not
   * synthesize the click a browser derives from that keystroke: a keydown test
   * here would be measuring jsdom, not the control. What can regress — the
   * trigger becoming a `div`, or losing `type="button"` and submitting a form —
   * is exactly what this catches.
   */
  it('exposes the chip as an activatable button', () => {
    render(<TagPopover {...defaultProps} />);
    const trigger = screen.getByTestId('tag-popover-trigger');

    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger).toHaveAttribute('type', 'button');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).not.toHaveAttribute('disabled');
  });

  it('reflects the open state on the chip', async () => {
    render(<TagPopover {...defaultProps} />);
    const trigger = screen.getByTestId('tag-popover-trigger');

    fireEvent.click(trigger);

    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'true'));
    expect(trigger).toHaveAttribute('data-state', 'open');
  });

  /**
   * Opening a control whose whole purpose is typing should not cost a Tab.
   * `TagEditor`'s effect does the focusing, but only because this component
   * preventDefaults Radix's `onOpenAutoFocus` — child effects run first, so
   * without that the FocusScope pulls the caret back onto the content wrapper.
   */
  it('lands the caret in the tag input on open', async () => {
    render(<TagPopover {...defaultProps} />);

    fireEvent.click(screen.getByTestId('tag-popover-trigger'));

    await waitFor(() => expect(screen.getByTestId('tag-input')).toHaveFocus());
  });

  it('forwards add and remove to the caller', async () => {
    const onAddTag = vi.fn();
    const onRemoveTag = vi.fn();
    render(<TagPopover {...defaultProps} onAddTag={onAddTag} onRemoveTag={onRemoveTag} />);

    fireEvent.click(screen.getByTestId('tag-popover-trigger'));
    await waitFor(() => expect(screen.getByTestId('tag-editor')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('tag-input'), { target: { value: 'graphql' } });
    fireEvent.keyDown(screen.getByTestId('tag-input'), { key: 'Enter' });
    expect(onAddTag).toHaveBeenCalledWith('graphql');

    fireEvent.click(screen.getByTestId('remove-tag-react'));
    expect(onRemoveTag).toHaveBeenCalledWith('react');
  });

  it('forwards the in-flight state so the editor disables itself', async () => {
    render(<TagPopover {...defaultProps} isLoading />);

    fireEvent.click(screen.getByTestId('tag-popover-trigger'));
    await waitFor(() => expect(screen.getByTestId('tag-input')).toBeDisabled());
  });

  /**
   * The load-bearing one.
   *
   * This popover is a portalled layer over the article editor, where bare
   * Escape is bound to `handleCancelEditing()`. A layer that leaves the key
   * unmarked dismisses itself AND throws the user out of edit mode into a
   * "Discard changes?" prompt — the class of bug documented for the block menu.
   *
   * Asserted through a real `document` listener rather than by inspecting the
   * wiring, because the wiring is exactly what is easy to get wrong: the same
   * handler on `onKeyDown` instead of `onEscapeKeyDown` passes a shallow check
   * and fails here.
   */
  it('closes on Escape without letting the key reach document listeners', async () => {
    render(<TagPopover {...defaultProps} />);
    const onDocumentEscape = vi.fn();
    document.addEventListener('keydown', onDocumentEscape);

    try {
      fireEvent.click(screen.getByTestId('tag-popover-trigger'));
      await waitFor(() => expect(screen.getByTestId('tag-editor')).toBeInTheDocument());
      onDocumentEscape.mockClear();

      fireEvent.keyDown(screen.getByTestId('tag-input'), { key: 'Escape' });

      await waitFor(() =>
        expect(screen.queryByTestId('tag-editor')).not.toBeInTheDocument(),
      );
      expect(onDocumentEscape).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', onDocumentEscape);
    }
  });

  /**
   * Escape peels one layer at a time: an open autocomplete claims the key, and
   * only a second Escape closes the popover.
   */
  it('peels the suggestion list before the popover', async () => {
    render(<TagPopover {...defaultProps} />);

    fireEvent.click(screen.getByTestId('tag-popover-trigger'));
    await waitFor(() => expect(screen.getByTestId('tag-input')).toBeInTheDocument());

    const input = screen.getByTestId('tag-input');
    fireEvent.change(input, { target: { value: 'java' } });
    expect(screen.getByTestId('tag-suggestions')).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByTestId('tag-suggestions')).not.toBeInTheDocument();
    expect(screen.getByTestId('tag-editor')).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.queryByTestId('tag-editor')).not.toBeInTheDocument(),
    );
  });
});
