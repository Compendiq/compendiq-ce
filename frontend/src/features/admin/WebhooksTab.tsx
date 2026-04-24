import { useCallback, useMemo, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { m } from 'framer-motion';
import * as Dialog from '@radix-ui/react-dialog';
import * as Switch from '@radix-ui/react-switch';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle2,
  Dices,
  History,
  Info,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Shield,
  TestTube2,
  Trash2,
  Webhook,
  X,
  XCircle,
} from 'lucide-react';
import type {
  CreateWebhookSubscriptionRequest,
  RotateWebhookSecretResponse,
  TestWebhookDeliveryResponse,
  UpdateWebhookSubscriptionRequest,
  WebhookDelivery,
  WebhookDeliveryListResponse,
  WebhookEventType,
  WebhookSubscription,
  WebhookSubscriptionListResponse,
  WebhookSubscriptionResponse,
} from '@compendiq/contracts';
import { WEBHOOK_EVENT_TYPES } from '@compendiq/contracts';
import { useAuthStore } from '../../stores/auth-store';
import { useEnterprise } from '../../shared/enterprise/use-enterprise';
import { cn } from '../../shared/lib/cn';

// ── Local fetch helper ─────────────────────────────────────────────────────
// We bypass `apiFetch` for the same reason as IpAllowlistTab: the backend
// returns structured error bodies (`{ error: 'invalid_url', detail }`) and
// the shared helper flattens them to `.message`. Preserving the raw shape
// lets the dialog surface inline field errors.

