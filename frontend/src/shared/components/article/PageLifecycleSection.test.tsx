/**
 * Document lifecycle section (#277) at the network boundary.
 *
 * `fetch` is mocked; the component, its hooks and the query client are real.
 * Each case is about a claim the interface must not overstate: capability is
 * the server's to grant, a refusal explains itself where a person can reach
 * it, and a failed freeze keeps the operator's text.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageLifecycleState } from '@compendiq/contracts';
import { PageLifecycleSection } from './PageLifecycleSection';

vi.mock('../../enterprise/use-enterprise', () => ({
  useEnterprise: () => ({ isEnterprise: enterpriseMode, hasFeature: () => enterpriseMode }),
}));

let enterpriseMode = false;

const EDITABLE: PageLifecycleState = {
  isFrozen: false,
  baselineId: null,
  frozenVersion: null,
  frozenAt: null,
  frozenBy: null,
  frozenByName: null,
  freezeReason: null,
  provenance: null,
  contentRevision: '4',
  lifecycleRevision: '2',
  canFreeze: true,
  freezeDeniedReason: null,
  canUnfreeze: false,
  unfreezeDeniedReason: 'page_not_frozen',
  canApprove: false,
  approveDeniedReason: null,
  canMutateContent: true,
  mutateContentDeniedReason: null,
  governanceProposalStatus: null,
};

const FROZEN: PageLifecycleState = {
  ...EDITABLE,
  isFrozen: true,
  baselineId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  frozenVersion: 7,
  frozenAt: '2026-04-02T09:00:00.000Z',
  frozenBy: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  frozenByName: 'Dana Fox',
  freezeReason: 'Released to the regulator',
  provenance: 'manual_assertion',
  canFreeze: false,
  freezeDeniedReason: 'page_is_frozen',
  canUnfreeze: true,
  unfreezeDeniedReason: null,
  canMutateContent: false,
  mutateContentDeniedReason: 'page_is_frozen',
};

const PREVIEW = {
  baselineId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  pageId: 42,
  version: 7,
  contentRevision: '4',
  manifestVersion: 1 as const,
  manifestDigest: 'a'.repeat(64),
  attachments: [],
  totalBytes: 0,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderSection(page: PageLifecycleState | undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PageLifecycleSection pageId="42" page={page} />
    </QueryClientProvider>,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  enterpriseMode = false;
  fetchMock = vi.fn(async () => json({}));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PageLifecycleSection', () => {
  it('offers no action and says so when the lifecycle state could not be read', () => {
    renderSection(undefined);
    expect(screen.getByTestId('document-lifecycle')).toHaveTextContent('could not be read');
    expect(screen.queryByTestId('freeze-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('unfreeze-btn')).not.toBeInTheDocument();
  });

  it('withholds Freeze without the server capability and explains the refusal in reachable prose', () => {
    renderSection({ ...EDITABLE, canFreeze: false, freezeDeniedReason: 'freeze_busy' });
    expect(screen.queryByTestId('freeze-btn')).not.toBeInTheDocument();
    // Reachable text, not the `title` of a disabled control.
    const denied = screen.getByTestId('freeze-denied');
    expect(denied).toHaveTextContent('Someone is editing this article right now');
    expect(denied.tagName).toBe('P');
  });

  it('reports a frozen article without claiming anyone approved it', () => {
    renderSection(FROZEN);
    expect(screen.getByTestId('lifecycle-state')).toHaveTextContent('Frozen at v7');
    expect(screen.getByTestId('lifecycle-details')).toHaveTextContent('Dana Fox');
    // A manual assertion is never rendered as an approval.
    expect(screen.queryByTestId('lifecycle-provenance')).not.toBeInTheDocument();
    expect(screen.getByTestId('document-lifecycle')).not.toHaveTextContent('Approved by');
  });

  it('shows the authenticated-approval provenance only when the server recorded one', () => {
    renderSection({ ...FROZEN, provenance: 'authenticated_approval' });
    expect(screen.getByTestId('lifecycle-provenance')).toHaveTextContent('Authenticated approval');
  });

  it('keeps governance state out of community mode and shows it under Enterprise', () => {
    const governed = { ...EDITABLE, governanceProposalStatus: 'in_review' as const };
    const { unmount } = renderSection(governed);
    expect(screen.queryByTestId('lifecycle-governance')).not.toBeInTheDocument();
    unmount();

    enterpriseMode = true;
    renderSection(governed);
    expect(screen.getByTestId('lifecycle-governance')).toHaveTextContent('collecting approvals');
  });

  it('sends the previewed manifest identity and never freezes optimistically', async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes('/freeze-preview')) return json(PREVIEW);
      if (url.endsWith('/freeze')) return json({ state: FROZEN });
      return json({});
    });

    renderSection(EDITABLE);
    fireEvent.click(screen.getByTestId('freeze-btn'));
    await screen.findByTestId('freeze-preview');

    const dialog = screen.getByTestId('freeze-dialog');
    fireEvent.change(within(dialog).getByTestId('freeze-reason'), {
      target: { value: 'Released to the regulator' },
    });
    fireEvent.click(within(dialog).getByTestId('freeze-confirm'));

    await waitFor(() => {
      expect(requests.some((request) => request.url.endsWith('/freeze'))).toBe(true);
    });
    const freeze = requests.find((request) => request.url.endsWith('/freeze'))!;
    expect(freeze.body).toMatchObject({
      reason: 'Released to the regulator',
      expectedContentRevision: PREVIEW.contentRevision,
      expectedManifestDigest: PREVIEW.manifestDigest,
    });
    // The section renders the page prop it was given; the frozen state comes
    // from the re-read, never from the mutation returning.
    expect(screen.getByTestId('lifecycle-state')).toHaveTextContent('Editable');
  });

  it('keeps the entered reason and explains a stale preview instead of reporting success', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('/freeze-preview')) return json(PREVIEW);
      if (url.endsWith('/freeze')) {
        return json({ error: 'The page content changed after preview', reason: 'stale_manifest' }, 409);
      }
      return json({});
    });

    renderSection(EDITABLE);
    fireEvent.click(screen.getByTestId('freeze-btn'));
    await screen.findByTestId('freeze-preview');
    const dialog = screen.getByTestId('freeze-dialog');
    fireEvent.change(within(dialog).getByTestId('freeze-reason'), {
      target: { value: 'Released to the regulator' },
    });
    fireEvent.click(within(dialog).getByTestId('freeze-confirm'));

    const error = await screen.findByTestId('freeze-error');
    expect(error).toHaveTextContent('The article changed since this preview was taken');
    expect(error).toHaveTextContent('nothing was frozen');
    // The dialog stays open with the text intact — the operator retries, they
    // do not retype.
    expect(within(screen.getByTestId('freeze-dialog')).getByTestId('freeze-reason'))
      .toHaveValue('Released to the regulator');
  });

  it('tells the thaw dialog that the baseline survives and reports a refusal without unlocking', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/unfreeze')) {
        return json({ error: 'Freeze permission is required', reason: 'not_authorized' }, 403);
      }
      return json({});
    });

    renderSection(FROZEN);
    fireEvent.click(screen.getByTestId('unfreeze-btn'));
    const dialog = await screen.findByTestId('unfreeze-dialog');
    expect(dialog).toHaveTextContent('frozen baseline is kept exactly as it was');

    fireEvent.change(within(dialog).getByTestId('unfreeze-reason'), {
      target: { value: 'Correcting a factual error found after release' },
    });
    fireEvent.click(within(dialog).getByTestId('unfreeze-confirm'));

    const error = await screen.findByTestId('unfreeze-error');
    expect(error).toHaveTextContent('You do not have permission');
    expect(error).toHaveTextContent('still frozen');
    expect(screen.getByTestId('lifecycle-state')).toHaveTextContent('Frozen at v7');
  });

  it('mounts its live region before any update rather than inserting it with its first sentence', () => {
    renderSection(EDITABLE);
    const announcer = screen.getByTestId('lifecycle-announcer');
    expect(announcer).toHaveAttribute('role', 'status');
    expect(announcer).toHaveTextContent('');
  });

  it('returns focus to the control that opened a dismissed dialog', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('/freeze-preview')) return json(PREVIEW);
      return json({});
    });
    renderSection(EDITABLE);
    const opener = screen.getByTestId('freeze-btn');
    opener.focus();
    fireEvent.click(opener);
    await screen.findByTestId('freeze-dialog');

    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('freeze-dialog')).not.toBeInTheDocument());
    // The opener survives a dismissal, so focus belongs on it rather than on
    // `body` — a browser run caught this landing on `body` first.
    await waitFor(() => expect(screen.getByTestId('freeze-btn')).toHaveFocus());
  });
});
