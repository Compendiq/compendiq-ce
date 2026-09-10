/**
 * Shared confirmation dialog — replaces the browser-native confirm() prompt so
 * confirmations match the neumorphic design system (ADR-010) instead of
 * the OS-styled browser dialog.
 *
 * Built on @radix-ui/react-dialog (same primitive as UserBulkActionDialog
 * et al.), which provides focus trapping, initial focus, Escape-to-dismiss
 * and overlay-click-to-dismiss for free. Both dismissal paths route
 * through `onCancel` via `onOpenChange(false)` — unless `onDismiss` is
 * provided, which they route to instead. Pass `onDismiss` whenever the
 * Cancel button carries a real action (not just "close"), so Escape and
 * overlay-click stay neutral.
 *
 * The confirm button uses the design-system `nm-button-destructive`
 * utility when `destructive` (same box metrics as `nm-button-primary` /
 * `nm-button-ghost`, destructive palette), otherwise `nm-button-primary`.
 *
 * **Focus returns to whatever invoked it** (#1531). Radix's own restore does
 * not fire here: `DialogContentModal` composes an `onCloseAutoFocus` that
 * `preventDefault()`s FocusScope's `focus(previouslyFocusedElement)` and
 * focuses `context.triggerRef` instead — and this component is fully
 * controlled through the `open` prop and renders no `Dialog.Trigger`, so that
 * ref is permanently `null`. The suppression stood, the replacement focused
 * nothing, and Cancel, Escape and Confirm each dropped the keyboard to
 * `<body>` at the top of a ~30-stop settings panel (WCAG 2.4.3). So the pair
 * of Radix hooks below saves the control that was focused when the dialog
 * opened and returns focus to it on close.
 *
 * The restore is a SINGLE deterministic step, resolved by identity rather than
 * by waiting (architect ruling, external round). Two earlier shapes are gone
 * for the same reason: a 500 ms restore window, and the DOM-mutation retry
 * chain that replaced it. Both were attempts to out-wait a trigger that could
 * not take focus, and neither can be reasoned about at a callsite — the window
 * restored focus on a fast server and silently gave up on a slow one, and the
 * retry chain left a document-wide `MutationObserver` running past the
 * dialog's own life to fix what is an identity problem, not a timing one.
 * `onCloseAutoFocus` fires one macrotask after the closing commit, so it reads
 * every commit the confirm handler made SYNCHRONOUSLY — the shape every
 * ConfirmDialog callsite has — and there is nothing left for it to wait for.
 * It is NOT a promise about a handler that commits its busy or re-mount state
 * in a LATER task (an `await` before `setIsPending`): that commit lands after
 * the single shot, so the shot reads the PRE-commit DOM (probed in review r1;
 * pinned by `mode="replaced-late"` in the test). The terminal state for that
 * shape is `<body>` — where the unfixed dialog left it — and closing it needs
 * a wait, which is the thing the ruling forbids. Recorded as an open question
 * rather than papered over here.
 *
 * What the one step resolves, in order:
 *
 * 1. Nothing at all, if the keyboard is not on `<body>`. The admin who tabbed
 *    on, and the callsite that rehomed focus during its own commit
 *    (`EmbeddingShadowMigrationCard`'s `rehomeAfterDismiss`), have both put
 *    focus somewhere deliberate; a shared dialog never takes it back.
 * 2. The invoker. The captured NODE, whenever it is still in the document —
 *    which is the whole restore for most real triggers, because most of them
 *    (`SpacesTab`'s Remove space and Save Selection, `PageViewPage`'s discard
 *    and trash, `ArticleRightPane`, `DrawioEditor`) carry neither a
 *    `data-testid` nor an `id` and so have no identity to re-resolve. Failing
 *    that, by IDENTITY (`data-testid`, else `id`): a callsite whose confirmed
 *    commit re-mounts the trigger as a new DOM node (a re-keyed row, a list
 *    that re-renders) leaves the captured node detached by close time while
 *    the control the admin pressed is still on screen. A dialog opened from a
 *    menu item captures the closing menu's portalled content instead of the
 *    kebab, so `menuOwner` maps that back through Radix's own aria contract
 *    (menu content carries `aria-labelledby={triggerId}`, the trigger carries
 *    that `id`) at capture time.
 * 3. Nothing, if that control is gone (`ConversationRowMenu`'s Delete takes
 *    its own kebab with the row) or cannot take focus. A trigger that holds
 *    itself natively `disabled` for the length of its POST is exactly the
 *    #1532 defect — in jsdom `focus()` simply no-ops on it, and in a browser
 *    the HTML focus fixup rule has already blurred the admin to `<body>`
 *    before this dialog is consulted — and the fix for it is converting the
 *    control to `aria-disabled` + a refusing handler, as
 *    `AttachmentStorageCard`, `ImageIndexCard` and `SyncTab`'s Force Re-sync
 *    All now are. That last one is why this paragraph is not hypothetical: a
 *    real-browser pass at `a820e9b7` found the restore working on every
 *    dismiss path and dropping to `<body>` on exactly the one trigger whose
 *    own confirm disabled it (checklist items 3 and 11). It is not this
 *    component's business to poll the document until someone else's button
 *    comes back.
 */

