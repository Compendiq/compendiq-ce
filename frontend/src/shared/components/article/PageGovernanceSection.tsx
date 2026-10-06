import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Loader2 } from 'lucide-react';
import type { PageGovernanceProposal, PageLifecycleState } from '@compendiq/contracts';
import { useAuthStore } from '../../../stores/auth-store';
import { useEnterprise } from '../../enterprise/use-enterprise';
import { denialExplanation, type PageBaselineError } from '../../hooks/use-page-lifecycle';
import {
  governanceRefusal,
  useApproveProposal,
  useCreateProposal,
  useFinalizeProposal,
  useGovernanceProposal,
  useRejectProposal,
  useWithdrawProposal,
} from '../../hooks/use-page-governance';
import { BASELINE_SETTINGS_PATH } from '../../lib/routes';

/**
 * Governed sign-off, inside the Details tab's Document lifecycle section
 * (#277 rendering #278's workflow).
 *
 * Three rules this surface exists to keep:
 *
 *   1. **A vote is an authenticated server record.** There is no field here
 *      in which anyone types a name, a role or a signature. The role is
 *      chosen from the proposal's own `requiredRoles`, and the POST carries
 *      the manifest digest and requirements revision the browser was shown,
 *      so a stale tab cannot approve content it never saw.
 *   2. **Licence loss stops new voting and nothing else.** The article stays
 *      locked, its retained evidence stays readable, and an authorized thaw
 *      is still available — so the unentitled branch says exactly that and
 *      issues no request at all.
 *   3. **Nothing is optimistic.** The last approval finalizes the freeze
 *      inside the server's own transaction and can legitimately fail there
 *      (`freeze_busy`, a missing signing key). A failure is reported as one,
 *      with the explicit retry the server requires, never as success.
 */
type LifecycleFields = Partial<PageLifecycleState>;

const STATUS_COPY: Record<string, string> = {
  none: 'No approval proposal is open.',
  draft: 'A proposal is open and has no current approvals.',
  in_review: 'A proposal is in review and is collecting approvals.',
  approved: 'Every required role has approved; the freeze has not completed yet.',
  rejected: 'The last proposal was rejected.',
  withdrawn: 'The last proposal was withdrawn.',
  unavailable: 'The approval workflow could not be reached, so its state is unknown.',
};

