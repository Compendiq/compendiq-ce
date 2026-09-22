/**
 * Retained baseline history (#277) at the network boundary.
 *
 * The subject is what this list is allowed to claim: a recorded transition,
 * the server's immutable actor snapshot, and names the freezing person typed
 * — which are never rendered as agreement collected from those people.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageFreezeHistoryEntry } from '@compendiq/contracts';
import { PageBaselineHistory } from './PageBaselineHistory';

const DIGEST = 'b'.repeat(64);

const ENTRY: PageFreezeHistoryEntry = {
  id: '44444444-4444-4444-8444-444444444444',
  action: 'freeze',
  baselineId: '55555555-5555-4555-8555-555555555555',
  pageId: 42,
  version: 7,
  manifestDigest: DIGEST,
  contentRevision: '9',
  lifecycleRevision: '3',
  reason: 'Released to the regulator',
  actorId: '66666666-6666-4666-8666-666666666666',
  actorName: 'Dana Fox',
  provenance: 'manual_assertion',
  reportedSignatories: [{ displayName: 'Ana Ruiz' }],
  reportedReference: 'CR-1188',
  createdAt: '2026-04-02T09:00:00.000Z',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderHistory() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PageBaselineHistory pageId="42" />
    </QueryClientProvider>,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => json({ entries: [ENTRY], nextCursor: null }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('baseline history', () => {
  it('reads nothing until the disclosure is opened', () => {
    renderHistory();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('baseline-history-toggle')).toHaveAttribute('aria-expanded', 'false');
  });

  it('states the transition, the actor and the reason', async () => {
    renderHistory();
    fireEvent.click(screen.getByTestId('baseline-history-toggle'));

    const entry = await screen.findByTestId('baseline-history-entry');
    expect(entry.textContent).toContain('Frozen at v7');
    expect(entry.textContent).toContain('Dana Fox');
    expect(entry.textContent).toContain('Released to the regulator');
  });

  it('keeps a manual assertion out of approval wording and labels typed names as reported', async () => {
    renderHistory();
    fireEvent.click(screen.getByTestId('baseline-history-toggle'));

    const entry = await screen.findByTestId('baseline-history-entry');
    expect(entry.textContent).not.toMatch(/authenticated approval/i);
    const signatories = screen.getByTestId('baseline-history-signatories');
    expect(signatories.textContent).toContain('Ana Ruiz');
    expect(signatories.textContent).toMatch(/not verified agreement/i);
  });

  it('renders a deleted actor’s retained display name rather than inventing one', async () => {
    fetchMock.mockImplementation(async () => json({
      entries: [{ ...ENTRY, actorId: null, actorName: 'Dana Fox (deleted)' }],
      nextCursor: null,
    }));
    renderHistory();
    fireEvent.click(screen.getByTestId('baseline-history-toggle'));

    const entry = await screen.findByTestId('baseline-history-entry');
    expect(entry.textContent).toContain('Dana Fox (deleted)');
    expect(entry.textContent).not.toMatch(/unknown/i);
  });

  it('renders a free-text reference as text, never as a link', async () => {
    renderHistory();
    fireEvent.click(screen.getByTestId('baseline-history-toggle'));

    const reference = await screen.findByTestId('baseline-history-reference');
    expect(reference.textContent).toContain('CR-1188');
    expect(reference.querySelector('a')).toBeNull();
  });

  it('appends the next page and drops the control at the end of the evidence', async () => {
    fetchMock.mockImplementationOnce(async () => json({ entries: [ENTRY], nextCursor: 'cursor-2' }));
    fetchMock.mockImplementationOnce(async () => json({
      entries: [{ ...ENTRY, id: '77777777-7777-4777-8777-777777777777', action: 'thaw' as const }],
      nextCursor: null,
    }));
    renderHistory();
    fireEvent.click(screen.getByTestId('baseline-history-toggle'));

    fireEvent.click(await screen.findByTestId('baseline-history-more'));
    await waitFor(() => {
      expect(screen.getAllByTestId('baseline-history-entry')).toHaveLength(2);
    });
    expect(screen.queryByTestId('baseline-history-more')).toBeNull();
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('cursor=cursor-2');
  });

  it('reports a failed read as a failure, not as an article that was never frozen', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'boom' }, 500));
    renderHistory();
    fireEvent.click(screen.getByTestId('baseline-history-toggle'));

    expect(await screen.findByTestId('baseline-history-error')).toBeInTheDocument();
    expect(screen.queryByTestId('baseline-history-empty')).toBeNull();
  });
});
