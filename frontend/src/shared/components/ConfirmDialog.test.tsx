import { describe, it, expect, vi } from 'vitest';
import { useEffect, useState } from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react';
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

/**
 * #1531 — the harness the focus cells need.
 *
 * `renderDialog` above mounts the dialog already `open`, with nothing outside
 * it: there is no element focus could be returned TO, so it cannot see this
 * defect at all. This one drives the dialog the way every callsite does —
 * `open` is state, a real `<button>` outside the portal flips it, and a second
 * outside control exists so "the admin moved on" is expressible.
 *
 * `onConfirmRehomes` reproduces the one shape that must NOT be overridden: a
 * callsite that closes the dialog and rehomes focus itself (the
 * `EmbeddingShadowMigrationCard` `rehomeAfterDismiss` pattern). The rehome
 * runs from an EFFECT and not from the click handler, because that is both the
 * real shape and the only one that can work: while the dialog is still mounted
 * FocusScope traps focus and pulls any outside `.focus()` straight back, so a
 * rehome in the handler is undone before the commit even lands.
 */
function TriggerHarness({ onConfirmRehomes = false }: { onConfirmRehomes?: boolean }) {
  const [open, setOpen] = useState(false);
  const [rehome, setRehome] = useState(false);
  useEffect(() => {
    if (!rehome) return;
    screen.getByTestId('elsewhere').focus();
  }, [rehome]);
  return (
    <>
      <button type="button" data-testid="trigger" onClick={() => setOpen(true)}>
        Force Re-sync All
      </button>
      <button type="button" data-testid="elsewhere">
        Elsewhere
      </button>
      <ConfirmDialog
        open={open}
        title="Force re-sync every space?"
        description="Every page is re-fetched from Confluence."
        confirmLabel="Force re-sync"
        onConfirm={() => {
          setOpen(false);
          if (onConfirmRehomes) setRehome(true);
        }}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}

/**
 * Radix's FocusScope dispatches its close-auto-focus event from a
 * `setTimeout(…, 0)` in the effect cleanup, so the restore lands one macrotask
 * after the unmount commit. Asserting without this flush reads the DOM inside
 * the window where focus is legitimately still on `<body>` — a cell that would
 * pass fixed and broken alike.
 */
async function flushCloseAutoFocus() {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    await promise;
  });
}

/** Focus the trigger like a keyboard user, then open. */
function openFromTrigger(): HTMLElement {
  const trigger = screen.getByTestId('trigger');
  trigger.focus();
  fireEvent.click(trigger);
  expect(screen.getByTestId('confirm-dialog').contains(document.activeElement)).toBe(true);
  return trigger;
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

  it('routes Escape to onDismiss instead of onCancel when onDismiss is provided', () => {
    // When the Cancel button carries a real action (e.g. "edit the published
    // version"), Escape/overlay must stay neutral: close without choosing.
    const onDismiss = vi.fn();
    const { onConfirm, onCancel } = renderDialog({ onDismiss });

    fireEvent.keyDown(screen.getByTestId('confirm-dialog'), { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('still routes the Cancel button to onCancel when onDismiss is provided', () => {
    const onDismiss = vi.fn();
    const { onCancel } = renderDialog({ onDismiss });

    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('renders a custom cancel label when cancelLabel is provided', () => {
    renderDialog({ cancelLabel: 'Edit published version' });

    expect(screen.getByTestId('confirm-dialog-cancel')).toHaveTextContent(
      'Edit published version',
    );
  });

  it('applies the design-system destructive button when destructive', () => {
    renderDialog({ destructive: true, confirmLabel: 'Delete user' });

    // nm-button-destructive (index.css @utility) replaces the old ad-hoc
    // bg-destructive recipe so the confirm button matches nm-button-ghost
    // (Cancel) in height/padding/press behavior.
    const confirmBtn = screen.getByTestId('confirm-dialog-confirm');
    expect(confirmBtn.className).toContain('nm-button-destructive');
    expect(confirmBtn.className).not.toContain('nm-button-primary');
    expect(confirmBtn.className).not.toContain('bg-destructive');
  });

  it('uses the primary design-system button when not destructive', () => {
    renderDialog();

    const confirmBtn = screen.getByTestId('confirm-dialog-confirm');
    expect(confirmBtn.className).toContain('nm-button-primary');
    expect(confirmBtn.className).not.toContain('nm-button-destructive');
  });

  it('moves focus inside the dialog on open (focus trap entry)', () => {
    renderDialog();

    const dialog = screen.getByTestId('confirm-dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  /**
   * #1531. `DialogContentModal` composes its own `onCloseAutoFocus` that
   * `preventDefault()`s FocusScope's restore and focuses `context.triggerRef`
   * instead — and this component renders no `Dialog.Trigger`, so that ref is
   * permanently `null`. The suppression stands, the replacement focuses
   * nothing, and every one of the five callsites drops the keyboard to
   * `<body>` in a ~30-stop settings panel (WCAG 2.4.3). Three closing paths,
   * three cells, because Cancel, Escape and Confirm leave through different
   * code.
   */
  it('returns focus to the invoking trigger when Cancel closes the dialog', async () => {
    render(<TriggerHarness />);
    const trigger = openFromTrigger();

    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    await flushCloseAutoFocus();

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(trigger);
  });

  it('returns focus to the invoking trigger when Escape closes the dialog', async () => {
    render(<TriggerHarness />);
    const trigger = openFromTrigger();

    fireEvent.keyDown(screen.getByTestId('confirm-dialog'), { key: 'Escape' });
    await flushCloseAutoFocus();

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(trigger);
  });

  it('returns focus to the invoking trigger when Confirm closes the dialog', async () => {
    render(<TriggerHarness />);
    const trigger = openFromTrigger();

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await flushCloseAutoFocus();

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(trigger);
  });

  /**
   * The guard that keeps the three cells above from being an unconditional
   * steal: a callsite that closes the dialog and rehomes focus itself keeps
   * the focus it chose. An always-restore passes 1-3 and fails this.
   */
  it('leaves focus where the callsite moved it instead of stealing it back', async () => {
    render(<TriggerHarness onConfirmRehomes />);
    const trigger = openFromTrigger();

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await flushCloseAutoFocus();

    expect(document.activeElement).toBe(screen.getByTestId('elsewhere'));
    expect(document.activeElement).not.toBe(trigger);
  });
});
