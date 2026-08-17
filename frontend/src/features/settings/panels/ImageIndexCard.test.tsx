import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ImageIndexStatus } from '@compendiq/contracts';
import { ImageIndexCard } from './ImageIndexCard';
import { useAuthStore } from '../../../stores/auth-store';

/**
 * #1115 P2 — the Embeddings-tab card.
 *
 * Fetch is mocked at the network boundary; the card runs its real logic. What
 * is pinned here is the copy that carries a CONSEQUENCE — re-scan, the model
 * change, and "this is not searchable yet" — plus the ADR-010 colour rule: a
 * failed last run is the only thing on this card allowed to be amber, because
 * it is the only thing that is genuinely attention-worthy.
 */

let queryClient: QueryClient;

function renderCard() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ImageIndexCard />
    </QueryClientProvider>,
  );
}

const NO_SKIPS = { missing: 0, unsupported: 0, oversized: 0, tooLarge: 0, capped: 0, external: 0 };

const ASSIGNED: ImageIndexStatus = {
  assigned: true,
  identity: {
    providerId: '00000000-0000-4000-8000-000000000001',
    model: 'Qwen/Qwen3-VL-Embedding-2B',
    dimensions: 2048,
    tier: 'halfvec',
  },
  identityMatchesAssignment: true,
  rows: 42,
  pagesDirty: 3,
  pagesTotal: 120,
  running: false,
  lastRun: null,
};

