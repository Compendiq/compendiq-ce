import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ShieldAlert, Webhook, type LucideIcon } from 'lucide-react';
import { AdminSettingsSchema, type AdminSettings } from '@compendiq/contracts';
import { apiFetch } from '../../shared/lib/api';
import { cn } from '../../shared/lib/cn';
import { useNoticeRetry } from '../../shared/hooks/use-notice-retry';

// ── CE-native retention windows (#264, #1875) ──────────────────────────────
//
// Single-table retention windows applied by the daily `data-retention-service`
// sweep, stored in `admin_settings` and edited through `/admin/settings`. The
// sweep runs in every edition and regardless of licence state, so the section
// is rendered in BOTH branches of `DataRetentionTab` (outside the Enterprise
// `data_retention_policies` gate) and is not gated on `webhook_push`: ledger
// rows outlive the webhook feature and are still pruned by this window.
//
// Each row is its own form and PUTs exactly one key, so saving one window can
// never carry, or overwrite, the other row's draft or any other admin setting.

type RetentionField = 'adminAccessDeniedRetentionDays' | 'webhookDeliveriesRetentionDays';

/** Backend default for both windows; shown when an older backend omits a field. */
const RETENTION_DEFAULT_DAYS = 90;
const VALIDATION_MESSAGE = 'Enter a whole number from 7 to 3650.';

interface RetentionRowConfig {
  field: RetentionField;
  /** Element id prefix; the input id doubles as its test id. */
  idBase: string;
  saveTestId: string;
  rowTestId: string;
  label: string;
  description: ReactNode;
  icon: LucideIcon;
  successToast: string;
}

const inlineCode = 'rounded bg-foreground/10 px-1';

const RETENTION_ROWS: RetentionRowConfig[] = [
  {
    field: 'adminAccessDeniedRetentionDays',
    idBase: 'admin-denied-retention',
    saveTestId: 'admin-denied-retention-save-btn',
    rowTestId: 'denied-admin-retention-section',
    label: 'Admin access-denied audit retention (days)',
    description: (
      <>
        Automated purge of <code className={inlineCode}>audit_log</code>{' '}
        rows recorded when non-admins attempted admin endpoints
        (action = <code className={inlineCode}>ADMIN_ACCESS_DENIED</code>).
        Default 90 days. Applies only to these rows; other audit events
        retain their own retention.
      </>
    ),
    icon: ShieldAlert,
    successToast: 'Denied-admin retention updated',
  },
  {
    field: 'webhookDeliveriesRetentionDays',
    idBase: 'webhook-deliveries-retention',
    saveTestId: 'webhook-deliveries-retention-save-btn',
    rowTestId: 'webhook-deliveries-retention-section',
    label: 'Webhook delivery attempts retention (days)',
    description: (
      <>
        Automated purge of <code className={inlineCode}>webhook_deliveries</code>{' '}
        rows, the log of each webhook delivery attempt. Only attempts of finished
        deliveries (delivered or dead-lettered) are removed; deliveries still
        retrying and the <code className={inlineCode}>webhook_outbox</code> queue
        are never touched. Default 90 days.
      </>
    ),
    icon: Webhook,
    successToast: 'Webhook delivery retention updated',
  },
];

/**
 * Parse a draft with the contract's own field schema, so the client accepts
 * exactly what `PUT /admin/settings` accepts (integer, 7–3650). The server
 * still validates; this only keeps an invalid value from being sent.
 */
function parseRetentionDays(field: RetentionField, raw: string): number | null {
  if (raw.trim() === '') return null;
  const result = AdminSettingsSchema.shape[field].safeParse(Number(raw));
  return result.success ? result.data : null;
}

