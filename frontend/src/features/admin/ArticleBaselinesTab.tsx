import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import {
  PageBaselineActivationStateSchema,
  PageGovernancePolicySchema,
  PageGovernanceRequirementsResponseSchema,
  PageGovernanceRoleAssignmentsResponseSchema,
  type PageBaselineActivationState,
  type PageGovernancePolicy,
  type PageGovernanceRequirements,
  type PageGovernanceRoleAssignment,
} from '@compendiq/contracts';
import { apiFetch, ApiError } from '../../shared/lib/api';
import { PanelHeader } from '../settings/PanelHeader';
import { useEnterprise } from '../../shared/enterprise/use-enterprise';

/**
 * Settings → Article baselines, in the Governance group (#277).
 *
 * Two configuration surfaces that had no UI at all and therefore made the
 * whole feature unreachable from the product:
 *
 *   1. **Activation** is CE and ships DISABLED. No startup path enables it,
 *      deliberately: a baseline created by one instance while another is
 *      still running a non-enforcing build is a claimed-immutable article
 *      that an old writer can still change. So this control states the
 *      rollout rule rather than being a bare switch, and it refuses while
 *      the server reports the deployment is not ready.
 *   2. **Sign-off governance** per space: the CE marker that makes a direct
 *      manual freeze refuse, plus — under an Enterprise licence — the
 *      approval roles and the people who hold them.
 *
 * Standalone-only (owner amendment, 2026-09-20): freeze and approval are
 * available for local articles while the acting user's Confluence integration
 * is off, which is why the space picker lists local spaces and why enabling
 * activation can come back 409 `confluence_integration_enabled`.
 */

interface LocalSpace {
  key: string;
  name: string;
}

function useActivation() {
  return useQuery<PageBaselineActivationState>({
    queryKey: ['admin', 'page-baseline-activation'],
    retry: false,
    queryFn: async () => PageBaselineActivationStateSchema.parse(
      await apiFetch('/admin/page-baselines/activation'),
    ),
  });
}

const BLOCKER_COPY: Record<string, string> = {
  protected_writer_enforcement_not_registered:
    'This instance has not registered the protected-writer enforcement, so it cannot guarantee a frozen article stays unchanged.',
  incompatible_page_writer_runtime:
    'At least one live backend instance is running a build that does not enforce baselines. Drain or upgrade it first.',
  deployment_readiness_unavailable:
    'Readiness could not be determined, so activation stays refused.',
};

function ActivationSection() {
  const queryClient = useQueryClient();
  const activation = useActivation();
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation<PageBaselineActivationState, unknown, boolean>({
    mutationFn: async (creationEnabled) => PageBaselineActivationStateSchema.parse(
      await apiFetch('/admin/page-baselines/activation', {
        method: 'PUT',
        body: JSON.stringify({ creationEnabled }),
      }),
    ),
    onSuccess: async () => {
      // Re-read rather than trusting the echo: readiness is recomputed from
      // the live writer runtimes on every read and can have moved.
      await queryClient.invalidateQueries({ queryKey: ['admin', 'page-baseline-activation'] });
    },
  });

  const state = activation.data;
  const ready = state?.deploymentReady === true;

  const submit = useCallback(async (next: boolean) => {
    if (mutation.isPending) return;
    setError(null);
    try {
      await mutation.mutateAsync(next);
    } catch (err) {
      if (err instanceof ApiError && err.reason === 'confluence_integration_enabled') {
        setError('Turn off the Confluence integration for your own account first — baselines cover local articles only.');
        return;
      }
      setError(err instanceof Error ? err.message : 'The change could not be saved.');
    }
  }, [mutation]);

  return (
    <section className="nm-card p-4" data-testid="baseline-activation">
      <h3 className="text-sm font-semibold text-foreground">Baseline creation</h3>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        Freezing an article records an immutable copy of it and its media, and refuses every
        content change until it is thawed. Do not enable this in a mixed-version cluster: every
        backend instance has to be running an enforcing build first. Once baselines exist,
        rolling back to a build that does not enforce them is not supported — disable creation
        here and fix forward instead.
      </p>

      {activation.isPending && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="activation-loading">
          Reading the activation state…
        </p>
      )}
      {activation.isError && (
        <p className="mt-2 text-xs text-destructive" data-testid="activation-error">
          The activation state could not be read, so no change is offered here.
        </p>
      )}

      {state && (
        <>
          <p className="mt-3 text-xs text-foreground/85" data-testid="activation-state">
            {state.creationEnabled
              ? 'Article freezing is enabled on this deployment.'
              : 'Article freezing is switched off on this deployment.'}
            {state.activatedByName && state.activatedAt && (
              <span className="text-muted-foreground">
                {' '}Last changed by {state.activatedByName} on{' '}
                {new Date(state.activatedAt).toLocaleDateString()}.
              </span>
            )}
          </p>

          {!ready && (
            <div
              role="status"
              className="mt-2 rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-foreground"
              data-testid="activation-blockers"
            >
              <p className="font-medium">This deployment is not ready to create baselines.</p>
              <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                {state.blockers.length === 0
                  ? <li>The server reported no specific blocker.</li>
                  : state.blockers.map((blocker) => (
                    <li key={blocker}>{BLOCKER_COPY[blocker] ?? blocker}</li>
                  ))}
              </ul>
            </div>
          )}

          {error && (
            <p className="mt-2 text-xs text-destructive" data-testid="activation-save-error">{error}</p>
          )}

          <button
            type="button"
            className="nm-button-ghost mt-3 inline-flex h-8 items-center gap-1.5 px-3 text-xs"
            aria-disabled={mutation.isPending || (!state.creationEnabled && !ready)}
            data-testid="activation-toggle"
            onClick={() => {
              if (mutation.isPending) return;
              if (!state.creationEnabled && !ready) {
                setError('Freezing cannot be enabled while this deployment reports a blocker above.');
                return;
              }
              void submit(!state.creationEnabled);
            }}
          >
            {mutation.isPending && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
            <span>
              {mutation.isPending
                ? 'Saving…'
                : state.creationEnabled ? 'Disable article freezing' : 'Enable article freezing'}
            </span>
          </button>
        </>
      )}
    </section>
  );
}

