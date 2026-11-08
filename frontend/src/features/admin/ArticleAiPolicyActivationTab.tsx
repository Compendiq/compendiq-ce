import { useCallback, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, ShieldCheck, ShieldOff } from 'lucide-react';
import {
  AiPolicyActivationRefusalSchema,
  AiPolicyActivationStateSchema,
  type AiPolicyActivationBlocker,
  type AiPolicyActivationRequest,
  type AiPolicyActivationState,
} from '@compendiq/contracts';
import { apiFetch, ApiError } from '../../shared/lib/api';
import { formatRelativeTime } from '../../shared/lib/format-relative-time';
import { statusChipClass } from '../../shared/components/badges/neutral-chip';
import { ConfirmDialog } from '../../shared/components/ConfirmDialog';
import { useNoticeRetry } from '../../shared/hooks/use-notice-retry';
import { PanelHeader } from '../settings/PanelHeader';

/**
 * Settings → Article AI policy (Governance group, #1881).
 *
 * The CE-owned, cluster-wide switch that lets editors choose a restrictive
 * AI policy for an article. Design of record:
 * `docs/superpowers/specs/2026-11-08-article-ai-policy-activation-design.md`.
 *
 * Three things this surface must not get wrong:
 *
 *   1. **Turning on is refused while an observable precondition is unmet**,
 *      and the server names each one. The panel renders every blocker with
 *      actionable copy and the actual rows behind it (runtime ids, legacy
 *      users), because "not ready" without the list is a ticket, not a fix.
 *   2. **Only the two legacy-client blockers can be acknowledged**, and the
 *      acknowledgement is audited. The checkbox appears only when every
 *      reported blocker is overridable; a runtime blocker hides it.
 *   3. **Turning off is reversible and weakens nothing stored**: admission
 *      never reads the switch. Its confirmation says so, and says what the
 *      editors lose meanwhile (the policy controls), so nobody reaches for it
 *      as a routine state.
 *
 * Reuses the `ArticleBaselinesTab` activation recipe: blocked actions stay
 * mounted with `aria-disabled` and an explanatory line (never native
 * `disabled`), a failed read is distinguished from a failed refresh over
 * cached state (`useNoticeRetry`), and the echo of a successful PUT is seeded
 * then re-read because readiness is recomputed on every read.
 */

const AI_POLICY_ACTIVATION_KEY = ['admin', 'ai-policy-activation'] as const;
const ACTIVATION_PATH = '/admin/ai-policy/activation';
const ACTIVATION_BUSY = 'ai_policy_activation_busy';

/** The runbook section an operator follows to retire a version-0 runtime row. */
const RUNTIME_RETIREMENT_RUNBOOK = 'docs/runbooks/immutable-page-baselines.md';
const RUNTIME_RETIREMENT_SECTION = 'Runtime retirement and fencing';

