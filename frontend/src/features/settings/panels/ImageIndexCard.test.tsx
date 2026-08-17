import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ImageIndexStatus } from '@compendiq/contracts';
import { ImageIndexCard } from './ImageIndexCard';
import { useAuthStore } from '../../../stores/auth-store';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

/**
 * #1115 P2 — the Embeddings-tab card.
 *
 * Fetch is mocked at the network boundary; the card runs its real logic. What
 * is pinned here is the copy that carries a CONSEQUENCE — re-scan, the model
 * change, and "this is not searchable yet" — plus the ADR-010 colour rule.
 *
 * That rule is THREE attention states, not one (review r2): a run with failed
 * images, a run with pages that could not be written, and an index whose
 * recorded identity is not the assigned pair. Each is something an operator has
 * to act on; everything else on the card is a measurement and renders neutral.
 * Each of the three is pinned for its colour as well as its words, because a
 * de-coloured amber and an absent one are the same assertion to a text test.
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
  kickResult: { marked?: number; started: boolean; alreadyRunning: boolean } = {
    marked: 120,
    started: true,
    alreadyRunning: false,
  },
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
    return new Response(JSON.stringify(kickResult), {
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
  // The `sonner` mock is module-level, so its call history outlives a test and
  // a "did not toast X" assertion would pass or fail on what ran before it.
  vi.clearAllMocks();
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

  it('points at the switch that turns the retrieval leg on (#1115 P3)', async () => {
    // This sentence used to say image search was not live yet. P3 landed the
    // leg, so that became false — the card now names where the leg is turned
    // on rather than denying it exists.
    mockApi(ASSIGNED);
    renderCard();
    const note = await screen.findByTestId('image-index-retrieval-note');
    expect(note.textContent).toMatch(/third retrieval leg/i);
    // The FULL panel chain, not a bare "under Retrieval" (review r2):
    // `settings-wayfinding.test.ts` only polices a pointer that starts
    // `Settings →`, so a naked tab name is a signpost no guard can check and
    // no reader can follow from another panel.
    expect(note.textContent).toMatch(/Settings → AI Models → Retrieval/);
    expect(note.textContent).not.toMatch(/not live yet/i);
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
    // …and WHERE that control lives (review r4). This card is on the Embeddings
    // tab and the Re-check button is on another panel entirely, so naming the
    // control without naming the panel leaves the operator hunting; the
    // not-assigned line one paragraph up already spells the same chain, and
    // `settings-wayfinding.test.ts` fails if either stops matching the rail.
    expect(note.textContent).toMatch(/Settings → AI Models → LLM providers/);
    // The third attention state, pinned for its colour like the other two
    // (review r2: it was the one of the three with no colour assertion).
    expect(note.className).toMatch(/text-warning/);
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
    // Amber, and pinned as amber: this is the second of the card's three
    // attention states, and a text-only assertion cannot tell a de-coloured
    // one from a missing one.
    expect(pages.className).toMatch(/text-warning/);
  });

  /**
   * Review r2 — the card must not report a scan that did not start.
   *
   * The POST answers `alreadyRunning` when the worker lock is already held.
   * Toasting "scan started" then is wrong twice: nothing started, and the
   * running scan walks a LIMIT/OFFSET window over a result set the Re-scan just
   * grew, so the pages it marked may need a second press.
   */
  describe('a trigger that lands on a running scan', () => {
    it('does not claim a Re-scan started, and names the second press', async () => {
      mockApi(ASSIGNED, undefined, undefined, { marked: 40, started: false, alreadyRunning: true });
      renderCard();
      await awaitLoaded();

      fireEvent.click(screen.getByTestId('image-index-rescan'));

      await waitFor(() => expect(vi.mocked(toast.message)).toHaveBeenCalled());
      const said = vi.mocked(toast.message).mock.calls.at(-1)?.[0] as string;
      // The half that DID happen is still reported…
      expect(said).toMatch(/40 pages/);
      // …and so is the reason it may not be enough.
      expect(said).toMatch(/already running/i);
      expect(said).toMatch(/Process now/);
      expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    });

    it('does not claim a Process now started', async () => {
      mockApi(ASSIGNED, undefined, undefined, { started: false, alreadyRunning: true });
      renderCard();
      await awaitLoaded();

      fireEvent.click(screen.getByTestId('image-index-process'));

      await waitFor(() =>
        expect(vi.mocked(toast.message)).toHaveBeenCalledWith(
          expect.stringMatching(/already running/i),
        ),
      );
      expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    });

    it('still reports a real start as a success', async () => {
      // The pin that keeps the two above honest: a card that never toasts a
      // success passes them without ever having distinguished the two answers.
      mockApi(ASSIGNED);
      renderCard();
      await awaitLoaded();

      fireEvent.click(screen.getByTestId('image-index-process'));

      await waitFor(() =>
        expect(vi.mocked(toast.success)).toHaveBeenCalledWith(expect.stringMatching(/started/i)),
      );
      expect(vi.mocked(toast.message)).not.toHaveBeenCalled();
    });
  });

  it('keeps polling after a kick even when the lock is not held yet', async () => {
    // `running` is read from the worker lock, and the POST answers BEFORE the
    // detached scan takes it. Arming the interval solely from the one post-kick
    // refetch therefore loses a race the client cannot see: the card freezes on
    // pre-scan counters, with both buttons live, until a remount.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls: Array<{ url: string; method: string }> = [];
    // Every GET says the lock is free — the exact payload that used to stop
    // the card polling for good.
    mockApi({ ...ASSIGNED, running: false }, calls);
    renderCard();
    await awaitLoaded();

    fireEvent.click(screen.getByTestId('image-index-process'));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST')).toBe(true),
    );
    const afterKick = calls.filter((c) => c.method === 'GET').length;

    await vi.advanceTimersByTimeAsync(11_000);

    expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThan(afterKick);
  });

  it('stops the warm-up polling rather than running forever', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls: Array<{ url: string; method: string }> = [];
    mockApi({ ...ASSIGNED, running: false }, calls);
    renderCard();
    await awaitLoaded();

    fireEvent.click(screen.getByTestId('image-index-process'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));

    // Past the warm-up window, with every payload still reporting a free lock.
    await vi.advanceTimersByTimeAsync(30_000);
    const settled = calls.filter((c) => c.method === 'GET').length;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(calls.filter((c) => c.method === 'GET').length).toBe(settled);
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