interface BackendErrorBody {
  error?: string;
  detail?: string;
  message?: string;
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
  const res = await fetch(`/api${path}`, { ...init, headers, credentials: 'include' });
  if (!res.ok) {
    const body: BackendErrorBody = await res.json().catch(() => ({}));
    const err = new Error(body.message ?? body.error ?? res.statusText) as FetchError;
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

// ── Secret generation helper ───────────────────────────────────────────────
/**
 * Produce a cryptographically-random 32-char base64url string.
 * 24 random bytes → base64url → ~32 chars (well above the 16-char minimum).
 */
function generateSecret(): string {
  const bytes = new Uint8Array(24);
  // Prefer the Web Crypto API; fall back to Math.random only in the rare
  // case it is unavailable (never true in a browser; kept for tests).
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  // base64url (no padding) via btoa
  const bin = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Relative time (tiny util) ──────────────────────────────────────────────
function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const mn = Math.round(s / 60);
  if (mn < 60) return `${mn}m ago`;
  const h = Math.round(mn / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

// ── Event catalogue (re-export for readability) ────────────────────────────
const EVENT_TYPES: readonly WebhookEventType[] = WEBHOOK_EVENT_TYPES;

// ── Main component ─────────────────────────────────────────────────────────

export function WebhooksTab() {
  const { isEnterprise, hasFeature } = useEnterprise();

  // Feature-gate: render nothing useful when the license doesn't grant
  // webhook_push. SettingsPanelRoute already redirects these admins away
  // from the panel, but we keep the inline guard so direct @imports or
  // legacy tab navigation still degrade gracefully.
  if (!isEnterprise || !hasFeature('webhook_push')) {
    return (
      <div
        className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100"
        role="alert"
        data-testid="webhooks-not-licensed"
      >
        Webhooks are an Enterprise feature. Upgrade your license to configure
        outbound webhook subscriptions.
      </div>
    );
  }

  return <WebhooksTabInner />;
}

// Split the body so the gate above short-circuits any network calls when the
// feature isn't licensed — keeps the render completely inert in that branch.
function WebhooksTabInner() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<WebhookSubscriptionListResponse>({
    queryKey: ['admin', 'webhooks'],
    queryFn: () =>
      fetchJson<WebhookSubscriptionListResponse>('/admin/webhooks'),
    staleTime: 30_000,
  });

  const subscriptions = data?.subscriptions ?? [];

  // Dialog state — a single discriminated union is easier to reason about
  // than N separate booleans.
  type ModalState =
    | { kind: 'closed' }
    | { kind: 'create' }
    | { kind: 'edit'; sub: WebhookSubscription }
    | { kind: 'rotate'; sub: WebhookSubscription }
    | { kind: 'test'; sub: WebhookSubscription }
    | { kind: 'history'; sub: WebhookSubscription }
    | { kind: 'delete'; sub: WebhookSubscription };

  const [modal, setModal] = useState<ModalState>({ kind: 'closed' });
  const closeModal = useCallback(() => setModal({ kind: 'closed' }), []);

  // ── Toggle-active mutation (inline on each row) ──────────────────────────
  const toggleMutation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      fetchJson<WebhookSubscriptionResponse>(`/admin/webhooks/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ active } satisfies UpdateWebhookSubscriptionRequest),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'webhooks'] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Failed to update');
    },
  });

  // ── Delete mutation (confirmation modal triggers this) ───────────────────
  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetchJson<void>(`/admin/webhooks/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Webhook deleted');
      queryClient.invalidateQueries({ queryKey: ['admin', 'webhooks'] });
      closeModal();
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Failed to delete');
    },
  });

  return (
    <m.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="space-y-6"
      data-testid="webhooks-tab"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Webhook size={22} className="text-primary" />
            Webhook endpoints
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Deliver signed HTTP POSTs to external systems when events happen in
            Compendiq. Every delivery carries an HMAC-SHA256 signature — your
            receiver must verify it before trusting the payload.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setModal({ kind: 'create' })}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          data-testid="webhooks-new-btn"
        >
          <Plus size={14} />
          New webhook
        </button>
      </div>

      {/* Non-dismissible notice about signing */}
      <div
        role="alert"
        className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-amber-100"
        data-testid="webhooks-signing-notice"
      >
        <Shield size={18} className="mt-0.5 shrink-0 text-amber-400" />
        <div className="text-sm">
          Receivers <strong>must verify the signature header</strong> before
          processing a delivery. See <em>USER-GUIDE → Webhook Signing</em> for
          the verification snippet.
        </div>
      </div>

      {/* Subscription list */}
      {isLoading ? (
        <div className="space-y-3" data-testid="webhooks-loading">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-lg bg-foreground/5" />
          ))}
        </div>
      ) : subscriptions.length === 0 ? (
        <div
          className="rounded-lg border border-border/40 bg-foreground/[0.02] p-6 text-center text-sm text-muted-foreground"
          data-testid="webhooks-empty"
        >
          No webhook endpoints configured.
          <br />
          Press <strong>New webhook</strong> above to create one.
        </div>
      ) : (
        <ul className="space-y-3" data-testid="webhooks-list">
          {subscriptions.map((sub) => (
            <SubscriptionRow
              key={sub.id}
              sub={sub}
              onToggle={(active) => toggleMutation.mutate({ id: sub.id, active })}
              toggleBusy={
                toggleMutation.isPending && toggleMutation.variables?.id === sub.id
              }
              onEdit={() => setModal({ kind: 'edit', sub })}
              onRotate={() => setModal({ kind: 'rotate', sub })}
              onTest={() => setModal({ kind: 'test', sub })}
              onHistory={() => setModal({ kind: 'history', sub })}
              onDelete={() => setModal({ kind: 'delete', sub })}
            />
          ))}
        </ul>
      )}

      {/* Modals */}
      {(modal.kind === 'create' || modal.kind === 'edit') && (
        <CreateEditDialog
          mode={modal.kind}
          subscription={modal.kind === 'edit' ? modal.sub : null}
          onClose={closeModal}
          onSaved={() =>
            queryClient.invalidateQueries({ queryKey: ['admin', 'webhooks'] })
          }
        />
      )}

      {modal.kind === 'rotate' && (
        <RotateSecretDialog
          subscription={modal.sub}
          onClose={closeModal}
          onSaved={() =>
            queryClient.invalidateQueries({ queryKey: ['admin', 'webhooks'] })
          }
        />
      )}

      {modal.kind === 'test' && (
        <TestDeliveryDialog
          subscription={modal.sub}
          onClose={closeModal}
        />
      )}

      {modal.kind === 'history' && (
        <DeliveryHistoryDialog
          subscription={modal.sub}
          onClose={closeModal}
        />
      )}

      {modal.kind === 'delete' && (
        <DeleteConfirmDialog
          subscription={modal.sub}
          isDeleting={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(modal.sub.id)}
          onClose={closeModal}
        />
      )}
    </m.div>
  );
}

// ── Subscription row ───────────────────────────────────────────────────────

interface SubscriptionRowProps {
  sub: WebhookSubscription;
  onToggle: (active: boolean) => void;
  toggleBusy: boolean;
  onEdit: () => void;
  onRotate: () => void;
  onTest: () => void;
  onHistory: () => void;
  onDelete: () => void;
}

