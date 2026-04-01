import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StatusBadgeView } from './StatusBadgeView';
import type { NodeViewProps } from '@tiptap/react';

function makeProps(overrides: Partial<NodeViewProps> = {}): NodeViewProps {
  return {
    node: {
      attrs: {
        color: 'blue',
        label: 'IN PROGRESS',
      },
      ...overrides.node,
    },
    updateAttributes: vi.fn(),
    deleteNode: vi.fn(),
    editor: {
      isEditable: true,
      ...overrides.editor,
    },
    getPos: () => 0,
    extension: {} as NodeViewProps['extension'],
    HTMLAttributes: {},
    decorations: [],
    selected: false,
    ...overrides,
  } as unknown as NodeViewProps;
}

describe('StatusBadgeView', () => {
  it('renders badge with correct color and label', () => {
    render(<StatusBadgeView {...makeProps()} />);

    const badge = screen.getByTestId('status-badge');
    expect(badge).toBeTruthy();
    expect(badge.textContent).toBe('IN PROGRESS');
    expect(badge.getAttribute('data-color')).toBe('blue');
  });

  it('renders all 5 status colors correctly', () => {
    const colors = ['grey', 'blue', 'green', 'yellow', 'red'] as const;

    for (const color of colors) {
      const props = makeProps({
        node: {
          attrs: { color, label: color.toUpperCase() },
        } as NodeViewProps['node'],
      });

      const { unmount } = render(<StatusBadgeView {...props} />);
      const badge = screen.getByTestId('status-badge');
      expect(badge.getAttribute('data-color')).toBe(color);
      expect(badge.textContent).toBe(color.toUpperCase());
      unmount();
    }
  });

  it('opens popover with text input and color picker on click', () => {
    render(<StatusBadgeView {...makeProps()} />);

    // Popover should not be visible initially
    expect(screen.queryByTestId('status-badge-popover')).toBeNull();

    // Click the badge
    fireEvent.click(screen.getByTestId('status-badge'));

    // Popover should now be visible with input, color picker, and apply button
    expect(screen.getByTestId('status-badge-popover')).toBeTruthy();
    expect(screen.getByTestId('status-label-input')).toBeTruthy();
    expect(screen.getByTestId('status-color-picker')).toBeTruthy();
    expect(screen.getByTestId('status-apply-btn')).toBeTruthy();
  });

  it('calls updateAttributes with new values when apply is clicked', () => {
    const updateAttributes = vi.fn();
    const props = makeProps({ updateAttributes });

    render(<StatusBadgeView {...props} />);

    // Open popover
    fireEvent.click(screen.getByTestId('status-badge'));

    // Change label text
    const input = screen.getByTestId('status-label-input');
    fireEvent.change(input, { target: { value: 'DONE' } });

    // Change color to green
    fireEvent.click(screen.getByTestId('status-color-green'));

    // Click apply
    fireEvent.click(screen.getByTestId('status-apply-btn'));

    expect(updateAttributes).toHaveBeenCalledWith({
      color: 'green',
      label: 'DONE',
    });
  });

  it('does not open popover when editor is not editable', () => {
    const props = makeProps({
      editor: { isEditable: false } as NodeViewProps['editor'],
    });

    render(<StatusBadgeView {...props} />);

    fireEvent.click(screen.getByTestId('status-badge'));

    // Popover should not appear
    expect(screen.queryByTestId('status-badge-popover')).toBeNull();
  });

  it('uses default label "STATUS" when input is empty and apply is clicked', () => {
    const updateAttributes = vi.fn();
    const props = makeProps({
      updateAttributes,
      node: {
        attrs: { color: 'grey', label: '' },
      } as NodeViewProps['node'],
    });

    render(<StatusBadgeView {...props} />);

    // Open popover
    fireEvent.click(screen.getByTestId('status-badge'));

    // Leave input empty and apply
    const input = screen.getByTestId('status-label-input');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByTestId('status-apply-btn'));

    expect(updateAttributes).toHaveBeenCalledWith({
      color: 'grey',
      label: 'STATUS',
    });
  });

  it('applies on Enter key in the input', () => {
    const updateAttributes = vi.fn();
    const props = makeProps({ updateAttributes });

    render(<StatusBadgeView {...props} />);

    fireEvent.click(screen.getByTestId('status-badge'));

    const input = screen.getByTestId('status-label-input');
    fireEvent.change(input, { target: { value: 'REVIEWED' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(updateAttributes).toHaveBeenCalledWith({
      color: 'blue',
      label: 'REVIEWED',
    });
  });

  it('converts label input to uppercase', () => {
    render(<StatusBadgeView {...makeProps()} />);

    fireEvent.click(screen.getByTestId('status-badge'));

    const input = screen.getByTestId('status-label-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'done' } });

    expect(input.value).toBe('DONE');
  });

  it('shows all 5 color options in the picker', () => {
    render(<StatusBadgeView {...makeProps()} />);

    fireEvent.click(screen.getByTestId('status-badge'));

    expect(screen.getByTestId('status-color-grey')).toBeTruthy();
    expect(screen.getByTestId('status-color-blue')).toBeTruthy();
    expect(screen.getByTestId('status-color-green')).toBeTruthy();
    expect(screen.getByTestId('status-color-yellow')).toBeTruthy();
    expect(screen.getByTestId('status-color-red')).toBeTruthy();
  });
});