function mockApi(
  status: ImageIndexStatus,
  capture?: Array<{ url: string; method: string }>,
  sequence?: ImageIndexStatus[],
) {
  let call = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = init?.method ?? 'GET';
    capture?.push({ url, method });
    if (url.includes('/admin/embedding/image-index') && method === 'GET') {
      const body = sequence ? (sequence[Math.min(call++, sequence.length - 1)] ?? status) : status;
      return new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ marked: 120, started: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

/** Every GET on this route fails; POSTs still succeed. */
function mockApiFailingStatus(capture?: Array<{ url: string; method: string }>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = init?.method ?? 'GET';
    capture?.push({ url, method });
    if (url.includes('/admin/embedding/image-index') && method === 'GET') {
      return new Response(JSON.stringify({ message: 'boom' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ marked: 120, started: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

/**
 * Wait for the STATUS to have arrived, not merely for the card to exist.
 *
 * Every element here renders on the first paint, so a bare `findByTestId`
 * resolves against the pre-fetch render and an assertion built on it passes
 * whatever the response says — the `EmbeddingShadowMigration` card's review-r5
 * trap, reached from the other direction. The pending paint shows `—` for
 * every number (review r1: a number the server has not sent is not a zero), so
 * that is what this waits out.
 */
async function awaitLoaded(): Promise<void> {
  await waitFor(() =>
    expect(screen.getByTestId('image-index-counters').textContent).not.toContain('—'),
  );
}

beforeEach(() => {
  useAuthStore.getState().setAuth('t', { id: '1', username: 'admin', role: 'admin' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  useAuthStore.getState().clearAuth();
});

describe('ImageIndexCard (#1115 P2)', () => {
  it('states the width, the tier and the model on one status line', async () => {
    mockApi(ASSIGNED);
    renderCard();
    await awaitLoaded();
    const status = screen.getByTestId('image-index-status');
    expect(status.textContent).toContain('2048-dim');
    expect(status.textContent).toContain('halfvec HNSW');
    expect(status.textContent).toContain('Qwen/Qwen3-VL-Embedding-2B');
  });

  it('points an unassigned instance at the row that switches the leg on', async () => {
    mockApi({ ...ASSIGNED, assigned: false, identity: null });
    renderCard();
    await awaitLoaded();
    const status = screen.getByTestId('image-index-status');
    expect(status.textContent).toMatch(/not assigned/i);
    expect(status.textContent).toMatch(/LLM providers/i);
  });

  it('reports the counters, so a low row count is explainable', async () => {
    mockApi(ASSIGNED);
    renderCard();
    await awaitLoaded();
    const counters = screen.getByTestId('image-index-counters');
    expect(counters.textContent).toContain('42');
    expect(counters.textContent).toContain('3');
  });

  it('names the consequence of Re-scan beside the control, not in a tooltip', async () => {
    // #1119's rule: a caveat that lives only in a `title` is unreachable by
    // touch, keyboard and screen readers.
    mockApi(ASSIGNED);
    renderCard();
    const note = await screen.findByTestId('image-index-rescan-note');
    expect(note.textContent).toMatch(/marks every page/i);
    expect(note.textContent).toMatch(/reused by content hash/i);
    expect(note.getAttribute('title')).toBeNull();
  });

  it('states that a model change empties and rebuilds the index, and spares text search', async () => {
    mockApi(ASSIGNED);
    renderCard();
    const note = await screen.findByTestId('image-index-model-change-note');
    expect(note.textContent).toMatch(/empties and rebuilds/i);
    expect(note.textContent).toMatch(/text search is unaffected/i);
  });

  it('says image search is not live yet in this release', async () => {
    // P3 has not landed. The card exists to explain an index nothing reads.
    mockApi(ASSIGNED);
    renderCard();
    const note = await screen.findByTestId('image-index-not-live-note');
    expect(note.textContent).toMatch(/not live yet/i);
  });

  it('Process now POSTs the process route', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    mockApi(ASSIGNED, calls);
    renderCard();
    await awaitLoaded();
    fireEvent.click(screen.getByTestId('image-index-process'));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.url.endsWith('/admin/embedding/image-index/process')),
      ).toBe(true),
    );
  });

  it('Re-scan all POSTs the rescan route', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    mockApi(ASSIGNED, calls);
    renderCard();
    await awaitLoaded();
    fireEvent.click(screen.getByTestId('image-index-rescan'));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.url.endsWith('/admin/embedding/image-index/rescan')),
      ).toBe(true),
    );
  });

  it('disables both actions while the leg is unassigned', async () => {
    // Neither does anything: the worker's own fast path answers "unassigned"
    // and clears nothing, so a live button would be a control that reports
    // success for work that never starts.
    mockApi({ ...ASSIGNED, assigned: false, identity: null });
    renderCard();
    await awaitLoaded();
    expect((screen.getByTestId('image-index-process') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('image-index-rescan') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables both actions once the leg IS assigned', async () => {
    // The pin that keeps the previous test honest: every control on this card
    // renders disabled on the pre-fetch paint, so "disabled when unassigned"
    // passes against a card that is permanently dead.
    mockApi(ASSIGNED);
    renderCard();
    await awaitLoaded();
    expect((screen.getByTestId('image-index-process') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('image-index-rescan') as HTMLButtonElement).disabled).toBe(false);
  });

  it('polls while a run is in progress and stops once it finishes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls: Array<{ url: string; method: string }> = [];
    mockApi(ASSIGNED, calls, [
      { ...ASSIGNED, running: true },
      { ...ASSIGNED, running: true },
      { ...ASSIGNED, running: false, rows: 60 },
    ]);
    renderCard();
    await screen.findByTestId('image-index-status');

    const before = calls.filter((c) => c.method === 'GET').length;
    // One whole 5s interval (the cadence is deliberately not 3s — see the
    // rate-limit test below).
    await vi.advanceTimersByTimeAsync(6_000);
    const during = calls.filter((c) => c.method === 'GET').length;
    expect(during).toBeGreaterThan(before);

    // Settled: the third response says `running: false`, so the interval stops.
    await vi.advanceTimersByTimeAsync(6_000);
    await waitFor(() => expect(screen.queryByTestId('image-index-running')).toBeNull());
    const settled = calls.filter((c) => c.method === 'GET').length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.filter((c) => c.method === 'GET').length).toBe(settled);
  });

  it('renders a successful last run in neutral chips, with no amber anywhere', async () => {
    // ADR-010: measurements are neutral. A run that embedded 20 images is a
    // measurement, and amber is reserved for attention.
    const { container } = (() => {
      mockApi({
        ...ASSIGNED,
        lastRun: {
          at: '2026-08-17T10:00:00.000Z',
          pages: 12,
          embedded: 20,
          reused: 5,
          removed: 1,
          failed: 0,
          pagesFailed: 0,
          skipped: { ...NO_SKIPS, unsupported: 2, capped: 3 },
        },
      });
      return renderCard();
    })();
    const run = await screen.findByTestId('image-index-last-run');
    await awaitLoaded();
    expect(run.textContent).toContain('20');
    expect(run.textContent).toMatch(/unsupported/i);
    expect(run.textContent).toMatch(/capped/i);
    expect(container.innerHTML).not.toMatch(/warning/);
  });

  it('renders a FAILED last run in amber — the one attention-worthy state here', async () => {
    const { container } = (() => {
      mockApi({
        ...ASSIGNED,
        lastRun: {
          at: '2026-08-17T10:00:00.000Z',
          pages: 12,
          embedded: 0,
          reused: 0,
          removed: 0,
          failed: 4,
          pagesFailed: 0,
          skipped: NO_SKIPS,
        },
      });
      return renderCard();
    })();
    const failed = await screen.findByTestId('image-index-last-run-failed');
    expect(failed.textContent).toContain('4');
    expect(container.innerHTML).toMatch(/warning/);
  });

  /**
   * #1115 P2 review r1 — a failed FETCH is a failure, not an unassigned leg.
   *
   * CLAUDE.md's `usePageTree` rule, on a different surface: reading `{ data }`
   * alone collapsed a 500 into the not-assigned state, so an admin whose leg
   * IS assigned was told to go and assign it, and both remedies were disabled
   * on the one surface that reports the index.
   */
  describe('a failed status read', () => {
    it('does not claim the leg is unassigned', async () => {
      mockApiFailingStatus();
      renderCard();

      const status = await screen.findByTestId('image-index-status');
      await waitFor(() => expect(status.textContent).toMatch(/could not be read/i));
      expect(status.textContent).not.toMatch(/not assigned/i);
      // …and it says what is NOT affected, so nobody goes looking for a
      // destroyed index.
      expect(status.textContent).toMatch(/assignment and the stored index are unaffected/i);
    });

    it('takes the destructive treatment, not amber — it is a failure, not a warning', async () => {
      const { container } = (() => {
        mockApiFailingStatus();
        return renderCard();
      })();
      await waitFor(() =>
        expect(screen.getByTestId('image-index-status').textContent).toMatch(/could not be read/i),
      );
      expect(screen.getByTestId('image-index-status').className).toMatch(/text-destructive/);
      expect(container.innerHTML).not.toMatch(/text-warning/);
    });

    it('leaves both remedies live, because they are the recovery', async () => {
      const calls: Array<{ url: string; method: string }> = [];
      mockApiFailingStatus(calls);
      renderCard();
      await waitFor(() =>
        expect(screen.getByTestId('image-index-status').textContent).toMatch(/could not be read/i),
      );

      expect((screen.getByTestId('image-index-process') as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(screen.getByTestId('image-index-process'));
      await waitFor(() =>
        expect(
          calls.some((c) => c.method === 'POST' && c.url.endsWith('/admin/embedding/image-index/process')),
        ).toBe(true),
      );
    });

    it('shows no invented zeroes while the first read is in flight', async () => {
      // A number the server has not sent is not a zero: `0 rows` on a healthy
      // index is exactly the reading that sends an operator to the runbook.
      mockApi(ASSIGNED);
      renderCard();
      expect(screen.getByTestId('image-index-counters').textContent).toContain('—');
      await awaitLoaded();
      expect(screen.getByTestId('image-index-counters').textContent).toContain('42');
    });
  });

  it('flags an index built for a different model than the one assigned now', async () => {
    // The guarded-DDL branch: the assignment saved, the `ALTER` did not, so
    // the status line names a model and a width that belong to different
    // things. Amber, like a failed run — the operator has to press Re-check.
    mockApi({ ...ASSIGNED, identityMatchesAssignment: false });
    renderCard();
    await awaitLoaded();

    const note = await screen.findByTestId('image-index-identity-mismatch');
    expect(note.textContent).toMatch(/different model or endpoint/i);
    expect(note.textContent).toMatch(/Re-check/);
  });

  it('says nothing about the identity when it matches', async () => {
    mockApi(ASSIGNED);
    renderCard();
    await awaitLoaded();
    expect(screen.queryByTestId('image-index-identity-mismatch')).toBeNull();
  });

  it('says nothing about the identity when there is nothing to compare', async () => {
    // A fresh install has recorded no identity at all; that is not a mismatch,
    // and rendering one would put a permanent amber strip on every new
    // deployment — which is how the reserved colour stops meaning anything.
    mockApi({ ...ASSIGNED, identityMatchesAssignment: null });
    renderCard();
    await awaitLoaded();
    expect(screen.queryByTestId('image-index-identity-mismatch')).toBeNull();
  });

  it('reports pages that could not be WRITTEN separately from images that failed to embed', async () => {
    // Different outages, different remedies: an image failure is the provider,
    // a page failure is the index. Reporting one as the other sends the
    // operator to the wrong place.
    mockApi({
      ...ASSIGNED,
      lastRun: {
        at: '2026-08-17T10:00:00.000Z',
        pages: 6,
        embedded: 0,
        reused: 0,
        removed: 0,
        failed: 0,
        pagesFailed: 6,
        skipped: NO_SKIPS,
      },
    });
    renderCard();
    await awaitLoaded();

    expect(screen.queryByTestId('image-index-last-run-failed')).toBeNull();
    const pages = screen.getByTestId('image-index-last-run-pages-failed');
    expect(pages.textContent).toContain('6');
    expect(pages.textContent).toMatch(/stay queued/i);
  });

  it('polls no faster than the admin rate limit allows', async () => {
    // 20/min is the per-route admin bucket, so a 3s interval sits exactly at
    // it — before the mount fetch and before the invalidate every button press
    // fires. With `retry: false` a 429 then freezes the card on stale counters
    // with both buttons disabled and no error shown.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls: Array<{ url: string; method: string }> = [];
    mockApi({ ...ASSIGNED, running: true }, calls);
    renderCard();
    await screen.findByTestId('image-index-status');
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThan(0));

    const before = calls.filter((c) => c.method === 'GET').length;
    await vi.advanceTimersByTimeAsync(60_000);
    const perMinute = calls.filter((c) => c.method === 'GET').length - before;

    expect(perMinute).toBeLessThan(20);
  });
});
