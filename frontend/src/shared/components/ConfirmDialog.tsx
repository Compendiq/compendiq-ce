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
 * of Radix hooks below saves the element that was focused when the dialog
 * opened and returns focus to it on close.
 */

import { useRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';

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
   * The element that had focus when this dialog opened. Captured in
   * `onOpenAutoFocus` rather than in an effect: FocusScope reads
   * `document.activeElement`, dispatches that event, and only THEN moves focus
   * into the content, so the event is the last moment the invoking element is
   * still `activeElement` — and a `useEffect` here would run after the child's
   * mount effect, i.e. after focus has already moved.
   */
  const invokerRef = useRef<HTMLElement | null>(null);
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
            const active = document.activeElement;
            invokerRef.current = active instanceof HTMLElement ? active : null;
            // Deliberately no `preventDefault()`: Radix's initial focus into
            // the content is the focus-trap entry this dialog wants.
          }}
          onCloseAutoFocus={(event) => {
            const invoker = invokerRef.current;
            invokerRef.current = null;
            // Two guards, both `EmbeddingShadowMigrationCard` precedent. The
            // saved element may have been removed by the very action that was
            // confirmed (a deleted row's own menu button), and focusing a
            // detached node silently drops focus to `<body>` — the defect this
            // exists to fix. And a callsite that rehomed focus itself during
            // the closing commit has ALREADY put the keyboard somewhere
            // deliberate; only a keyboard sitting on `<body>` is lost.
            if (!invoker || !document.contains(invoker)) return;
            if (document.activeElement !== document.body) return;
            // Suppresses `DialogContentModal`'s composed handler, which would
            // otherwise `preventDefault()` FocusScope's restore and focus a
            // `triggerRef` this trigger-less dialog never populates.
            event.preventDefault();
            invoker.focus();
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
