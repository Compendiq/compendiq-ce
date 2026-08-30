import { describe, it, expect, vi } from 'vitest';
import { useEffect, useState } from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react';
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
 * The shapes the browser pass caught that `TriggerHarness` cannot (fixer,
 * external round): a trigger the CONFIRMED action takes out from under the
 * restore. Four flavours, one per real callsite:
 *
 * - `mode="disabled"` — the mutation the confirm fired sets native `disabled`
 *   on the trigger for its own in-flight window (`SyncTab`'s Force re-sync all,
 *   and every ConfirmDialog trigger #1532 has not converted). Instrumented in
 *   the real browser at `disabled:true` 7 ms after the click and
 *   `disabled:false` by 48 ms. jsdom agrees on the part that matters:
 *   `focus()` on a disabled button is a no-op that leaves
 *   `document.activeElement` on `<body>`. Under the single-shot restore
 *   (architect ruling) this callsite gets NO restore, and that IS the ruling:
 *   the HTML focus fixup rule has already blurred the admin to `<body>` before
 *   the dialog is consulted, which is #1532's defect to fix at the callsite,
 *   not a state for a shared dialog to out-wait with a clock or an observer.
 * - `mode="aria-busy"` — the same in-flight window on a control converted per
 *   #1532: `aria-disabled` plus a refusing handler, never native `disabled`.
 *   The trigger stays focusable for the whole run, so the single-shot restore
 *   lands. This is the shape both cards in this PR now have.
 * - `mode="replaced"` — the confirmed commit re-renders the trigger as a NEW
 *   DOM node (a re-keyed row, a list that re-mounts). The captured node is
 *   detached by close time while the logical control is still on screen.
 * - `mode="removed"` — the confirmed action removes the trigger for good (the
 *   deleted row's own kebab, `ConversationRowMenu`). Re-resolving by identity
 *   must NOT degrade into grabbing a neighbouring control: this callsite
 *   deliberately wants no restore once the delete succeeds.
 * - `mode="replaced-late"` — the same re-mount, committed in a LATER task, as
 *   an `onSuccess` that only bumps its state after an `await` would. The single
 *   shot then reads the PRE-commit DOM, focuses the node that is about to be
 *   detached, and the commit drops the keyboard to `<body>`. No callsite has
 *   this shape today (every ConfirmDialog `onConfirm` commits synchronously),
 *   and closing it would need the wait the architect ruling removed, so the
 *   cell below pins `<body>` as the DOCUMENTED terminal state — the same place
 *   the unfixed dialog left it — rather than claiming a guarantee the
 *   component does not make (review r1).
 *
 * `finish` settles the in-flight mutation the way the POST's own response does,
 * from outside the dialog. jsdom does not focus on click, so pressing it moves
 * nothing — which is what makes it a clean probe for "is anything still acting
 * on the document after the dialog closed?".
 */
function ReplacedTriggerHarness({
  mode,
}: {
  mode: 'disabled' | 'aria-busy' | 'replaced' | 'removed' | 'replaced-late';
}) {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [generation, setGeneration] = useState(0);
  const busy = (mode === 'disabled' || mode === 'aria-busy') && running;
  return (
    <>
      {(mode !== 'removed' || generation === 0) && (
        <button
          key={generation}
          type="button"
          data-testid="trigger"
          disabled={mode === 'disabled' && busy}
          aria-disabled={mode === 'aria-busy' && busy ? true : undefined}
          onClick={() => {
            if (busy) return;
            setOpen(true);
          }}
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
          if (mode === 'disabled' || mode === 'aria-busy') setRunning(true);
          else if (mode === 'replaced-late')
            setTimeout(() => setGeneration((generationValue) => generationValue + 1), 0);
          else setGeneration((generationValue) => generationValue + 1);
        }}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}

/**
 * The two identity paths every harness above hides, because all of them label
 * their trigger `data-testid="trigger"` — which made both branches provably
 * zero-red (review r1: deleting either left the suite 21/21 green).
 *
 * - `kind="anonymous"` — no `data-testid` and no `id`, which is what MOST real
 *   ConfirmDialog triggers are: `SpacesTab`'s Remove-space `IconButton` and its
 *   Save Selection button, `PageViewPage`'s discard and trash buttons,
 *   `ArticleRightPane`, `DrawioEditor`. `identitySelector` returns `null` for
 *   all of them, so `resolveInvoker`'s captured-node path is the ENTIRE restore.
 * - `kind="id"` — identified by an author-written `id` (not Radix `useId()`
 *   output, which a re-mount regenerates) and re-mounted by the confirmed
 *   commit, so the captured node is detached and only the `id` half of
 *   `identitySelector` can find the control again.
 */
function IdentityHarness({ kind }: { kind: 'anonymous' | 'id' }) {
  const [open, setOpen] = useState(false);
  const [generation, setGeneration] = useState(0);
  return (
    <>
      <button
        key={generation}
        type="button"
        id={kind === 'id' ? 'remove-space-confluence' : undefined}
        onClick={() => setOpen(true)}
      >
        Remove space
      </button>
      <ConfirmDialog
        open={open}
        title="Remove this space?"
        description="Its synced pages are deleted."
        confirmLabel="Remove"
        onConfirm={() => {
          setOpen(false);
          setGeneration((generationValue) => generationValue + 1);
        }}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}

/** Focus and press a trigger identified only by its accessible name. */
function openFromNamedTrigger(): HTMLElement {
  const trigger = screen.getByRole('button', { name: 'Remove space' });
  trigger.focus();
  fireEvent.click(trigger);
  expect(screen.getByTestId('confirm-dialog').contains(document.activeElement)).toBe(true);
  return trigger;
}

/**
 * The owner unmounts the dialog while it is still `open` — the confirmed action
 * navigates away (a 401 redirect to the login page, a parent switching to an
 * error branch) — and the surface that replaces it reuses the same
 * `data-testid`. Radix dispatches close-auto-focus one macrotask AFTER that
 * unmount commit, so the restore starts with every cleanup here already run,
 * and a freshly-mounted screen looks exactly like the state the restore waits
 * for: `<body>` holding the keyboard.
 */
function UnmountOnConfirmHarness() {
  const [gone, setGone] = useState(false);
  const [open, setOpen] = useState(false);
  if (gone) {
    // A different subtree, so React really unmounts the trigger rather than
    // reconciling the two buttons into one node: the replacement control is a
    // new element that happens to carry the identity the restore resolves by.
    return (
      <div data-testid="next-screen">
        <button type="button" data-testid="trigger">
          A totally different control on the next screen
        </button>
      </div>
    );
  }
  return (
    <>
      <button type="button" data-testid="trigger" onClick={() => setOpen(true)}>
        Delete conversation
      </button>
      <ConfirmDialog
        open={open}
        destructive
        title="Delete conversation?"
        description="This can't be undone."
        confirmLabel="Delete"
        onConfirm={() => setGone(true)}
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
   * The deterministic-resolution ruling, and the cell that reds against the
   * previous head (architect ruling, external round). The confirmed mutation
   * holds its OWN trigger natively `disabled` while it is in flight, so at
   * close time the invoker cannot take focus — and the answer is one attempt
   * that lands nowhere, not a wait. Nothing may act on the document afterwards:
   * settling the mutation re-enables the trigger, and the keyboard must STILL
   * be where the close left it. Against the retry chain this reds
   * (`activeElement` becomes the trigger seconds after the dialog closed);
   * against the 500 ms window it reds or passes depending on how fast the
   * server answered, which is why neither survived.
   *
   * This is not a regression for the admin: the HTML focus fixup rule blurred
   * the focused control the moment native `disabled` landed on it, before this
   * dialog was consulted. Restoring focus TO a `disabled` control is not
   * possible; the fix is converting the control (#1532), which the next cell
   * pins.
   */
  it('makes exactly one attempt and leaves the document alone afterwards', async () => {
    render(<ReplacedTriggerHarness mode="disabled" />);
    openFromTrigger();

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await flushCloseAutoFocus();
    // Premise: the confirmed mutation is in flight and its trigger — the
    // control the restore aims at — cannot take focus.
    expect(screen.getByTestId('trigger')).toBeDisabled();
    expect(document.activeElement).toBe(document.body);

    // The mutation settles and the trigger is focusable again. No observer, no
    // timer and no retry may still be watching for that.
    fireEvent.click(screen.getByTestId('finish'));
    expect(screen.getByTestId('trigger')).not.toBeDisabled();
    await act(async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 50);
      await promise;
    });

    expect(document.activeElement).toBe(document.body);
  });

  /**
   * The other side of the same coin, and the join between #1531 and #1532: a
   * trigger converted to `aria-disabled` + a refusing handler stays focusable
   * for its whole multi-minute run, so the single-shot restore lands on it
   * while the run is still going. Both cards this PR converts
   * (`AttachmentStorageCard`, `ImageIndexCard`) are this shape.
   *
   * jsdom implements no focus fixup, so this cell cannot see the defect
   * `mode="disabled"` describes — it is the regression pin for the converted
   * shape, and browser checklist item 2 is the proof.
   */
  it('returns focus to a busy trigger that holds itself with aria-disabled', async () => {
    render(<ReplacedTriggerHarness mode="aria-busy" />);
    const trigger = openFromTrigger();

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await flushCloseAutoFocus();

    // Premise: the run really is in flight and the control really is marked
    // busy — it is simply still focusable, because the mark is not `disabled`.
    expect(screen.getByTestId('trigger')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('trigger')).not.toHaveAttribute('disabled');
    expect(document.activeElement).toBe(trigger);
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
   * is gone for good stays gone.
   */
  it('restores nothing when the confirmed action removed the trigger for good', async () => {
    render(<ReplacedTriggerHarness mode="removed" />);
    openFromTrigger();

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await flushCloseAutoFocus();

    expect(screen.queryByTestId('trigger')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
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

  /**
   * The restore must not outlive the component. Radix dispatches
   * close-auto-focus one macrotask after the unmount commit, so a dialog whose
   * OWNER unmounts it while still `open` reaches `onCloseAutoFocus` with every
   * cleanup already run — and re-resolving the invoker by `data-testid` then
   * aims at whatever carries that identity on the surface that replaced it.
   * Deleting the `aliveRef` guard reds this: focus lands on a control the
   * operator never pressed, on a screen the dialog never belonged to.
   */
  it('never restores onto a surface the dialog no longer belongs to', async () => {
    render(<UnmountOnConfirmHarness />);
    const trigger = openFromTrigger();

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await flushCloseAutoFocus();

    // Premise: the replacement really does carry the identity the restore
    // re-resolves by, and the dialog itself is gone.
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('trigger')).not.toBe(trigger);
    expect(document.activeElement).toBe(document.body);
  });

  /**
   * The path MOST real callsites take, and the one every other cell here hid
   * behind `data-testid="trigger"`: a trigger with no `data-testid` and no
   * `id` (`SpacesTab`'s Remove space and Save Selection, `PageViewPage`'s
   * discard and trash, `ArticleRightPane`, `DrawioEditor`). `identitySelector`
   * returns `null` for them, so the captured NODE is the whole restore —
   * deleting `resolveInvoker`'s node path reds only this cell (review r1).
   */
  it('returns focus to a trigger that carries no data-testid and no id', async () => {
    render(<IdentityHarness kind="anonymous" />);
    const trigger = openFromNamedTrigger();

    // Premise: there really is no identity to re-resolve by.
    expect(trigger).not.toHaveAttribute('data-testid');
    expect(trigger.id).toBe('');

    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    await flushCloseAutoFocus();

    expect(document.activeElement).toBe(trigger);
  });

  /**
   * The second identity branch, which was equally zero-red before this cell:
   * an author-written `id` (not Radix `useId()` output, which a re-mount
   * regenerates) on a trigger the confirmed commit re-mounts. The captured node
   * is detached, `data-testid` is absent, and the `id` selector is the only
   * thing left that can find the control.
   */
  it('returns focus by id to a re-mounted trigger that has no data-testid', async () => {
    render(<IdentityHarness kind="id" />);
    const originalNode = openFromNamedTrigger();
    expect(originalNode).not.toHaveAttribute('data-testid');
    expect(originalNode.id).toBe('remove-space-confluence');

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await flushCloseAutoFocus();

    const remounted = screen.getByRole('button', { name: 'Remove space' });
    expect(remounted).not.toBe(originalNode);
    expect(document.contains(originalNode)).toBe(false);
    expect(document.activeElement).toBe(remounted);
  });

  /**
   * The precondition the single shot depends on, stated as a test instead of as
   * a claim in the header (review r1). `onCloseAutoFocus` reads the DOM of every
   * commit the confirm handler made SYNCHRONOUSLY — which is what all five
   * callsites do — but a handler that commits in a LATER task (an `onSuccess`
   * that bumps its state after an `await`) commits after the shot has already
   * been taken. The shot then lands on the node that is about to be detached
   * and the commit drops the keyboard to `<body>`.
   *
   * Recorded with a capture-phase `focusin` log rather than with
   * `document.activeElement`, because by the time an `act` flush returns the
   * deferred commit has already detached the node the shot hit and
   * `activeElement` has fallen back to `<body>`. The log is what makes this
   * cell load-bearing: deleting the restore empties it (mutation M1). The
   * terminal `<body>` is a documented state, not a guard — it is where the
   * unfixed dialog left focus, and reaching the re-mounted node would need the
   * wait the ruling removed. A retry chain does not red this cell either,
   * because its first attempt SUCCEEDS on the doomed node and never re-arms
   * (executed, review r1), which is precisely why this shape is an open
   * question and not a bug to patch in the dialog.
   */
  it('takes its one shot before a confirm handler that commits in a later task', async () => {
    render(<ReplacedTriggerHarness mode="replaced-late" />);
    const originalNode = openFromTrigger();

    const focusLog: Element[] = [];
    const record = (event: Event) => {
      if (event.target instanceof Element) focusLog.push(event.target);
    };
    document.addEventListener('focusin', record, true);
    try {
      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
      await flushCloseAutoFocus();
      // Let the deferred commit land, and then some: nothing may act afterwards.
      await act(async () => {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 50);
        await promise;
      });
    } finally {
      document.removeEventListener('focusin', record, true);
    }

    const remounted = screen.getByTestId('trigger');
    // Premise: the commit really did re-mount the control, and the control that
    // replaced it really can take focus — so the terminal state below is the
    // ordering, not an unfocusable trigger.
    expect(remounted).not.toBe(originalNode);
    expect(remounted).not.toHaveAttribute('disabled');

    // The shot was taken, on the PRE-commit DOM: it hit the node the commit was
    // about to throw away, and never saw the node that replaced it.
    expect(focusLog).toContain(originalNode);
    expect(focusLog).not.toContain(remounted);
    expect(document.activeElement).toBe(document.body);
  });
});
