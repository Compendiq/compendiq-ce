/**
 * Governed sign-off section (#277) at the network boundary.
 *
 * `fetch` is mocked; the component, its hooks and the query client are real.
 * Every case here is about a claim the interface must not overstate: a vote
 * is the server's record and never something a user types, a licence that
 * lapsed is not data loss, and a freeze that failed inside the final approval
 * is reported as a failure with the retry the server actually requires.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageGovernanceProposal, PageLifecycleState } from '@compendiq/contracts';
import { PageGovernanceSection } from './PageGovernanceSection';
import { useAuthStore } from '../../../stores/auth-store';

vi.mock('../../enterprise/use-enterprise', () => ({
  useEnterprise: () => ({ isEnterprise: entitled, hasFeature: () => entitled }),
}));

let entitled = true;

const APPROVER_ID = '11111111-1111-4111-8111-111111111111';
const REQUESTER_ID = '22222222-2222-4222-8222-222222222222';
const PROPOSAL_ID = '33333333-3333-4333-8333-333333333333';
const DIGEST = 'a'.repeat(64);

const GOVERNED: Partial<PageLifecycleState> = {
  isFrozen: false,
  baselineId: null,
  frozenVersion: null,
  contentRevision: '9',
  lifecycleRevision: '3',
  canFreeze: false,
  freezeDeniedReason: 'governance_required',
  canUnfreeze: false,
  unfreezeDeniedReason: 'page_not_frozen',
  canApprove: true,
  approveDeniedReason: null,
  canMutateContent: true,
  mutateContentDeniedReason: null,
  governanceEnabled: true,
  governanceProposalStatus: 'in_review',
  governanceProposalId: PROPOSAL_ID,
};

const PROPOSAL: PageGovernanceProposal = {
  id: PROPOSAL_ID,
  pageId: 42,
  originalPageId: 42,
  spaceKey: 'LOCAL',
  status: 'in_review',
  expectedManifestDigest: DIGEST,
  expectedContentRevision: '9',
  requirementsRevision: '4',
  requiredRoles: ['quality', 'regulatory'],
  requestedBy: REQUESTER_ID,
  requestedByName: 'Robin Ash',
  contentAuthorName: 'Robin Ash',
  baselineId: null,
  finalizeError: null,
  decisionReason: null,
  createdAt: '2026-05-01T10:00:00.000Z',
  updatedAt: '2026-05-01T10:00:00.000Z',
  approvals: [{
    role: 'quality',
    approverUserId: APPROVER_ID,
    approverName: 'Mina Okafor',
    manifestDigest: DIGEST,
    signedAt: '2026-05-02T08:00:00.000Z',
    comment: null,
  }],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderSection(page: Partial<PageLifecycleState> | undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PageGovernanceSection pageId="42" page={page} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  entitled = true;
  useAuthStore.setState({
    user: { id: APPROVER_ID, username: 'mina', role: 'user' } as never,
  });
  fetchMock = vi.fn(async () => json({ proposal: PROPOSAL }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function bodyOf(call: [string, RequestInit]): Record<string, unknown> {
  return JSON.parse(String(call[1].body));
}

describe('governed sign-off section', () => {
  it('renders nothing at all for an ungoverned space', () => {
    const { container } = renderSection({ ...GOVERNED, governanceEnabled: false });
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('explains a lapsed licence without claiming the article was unlocked', async () => {
    entitled = false;
    renderSection(GOVERNED);

    const notice = await screen.findByTestId('governance-unlicensed');
    expect(notice.textContent).toMatch(/unavailable/i);
    expect(notice.textContent).toMatch(/stays frozen/i);
    expect(notice.textContent).toMatch(/authorized thaw/i);
    // Nothing is asked of a workflow that is entitlement-gated server-side.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders one row per required role with the authenticated approver', async () => {
    renderSection(GOVERNED);

    const quality = await screen.findByTestId('governance-vote-quality');
    expect(quality.textContent).toContain('Mina Okafor');
    expect(screen.getByTestId('governance-vote-regulatory').textContent).toMatch(/not approved yet/i);
  });

  it('approves exactly the manifest and policy revision the proposal carries', async () => {
    renderSection(GOVERNED);
    await screen.findByTestId('governance-vote-quality');

    fetchMock.mockImplementation(async () => json({ proposal: { ...PROPOSAL, status: 'approved' } }));
    fireEvent.click(screen.getByTestId('governance-approve-btn'));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/sign-off'));
      expect(call).toBeTruthy();
      expect(bodyOf(call as [string, RequestInit])).toMatchObject({
        proposalId: PROPOSAL_ID,
        role: 'quality',
        expectedManifestDigest: DIGEST,
        expectedRequirementsRevision: '4',
      });
    });
  });

  it('offers only the roles this proposal requires — never a typed role', async () => {
    renderSection(GOVERNED);
    const select = await screen.findByTestId('governance-role');
    expect(select.tagName).toBe('SELECT');
    expect([...select.querySelectorAll('option')].map((o) => o.textContent))
      .toEqual(['quality', 'regulatory']);
  });

  it('keeps the typed comment and names a stale-manifest refusal', async () => {
    renderSection(GOVERNED);
    await screen.findByTestId('governance-vote-quality');

    fireEvent.change(screen.getByTestId('governance-comment'), { target: { value: 'checked pages 3-7' } });
    fetchMock.mockImplementation(async () => json({ error: 'stale_manifest', reason: 'stale_manifest', detail: 'changed' }, 409));
    fireEvent.click(screen.getByTestId('governance-approve-btn'));

    const error = await screen.findByTestId('governance-error');
    expect(error.textContent).toMatch(/changed after this proposal was opened/i);
    expect(screen.getByTestId('governance-comment')).toHaveValue('checked pages 3-7');
  });

  it('flags a proposal the article has moved past', async () => {
    renderSection({ ...GOVERNED, contentRevision: '11' });

    const stale = await screen.findByTestId('governance-stale');
    expect(stale.textContent).toMatch(/no longer cover/i);
    // Voting on content nobody reviewed is exactly what must not be offered.
    expect(screen.queryByTestId('governance-approve-btn')).toBeNull();
  });

  it('reports a failed finalization as a failure with an explicit retry', async () => {
    fetchMock.mockImplementation(async () => json({
      proposal: { ...PROPOSAL, status: 'approved', finalizeError: 'freeze_busy' },
    }));
    renderSection({ ...GOVERNED, governanceProposalStatus: 'approved' });

    const strip = await screen.findByTestId('governance-finalize-error');
    expect(strip.textContent).toMatch(/did not complete/i);
    expect(strip.textContent).toMatch(/editing this article/i);

    fireEvent.click(screen.getByTestId('governance-finalize-retry'));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/finalize'))).toBe(true);
    });
  });

  it('never reports an unreachable workflow as "no proposal is open"', async () => {
    renderSection({
      ...GOVERNED,
      governanceProposalStatus: 'unavailable',
      governanceProposalId: null,
      canApprove: false,
      approveDeniedReason: 'governance_unavailable',
    });

    const status = await screen.findByTestId('governance-status');
    expect(status.textContent).toMatch(/could not be reached/i);
    expect(status.textContent).not.toMatch(/no approval proposal/i);
  });

  it('explains why approval is unavailable instead of hiding the reason', async () => {
    renderSection({ ...GOVERNED, canApprove: false, approveDeniedReason: 'not_authorized' });

    const denied = await screen.findByTestId('governance-approve-denied');
    expect(denied.textContent).toMatch(/permission/i);
    expect(screen.queryByTestId('governance-approve-btn')).toBeNull();
  });
});