function SubscriptionRow({
  sub,
  onToggle,
  toggleBusy,
  onEdit,
  onRotate,
  onTest,
  onHistory,
  onDelete,
}: SubscriptionRowProps) {
  // Lazy-fetch the most recent delivery for the last-delivery indicator.
  // Scoped to the row so we don't round-trip once per subscription up-front.
  const { data: lastDelivery } = useQuery<WebhookDeliveryListResponse>({
    queryKey: ['admin', 'webhooks', sub.id, 'deliveries', 'last'],
    queryFn: () =>
      fetchJson<WebhookDeliveryListResponse>(
        `/admin/webhooks/${sub.id}/deliveries?limit=1`,
      ),
    staleTime: 10_000,
  });
  const last = lastDelivery?.deliveries[0];

  return (
    <li
      className="rounded-lg border border-border/40 bg-card/50 p-4 backdrop-blur-sm"
      data-testid={`webhook-row-${sub.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Switch.Root
              checked={sub.active}
              onCheckedChange={(v) => onToggle(v)}
              disabled={toggleBusy}
              className="relative h-5 w-9 shrink-0 rounded-full bg-foreground/10 transition-colors outline-none data-[state=checked]:bg-primary disabled:opacity-50"
              data-testid={`webhook-toggle-${sub.id}`}
              aria-label={`${sub.active ? 'Disable' : 'Enable'} webhook ${sub.label ?? sub.url}`}
            >
              <Switch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-4" />
            </Switch.Root>
            <div className="truncate text-sm font-medium" data-testid={`webhook-label-${sub.id}`}>
              {sub.label ?? '(unlabelled)'}
            </div>
            {sub.hasSecondarySecret && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300"
                data-testid={`webhook-rotation-chip-${sub.id}`}
                title={
                  sub.secretSecondaryAddedAt
                    ? `Secondary secret added ${relativeTime(sub.secretSecondaryAddedAt)}`
                    : 'Rotation window open'
                }
              >
                <RefreshCw size={11} />
                Rotation open
              </span>
            )}
          </div>
          <div
            className="truncate font-mono text-xs text-muted-foreground"
            data-testid={`webhook-url-${sub.id}`}
          >
            {sub.url}
          </div>
          <div className="flex flex-wrap gap-1" data-testid={`webhook-events-${sub.id}`}>
            {sub.eventTypes.map((ev) => (
              <span
                key={ev}
                className="inline-flex items-center rounded-full bg-foreground/5 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground"
              >
                {ev}
              </span>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3 pt-1 text-xs text-muted-foreground">
            <span data-testid={`webhook-secret-hint-${sub.id}`}>
              secret: <code className="font-mono">…{sub.secretHint ?? '????'}</code>
            </span>
            {last ? (
              <span
                className="flex items-center gap-1"
                data-testid={`webhook-last-delivery-${sub.id}`}
              >
                {last.status === 'success' ? (
                  <CheckCircle2 size={12} className="text-emerald-400" />
                ) : (
                  <XCircle size={12} className="text-destructive" />
                )}
                last delivery {relativeTime(last.attemptedAt)}
              </span>
            ) : (
              <span
                className="text-muted-foreground/60"
                data-testid={`webhook-no-deliveries-${sub.id}`}
              >
                no deliveries yet
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <IconButton onClick={onTest} icon={<TestTube2 size={14} />} label="Test" testid={`webhook-test-btn-${sub.id}`} />
          <IconButton onClick={onHistory} icon={<History size={14} />} label="History" testid={`webhook-history-btn-${sub.id}`} />
          <IconButton onClick={onRotate} icon={<RefreshCw size={14} />} label="Rotate secret" testid={`webhook-rotate-btn-${sub.id}`} />
          <IconButton onClick={onEdit} icon={<Pencil size={14} />} label="Edit" testid={`webhook-edit-btn-${sub.id}`} />
          <IconButton
            onClick={onDelete}
            icon={<Trash2 size={14} />}
            label="Delete"
            testid={`webhook-delete-btn-${sub.id}`}
            variant="destructive"
          />
        </div>
      </div>
    </li>
  );
}

function IconButton({
  onClick,
  icon,
  label,
  testid,
  variant,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  testid?: string;
  variant?: 'destructive';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testid}
      aria-label={label}
      title={label}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors',
        variant === 'destructive'
          ? 'bg-destructive/10 text-destructive hover:bg-destructive/20'
          : 'bg-foreground/5 text-foreground hover:bg-foreground/10',
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

// ── Shared dialog shell ────────────────────────────────────────────────────

interface DialogShellProps {
  open: boolean;
  onClose: () => void;
  title: string;
  testid: string;
  children: React.ReactNode;
  widthClass?: string;
}

function DialogShell({
  open,
  onClose,
  title,
  testid,
  children,
  widthClass,
}: DialogShellProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-full -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border/60 bg-card/90 shadow-2xl backdrop-blur-xl outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 max-h-[85vh] overflow-y-auto',
            widthClass ?? 'max-w-lg',
          )}
          aria-describedby={undefined}
          data-testid={testid}
        >
          <div className="flex items-center justify-between border-b border-border/50 px-5 py-4">
            <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                aria-label="Close"
                data-testid={`${testid}-close`}
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>
          <div className="p-5">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ── Create / Edit dialog ───────────────────────────────────────────────────

interface CreateEditDialogProps {
  mode: 'create' | 'edit';
  subscription: WebhookSubscription | null;
  onClose: () => void;
  onSaved: () => void;
}

function CreateEditDialog({
  mode,
  subscription,
  onClose,
  onSaved,
}: CreateEditDialogProps) {
  const [label, setLabel] = useState(subscription?.label ?? '');
  const [url, setUrl] = useState(subscription?.url ?? '');
  const [eventTypes, setEventTypes] = useState<string[]>(
    subscription?.eventTypes ?? [],
  );
  const [secret, setSecret] = useState('');
  const [inlineError, setInlineError] = useState<{
    field: 'url' | 'eventTypes' | 'secret' | 'other';
    message: string;
  } | null>(null);

  const urlValid = useMemo(() => {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }, [url]);

  const toggleEventType = useCallback((ev: string) => {
    setEventTypes((prev) =>
      prev.includes(ev) ? prev.filter((e) => e !== ev) : [...prev, ev],
    );
  }, []);

  // Save-button lockout:
  //   - valid URL
  //   - at least one event type
  //   - on create: secret ≥ 16 chars
  const canSubmit =
    urlValid &&
    eventTypes.length > 0 &&
    (mode === 'edit' || secret.length >= 16);

  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === 'create') {
        const body: CreateWebhookSubscriptionRequest = {
          label: label || undefined,
          url,
          eventTypes: eventTypes as WebhookEventType[],
          secret,
        };
        return fetchJson<WebhookSubscriptionResponse>('/admin/webhooks', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }
      const body: UpdateWebhookSubscriptionRequest = {
        label: label || undefined,
        url,
        eventTypes: eventTypes as WebhookEventType[],
      };
      return fetchJson<WebhookSubscriptionResponse>(
        `/admin/webhooks/${subscription!.id}`,
        {
          method: 'PUT',
          body: JSON.stringify(body),
        },
      );
    },
    onSuccess: () => {
      toast.success(mode === 'create' ? 'Webhook created' : 'Webhook updated');
      onSaved();
      onClose();
    },
    onError: (err: unknown) => {
      const body = (err as FetchError).body;
      if (body?.error === 'invalid_url') {
        setInlineError({ field: 'url', message: body.detail ?? 'Invalid URL' });
      } else if (body?.error === 'invalid_event_type') {
        setInlineError({
          field: 'eventTypes',
          message: body.detail ?? 'Unknown event type',
        });
      } else if (body?.error === 'secret_too_short') {
        setInlineError({
          field: 'secret',
          message: body.detail ?? 'Secret too short',
        });
      } else {
        setInlineError({
          field: 'other',
          message: err instanceof Error ? err.message : 'Failed to save',
        });
      }
    },
  });

  const title = mode === 'create' ? 'New webhook' : 'Edit webhook';

  return (
    <DialogShell
      open
      onClose={onClose}
      title={title}
      testid={mode === 'create' ? 'webhook-create-dialog' : 'webhook-edit-dialog'}
    >
      <div className="space-y-4">
        {/* Label */}
        <div>
          <label htmlFor="webhook-label" className="mb-1 block text-xs font-medium text-muted-foreground">
            Label (optional)
          </label>
          <input
            id="webhook-label"
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Slack ingress"
            className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            data-testid="webhook-label-input"
          />
        </div>

        {/* URL */}
        <div>
          <label htmlFor="webhook-url" className="mb-1 block text-xs font-medium text-muted-foreground">
            URL
          </label>
          <input
            id="webhook-url"
            type="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (inlineError?.field === 'url') setInlineError(null);
            }}
            placeholder="https://hooks.example.com/ingest"
            className={cn(
              'w-full rounded-md bg-foreground/5 px-3 py-2 font-mono text-xs outline-none focus:ring-1 focus:ring-primary',
              inlineError?.field === 'url' && 'ring-1 ring-destructive',
            )}
            data-testid="webhook-url-input"
          />
          {inlineError?.field === 'url' && (
            <p className="mt-1 text-xs text-destructive" data-testid="webhook-url-error">
              {inlineError.message}
            </p>
          )}
          {url && !urlValid && !inlineError && (
            <p className="mt-1 text-xs text-muted-foreground">
              URL must be a valid http:// or https:// URL.
            </p>
          )}
        </div>

        {/* Event types */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-xs font-medium text-muted-foreground">
              Event types
            </label>
            <span className="text-xs text-muted-foreground/60">
              {eventTypes.length} selected
            </span>
          </div>
          <div
            className={cn(
              'grid grid-cols-2 gap-2 rounded-md border bg-foreground/[0.02] p-2',
              inlineError?.field === 'eventTypes'
                ? 'border-destructive'
                : 'border-border/40',
            )}
            data-testid="webhook-events-select"
          >
            {EVENT_TYPES.map((ev) => {
              const checked = eventTypes.includes(ev);
              return (
                <label
                  key={ev}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors',
                    checked
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-foreground/5',
                  )}
                  data-testid={`webhook-event-option-${ev}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      toggleEventType(ev);
                      if (inlineError?.field === 'eventTypes') setInlineError(null);
                    }}
                    className="h-3.5 w-3.5 rounded border-border accent-primary"
                    data-testid={`webhook-event-checkbox-${ev}`}
                  />
                  <span className="font-mono">{ev}</span>
                </label>
              );
            })}
          </div>
          {inlineError?.field === 'eventTypes' && (
            <p className="mt-1 text-xs text-destructive" data-testid="webhook-events-error">
              {inlineError.message}
            </p>
          )}
        </div>

        {/* Secret (create-only) */}
        {mode === 'create' && (
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label htmlFor="webhook-secret" className="text-xs font-medium text-muted-foreground">
                Signing secret (≥ 16 chars)
              </label>
              <button
                type="button"
                onClick={() => {
                  setSecret(generateSecret());
                  if (inlineError?.field === 'secret') setInlineError(null);
                }}
                className="flex items-center gap-1 rounded-md bg-foreground/5 px-2 py-0.5 text-xs text-muted-foreground hover:bg-foreground/10"
                data-testid="webhook-secret-generate-btn"
              >
                <Dices size={11} />
                Generate
              </button>
            </div>
            <input
              id="webhook-secret"
              type="text"
              value={secret}
              onChange={(e) => {
                setSecret(e.target.value);
                if (inlineError?.field === 'secret') setInlineError(null);
              }}
              placeholder="min 16 chars — use Generate for a secure random value"
              className={cn(
                'w-full rounded-md bg-foreground/5 px-3 py-2 font-mono text-xs outline-none focus:ring-1 focus:ring-primary',
                inlineError?.field === 'secret' && 'ring-1 ring-destructive',
              )}
              data-testid="webhook-secret-input"
              spellCheck={false}
            />
            {inlineError?.field === 'secret' && (
              <p className="mt-1 text-xs text-destructive" data-testid="webhook-secret-error">
                {inlineError.message}
              </p>
            )}
            <p className="mt-1 flex items-start gap-1 text-xs text-muted-foreground">
              <Info size={11} className="mt-0.5 shrink-0" />
              Store this secret on your receiver; we will never display it
              again. Rotate it later from the row actions.
            </p>
          </div>
        )}

        {inlineError?.field === 'other' && (
          <div className="text-xs text-destructive" data-testid="webhook-dialog-error">
            {inlineError.message}
          </div>
        )}
      </div>

      <div className="mt-5 flex items-center justify-end gap-2 border-t border-border/50 pt-4">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md bg-foreground/5 px-3 py-1.5 text-sm hover:bg-foreground/10"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            setInlineError(null);
            mutation.mutate();
          }}
          disabled={!canSubmit || mutation.isPending}
          className="flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="webhook-save-btn"
        >
          {mutation.isPending && <Loader2 size={14} className="animate-spin" />}
          {mode === 'create' ? 'Create' : 'Save'}
        </button>
      </div>
    </DialogShell>
  );
}