function PolicySection({ spaceKey }: { spaceKey: string }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const policy = useQuery<PageGovernancePolicy>({
    queryKey: ['admin', 'page-governance-policy', spaceKey],
    retry: false,
    queryFn: async () => PageGovernancePolicySchema.parse(
      await apiFetch(`/admin/page-governance/${encodeURIComponent(spaceKey)}/policy`),
    ),
  });

  const mutation = useMutation<PageGovernancePolicy, unknown, boolean>({
    mutationFn: async (enabled) => PageGovernancePolicySchema.parse(
      await apiFetch(`/admin/page-governance/${encodeURIComponent(spaceKey)}/policy`, {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      }),
    ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'page-governance-policy', spaceKey] });
    },
  });

  return (
    <div className="mt-4" data-testid="governance-policy">
      <h4 className="text-xs font-semibold text-foreground">Approval policy</h4>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        With approvals required, a direct manual freeze is refused for every article in this
        space and only the approval workflow can freeze one. The policy is persisted, so it keeps
        refusing while an Enterprise licence is expired; turning it off is a separate audited
        change, never an automatic fallback.
      </p>
      {policy.isPending && (
        <p className="mt-2 text-xs text-muted-foreground">Reading the policy…</p>
      )}
      {policy.isError && (
        <p className="mt-2 text-xs text-destructive" data-testid="policy-error">
          The policy for this space could not be read.
        </p>
      )}
      {error && <p className="mt-2 text-xs text-destructive" data-testid="policy-save-error">{error}</p>}
      {policy.data && (
        <>
          <p className="mt-2 text-xs text-foreground/85" data-testid="policy-state">
            {policy.data.enabled
              ? 'Approvals are required in this space.'
              : 'Approvals are not required in this space.'}
          </p>
          <button
            type="button"
            className="nm-button-ghost mt-2 inline-flex h-8 items-center gap-1.5 px-3 text-xs"
            aria-disabled={mutation.isPending}
            data-testid="policy-toggle"
            onClick={() => {
              if (mutation.isPending) return;
              setError(null);
              mutation.mutateAsync(!policy.data!.enabled).catch((err: unknown) => {
                setError(err instanceof Error ? err.message : 'The policy could not be saved.');
              });
            }}
          >
            {mutation.isPending && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
            <span>
              {mutation.isPending
                ? 'Saving…'
                : policy.data.enabled ? 'Stop requiring approvals' : 'Require approvals'}
            </span>
          </button>
        </>
      )}
    </div>
  );
}