function formatWhen(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function pendingLabel(busy: boolean, idle: string, working: string) {
  return busy ? working : idle;
}

export function PageGovernanceSection({ pageId, page }: { pageId: string; page: LifecycleFields | undefined }) {
  const { isEnterprise, hasFeature } = useEnterprise();
  const currentUser = useAuthStore((state) => state.user);
  const entitled = isEnterprise && hasFeature('document_sign_off_governance');
  const governed = page?.governanceEnabled === true;

  const proposalId = page?.governanceProposalId ?? null;
  const proposalQuery = useGovernanceProposal(proposalId, governed && entitled);
  const proposal = proposalQuery.data;

  const [error, setError] = useState<PageBaselineError | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [role, setRole] = useState('');
  const [comment, setComment] = useState('');
  const [decision, setDecision] = useState<'reject' | 'withdraw' | null>(null);
  const [decisionReason, setDecisionReason] = useState('');

  const create = useCreateProposal(pageId);
  const approve = useApproveProposal(pageId, proposalId);
  const reject = useRejectProposal(pageId, proposalId);
  const withdraw = useWithdrawProposal(pageId, proposalId);
  const finalize = useFinalizeProposal(pageId, proposalId);

  const selectedRole = useMemo(() => {
    if (!proposal) return '';
    if (role && proposal.requiredRoles.includes(role)) return role;
    return proposal.requiredRoles[0] ?? '';
  }, [proposal, role]);

  const run = useCallback(async (action: () => Promise<PageGovernanceProposal>, announce: string) => {
    setError(null);
    try {
      await action();
      setAnnouncement(announce);
      return true;
    } catch (err) {
      // The typed text stays: a refusal here is usually something the user
      // retries with the same words once the server's state has moved.
      setError(err as PageBaselineError);
      return false;
    }
  }, []);

  if (!governed) return null;

  if (!entitled) {
    return (
      <div className="mt-3 text-xs text-muted-foreground" data-testid="governance-unlicensed">
        <p className="font-medium text-foreground/85">Approval required</p>
        <p className="mt-1">
          This space requires approvals before an article can be frozen. New proposals, votes and
          finalization need an active Enterprise licence and are unavailable right now.
        </p>
        <p className="mt-1">
          Nothing was lost: a frozen article stays frozen, its retained evidence stays readable,
          and an authorized thaw is still available.
        </p>
      </div>
    );
  }

  const status = page?.governanceProposalStatus ?? 'none';
  const proposalStale = Boolean(
    proposal && page?.contentRevision && proposal.expectedContentRevision !== page.contentRevision,
  );
  const open = proposal?.status === 'draft' || proposal?.status === 'in_review';
  const canWithdraw = Boolean(
    proposal && open
    && (proposal.requestedBy === currentUser?.id || currentUser?.role === 'admin'),
  );
  const busy = create.isPending || approve.isPending || reject.isPending
    || withdraw.isPending || finalize.isPending;

  return (
    <div className="mt-3 text-xs" data-testid="governance-section">
      <p className="font-medium text-foreground/85">Approval</p>
      <p className="mt-1 text-muted-foreground" data-testid="governance-status">
        {STATUS_COPY[status] ?? 'Approval state is unknown.'}
      </p>

      {proposalQuery.isError && (
        <p className="mt-1 text-destructive" data-testid="governance-read-error">
          The proposal could not be read, so its votes are not shown here.
        </p>
      )}

      {proposal && (
        <div className="mt-2" data-testid="governance-proposal">
          <p className="text-muted-foreground">
            Requested by {proposal.requestedByName} on {formatWhen(proposal.createdAt)}
          </p>
          <ul className="mt-1.5" data-testid="governance-votes">
            {proposal.requiredRoles.map((required) => {
              const vote = proposal.approvals.find((approval) => approval.role === required);
              return (
                <li
                  key={required}
                  className="flex items-start justify-between gap-3 border-t border-border py-1 first:border-t-0"
                  data-testid={`governance-vote-${required}`}
                >
                  <span className="text-muted-foreground">{required}</span>
                  <span className="text-right text-foreground/85">
                    {vote
                      ? (
                        <span className="inline-flex items-center gap-1">
                          <Check size={12} className="shrink-0 opacity-70" aria-hidden="true" />
                          {vote.approverName} · {formatWhen(vote.signedAt)}
                        </span>
                      )
                      : <span className="text-muted-foreground">Not approved yet</span>}
                  </span>
                </li>
              );
            })}
          </ul>

          {proposalStale && (
            // Genuine attention: approvals already collected no longer cover
            // what is on screen, and no amount of further voting fixes it.
            <p
              role="status"
              className="mt-2 rounded-md border border-warning/30 bg-warning/10 p-2 text-foreground"
              data-testid="governance-stale"
            >
              This article changed after the proposal was opened, so the recorded approvals no
              longer cover its current content. Open a new proposal.
            </p>
          )}

          {proposal.status === 'approved' && proposal.finalizeError && (
            <div
              role="status"
              className="mt-2 rounded-md border border-warning/30 bg-warning/10 p-2 text-foreground"
              data-testid="governance-finalize-error"
            >
              <p>
                Every required role approved, but the freeze did not complete:{' '}
                {governanceRefusal(proposal.finalizeError) ?? proposal.finalizeError}
              </p>
              <p className="mt-1 text-muted-foreground">
                Nothing is scheduled — the proposal keeps its approvals until someone retries.
              </p>
              <button
                type="button"
                className="nm-button-ghost mt-1.5 inline-flex h-8 items-center gap-1.5 px-2 text-xs"
                aria-disabled={busy}
                data-testid="governance-finalize-retry"
                onClick={() => {
                  if (busy) return;
                  void run(() => finalize.mutateAsync(), 'Finalization was retried.');
                }}
              >
                {finalize.isPending && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
                <span>{pendingLabel(finalize.isPending, 'Retry finalization', 'Retrying…')}</span>
              </button>
            </div>
          )}
        </div>
      )}

      {page?.canApprove === true && proposal && open && !proposalStale && (
        <div className="mt-2" data-testid="governance-approve">
          <label className="block font-medium text-foreground" htmlFor="governance-role">
            Approve as
          </label>
          <select
            id="governance-role"
            className="nm-select mt-1 h-8 w-full text-xs"
            value={selectedRole}
            onChange={(event) => setRole(event.target.value)}
            data-testid="governance-role"
          >
            {proposal.requiredRoles.map((required) => (
              <option key={required} value={required}>{required}</option>
            ))}
          </select>
          <label className="mt-2 block font-medium text-foreground" htmlFor="governance-comment">
            Comment (optional)
          </label>
          <input
            id="governance-comment"
            className="nm-input mt-1 w-full text-xs"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            data-testid="governance-comment"
          />
          <button
            type="button"
            className="nm-button-primary mt-2 inline-flex h-8 items-center gap-1.5 px-3 text-xs"
            aria-disabled={busy || !selectedRole}
            data-testid="governance-approve-btn"
            onClick={() => {
              if (busy || !selectedRole) return;
              void run(
                () => approve.mutateAsync({
                  proposalId: proposal.id,
                  role: selectedRole,
                  expectedManifestDigest: proposal.expectedManifestDigest,
                  expectedRequirementsRevision: proposal.requirementsRevision,
                  ...(comment.trim() ? { comment: comment.trim() } : {}),
                }),
                'Your approval was recorded.',
              ).then((ok) => { if (ok) setComment(''); });
            }}
          >
            {approve.isPending && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
            <span>{pendingLabel(approve.isPending, 'Approve', 'Recording…')}</span>
          </button>
        </div>
      )}

      {page?.canApprove !== true && denialExplanation(page?.approveDeniedReason) && status !== 'none' && (
        <p className="mt-2 text-muted-foreground" data-testid="governance-approve-denied">
          {denialExplanation(page?.approveDeniedReason)}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {(status === 'none' || status === 'rejected' || status === 'withdrawn') && (
          <button
            type="button"
            className="nm-button-ghost inline-flex h-8 items-center gap-1.5 px-2 text-xs"
            aria-disabled={busy}
            data-testid="governance-request"
            onClick={() => {
              if (busy) return;
              void run(() => create.mutateAsync(), 'An approval proposal was opened.');
            }}
          >
            {create.isPending && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
            <span>{pendingLabel(create.isPending, 'Request approval', 'Opening…')}</span>
          </button>
        )}
        {proposal && open && page?.canApprove === true && (
          <button
            type="button"
            className="nm-action-destructive inline-flex h-8 items-center gap-1.5 px-2 text-xs"
            aria-disabled={busy}
            data-testid="governance-reject"
            onClick={() => { if (!busy) { setDecision('reject'); setDecisionReason(''); } }}
          >
            Reject
          </button>
        )}
        {canWithdraw && (
          <button
            type="button"
            className="nm-button-ghost inline-flex h-8 items-center gap-1.5 px-2 text-xs"
            aria-disabled={busy}
            data-testid="governance-withdraw"
            onClick={() => { if (!busy) { setDecision('withdraw'); setDecisionReason(''); } }}
          >
            Withdraw
          </button>
        )}
      </div>

      {decision && (
        <div className="mt-2" data-testid="governance-decision">
          <label className="block font-medium text-foreground" htmlFor="governance-decision-reason">
            {decision === 'reject' ? 'Why are you rejecting this?' : 'Why are you withdrawing it?'}
          </label>
          <textarea
            id="governance-decision-reason"
            className="nm-input mt-1 w-full text-xs"
            rows={2}
            value={decisionReason}
            onChange={(event) => setDecisionReason(event.target.value)}
            data-testid="governance-decision-reason"
          />
          <p className="mt-1 text-muted-foreground">
            This drops every approval already recorded on the proposal.
          </p>
          <div className="mt-1.5 flex gap-2">
            <button
              type="button"
              className="nm-button-ghost h-8 px-3 text-xs"
              onClick={() => { if (!busy) setDecision(null); }}
              data-testid="governance-decision-cancel"
            >
              Cancel
            </button>
            <button
              type="button"
              className="nm-button-primary inline-flex h-8 items-center gap-1.5 px-3 text-xs"
              aria-disabled={busy || decisionReason.trim().length < 3}
              data-testid="governance-decision-confirm"
              onClick={() => {
                if (busy || decisionReason.trim().length < 3) return;
                const reason = decisionReason.trim();
                const mutation = decision === 'reject' ? reject : withdraw;
                void run(
                  () => mutation.mutateAsync({ reason }),
                  decision === 'reject' ? 'The proposal was rejected.' : 'The proposal was withdrawn.',
                ).then((ok) => { if (ok) { setDecision(null); setDecisionReason(''); } });
              }}
            >
              {(reject.isPending || withdraw.isPending) && (
                <Loader2 size={12} className="animate-spin" aria-hidden="true" />
              )}
              <span>
                {decision === 'reject'
                  ? pendingLabel(reject.isPending, 'Reject proposal', 'Rejecting…')
                  : pendingLabel(withdraw.isPending, 'Withdraw proposal', 'Withdrawing…')}
              </span>
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-2 text-destructive" data-testid="governance-error">
          {governanceRefusal(error.reason) ?? error.message}
        </p>
      )}

      {currentUser?.role === 'admin' && (
        <p className="mt-2">
          <Link className="text-muted-foreground underline" to={BASELINE_SETTINGS_PATH}>
            Configure approval roles
          </Link>
        </p>
      )}

      <span className="sr-only" role="status" aria-live="polite" data-testid="governance-announcer">
        {announcement}
      </span>
    </div>
  );
}
