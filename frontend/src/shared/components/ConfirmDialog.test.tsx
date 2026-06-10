import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmDialog } from './ConfirmDialog';
import type { ConfirmDialogProps } from './ConfirmDialog';

function renderDialog(overrides: Partial<ConfirmDialogProps> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const props: ConfirmDialogProps = {
    open: true,
    title: 'Move page to trash?',
    description: 'It can be restored from Trash for 30 days.',
    confirmLabel: 'Move to trash',
    onConfirm,
    onCancel,
    ...overrides,
  };
  const utils = render(<ConfirmDialog {...props} />);
  return { onConfirm, onCancel, ...utils };
}

describe('ConfirmDialog', () => {
  it('renders title and description when open', () => {
    renderDialog();

    expect(screen.getByText('Move page to trash?')).toBeInTheDocument();
    expect(
      screen.getByText('It can be restored from Trash for 30 days.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    renderDialog({ open: false });

    expect(screen.queryByText('Move page to trash?')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders the confirm button with the given label and fires onConfirm', () => {
    const { onConfirm, onCancel } = renderDialog();

    const confirmBtn = screen.getByTestId('confirm-dialog-confirm');
    expect(confirmBtn).toHaveTextContent('Move to trash');

    fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('fires onCancel when Cancel is clicked', () => {
    const { onConfirm, onCancel } = renderDialog();

    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('fires onCancel when Escape is pressed', () => {
    const { onConfirm, onCancel } = renderDialog();

    fireEvent.keyDown(screen.getByTestId('confirm-dialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('applies destructive styling to the confirm button when destructive', () => {
    renderDialog({ destructive: true, confirmLabel: 'Delete user' });

    const confirmBtn = screen.getByTestId('confirm-dialog-confirm');
    expect(confirmBtn.className).toContain('bg-destructive');
    expect(confirmBtn.className).toContain('text-destructive-foreground');
    expect(confirmBtn.className).not.toContain('nm-button-primary');
  });

  it('uses the primary design-system button when not destructive', () => {
    renderDialog();

    const confirmBtn = screen.getByTestId('confirm-dialog-confirm');
    expect(confirmBtn.className).toContain('nm-button-primary');
    expect(confirmBtn.className).not.toContain('bg-destructive');
  });

  it('moves focus inside the dialog on open (focus trap entry)', () => {
    renderDialog();

    const dialog = screen.getByTestId('confirm-dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