function RequirementsSection({ spaceKey }: { spaceKey: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const requirements = useQuery<PageGovernanceRequirements | null>({
    queryKey: ['admin', 'page-governance-requirements', spaceKey],
    retry: false,
    queryFn: async () => PageGovernanceRequirementsResponseSchema.parse(
      await apiFetch(`/admin/page-governance/${encodeURIComponent(spaceKey)}/requirements`),
    ).requirements,
  });

  const saved = requirements.data?.requiredRoles.join(', ') ?? '';
  const value = draft ?? saved;

  const mutation = useMutation<unknown, unknown, string[]>({
    mutationFn: async (requiredRoles) => await apiFetch(
      `/admin/page-governance/${encodeURIComponent(spaceKey)}/requirements`,
      { method: 'PUT', body: JSON.stringify({ requiredRoles }) },
    ),
    onSuccess: async () => {
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'page-governance-requirements', spaceKey] });
    },
  });

  const roles = useMemo(
    () => value.split(',').map((role) => role.trim()).filter(Boolean),
    [value],
  );

  return (
    <div className="mt-4" data-testid="governance-requirements">
      <h4 className="text-xs font-semibold text-foreground">Required approval roles</h4>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        Every role listed here has to approve before an article in this space can be frozen.
        Changing the list invalidates every pending vote in the space: a vote means “these roles,
        this policy revision”, so it cannot survive the policy it was cast under.
      </p>
      {requirements.isError && (
        <p className="mt-2 text-xs text-destructive" data-testid="requirements-error">
          The approval roles for this space could not be read.
        </p>
      )}
      <label className="mt-2 block text-xs font-medium text-foreground" htmlFor="governance-required-roles">
        Roles (comma separated, 1–16)
      </label>
      <input
        id="governance-required-roles"
        className="nm-input mt-1 w-full text-xs"
        value={value}
        onChange={(event) => setDraft(event.target.value)}
        data-testid="requirements-input"
      />
      {error && <p className="mt-2 text-xs text-destructive" data-testid="requirements-save-error">{error}</p>}
      <button
        type="button"
        className="nm-button-ghost mt-2 inline-flex h-8 items-center gap-1.5 px-3 text-xs"
        aria-disabled={mutation.isPending || roles.length === 0 || roles.length > 16}
        data-testid="requirements-save"
        onClick={() => {
          if (mutation.isPending || roles.length === 0 || roles.length > 16) return;
          setError(null);
          mutation.mutateAsync(roles).catch((err: unknown) => {
            setError(err instanceof Error ? err.message : 'The approval roles could not be saved.');
          });
        }}
      >
        {mutation.isPending && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
        <span>{mutation.isPending ? 'Saving…' : 'Save approval roles'}</span>
      </button>
    </div>
  );
}