// ── Rotate-secret dialog ───────────────────────────────────────────────────

interface RotateDialogProps {
  subscription: WebhookSubscription;
  onClose: () => void;
  onSaved: () => void;
}

function RotateSecretDialog({
  subscription,
  onClose,
  onSaved,
}: RotateDialogProps) {
  const [newSecret, setNewSecret] = useState('');
  const [result, setResult] = useState<RotateWebhookSecretResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Best-effort guard against reusing the current secret: compare the last-4
  // characters against the subscription's `secretHint`. We don't have the full
  // current secret to compare against, so this is a convenience check only.
  const last4 = newSecret.slice(-4);
  const reusesCurrentHint =
    newSecret.length >= 4 &&
    subscription.secretHint !== null &&
    last4 === subscription.secretHint;

  const canSubmit = newSecret.length >= 16 && !reusesCurrentHint;

  const mutation = useMutation({
    mutationFn: () =>
      fetchJson<RotateWebhookSecretResponse>(
        `/admin/webhooks/${subscription.id}/rotate-secret`,
        {
          method: 'POST',
          body: JSON.stringify({ newSecret }),
        },
      ),
    onSuccess: (res) => {
      setResult(res);
      setError(null);
      onSaved();
      toast.success('Secret rotated');
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : 'Rotation failed');
    },
  });

  return (
    <DialogShell
      open
      onClose={onClose}
      title="Rotate signing secret"
      testid="webhook-rotate-dialog"
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-amber-100">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-400" />
          <p className="text-xs">
            Both the current and new secret will sign deliveries until you
            press <strong>Complete rotation</strong>, or 24 hours pass — whichever
            comes first. Receivers must accept either signature during the
            overlap window.
          </p>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label htmlFor="webhook-new-secret" className="text-xs font-medium text-muted-foreground">
              New signing secret (≥ 16 chars)
            </label>
            <button
              type="button"
              onClick={() => setNewSecret(generateSecret())}
              className="flex items-center gap-1 rounded-md bg-foreground/5 px-2 py-0.5 text-xs text-muted-foreground hover:bg-foreground/10"
              data-testid="webhook-rotate-generate-btn"
            >
              <Dices size={11} />
              Generate
            </button>
          </div>
          <input
            id="webhook-new-secret"
            type="text"
            value={newSecret}
            onChange={(e) => setNewSecret(e.target.value)}
            placeholder="min 16 chars"
            className={cn(
              'w-full rounded-md bg-foreground/5 px-3 py-2 font-mono text-xs outline-none focus:ring-1 focus:ring-primary',
              reusesCurrentHint && 'ring-1 ring-destructive',
            )}
            data-testid="webhook-rotate-secret-input"
            spellCheck={false}
            disabled={!!result}
          />
          {reusesCurrentHint && (
            <p className="mt-1 text-xs text-destructive" data-testid="webhook-rotate-reuse-warning">
              Last 4 chars match the current secret — please pick a new value.
            </p>
          )}
        </div>

        {result && (
          <div
            className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs text-emerald-100"
            data-testid="webhook-rotate-result"
          >
            <div className="flex items-center gap-2 font-medium">
              <CheckCircle2 size={14} />
              Rotation staged
            </div>
            <div className="mt-1 text-muted-foreground">
              Overlap window open until{' '}
              <strong data-testid="webhook-rotate-until">
                {new Date(result.secondaryActiveUntil).toLocaleString()}
              </strong>
              . Update receivers, then press Complete rotation to clear the
              secondary slot early.
            </div>
          </div>
        )}

        {error && (
          <div className="text-xs text-destructive" data-testid="webhook-rotate-error">
            {error}
          </div>
        )}
      </div>

      <div className="mt-5 flex items-center justify-end gap-2 border-t border-border/50 pt-4">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md bg-foreground/5 px-3 py-1.5 text-sm hover:bg-foreground/10"
        >
          {result ? 'Done' : 'Cancel'}
        </button>
        {!result && (
          <button
            type="button"
            onClick={() => {
              setError(null);
              mutation.mutate();
            }}
            disabled={!canSubmit || mutation.isPending}
            className="flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="webhook-rotate-submit-btn"
          >
            {mutation.isPending && <Loader2 size={14} className="animate-spin" />}
            Rotate secret
          </button>
        )}
      </div>
    </DialogShell>
  );
}