/** Minute precision: `clearsAt` is hours away, and a date alone would read as "tomorrow". */
function formatWhen(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * One blocker, as the thing to do about it. Each branch names the
 * observation the server made, the rows behind it, and the remedy — the
 * runbook procedure for runtimes, time or the acknowledgement for the two
 * legacy-client blockers, a restart or a retry for the two instance faults.
 */
function BlockerItem({ blocker }: { blocker: AiPolicyActivationBlocker }) {
  switch (blocker.code) {
    case 'incompatible_ai_policy_runtime':
      return (
        <li data-testid="blocker-incompatible_ai_policy_runtime">
          <p className="font-medium text-foreground">
            {plural(blocker.total, 'backend instance')} {blocker.total === 1 ? 'is' : 'are'} running a build
            without AI-policy enforcement.
          </p>
          <p className="mt-0.5">
            Enforcement cannot be turned on, and no restriction can be stored, while one is active.
            Upgrade or drain each of them; for a process that is already gone, fence its row following{' '}
            <code className="font-mono text-foreground/85">{RUNTIME_RETIREMENT_RUNBOOK}</code>
            {' → '}<span className="italic">{RUNTIME_RETIREMENT_SECTION}</span>.
          </p>
          <ul className="mt-1.5 space-y-1" aria-label="Incompatible runtimes">
            {blocker.runtimes.map((runtime) => (
              <li key={runtime.runtimeId} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <code className="font-mono text-foreground/85">{runtime.runtimeId}</code>
                <span>
                  {runtime.host ?? 'unknown host'}
                  {runtime.pid !== null && <> · pid <span className="font-mono">{runtime.pid}</span></>}
                </span>
                <span title={new Date(runtime.startedAt).toLocaleString()}>
                  started {formatRelativeTime(runtime.startedAt)}
                </span>
              </li>
            ))}
          </ul>
          {blocker.total > blocker.runtimes.length && (
            <p className="mt-1">
              Showing the first {blocker.runtimes.length} of {blocker.total}. The runbook's bulk procedure
              covers the rest.
            </p>
          )}
        </li>
      );
    case 'legacy_clients_active':
      return (
        <li data-testid="blocker-legacy_clients_active">
          <p className="font-medium text-foreground">
            {plural(blocker.users, 'user')} signed in from an older build within the last access-token
            lifetime.
          </p>
          <p className="mt-0.5">
            Those tabs keep their current access token until it expires and must reload to pick up the
            policy-aware build. This clears by itself at {formatWhen(blocker.clearsAt)}, or you can
            acknowledge the remaining window below.
          </p>
          <ul className="mt-1.5 space-y-1" aria-label="Legacy client sessions">
            {blocker.recent.map((user) => (
              <li key={user.userId} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="font-medium text-foreground/85">{user.username}</span>
                <span title={new Date(user.lastSeenAt).toLocaleString()}>
                  last seen {formatRelativeTime(user.lastSeenAt)}
                </span>
              </li>
            ))}
          </ul>
          {blocker.users > blocker.recent.length && (
            <p className="mt-1">Showing the {blocker.recent.length} most recent of {blocker.users}.</p>
          )}
        </li>
      );
    case 'legacy_client_window_open':
      return (
        <li data-testid="blocker-legacy_client_window_open">
          <p className="font-medium text-foreground">
            Older browser sessions cannot be ruled out yet.
          </p>
          <p className="mt-0.5">
            The server has only been observing sign-ins since {formatWhen(blocker.since)}, so a session
            issued before that — by this install before its upgrade, or by a replica since drained — is
            invisible to it until every such token has expired, at {formatWhen(blocker.clearsAt)}. On a
            fresh install nobody has signed in from an older build, so acknowledging below is the
            appropriate step.
          </p>
        </li>
      );
    case 'ai_policy_enforcement_not_registered':
      return (
        <li data-testid="blocker-ai_policy_enforcement_not_registered">
          <p className="font-medium text-foreground">
            This backend instance has not registered its AI-policy enforcement.
          </p>
          <p className="mt-0.5">
            It cannot vouch for the deployment, so turning on is refused. Restart the instance on the
            current build; if this persists, check its startup log.
          </p>
        </li>
      );
    case 'ai_policy_readiness_unavailable':
      return (
        <li data-testid="blocker-ai_policy_readiness_unavailable">
          <p className="font-medium text-foreground">Readiness could not be determined.</p>
          <p className="mt-0.5">
            The server could not read its runtimes or legacy-client observations, so turning on stays
            refused. Retry in a moment; a persistent failure is a database fault to look at first.
          </p>
        </li>
      );
  }
}

function StateLine({ state }: { state: AiPolicyActivationState }) {
  const when = state.changedAt ? formatWhen(state.changedAt) : null;
  const by = state.changedByName ? ` by ${state.changedByName}` : '';
  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-foreground/85" data-testid="activation-state">
      <span className={statusChipClass}>
        {state.enabled
          ? <ShieldCheck size={12} aria-hidden="true" />
          : <ShieldOff size={12} aria-hidden="true" />}
        {state.enabled ? 'Enforcement on' : 'Enforcement off'}
      </span>
      <span>
        {state.enabled && when && `On since ${when}${by}.`}
        {!state.enabled && when && `Turned off ${when}${by}.`}
        {!state.enabled && !when && 'It has never been turned on.'}
        {state.enabled && state.legacyClientsAcknowledged && (
          <span className="text-muted-foreground">
            {' '}Legacy clients were acknowledged when it was turned on.
          </span>
        )}
      </span>
    </p>
  );
}