import { useEffect, useRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';

/**
 * The invoking control, plus a way to find it again if the confirmed action
 * replaced the node. `data-testid` first, `id` second, and often neither:
 * an `id` minted by Radix's `useId()` is regenerated by a re-mount and so only
 * ever resolves the node that is still there, but an author-written `id` (a
 * plain `<button id="…">`) survives one, which is why the second branch exists
 * and is tested. When both are absent `selector` is `null` and the captured
 * node is the whole restore — the common case, see (2) in the header.
 */
interface Invoker {
  node: HTMLElement;
  selector: string | null;
}

const cssString = (value: string) => `"${value.replace(/["\\]/g, '\\$&')}"`;

function identitySelector(node: HTMLElement): string | null {
  const testid = node.dataset.testid;
  if (testid) return `[data-testid=${cssString(testid)}]`;
  if (node.id) return `[id=${cssString(node.id)}]`;
  return null;
}

/** See (2) in the header: the menu the captured node belongs to names its trigger. */
function menuOwner(active: HTMLElement): HTMLElement | null {
  const menu = active.closest('[role="menu"],[role="menubar"]');
  const ownerId = menu?.getAttribute('aria-labelledby');
  const owner = ownerId ? document.getElementById(ownerId) : null;
  return owner instanceof HTMLElement ? owner : null;
}

function captureInvoker(active: Element | null): Invoker | null {
  if (!(active instanceof HTMLElement)) return null;
  const node = menuOwner(active) ?? active;
  return { node, selector: identitySelector(node) };
}

function resolveInvoker({ node, selector }: Invoker): HTMLElement | null {
  if (document.contains(node)) return node;
  const replacement = selector ? document.querySelector(selector) : null;
  return replacement instanceof HTMLElement ? replacement : null;
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  /** Cancel-button text. Defaults to "Cancel". */
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /**
   * Escape / overlay-click handler. Defaults to `onCancel`. Provide it when
   * the Cancel button performs a real action, so dismissing the dialog means
   * "close without choosing" rather than silently picking the cancel path.
   */
  onDismiss?: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel,
  onDismiss,
}: ConfirmDialogProps) {
  /**
   * The control that had focus when this dialog opened. Captured in
   * `onOpenAutoFocus` rather than in an effect: FocusScope reads
   * `document.activeElement`, dispatches that event, and only THEN moves focus
   * into the content, so the event is the last moment the invoking element is
   * still `activeElement` — and a `useEffect` here would run after the child's
   * mount effect, i.e. after focus has already moved.
   */
  const invokerRef = useRef<Invoker | null>(null);
  /**
   * False from the unmount commit onwards. Radix's FocusScope dispatches
   * close-auto-focus from a `setTimeout(…, 0)` in its own effect cleanup, so an
   * owner that unmounts a still-OPEN dialog (a 401 redirect to the login page,
   * a parent switching to an error branch) reaches `onCloseAutoFocus` a
   * macrotask after every cleanup here has already run. Without this flag the
   * restore re-resolves the invoker by `data-testid` against whatever surface
   * replaced the dialog's own, and a fresh screen looks exactly like the state
   * the restore acts on — `<body>` holding the keyboard (review r1, proved by a
   * probe that focused a control on the next route).
   */
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) (onDismiss ?? onCancel)();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
          data-testid="confirm-dialog-overlay"
        />
        <Dialog.Content
          className="nm-card fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 p-6 outline-none"
          data-testid="confirm-dialog"
          onOpenAutoFocus={() => {
            invokerRef.current = captureInvoker(document.activeElement);
            // Deliberately no `preventDefault()`: Radix's initial focus into
            // the content is the focus-trap entry this dialog wants.
          }}
          onCloseAutoFocus={() => {
            const invoker = invokerRef.current;
            // A release, not a guard: nothing else reads it, and a closed
            // dialog that keeps the reference pins a possibly-detached subtree
            // until its next open. No cell can red for it and none is claimed
            // (see the mutation table in the PR) — every open dispatches
            // `onOpenAutoFocus` and overwrites it, so there is no
            // stale-invoker path left to observe.
            invokerRef.current = null;
            // `Invoker | null` narrowing rather than a behaviour branch: `tsc`
            // is what reds for it ("'invoker' is possibly 'null'").
            if (!invoker) return;
            // No `preventDefault()` here, deliberately (external round). This
            // dialog renders no `Dialog.Trigger`, so `DialogContentModal`'s
            // composed handler — `event.preventDefault();
            // context.triggerRef.current?.focus()` — prevents the default
            // either way and then focuses a ref that is permanently `null`.
            // Suppressing it suppressed a no-op: no cell could red for the
            // line, so it is gone rather than defended in a comment.
            //
            // See the header: one attempt, on the post-confirm DOM, and only
            // while nothing else holds the keyboard. `focus()` on a control
            // that cannot take it is a no-op, which is the intended outcome —
            // not a state to wait out.
            if (!aliveRef.current) return;
            if (document.activeElement !== document.body) return;
            resolveInvoker(invoker)?.focus();
          }}
        >
          <Dialog.Title className="text-base font-semibold text-foreground">
            {title}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-muted-foreground">
            {description}
          </Dialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="nm-button-ghost"
              data-testid="confirm-dialog-cancel"
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className={destructive ? 'nm-button-destructive' : 'nm-button-primary'}
              data-testid="confirm-dialog-confirm"
            >
              {confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
