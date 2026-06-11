/**
 * Shared confirmation dialog — replaces the browser-native confirm() prompt so
 * confirmations match the neumorphic design system (ADR-010) instead of
 * the OS-styled browser dialog.
 *
 * Built on @radix-ui/react-dialog (same primitive as UserBulkActionDialog
 * et al.), which provides focus trapping, initial focus, Escape-to-dismiss
 * and overlay-click-to-dismiss for free. Both dismissal paths route
 * through `onCancel` via `onOpenChange(false)`.
 *
 * The confirm button uses the design-system `nm-button-destructive`
 * utility when `destructive` (same box metrics as `nm-button-primary` /
 * `nm-button-ghost`, destructive palette), otherwise `nm-button-primary`.
 */

import * as Dialog from '@radix-ui/react-dialog';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel();
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
              Cancel
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