// ── Test-delivery dialog ───────────────────────────────────────────────────

interface TestDialogProps {
  subscription: WebhookSubscription;
  onClose: () => void;
}

function TestDeliveryDialog({ subscription, onClose }: TestDialogProps) {
  const [eventType, setEventType] = useState<string>(
    subscription.eventTypes[0] ?? '',
  );
  const [result, setResult] = useState<TestWebhookDeliveryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      fetchJson<TestWebhookDeliveryResponse>(
        `/admin/webhooks/${subscription.id}/test`,
        {
          method: 'POST',
          body: JSON.stringify({ eventType }),
        },
      ),
    onSuccess: (res) => {
      setResult(res);
      setError(null);
      if (res.status === 'success') {
        toast.success('Test delivery succeeded');
      } else {
        toast.error('Test delivery failed');
      }
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : 'Test failed');
    },
  });

  return (
    <DialogShell open onClose={onClose} title="Test delivery" testid="webhook-test-dialog">
      <div className="space-y-4">
        <div>
          <label htmlFor="webhook-test-event" className="mb-1 block text-xs font-medium text-muted-foreground">
            Event type
          </label>
          <select
            id="webhook-test-event"
            value={eventType}
            onChange={(e) => setEventType(e.target.value)}
            className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            data-testid="webhook-test-event-select"
          >
            {subscription.eventTypes.map((ev) => (
              <option key={ev} value={ev}>
                {ev}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted-foreground">
            Only event types this subscription listens to are selectable.
          </p>
        </div>

        {result && (
          <div
            className={cn(
              'rounded-lg border p-3 text-xs',
              result.status === 'success'
                ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-100'
                : 'border-destructive/40 bg-destructive/5 text-destructive',
            )}
            data-testid="webhook-test-result"
          >
            <div
              className="flex items-center gap-2 font-medium"
              data-testid="webhook-test-status"
            >
              {result.status === 'success' ? (
                <CheckCircle2 size={14} />
              ) : (
                <XCircle size={14} />
              )}
              {result.status === 'success' ? 'Delivery succeeded' : 'Delivery failed'}
            </div>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
              {typeof result.httpStatus === 'number' && (
                <>
                  <dt>HTTP status</dt>
                  <dd className="font-mono" data-testid="webhook-test-http-status">
                    {result.httpStatus}
                  </dd>
                </>
              )}
              <dt>Duration</dt>
              <dd className="font-mono" data-testid="webhook-test-duration">
                {result.durationMs} ms
              </dd>
              {result.errorMessage && (
                <>
                  <dt>Error</dt>
                  <dd
                    className="break-words font-mono"
                    data-testid="webhook-test-error-message"
                  >
                    {result.errorMessage}
                  </dd>
                </>
              )}
            </dl>
          </div>
        )}

        {error && (
          <div className="text-xs text-destructive" data-testid="webhook-test-error">
            {error}
          </div>
        )}
      </div>

      <div className="mt-5 flex items-center justify-end gap-2 border-t border-border/50 pt-4">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md bg-foreground/5 px-3 py-1.5 text-sm hover:bg-foreground/10"
        >
          Close
        </button>
        <button
          type="button"
          onClick={() => {
            setResult(null);
            setError(null);
            mutation.mutate();
          }}
          disabled={!eventType || mutation.isPending}
          className="flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="webhook-test-submit-btn"
        >
          {mutation.isPending ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <TestTube2 size={14} />
          )}
          Send test
        </button>
      </div>
    </DialogShell>
  );
}

// ── Delivery-history dialog ────────────────────────────────────────────────

interface HistoryDialogProps {
  subscription: WebhookSubscription;
  onClose: () => void;
}

function DeliveryHistoryDialog({ subscription, onClose }: HistoryDialogProps) {
  const { data, isLoading } = useQuery<WebhookDeliveryListResponse>({
    queryKey: ['admin', 'webhooks', subscription.id, 'deliveries'],
    queryFn: () =>
      fetchJson<WebhookDeliveryListResponse>(
        `/admin/webhooks/${subscription.id}/deliveries?limit=50`,
      ),
    staleTime: 5_000,
  });

  const [expanded, setExpanded] = useState<string | null>(null);
  const deliveries = data?.deliveries ?? [];

  return (
    <DialogShell
      open
      onClose={onClose}
      title={`Delivery history — ${subscription.label ?? subscription.url}`}
      testid="webhook-history-dialog"
      widthClass="max-w-3xl"
    >
      {isLoading ? (
        <div className="space-y-2" data-testid="webhook-history-loading">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-10 animate-pulse rounded bg-foreground/5" />
          ))}
        </div>
      ) : deliveries.length === 0 ? (
        <div
          className="rounded-lg border border-border/40 bg-foreground/[0.02] p-6 text-center text-sm text-muted-foreground"
          data-testid="webhook-history-empty"
        >
          No deliveries recorded yet.
        </div>
      ) : (
        <table className="w-full text-xs" data-testid="webhook-history-table">
          <thead className="text-left text-muted-foreground">
            <tr className="border-b border-border/40">
              <th className="pb-2 pl-1 pr-2 font-medium">#</th>
              <th className="pb-2 pr-2 font-medium">Status</th>
              <th className="pb-2 pr-2 font-medium">HTTP</th>
              <th className="pb-2 pr-2 font-medium">Duration</th>
              <th className="pb-2 pr-2 font-medium">Attempted</th>
            </tr>
          </thead>
          <tbody>
            {deliveries.map((d) => (
              <DeliveryRow
                key={d.id}
                delivery={d}
                expanded={expanded === d.id}
                onToggle={() => setExpanded((cur) => (cur === d.id ? null : d.id))}
              />
            ))}
          </tbody>
        </table>
      )}

      <div className="mt-5 flex items-center justify-end border-t border-border/50 pt-4">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md bg-foreground/5 px-3 py-1.5 text-sm hover:bg-foreground/10"
        >
          Close
        </button>
      </div>
    </DialogShell>
  );
}

