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
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageGovernanceProposal, PageLifecycleState } from '@compendiq/contracts';
import { PageGovernanceSection } from './PageGovernanceSection';
import { useAuthStore } from '../../../stores/auth-store';
import type { LicenseInfo } from '../../enterprise/types';

vi.mock('../../enterprise/use-enterprise', () => ({
  useEnterprise: () => ({ isEnterprise: entitled, hasFeature: () => entitled, license: licence }),
}));

let entitled = true;

const LICENCE: LicenseInfo = {
  edition: 'enterprise',
  tier: 'enterprise',
  features: ['document_sign_off_governance'],
  valid: true,
  licenseId: 'CPQ1a2b3c4d',
  expiresAt: '2027-01-01',
};
let licence: LicenseInfo | null = LICENCE;

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
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PageGovernanceSection pageId="42" page={page} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const result = render(tree());
  // Same client, same page: only what `useEnterprise()` reports has moved.
  return { ...result, rerenderSection: () => result.rerender(tree()) };
}

function governanceCalls(): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.includes('/enterprise/'));
}

/** Lets any request a settle-invalidation or an effect would start reach `fetch`. */
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  entitled = true;
  licence = LICENCE;
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

    fetchMock.mockImplementation(async () => json({
      proposal: { ...PROPOSAL, status: 'finalized', baselineId: PROPOSAL_ID },
    }));
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

  it('reports a final approval that froze the article as done, with its votes as a record', async () => {
    renderSection(GOVERNED);
    await screen.findByTestId('governance-vote-quality');

    const finalized: PageGovernanceProposal = {
      ...PROPOSAL,
      status: 'finalized',
      baselineId: PROPOSAL_ID,
      approvals: [...PROPOSAL.approvals, {
        role: 'regulatory',
        approverUserId: APPROVER_ID,
        approverName: 'Mina Okafor',
        manifestDigest: DIGEST,
        signedAt: '2026-05-03T08:00:00.000Z',
        comment: null,
      }],
    };
    fetchMock.mockImplementation(async () => json({ proposal: finalized }));
    fireEvent.change(screen.getByTestId('governance-role'), { target: { value: 'regulatory' } });
    fireEvent.click(screen.getByTestId('governance-approve-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('governance-status').textContent).toMatch(/froze the article/i);
    });
    expect(screen.getByTestId('governance-announcer').textContent).toMatch(/now frozen/i);
    expect(screen.queryByTestId('governance-error')).toBeNull();
    expect(screen.getByTestId('governance-section').textContent).not.toMatch(/refused/i);
    expect(screen.getByTestId('governance-vote-regulatory').textContent).toContain('Mina Okafor');
    for (const control of ['governance-approve-btn', 'governance-reject', 'governance-withdraw', 'governance-request']) {
      expect(screen.queryByTestId(control)).toBeNull();
    }
  });

  it('keeps a final vote whose freeze failed as a recorded vote with an explicit retry', async () => {
    renderSection(GOVERNED);
    await screen.findByTestId('governance-vote-quality');

    fireEvent.change(screen.getByTestId('governance-comment'), { target: { value: 'all sections reviewed' } });
    fetchMock.mockImplementation(async () => json({
      proposal: { ...PROPOSAL, status: 'approved', finalizeError: 'freeze_busy' },
    }));
    fireEvent.click(screen.getByTestId('governance-approve-btn'));

    const strip = await screen.findByTestId('governance-finalize-error');
    expect(strip.textContent).toMatch(/editing this article/i);
    expect(screen.getByTestId('governance-finalize-retry')).toBeInTheDocument();
    expect(screen.getByTestId('governance-announcer').textContent).toMatch(/did not complete/i);
    // The vote is the server's record now: nothing to approve again, and the
    // comment that went with it is not left behind to be sent twice.
    expect(screen.queryByTestId('governance-approve-btn')).toBeNull();
    expect(screen.queryByTestId('governance-comment')).toBeNull();
    expect(screen.queryByTestId('governance-error')).toBeNull();
  });

  it('re-reads the proposal after a refused finalize retry and announces the refusal', async () => {
    const failed = { ...PROPOSAL, status: 'approved', finalizeError: 'signing_key_unavailable' };
    fetchMock.mockImplementation(async () => json({ proposal: failed }));
    renderSection({ ...GOVERNED, governanceProposalStatus: 'approved' });
    await screen.findByTestId('governance-finalize-error');

    fetchMock.mockImplementation(async (url: string) => (String(url).endsWith('/finalize')
      ? json({ error: 'freeze_busy', reason: 'freeze_busy', detail: 'busy' }, 409)
      : json({ proposal: { ...failed, finalizeError: 'freeze_busy' } })));
    const before = governanceCalls().length;
    fireEvent.click(screen.getByTestId('governance-finalize-retry'));

    const error = await screen.findByRole('alert');
    expect(error).toHaveAttribute('data-testid', 'governance-error');
    expect(error.textContent).toMatch(/editing this article/i);
    // The refusal persisted its reason server-side; the strip shows the re-read.
    await waitFor(() => {
      expect(screen.getByTestId('governance-finalize-error').textContent).toMatch(/editing this article/i);
    });
    expect(governanceCalls().slice(before)).toEqual([
      `/api/enterprise/page-governance/proposals/${PROPOSAL_ID}/finalize`,
      `/api/enterprise/page-governance/proposals/${PROPOSAL_ID}`,
    ]);
  });

  it('shows a finalize error stored as prose verbatim rather than as a refusal code', async () => {
    fetchMock.mockImplementation(async () => json({
      proposal: { ...PROPOSAL, status: 'approved', finalizeError: 'Signing key PAGE_BASELINE_SIGNING_KEY is not configured' },
    }));
    renderSection({ ...GOVERNED, governanceProposalStatus: 'approved' });

    const strip = await screen.findByTestId('governance-finalize-error');
    expect(strip.textContent).toContain('Signing key PAGE_BASELINE_SIGNING_KEY is not configured');
    expect(strip.textContent).not.toMatch(/refused/i);
  });

  it('stops asking once a vote is refused for a lapsed licence, and resumes when the licence changes', async () => {
    const view = renderSection(GOVERNED);
    await screen.findByTestId('governance-vote-quality');

    fireEvent.change(screen.getByTestId('governance-comment'), { target: { value: 'checked pages 3-7' } });
    fetchMock.mockImplementation(async () => json({
      error: 'EnterpriseRequired',
      reason: 'governance_license_required',
      message: 'This feature requires an enterprise license with "document_sign_off_governance" enabled',
      statusCode: 403,
    }, 403));
    fireEvent.click(screen.getByTestId('governance-approve-btn'));

    const notice = await screen.findByRole('alert');
    expect(notice).toHaveAttribute('data-testid', 'governance-unlicensed');
    expect(notice.textContent).toMatch(/Enterprise licence/);
    expect(notice.textContent).toMatch(/stays frozen/i);
    expect(notice.textContent).not.toMatch(/refused/i);

    await settle();
    // The refused vote was the last governance request: no proposal re-read
    // on settle, and none from the now-disabled proposal query.
    expect(governanceCalls().at(-1)).toBe('/api/enterprise/pages/42/sign-off');
    expect(governanceCalls().filter((url) => url.endsWith('/sign-off'))).toHaveLength(1);

    // Restored licence (a new identity from `/admin/license`): the latch lets
    // go, the proposal is read again and the typed comment is still there.
    fetchMock.mockImplementation(async () => json({ proposal: PROPOSAL }));
    licence = { ...LICENCE, licenseId: 'CPQ9f8e7d6c', expiresAt: '2028-01-01' };
    const before = governanceCalls().length;
    view.rerenderSection();

    expect(await screen.findByTestId('governance-comment')).toHaveValue('checked pages 3-7');
    expect(screen.queryByTestId('governance-unlicensed')).toBeNull();
    await waitFor(() => {
      expect(governanceCalls().slice(before)).toEqual([`/api/enterprise/page-governance/proposals/${PROPOSAL_ID}`]);
    });
  });

  it('keeps the latch across a re-read of the same licence', async () => {
    fetchMock.mockImplementation(async () => json({
      error: 'EnterpriseRequired', reason: 'governance_license_required', message: 'licence', statusCode: 403,
    }, 403));
    const view = renderSection(GOVERNED);

    expect(await screen.findByTestId('governance-unlicensed')).toBeInTheDocument();
    // A routine token refresh re-reads an identical licence into a new object.
    licence = { ...LICENCE };
    view.rerenderSection();
    await settle();

    expect(screen.getByTestId('governance-unlicensed')).toBeInTheDocument();
    expect(governanceCalls()).toEqual([`/api/enterprise/page-governance/proposals/${PROPOSAL_ID}`]);
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
