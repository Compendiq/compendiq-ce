import { describe, it, expect, vi } from 'vitest';
import { useEffect, useState } from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
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
 * The shape the browser pass caught that `TriggerHarness` cannot (fixer,
 * external round): a trigger the CONFIRMED action takes out from under the
 * restore. Three flavours, one per real callsite:
 *
 * - `mode="disabled"` — the mutation the confirm fired sets `disabled` on the
 *   trigger for its own in-flight window (`SyncTab`'s Force re-sync all, and
 *   every ConfirmDialog trigger #1532 has not converted). Instrumented in the
 *   real browser at `disabled:true` 7 ms after the click and `disabled:false`
 *   by 48 ms — disabled across exactly Radix's `setTimeout(…, 0)` restore.
 *   jsdom agrees on the part that matters: `focus()` on a disabled button is a
 *   no-op that leaves `document.activeElement` on `<body>`.
 * - `mode="replaced"` — the confirmed commit re-renders the trigger as a NEW
 *   DOM node (a re-keyed row, a list that re-mounts). The captured node is
 *   detached by close time while the logical control is still on screen.
 * - `mode="removed"` — the confirmed action removes the trigger for good (the
 *   deleted row's own kebab, `ConversationRowMenu`). Re-resolving by identity
 *   must NOT degrade into grabbing a neighbouring control: this callsite
 *   deliberately wants no restore once the delete succeeds.
 *
 * `finish` re-enables the trigger the way the settling mutation does, from
 * outside the dialog, so the retry window is exercised without a timer race.
 * jsdom does not focus on click, so pressing it moves nothing.
 */
function ReplacedTriggerHarness({ mode }: { mode: 'disabled' | 'replaced' | 'removed' }) {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [generation, setGeneration] = useState(0);
  return (
    <>
      {(mode !== 'removed' || generation === 0) && (
        <button
          key={generation}
          type="button"
          data-testid="trigger"
          disabled={mode === 'disabled' && running}
          onClick={() => setOpen(true)}
        >
          Force Re-sync All
        </button>
      )}
      <button type="button" data-testid="elsewhere">
        Elsewhere
      </button>
      <button type="button" data-testid="finish" onClick={() => setRunning(false)}>
        Settle the mutation
      </button>
      <ConfirmDialog
        open={open}
        title="Force re-sync every space?"
        description="Every page is re-fetched from Confluence."
        confirmLabel="Force re-sync"
        onConfirm={() => {
          setOpen(false);
          if (mode === 'disabled') setRunning(true);
          else setGeneration((generationValue) => generationValue + 1);
        }}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}

/**
 * A dialog opened from a Radix `DropdownMenu` item — `ConversationRowMenu`'s
 * Delete and `UserMenu`'s Sign out. The menu is already closing when the dialog
 * opens, so `document.activeElement` at that moment is the menu's portalled
 * content and not the control the admin pressed; that content is detached by
 * close time, and the kebab, still on screen, never gets the keyboard back.
 */
function MenuTriggerHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger data-testid="kebab" aria-label="Row actions">
          Actions
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content>
            <DropdownMenu.Item data-testid="menu-delete" onSelect={() => setOpen(true)}>
              Delete
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <ConfirmDialog
        open={open}
        destructive
        title="Delete conversation?"
        description="This can't be undone."
        confirmLabel="Delete"
        onConfirm={() => setOpen(false)}
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

/**
 * Focus the kebab, open the Radix menu (it opens on `pointerDown`, like every
 * menu callsite in this codebase — see `NotificationBell.test.tsx`) and pick
 * the item that opens the dialog.
 */
async function openFromMenuItem(): Promise<HTMLElement> {
  const kebab = screen.getByTestId('kebab');
  kebab.focus();
  fireEvent.pointerDown(kebab, { button: 0, pointerType: 'mouse' });
  fireEvent.click(kebab);
  fireEvent.click(await screen.findByTestId('menu-delete'));
  expect(await screen.findByTestId('confirm-dialog')).toBeInTheDocument();
  return kebab;
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
   * nothing, and all fifteen render sites (twelve files, `grep '<ConfirmDialog'`)
   * drop the keyboard to `<body>` in a ~30-stop settings panel (WCAG 2.4.3).
   * Three closing paths, three cells, because Cancel, Escape and Confirm leave
   * through different code.
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

  /**
   * The browser pass caught what cell 3 above cannot: on `SyncTab`'s Force
   * re-sync all, Confirm left `document.activeElement` on `<body>` even with
   * the restore in place, because the mutation the confirm fired disables its
   * own trigger across Radix's `setTimeout(…, 0)` — measured `disabled:true`
   * at 7 ms, `disabled:false` at 48 ms. A one-shot `invoker.focus()` fires
   * inside that window and a `focus()` on a disabled control is a no-op, so
   * the restore has to survive a trigger that is momentarily unfocusable.
   */
  it('returns focus to a trigger the confirmed action disables across the restore', async () => {
    render(<ReplacedTriggerHarness mode="disabled" />);
    const trigger = openFromTrigger();

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await flushCloseAutoFocus();
    // Premise, not the assertion: the confirmed mutation is in flight, its
    // trigger is disabled, and nothing can hold the keyboard yet.
    expect(screen.getByTestId('trigger')).toBeDisabled();
    expect(document.activeElement).toBe(document.body);

    fireEvent.click(screen.getByTestId('finish'));

    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });

  /**
   * The other half of the same defect: the confirmed commit re-mounts the
   * trigger, so the saved node is detached by close time while the control the
   * admin pressed is on screen. Restoring by NODE cannot work here; the
   * invoker has to be re-resolved by identity (`data-testid`).
   */
  it('returns focus to a trigger the confirmed action re-mounts as a new node', async () => {
    render(<ReplacedTriggerHarness mode="replaced" />);
    const originalNode = openFromTrigger();

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await flushCloseAutoFocus();

    const remounted = screen.getByTestId('trigger');
    // Premise: this really is a different DOM node, so a node-only restore
    // would have had nothing to focus.
    expect(remounted).not.toBe(originalNode);
    expect(document.contains(originalNode)).toBe(false);
    expect(document.activeElement).toBe(remounted);
  });

  /**
   * The cost of re-resolving by identity is that it must not degrade into
   * "focus something nearby". `ConversationRowMenu` wants exactly no restore
   * once the delete succeeds — its kebab left with the row — so a trigger that
   * is gone for good stays gone, for the whole retry window.
   */
  it('restores nothing when the confirmed action removed the trigger for good', async () => {
    render(<ReplacedTriggerHarness mode="removed" />);
    openFromTrigger();

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await flushCloseAutoFocus();
    await act(async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 120);
      await promise;
    });

    expect(screen.queryByTestId('trigger')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
  });

  /**
   * The retry window must not become a delayed steal: once anything else holds
   * the keyboard — the admin tabbing on while the mutation settles — the
   * restore is over, even if the invoker becomes focusable again inside the
   * window. Deleting the `<body>` guard from the retry reds this and nothing
   * else.
   */
  it('abandons the retry once the admin has moved the keyboard on', async () => {
    render(<ReplacedTriggerHarness mode="disabled" />);
    openFromTrigger();

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await flushCloseAutoFocus();
    const elsewhere = screen.getByTestId('elsewhere');
    elsewhere.focus();

    // The trigger becomes focusable again well inside the retry window.
    fireEvent.click(screen.getByTestId('finish'));
    await act(async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 120);
      await promise;
    });

    expect(document.activeElement).toBe(elsewhere);
  });

  /**
   * The two dropdown-invoked callsites (`ConversationRowMenu` Delete,
   * `UserMenu` Sign out): the captured `activeElement` is the closing menu's
   * portalled content, which is detached by close time. Radix names the owner
   * — menu content carries `aria-labelledby={triggerId}`, the trigger carries
   * that `id` — so the invoker is re-resolved by identity rather than guessed
   * from ancestry.
   */
  it('returns focus to the menu trigger when the dialog was opened from a menu item', async () => {
    render(<MenuTriggerHarness />);
    const kebab = await openFromMenuItem();

    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    await flushCloseAutoFocus();

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(kebab);
  });
});