function DeliveryRow({
  delivery,
  expanded,
  onToggle,
}: {
  delivery: WebhookDelivery;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer border-b border-border/20 hover:bg-foreground/[0.03]"
        data-testid={`webhook-delivery-row-${delivery.id}`}
      >
        <td className="py-2 pl-1 pr-2 font-mono">{delivery.attemptNumber}</td>
        <td className="py-2 pr-2">
          <StatusChip status={delivery.status} />
        </td>
        <td className="py-2 pr-2 font-mono">{delivery.httpStatus ?? '—'}</td>
        <td className="py-2 pr-2 font-mono">
          {delivery.durationMs !== null ? `${delivery.durationMs} ms` : '—'}
        </td>
        <td className="py-2 pr-2 text-muted-foreground">
          {relativeTime(delivery.attemptedAt)}
        </td>
      </tr>
      {expanded && (
        <tr data-testid={`webhook-delivery-details-${delivery.id}`}>
          <td colSpan={5} className="bg-foreground/[0.02] px-3 py-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono">
              <dt className="text-muted-foreground">Response body</dt>
              <dd
                className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-foreground/80"
                data-testid={`webhook-delivery-body-${delivery.id}`}
              >
                {delivery.responseBody ?? '(empty)'}
              </dd>
              {delivery.errorMessage && (
                <>
                  <dt className="text-muted-foreground">Error message</dt>
                  <dd
                    className="whitespace-pre-wrap break-words text-destructive"
                    data-testid={`webhook-delivery-error-${delivery.id}`}
                  >
                    {delivery.errorMessage}
                  </dd>
                </>
              )}
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}

function StatusChip({ status }: { status: WebhookDelivery['status'] }) {
  const styles: Record<WebhookDelivery['status'], string> = {
    success: 'bg-emerald-500/15 text-emerald-300',
    failure: 'bg-destructive/15 text-destructive',
    timeout: 'bg-amber-500/15 text-amber-300',
    ssrf_blocked: 'bg-purple-500/15 text-purple-300',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium',
        styles[status],
      )}
    >
      {status}
    </span>
  );
}

// ── Delete confirmation dialog ─────────────────────────────────────────────

interface DeleteConfirmDialogProps {
  subscription: WebhookSubscription;
  isDeleting: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

function DeleteConfirmDialog({
  subscription,
  isDeleting,
  onConfirm,
  onClose,
}: DeleteConfirmDialogProps) {
  return (
    <DialogShell
      open
      onClose={onClose}
      title="Delete webhook"
      testid="webhook-delete-dialog"
    >
      <div className="space-y-3">
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-destructive" />
          <div>
            <div className="font-medium text-destructive">
              This cannot be undone.
            </div>
            <div className="mt-1 text-muted-foreground">
              Pending deliveries will be dropped. Delivery history is preserved
              for audit, but the endpoint will no longer receive events.
            </div>
          </div>
        </div>
        <div className="text-sm">
          Delete{' '}
          <strong className="font-mono">
            {subscription.label ?? subscription.url}
          </strong>
          ?
        </div>
      </div>
      <div className="mt-5 flex items-center justify-end gap-2 border-t border-border/50 pt-4">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md bg-foreground/5 px-3 py-1.5 text-sm hover:bg-foreground/10"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={isDeleting}
          className="flex items-center gap-2 rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
          data-testid="webhook-delete-confirm-btn"
        >
          {isDeleting && <Loader2 size={14} className="animate-spin" />}
          Delete
        </button>
      </div>
    </DialogShell>
  );
}