function ActivationSection() {
  const queryClient = useQueryClient();
  const activation = useQuery<AiPolicyActivationState>({
    queryKey: AI_POLICY_ACTIVATION_KEY,
    retry: false,
    queryFn: async () => AiPolicyActivationStateSchema.parse(await apiFetch(ACTIVATION_PATH)),
  });
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { retryInFlight, onRetry } = useNoticeRetry(activation.refetch, activation.isError, headingRef);
  const hintId = useId();
  const acknowledgeId = useId();

  const [acknowledge, setAcknowledge] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<'enable' | 'disable' | null>(null);

  const mutation = useMutation<AiPolicyActivationState, unknown, AiPolicyActivationRequest>({
    mutationFn: async (body) => AiPolicyActivationStateSchema.parse(
      await apiFetch(ACTIVATION_PATH, { method: 'PUT', body: JSON.stringify(body) }),
    ),
    onSuccess: async (next) => {
      // The echo is the committed record, so show it at once; then re-read,
      // because readiness is recomputed from live runtimes and observations
      // on every read and can have moved. Article details carry
      // `aiPolicyActivation`, so every mounted one re-reads too.
      queryClient.setQueryData(AI_POLICY_ACTIVATION_KEY, next);
      setAcknowledge(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: AI_POLICY_ACTIVATION_KEY }),
        queryClient.invalidateQueries({ queryKey: ['pages'] }),
      ]);
    },
  });

  const state = activation.data;
  const blockers = state?.blockers ?? [];
  const hasNonOverridable = blockers.some((blocker) => !blocker.overridable);
  const overridableOnly = blockers.length > 0 && !hasNonOverridable;
  const canEnable = state?.ready === true || (overridableOnly && acknowledge);
  const showFailure = activation.isError || retryInFlight;

  const submit = useCallback(async (body: AiPolicyActivationRequest) => {
    if (mutation.isPending) return;
    setError(null);
    try {
      await mutation.mutateAsync(body);
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 409) {
        const refusal = AiPolicyActivationRefusalSchema.safeParse(err.body);
        if (refusal.success) {
          // The refusal carries the blockers the server saw under its lock —
          // the latest observation there is — so they replace the list the
          // GET showed, and a re-read follows for the rest of the state. The
          // acknowledgement is asked again: it was given for a different list.
          queryClient.setQueryData<AiPolicyActivationState>(AI_POLICY_ACTIVATION_KEY, (current) => (
            current ? { ...current, ready: false, blockers: refusal.data.blockers } : current
          ));
          void queryClient.invalidateQueries({ queryKey: AI_POLICY_ACTIVATION_KEY });
          setAcknowledge(false);
          setError(
            `The server refused to turn on enforcement and reported ${plural(refusal.data.blockers.length, 'blocker')}, listed above.`,
          );
          return;
        }
      }
      // N25: the activation transaction's lock timeout answers a retryable
      // 503; nothing was written, so the same request can simply be repeated.
      const body = err instanceof ApiError ? err.body : null;
      if (err instanceof ApiError && err.statusCode === 503
        && typeof body === 'object' && body !== null && 'error' in body && body.error === ACTIVATION_BUSY) {
        setError('Another change to this switch is still being applied. Try again in a moment.');
        return;
      }
      setError(err instanceof Error ? err.message : 'The change could not be saved.');
    }
  }, [mutation, queryClient]);

  const blockedHint = !state || state.enabled
    ? null
    : hasNonOverridable
      ? 'Enforcement cannot be turned on while a blocker above is unresolved.'
      : overridableOnly && !acknowledge
        ? 'Tick the acknowledgement above to turn on enforcement with older sessions outstanding.'
        : null;

  const enableDescription = [
    'Editors with change rights can then set an article to Local AI only or No AI allowed, and every AI path enforces it.',
    'Once any restriction exists, backend builds without AI-policy enforcement can no longer start; the way forward is to upgrade them.',
    'Browser tabs still running an older build must reload before they can sign in again.',
    overridableOnly && acknowledge
      ? 'You are acknowledging the older sessions listed above; the acknowledgement is recorded in the audit log with the users it covers.'
      : null,
  ].filter((sentence): sentence is string => sentence !== null).join(' ');

  const disableDescription =
    'Stored restrictions stay enforced: AI keeps refusing restricted articles. While enforcement is off, '
    + 'editors cannot choose or relax an article\u2019s policy from the inspector and no new restriction can '
    + 'be stored. Turn it back on to restore the controls.';

  return (
    <section className="nm-card p-4" data-testid="ai-policy-activation">
      <h3 ref={headingRef} tabIndex={-1} className="text-sm font-semibold text-foreground outline-none">
        Policy enforcement
      </h3>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        An article's AI policy decides which AI may process it: any configured provider, only
        providers declared local, or none. Stored restrictions are always enforced. This switch only
        decides whether editors can create new ones, and it waits until every backend instance
        enforces them and every browser tab is on a build that reports itself. It is the same for
        Community and Enterprise; a licence never opens or closes it.
      </p>

      {activation.isPending && !showFailure && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="activation-loading">
          Reading the activation state…
        </p>
      )}

      {showFailure && (
        <p
          role={state ? 'status' : 'alert'}
          className={`mt-2 text-xs ${state ? 'text-warning' : 'text-destructive'}`}
          data-testid={state ? 'activation-stale' : 'activation-error'}
        >
          <span>
            {state
              ? 'The activation state could not be refreshed. The last loaded state is shown.'
              : 'The activation state could not be read, so no change is offered here.'}
          </span>{' '}
          <button
            type="button"
            onClick={onRetry}
            aria-disabled={retryInFlight || undefined}
            className="nm-button-ghost h-8 text-xs aria-disabled:cursor-default aria-disabled:opacity-70"
            data-testid="activation-retry"
          >
            {retryInFlight ? 'Retrying…' : 'Retry'}
          </button>
        </p>
      )}

      {state && (
        <>
          <StateLine state={state} />

          {!state.enabled && blockers.length > 0 && (
            <div
              role="status"
              className="mt-3 rounded-md border border-warning/30 bg-warning/10 p-3 text-xs text-muted-foreground"
              data-testid="activation-blockers"
            >
              <p className="font-medium text-foreground">
                {hasNonOverridable
                  ? 'This deployment is not ready for enforcement.'
                  : 'Older browser sessions may still be open.'}
              </p>
              <ul className="mt-2 space-y-3">
                {blockers.map((blocker) => <BlockerItem key={blocker.code} blocker={blocker} />)}
              </ul>
            </div>
          )}

          {!state.enabled && overridableOnly && (
            <label htmlFor={acknowledgeId} className="mt-3 flex items-start gap-2 text-xs text-foreground">
              <input
                id={acknowledgeId}
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-primary"
                checked={acknowledge}
                onChange={(event) => {
                  setAcknowledge(event.target.checked);
                  if (error) setError(null);
                }}
                data-testid="activation-acknowledge"
              />
              <span>
                I accept that tabs still running an older build keep their current access token for at
                most one token lifetime, and that this acknowledgement is recorded in the audit log.
              </span>
            </label>
          )}

          {error && (
            <p role="alert" className="mt-3 text-xs text-destructive" data-testid="activation-save-error">
              {error}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {!state.enabled ? (
              <button
                type="button"
                className="nm-button-primary inline-flex h-8 items-center gap-1.5 px-3 text-xs aria-disabled:cursor-default aria-disabled:opacity-70"
                aria-disabled={mutation.isPending || !canEnable || undefined}
                aria-describedby={blockedHint ? hintId : undefined}
                data-testid="activation-enable"
                onClick={() => {
                  // The refusal `aria-disabled` cannot perform; the hint
                  // beside the button (and `aria-describedby`) already says why.
                  if (mutation.isPending || !canEnable) return;
                  setError(null);
                  setPendingAction('enable');
                }}
              >
                {mutation.isPending && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
                <span>{mutation.isPending ? 'Saving…' : 'Turn on enforcement…'}</span>
              </button>
            ) : (
              <button
                type="button"
                className="nm-button-ghost inline-flex h-8 items-center gap-1.5 px-3 text-xs aria-disabled:cursor-default aria-disabled:opacity-70"
                aria-disabled={mutation.isPending || undefined}
                data-testid="activation-disable"
                onClick={() => {
                  if (mutation.isPending) return;
                  setError(null);
                  setPendingAction('disable');
                }}
              >
                {mutation.isPending && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
                <span>{mutation.isPending ? 'Saving…' : 'Turn off enforcement…'}</span>
              </button>
            )}
            {blockedHint && (
              <span id={hintId} className="text-xs text-muted-foreground" data-testid="activation-hint">
                {blockedHint}
              </span>
            )}
          </div>

          <ConfirmDialog
            open={pendingAction === 'enable'}
            title="Turn on article AI policy enforcement?"
            description={enableDescription}
            confirmLabel="Turn on enforcement"
            onConfirm={() => {
              setPendingAction(null);
              void submit(overridableOnly && acknowledge
                ? { enabled: true, acknowledgeLegacyClients: true }
                : { enabled: true });
            }}
            onCancel={() => setPendingAction(null)}
          />
          <ConfirmDialog
            open={pendingAction === 'disable'}
            title="Turn off article AI policy enforcement?"
            description={disableDescription}
            confirmLabel="Turn off enforcement"
            onConfirm={() => {
              setPendingAction(null);
              void submit({ enabled: false });
            }}
            onCancel={() => setPendingAction(null)}
          />
        </>
      )}
    </section>
  );
}

export function ArticleAiPolicyActivationTab() {
  return (
    <>
      <PanelHeader subtitle="Article AI policy: the deployment-wide switch that lets editors restrict how AI may use an article, and the preconditions it waits for." />
      <div className="space-y-4">
        <ActivationSection />
      </div>
    </>
  );
}