function ApproversSection({ spaceKey, roles }: { spaceKey: string; roles: string[] }) {
  const queryClient = useQueryClient();
  const [role, setRole] = useState('');
  const [userId, setUserId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const assignments = useQuery<PageGovernanceRoleAssignment[]>({
    queryKey: ['admin', 'page-governance-roles', spaceKey],
    retry: false,
    queryFn: async () => PageGovernanceRoleAssignmentsResponseSchema.parse(
      await apiFetch(`/admin/page-governance/${encodeURIComponent(spaceKey)}/roles`),
    ).assignments,
  });

  const users = useQuery<{ id: string; username: string; displayName: string | null }[]>({
    queryKey: ['admin', 'users'],
    retry: false,
    queryFn: async () => (await apiFetch<{ users: { id: string; username: string; displayName: string | null }[] }>('/admin/users')).users,
  });

  const mutation = useMutation<unknown, unknown, { method: 'POST' | 'DELETE'; role: string; userId: string }>({
    mutationFn: async ({ method, role: assignedRole, userId: assignedUser }) => await apiFetch(
      `/admin/page-governance/${encodeURIComponent(spaceKey)}/roles`,
      { method, body: JSON.stringify({ role: assignedRole, userId: assignedUser }) },
    ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'page-governance-roles', spaceKey] });
    },
  });

  const selectableRole = role || roles[0] || '';

  return (
    <div className="mt-4" data-testid="governance-approvers">
      <h4 className="text-xs font-semibold text-foreground">Approvers</h4>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        A role assignment is authority to approve and nothing else — it grants no access to this
        policy and no access to compliance reports. Assigning or removing one also invalidates
        every pending vote in this space.
      </p>

      {assignments.isError && (
        <p className="mt-2 text-xs text-destructive" data-testid="approvers-error">
          The approvers for this space could not be read.
        </p>
      )}
      {assignments.data && assignments.data.length === 0 && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="approvers-empty">
          Nobody holds an approval role in this space yet, so no article here can be frozen.
        </p>
      )}
      {assignments.data && assignments.data.length > 0 && (
        <ul className="mt-2 text-xs" data-testid="approvers-list">
          {assignments.data.map((assignment) => (
            <li
              key={`${assignment.role}:${assignment.userId}`}
              className="flex items-center justify-between gap-3 border-t border-border py-1.5 first:border-t-0"
            >
              <span className="text-foreground/85">
                {assignment.username} <span className="text-muted-foreground">· {assignment.role}</span>
              </span>
              <button
                type="button"
                className="nm-action-destructive h-8 px-2 text-xs"
                aria-disabled={mutation.isPending}
                data-testid={`approver-remove-${assignment.role}-${assignment.userId}`}
                onClick={() => {
                  if (mutation.isPending) return;
                  setError(null);
                  mutation.mutateAsync({
                    method: 'DELETE',
                    role: assignment.role,
                    userId: assignment.userId,
                  }).catch((err: unknown) => {
                    setError(err instanceof Error ? err.message : 'The assignment could not be removed.');
                  });
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-xs font-medium text-foreground" htmlFor="approver-role">Role</label>
          <select
            id="approver-role"
            className="nm-select mt-1 h-8 text-xs"
            value={selectableRole}
            onChange={(event) => setRole(event.target.value)}
            data-testid="approver-role"
          >
            {roles.length === 0 && <option value="">No roles configured</option>}
            {roles.map((available) => <option key={available} value={available}>{available}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-foreground" htmlFor="approver-user">Person</label>
          <select
            id="approver-user"
            className="nm-select mt-1 h-8 text-xs"
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            data-testid="approver-user"
          >
            <option value="">Select a person…</option>
            {(users.data ?? []).map((user) => (
              <option key={user.id} value={user.id}>{user.displayName || user.username}</option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="nm-button-ghost inline-flex h-8 items-center gap-1.5 px-3 text-xs"
          aria-disabled={mutation.isPending || !selectableRole || !userId}
          data-testid="approver-add"
          onClick={() => {
            if (mutation.isPending || !selectableRole || !userId) return;
            setError(null);
            mutation.mutateAsync({ method: 'POST', role: selectableRole, userId })
              .then(() => setUserId(''))
              .catch((err: unknown) => {
                setError(err instanceof Error ? err.message : 'The assignment could not be saved.');
              });
          }}
        >
          {mutation.isPending && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
          <span>{mutation.isPending ? 'Saving…' : 'Assign approver'}</span>
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-destructive" data-testid="approvers-save-error">{error}</p>}
    </div>
  );
}

export function ArticleBaselinesTab() {
  const { isEnterprise, hasFeature } = useEnterprise();
  const entitled = isEnterprise && hasFeature('document_sign_off_governance');
  const [spaceKey, setSpaceKey] = useState('');

  const spaces = useQuery<LocalSpace[]>({
    queryKey: ['local-spaces'],
    retry: false,
    queryFn: async () => await apiFetch<LocalSpace[]>('/spaces/local'),
  });

  // The selector defaults to the first space rather than to "nothing chosen",
  // so everything below keys on the resolved selection. Keying the read on
  // the raw state meant the approver picker had no roles until the admin
  // touched a selector that was already showing the space it would read.
  const selected = spaceKey || spaces.data?.[0]?.key || '';

  const requirements = useQuery<PageGovernanceRequirements | null>({
    queryKey: ['admin', 'page-governance-requirements', selected],
    enabled: entitled && selected.length > 0,
    retry: false,
    queryFn: async () => PageGovernanceRequirementsResponseSchema.parse(
      await apiFetch(`/admin/page-governance/${encodeURIComponent(selected)}/requirements`),
    ).requirements,
  });

  return (
    <>
      <PanelHeader subtitle="Immutable article baselines: deployment activation, and which spaces require approvals before an article can be frozen." />

      <div className="space-y-4">
        <ActivationSection />

        <section className="nm-card p-4" data-testid="baseline-governance">
          <h3 className="text-sm font-semibold text-foreground">Sign-off governance</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Per space. Baselines cover local articles, so these are the local spaces.
          </p>

          {spaces.isError && (
            <p className="mt-2 text-xs text-destructive" data-testid="spaces-error">
              The list of spaces could not be read.
            </p>
          )}
          {spaces.data && spaces.data.length === 0 && (
            <p className="mt-2 text-xs text-muted-foreground" data-testid="spaces-empty">
              There are no local spaces yet, so there is nothing to govern.
            </p>
          )}

          {spaces.data && spaces.data.length > 0 && (
            <>
              <label className="mt-3 block text-xs font-medium text-foreground" htmlFor="governance-space">
                Space
              </label>
              <select
                id="governance-space"
                className="nm-select mt-1 h-8 text-xs"
                value={selected}
                onChange={(event) => setSpaceKey(event.target.value)}
                data-testid="governance-space"
              >
                {spaces.data.map((space) => (
                  <option key={space.key} value={space.key}>{space.name || space.key}</option>
                ))}
              </select>

              {selected && <PolicySection spaceKey={selected} />}

              {selected && !entitled && (
                <p className="mt-4 text-xs text-muted-foreground" data-testid="governance-unlicensed">
                  Approval roles and their holders are an Enterprise feature and need an active
                  licence. The policy above stays in force meanwhile: a governed space keeps
                  refusing a direct manual freeze.
                </p>
              )}

              {selected && entitled && (
                <>
                  <RequirementsSection spaceKey={selected} />
                  <ApproversSection
                    spaceKey={selected}
                    roles={requirements.data?.requiredRoles ?? []}
                  />
                </>
              )}
            </>
          )}
        </section>
      </div>
    </>
  );
}