function withTerminalPunctuation(message: string): string {
  const trimmed = message.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function RetentionDaysRow({ config, serverValue }: { config: RetentionRowConfig; serverValue: number }) {
  const queryClient = useQueryClient();
  // Raw input text over the server value: `undefined` means "showing saved",
  // so a background refetch never clobbers an unsaved edit.
  const [draft, setDraft] = useState<string | undefined>(undefined);
  // The validation message waits for blur or a submit attempt, so typing "30"
  // never flashes (or announces) an error at "3". `aria-invalid` stays live.
  const [touched, setTouched] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // `isPending` re-renders through react-query's notify scheduler, not
  // synchronously, so a second activation in the same tick needs this guard.
  const inFlight = useRef(false);

  const save = useMutation({
    mutationFn: ({ days }: { days: number; submitted: string }) =>
      apiFetch('/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({ [config.field]: days }),
      }),
    onSuccess: async (_result, { days, submitted }) => {
      // The write is confirmed even if the follow-up read fails. Merge only
      // this field: the key is shared with other settings panels.
      queryClient.setQueryData<AdminSettings>(['admin-settings'], (current) =>
        current ? { ...current, [config.field]: days } : current,
      );
      // Keep an edit typed while the request was out.
      setDraft((current) => (current === submitted ? undefined : current));
      toast.success(config.successToast);
      await queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
    },
    onError: (err) => {
      setSaveError(err instanceof Error && err.message ? err.message : 'The change could not be saved');
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });

  const parsed = draft === undefined ? serverValue : parseRetentionDays(config.field, draft);
  const invalid = draft !== undefined && parsed === null;
  const hasChange = draft !== undefined && parsed !== null && parsed !== serverValue;
  const pending = save.isPending;
  const unavailable = !hasChange || pending;
  const showValidation = invalid && touched;

  const inputId = `${config.idBase}-input`;
  const descriptionId = `${config.idBase}-description`;
  const hintId = `${config.idBase}-hint`;
  const validationId = `${config.idBase}-error`;
  const saveErrorId = `${config.idBase}-save-error`;
  const describedBy = [
    descriptionId,
    hintId,
    showValidation ? validationId : null,
    saveError ? saveErrorId : null,
  ].filter(Boolean).join(' ');

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched(true);
    if (inFlight.current || draft === undefined || parsed === null || !hasChange) return;
    inFlight.current = true;
    setSaveError(null);
    save.mutate({ days: parsed, submitted: draft });
  }

  const Icon = config.icon;
  return (
    <form
      noValidate
      onSubmit={handleSubmit}
      className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 py-4 last:pb-0"
      data-testid={config.rowTestId}
    >
      <div className="flex min-w-0 flex-1 basis-72 items-start gap-3">
        <Icon size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <label htmlFor={inputId} className="block text-sm font-medium">
            {config.label}
          </label>
          <p id={descriptionId} className="mt-1 text-xs text-muted-foreground">
            {config.description}
          </p>
          <p id={hintId} className="mt-1 text-xs text-muted-foreground">
            Whole days, 7–3650.
          </p>
          {/* Mounted for the row's life so the message is announced when it appears. */}
          <p
            id={validationId}
            aria-live="polite"
            className={cn('text-xs text-destructive', showValidation && 'mt-1')}
          >
            {showValidation ? VALIDATION_MESSAGE : ''}
          </p>
          {saveError && (
            <p id={saveErrorId} role="alert" className="mt-1 break-words text-xs text-destructive">
              {withTerminalPunctuation(saveError)} Your change has been kept. Retry saving.
            </p>
          )}
        </div>
      </div>
      <div className="ml-[30px] flex shrink-0 items-center gap-2 sm:ml-0">
        <input
          id={inputId}
          data-testid={inputId}
          type="number"
          inputMode="numeric"
          min={7}
          max={3650}
          step={1}
          value={draft ?? String(serverValue)}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(event) => {
            setDraft(event.target.value);
            setTouched(false);
            setSaveError(null);
          }}
          onBlur={() => setTouched(true)}
          className={cn('nm-input h-8 w-24 text-right tabular-nums', showValidation && 'border-destructive')}
        />
        <button
          type="submit"
          aria-disabled={unavailable || undefined}
          aria-busy={pending || undefined}
          className="nm-button-ghost h-8 min-w-20 justify-center text-xs aria-disabled:cursor-default aria-disabled:opacity-70"
          data-testid={config.saveTestId}
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

export function RetentionWindowsSection() {
  const { data: settings, isError, refetch } = useQuery<AdminSettings>({
    queryKey: ['admin-settings'],
    queryFn: () => apiFetch('/admin/settings'),
  });
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { retryInFlight, onRetry } = useNoticeRetry(refetch, isError, headingRef);
  const showFailure = isError || retryInFlight;
  // An older backend may omit either field; treat it as the shipped default.
  const serverValues: Partial<Pick<AdminSettings, RetentionField>> | undefined = settings;

  return (
    <section
      className="nm-card p-4"
      aria-labelledby="retention-windows-heading"
      data-testid="retention-windows-section"
    >
      <h2
        id="retention-windows-heading"
        ref={headingRef}
        tabIndex={-1}
        className="text-lg font-semibold focus:outline-none"
      >
        Retention windows
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        The daily retention sweep deletes these rows once they are older than
        their window. Each window is saved on its own.
      </p>

      {showFailure && (
        <p role="status" className={cn('mt-3 text-xs', settings ? 'text-warning' : 'text-destructive')}>
          <span id="retention-windows-notice">
            {settings
              ? 'Retention settings could not be refreshed. Last loaded values and unsaved edits are still shown.'
              : 'Retention settings could not be read.'}
          </span>{' '}
          <button
            type="button"
            onClick={onRetry}
            aria-disabled={retryInFlight || undefined}
            aria-describedby="retention-windows-notice"
            className="nm-button-ghost h-8 text-xs aria-disabled:cursor-default aria-disabled:opacity-70"
            data-testid="retention-windows-retry"
          >
            {retryInFlight ? 'Retrying…' : 'Retry'}
          </button>
        </p>
      )}

      {serverValues ? (
        // `max-w-2xl` matches the cap SettingsLayout puts on every form (each
        // row is one), so the hairlines run exactly as wide as the rows.
        <div className="mt-4 max-w-2xl divide-y divide-border border-t border-border">
          {RETENTION_ROWS.map((config) => (
            <RetentionDaysRow
              key={config.field}
              config={config}
              serverValue={serverValues[config.field] ?? RETENTION_DEFAULT_DAYS}
            />
          ))}
        </div>
      ) : !showFailure ? (
        <div role="status" className="mt-4 space-y-3" data-testid="denied-admin-retention-loading">
          <p className="text-xs text-muted-foreground">Loading retention settings…</p>
          <div aria-hidden="true" className="h-10 animate-pulse rounded bg-foreground/5" />
          <div aria-hidden="true" className="h-10 animate-pulse rounded bg-foreground/5" />
        </div>
      ) : null}
    </section>
  );
}
