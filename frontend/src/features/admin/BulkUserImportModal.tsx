/**
 * Three-step bulk-user CSV import dialog (EE #116).
 *
 * Step 1 — File picker. User picks a `.csv` file; we read it with
 * `FileReader` and POST the raw text to `/admin/users/bulk/preview`.
 * Server (EE overlay) parses with `fast-csv`, validates each row, and
 * returns a per-row preview with field-level errors and dup detection.
 *
 * Step 2 — Preview. We render the parsed rows. Invalid rows highlighted
 * red with the field-level errors next to them; rows that match an
 * existing username/email highlighted yellow with the existing-marker.
 * Summary chip at top: `N valid · N invalid · N will update`.
 *
 * Step 3 — Confirm. Radio for `create-only` (errors on dups) vs
 * `upsert` (updates existing in place). Submit POSTs to
 * `/admin/users/bulk/import` with `{ csv, mode }`. On success we close,
 * toast, and invalidate the user list query.
 *
 * Until the EE overlay PR lands, the bulk routes don't exist server-side
 * — the preview call 404s and we render an inline "requires Enterprise"
 * message instead of the preview table. The whole modal is also
 * feature-gated by `useEnterprise().hasFeature('bulk_user_operations')`
 * so it never appears in CE-only mode anyway, but the inline 404 branch
 * is the belt-and-braces fallback for the licence-installed-but-overlay-
 * not-yet-deployed transitional state.
 *
 * Glassmorphic styling per ADR-010 — same `DialogShell` shape as
 * `WebhooksTab` so the visual idiom is consistent.
 */

import { useCallback, useState, type ChangeEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Upload,
  Users,
  X,
} from 'lucide-react';
import type {
  BulkUserImportPreviewResponse,
  BulkUserImportApplyRequest,
} from '@compendiq/contracts';
import { useAuthStore } from '../../stores/auth-store';
import { useEnterprise } from '../../shared/enterprise/use-enterprise';
import { cn } from '../../shared/lib/cn';

// ── Local fetch helper ─────────────────────────────────────────────────────
// Mirrors the WebhooksTab / IpAllowlistTab pattern — we bypass `apiFetch`
// because the structured error shape from the EE overlay (`{ error: ... }`)
// gets flattened to `.message` by the shared helper, and we want the raw
// response status to detect the "overlay not deployed" 404 case.

interface BackendErrorBody {
  error?: string;
  message?: string;
  detail?: string;
}

type FetchError = Error & {
  status?: number;
  body?: BackendErrorBody;
};

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const { accessToken } = useAuthStore.getState();
  const headers = new Headers(init?.headers);
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(`/api${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });
  if (!res.ok) {
    const body: BackendErrorBody = await res.json().catch(() => ({}));
    const err = new Error(
      body.message ?? body.error ?? res.statusText,
    ) as FetchError;
    err.status = res.status;
    err.body = body;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  if (res.headers.get('content-type')?.includes('application/json')) {
    return res.json();
  }
  return undefined as T;
}

// ── Public component ──────────────────────────────────────────────────────

interface BulkUserImportModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Outer gate. Renders nothing in CE-only mode so the modal never shows
 * even if a parent forgets to gate the trigger button.
 */
export function BulkUserImportModal({
  open,
  onClose,
}: BulkUserImportModalProps) {
  const { hasFeature } = useEnterprise();
  if (!hasFeature('bulk_user_operations')) {
    return null;
  }
  return <BulkUserImportModalInner open={open} onClose={onClose} />;
}

// ── Inner stateful body ───────────────────────────────────────────────────

type Step =
  | { kind: 'pick' }
  | { kind: 'previewing'; csv: string; filename: string }
  | {
      kind: 'preview-loaded';
      csv: string;
      filename: string;
      preview: BulkUserImportPreviewResponse;
    }
  | {
      kind: 'preview-failed';
      csv: string;
      filename: string;
      message: string;
      // 404 means the EE overlay isn't deployed yet — render the
      // "requires Enterprise" message instead of the generic error.
      isMissingOverlay: boolean;
    };

type Mode = 'create-only' | 'upsert';

function BulkUserImportModalInner({
  open,
  onClose,
}: BulkUserImportModalProps) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>({ kind: 'pick' });
  const [mode, setMode] = useState<Mode>('create-only');

  const reset = useCallback(() => {
    setStep({ kind: 'pick' });
    setMode('create-only');
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  // ── Preview mutation ────────────────────────────────────────────────────
  const previewMutation = useMutation({
    mutationFn: ({ csv, filename }: { csv: string; filename: string }) =>
      fetchJson<BulkUserImportPreviewResponse>(
        '/admin/users/bulk/preview',
        {
          method: 'POST',
          body: JSON.stringify({ csv }),
        },
      ).then((preview) => ({ preview, csv, filename })),
    onMutate: ({ csv, filename }) => {
      setStep({ kind: 'previewing', csv, filename });
    },
    onSuccess: ({ preview, csv, filename }) => {
      setStep({ kind: 'preview-loaded', csv, filename, preview });
    },
    onError: (err: FetchError, { csv, filename }) => {
      const isMissingOverlay = err.status === 404;
      setStep({
        kind: 'preview-failed',
        csv,
        filename,
        message: isMissingOverlay
          ? 'Bulk user operations require Enterprise. Install the Enterprise overlay or contact your administrator.'
          : err.message || 'Preview failed',
        isMissingOverlay,
      });
    },
  });

  // ── Apply mutation ──────────────────────────────────────────────────────
  const applyMutation = useMutation({
    mutationFn: (body: BulkUserImportApplyRequest) =>
      fetchJson<{ created: number; updated: number; skipped: number }>(
        '/admin/users/bulk/import',
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      ),
    onSuccess: () => {
      toast.success('Bulk import complete');
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      // CE #304 also uses ['admin', 'users'] — keep both in sync so the
      // UsersAdminPage list re-fetches regardless of which key wins.
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      handleClose();
    },
    onError: (err: FetchError) => {
      toast.error(err.message || 'Bulk import failed');
    },
  });

  // ── File picker handler ─────────────────────────────────────────────────
  const onFileChosen = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      // Accept any file the user picks — the server is the authoritative
      // CSV validator. We just need the text.
      const csv = await file.text();
      previewMutation.mutate({ csv, filename: file.name });
    },
    [previewMutation],
  );

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) handleClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
          data-testid="bulk-import-overlay"
        />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-full max-w-3xl -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border/60 bg-card/90 shadow-2xl backdrop-blur-xl outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 max-h-[85vh] overflow-y-auto',
          )}
          aria-describedby={undefined}
          data-testid="bulk-import-modal"
        >
          <div className="flex items-center justify-between border-b border-border/50 px-5 py-4">
            <Dialog.Title className="flex items-center gap-2 text-base font-semibold">
              <Users size={16} className="text-primary" />
              Bulk import users
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                aria-label="Close"
                data-testid="bulk-import-close"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <div className="p-5">
            {step.kind === 'pick' && (
              <PickStep onFileChosen={onFileChosen} />
            )}

            {step.kind === 'previewing' && (
              <div
                className="flex items-center gap-3 rounded-lg border border-border/40 bg-foreground/5 p-4 text-sm"
                data-testid="bulk-import-previewing"
              >
                <Loader2 size={16} className="animate-spin" />
                <span>
                  Parsing <strong>{step.filename}</strong>…
                </span>
              </div>
            )}

            {step.kind === 'preview-loaded' && (
              <PreviewStep
                preview={step.preview}
                filename={step.filename}
                mode={mode}
                onModeChange={setMode}
                onBack={reset}
                onSubmit={() =>
                  applyMutation.mutate({ csv: step.csv, mode })
                }
                applying={applyMutation.isPending}
              />
            )}

            {step.kind === 'preview-failed' && (
              <PreviewFailedStep
                message={step.message}
                isMissingOverlay={step.isMissingOverlay}
                onBack={reset}
              />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ── Step 1: file picker ───────────────────────────────────────────────────

interface PickStepProps {
  onFileChosen: (e: ChangeEvent<HTMLInputElement>) => void;
}

function PickStep({ onFileChosen }: PickStepProps) {
  return (
    <div className="space-y-4" data-testid="bulk-import-pick">
      <p className="text-sm text-muted-foreground">
        Pick a CSV file with the columns{' '}
        <code className="rounded bg-foreground/10 px-1 text-xs">
          username,email,displayName,role,initialPassword,sendInvitation
        </code>
        . The server will parse and validate every row, then show a
        preview before any change is written. See ADMIN-GUIDE → Bulk
        user operations for the exact format and a downloadable
        template.
      </p>

      <label
        htmlFor="bulk-import-file"
        className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border/60 bg-foreground/[0.02] p-8 text-sm transition-colors hover:border-primary/60 hover:bg-foreground/5"
        data-testid="bulk-import-dropzone"
      >
        <Upload size={20} className="text-muted-foreground" />
        <span className="font-medium">Click to choose a .csv file</span>
        <span className="text-xs text-muted-foreground">
          The file is parsed server-side; nothing is written until you
          confirm.
        </span>
      </label>

      <input
        type="file"
        id="bulk-import-file"
        data-testid="bulk-import-file-input"
        accept=".csv,text/csv"
        className="sr-only"
        onChange={onFileChosen}
      />
    </div>
  );
}

// ── Step 2: preview table ─────────────────────────────────────────────────

interface PreviewStepProps {
  preview: BulkUserImportPreviewResponse;
  filename: string;
  mode: Mode;
  onModeChange: (m: Mode) => void;
  onBack: () => void;
  onSubmit: () => void;
  applying: boolean;
}

function PreviewStep({
  preview,
  filename,
  mode,
  onModeChange,
  onBack,
  onSubmit,
  applying,
}: PreviewStepProps) {
  const { rows, summary } = preview;
  return (
    <div className="space-y-4" data-testid="bulk-import-preview">
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          Preview of <strong>{filename}</strong>
        </p>
        <div
          className="flex flex-wrap gap-2 text-xs"
          data-testid="bulk-import-summary"
        >
          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 font-medium text-emerald-700 dark:text-emerald-300">
            {summary.valid} valid
          </span>
          {summary.invalid > 0 && (
            <span className="rounded-full bg-red-500/15 px-2 py-0.5 font-medium text-red-700 dark:text-red-300">
              {summary.invalid} invalid
            </span>
          )}
          {summary.wouldUpdate > 0 && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-700 dark:text-amber-300">
              {summary.wouldUpdate} will update
            </span>
          )}
          {summary.wouldCreate > 0 && (
            <span className="rounded-full bg-sky-500/15 px-2 py-0.5 font-medium text-sky-700 dark:text-sky-300">
              {summary.wouldCreate} new
            </span>
          )}
          {summary.wouldSkip > 0 && (
            <span className="rounded-full bg-foreground/10 px-2 py-0.5 font-medium text-muted-foreground">
              {summary.wouldSkip} skipped
            </span>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-border/40">
        <table className="w-full text-xs">
          <thead className="bg-foreground/5 text-left uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="p-2">#</th>
              <th className="p-2">Username</th>
              <th className="p-2">Email</th>
              <th className="p-2">Role</th>
              <th className="p-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => {
              const invalid = r.row === null || r.errors.length > 0;
              const dup = r.existing !== 'none';
              return (
                <tr
                  key={idx}
                  className={cn(
                    'border-t border-border/40',
                    invalid && 'bg-red-500/5',
                    !invalid && dup && 'bg-amber-500/5',
                  )}
                  data-testid={`bulk-import-row-${idx}`}
                >
                  <td className="p-2 text-muted-foreground">{idx + 1}</td>
                  <td className="p-2 font-medium">{r.row?.username ?? '—'}</td>
                  <td className="p-2 text-muted-foreground">
                    {r.row?.email ?? '—'}
                  </td>
                  <td className="p-2">{r.row?.role ?? '—'}</td>
                  <td className="p-2">
                    {invalid ? (
                      <span
                        className="flex items-center gap-1 text-red-700 dark:text-red-300"
                        data-testid={`bulk-import-row-${idx}-invalid`}
                      >
                        <AlertTriangle size={12} />
                        {r.errors.length > 0 ? r.errors.join(', ') : 'Invalid row'}
                      </span>
                    ) : dup ? (
                      <span
                        className="text-amber-700 dark:text-amber-300"
                        data-testid={`bulk-import-row-${idx}-dup`}
                      >
                        existing {r.existing}
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                        <CheckCircle2 size={12} />
                        ready
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <fieldset
        className="space-y-2 rounded-lg border border-border/40 p-3"
        data-testid="bulk-import-mode"
      >
        <legend className="px-1 text-xs font-medium text-muted-foreground">
          Apply mode
        </legend>
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="radio"
            name="bulk-import-mode"
            checked={mode === 'create-only'}
            onChange={() => onModeChange('create-only')}
            data-testid="bulk-import-mode-create-only"
            className="mt-1"
          />
          <div>
            <div className="font-medium">Create only</div>
            <div className="text-xs text-muted-foreground">
              Errors out if any row matches an existing username or
              email. Safest for first-time onboarding batches.
            </div>
          </div>
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="radio"
            name="bulk-import-mode"
            checked={mode === 'upsert'}
            onChange={() => onModeChange('upsert')}
            data-testid="bulk-import-mode-upsert"
            className="mt-1"
          />
          <div>
            <div className="font-medium">Upsert</div>
            <div className="text-xs text-muted-foreground">
              Updates existing users in place; creates the rest. Useful
              for periodic full-roster syncs.
            </div>
          </div>
        </label>
      </fieldset>

      <div className="flex justify-end gap-2 border-t border-border/40 pt-4">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md border border-border/60 px-4 py-2 text-sm hover:bg-foreground/5"
          data-testid="bulk-import-back"
          disabled={applying}
        >
          Back
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={applying || summary.valid === 0}
          className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          data-testid="bulk-import-submit"
        >
          {applying && <Loader2 size={14} className="animate-spin" />}
          Import {summary.valid} user{summary.valid === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  );
}

// ── Step 2/error: preview failed ──────────────────────────────────────────

interface PreviewFailedStepProps {
  message: string;
  isMissingOverlay: boolean;
  onBack: () => void;
}

function PreviewFailedStep({
  message,
  isMissingOverlay,
  onBack,
}: PreviewFailedStepProps) {
  return (
    <div
      className="space-y-4"
      data-testid={
        isMissingOverlay
          ? 'bulk-import-requires-enterprise'
          : 'bulk-import-error'
      }
    >
      <div
        role="alert"
        className={cn(
          'flex items-start gap-3 rounded-lg border p-4 text-sm',
          isMissingOverlay
            ? 'border-amber-500/40 bg-amber-500/10 text-amber-100'
            : 'border-red-500/40 bg-red-500/10 text-red-100',
        )}
      >
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <div>{message}</div>
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md border border-border/60 px-4 py-2 text-sm hover:bg-foreground/5"
          data-testid="bulk-import-error-back"
        >
          Back
        </button>
      </div>
    </div>
  );
}
