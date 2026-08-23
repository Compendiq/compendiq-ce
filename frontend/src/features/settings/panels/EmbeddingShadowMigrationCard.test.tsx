import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { EmbeddingShadowMigrationCard } from './EmbeddingShadowMigrationCard';
import { useAuthStore } from '../../../stores/auth-store';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

let queryClient: QueryClient;
function renderCard(pending: { providerId: string; model: string } | null) {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <EmbeddingShadowMigrationCard pending={pending} />
    </QueryClientProvider>,
  );
}

// #1116 admin surface for the zero-downtime re-embed. Fetch is mocked at the
// network boundary; the card drives the real component logic.

beforeEach(() => {
  useAuthStore.getState().setAuth('t', { id: '1', username: 'admin', role: 'admin' });
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.warning).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  useAuthStore.getState().clearAuth();
});

const PENDING = { providerId: '2c0c8a92-98a8-4f8c-a6a1-000000000001', model: 'qwen3-embedding:4b' };

type Status = {
  active: boolean;
  migration: null | {
    phase: 'backfilling' | 'ready' | 'swapped' | 'aborting';
    model: string;
    dimensions: number;
    totalPages: number;
    backfilledPages: number;
    stragglerPages: number;
    indexed: boolean;
    indexReady: boolean;
    startedAt: string;
  };
};

function mockApi(status: Status, capture?: Array<{ url: string; method: string; body?: string }>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = init?.method ?? 'GET';
    capture?.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
    if (url.includes('/admin/embedding/shadow-migration') && method === 'GET') {
      return new Response(JSON.stringify(status), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/admin/embedding/shadow-migration')) {
      return new Response(JSON.stringify({ dimensions: 2560, pageCount: 42, jobId: 'shadow-reembed' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  });
}

describe('EmbeddingShadowMigrationCard (#1116)', () => {
  it('renders nothing with no pending change and no active migration', async () => {
    // Wait for the poll to actually SETTLE before asserting absence: the
    // pre-fetch render is null for every input, so an assertion that resolves
    // on the first synchronous tick passes no matter what the response says
    // (review r5).
    const fetchSpy = mockApi({ active: false, migration: null });
    const { container } = renderCard(null);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/zero-downtime|Backfill/i)).toBeNull());
    expect(container.querySelector('[data-testid="shadow-migration-card"]')).toBeNull();
  });

  it('estimates from progress it WATCHED, not from startedAt (review r9/r10)', async () => {
    // A re-run after a crashed worker leaves startedAt hours in the past with
    // the pages already done, so startedAt ÷ done divided idle time into the
    // work and advertised hundreds of hours for a run with minutes left.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-08-07T10:00:00.000Z')); // a full day after startedAt
    const statuses = [
      { phase: 'backfilling', model: 'm', dimensions: 1024, totalPages: 100, backfilledPages: 50, stragglerPages: 50, indexed: true, indexReady: false, startedAt: '2026-08-06T10:00:00.000Z' },
      { phase: 'backfilling', model: 'm', dimensions: 1024, totalPages: 100, backfilledPages: 60, stragglerPages: 40, indexed: true, indexReady: false, startedAt: '2026-08-06T10:00:00.000Z' },
    ];
    let call = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const body = { active: true, migration: statuses[Math.min(call++, statuses.length - 1)] };
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    });

    const { unmount } = renderCard(null);
    // First sample only establishes the baseline — no estimate yet, and in
    // particular not the ~24h-inflated one startedAt would have produced.
    expect(await screen.findByText(/50\/100/)).toBeInTheDocument();
    expect(screen.queryByText(/remaining/i)).toBeNull();

    // 10 pages watched over 60s → 40 remaining ≈ 4 min.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await screen.findByText(/4 min remaining/i)).toBeInTheDocument();
    unmount();
    vi.useRealTimers();

    // Pages done, index building: no page counter to extrapolate from, so it
    // names the phase rather than showing a countdown it cannot honour.
    mockApi({
      active: true,
      migration: { phase: 'backfilling', model: 'm', dimensions: 1024, totalPages: 100, backfilledPages: 100, stragglerPages: 0, indexed: true, indexReady: false, startedAt: '2026-08-06T10:00:00.000Z' },
    });
    renderCard(null);
    expect(await screen.findByText(/building the vector index/i)).toBeInTheDocument();
    expect(screen.queryByText(/remaining/i)).toBeNull();
  });

  it('warns instead of claiming an index when the dimension is past pgvector\'s indexable range (review r5)', async () => {
    // >4000 dimensions builds no HNSW index at all — telling the admin "the
    // new index is built" hides a post-swap sequential scan behind a Swap
    // button. 06-data-model.md names a real model in this tier.
    mockApi({
      active: true,
      migration: { phase: 'ready', model: 'qwen3-embedding:8b', dimensions: 4096, totalPages: 40, backfilledPages: 40, stragglerPages: 0, indexed: false, indexReady: true, startedAt: '2026-08-06T10:00:00.000Z' },
    });
    renderCard(null);

    expect(await screen.findByText(/no vector index/i)).toBeInTheDocument();
    expect(screen.getByText(/scan sequentially/i)).toBeInTheDocument();
    expect(screen.queryByText(/the new index is built/i)).toBeNull();
  });

  it('tells the parent to re-seed after a lifecycle action (review r7)', async () => {
    // Invalidating ['llm-usecases'] refetches the server state, but LlmTab
    // holds a local working copy behind a one-shot hydration guard — only
    // this callback drops it. Without it a swap re-raises the destructive
    // "model changed" banner over a migration that just succeeded.
    mockApi({
      active: true,
      migration: { phase: 'ready', model: 'qwen3-embedding:4b', dimensions: 2560, totalPages: 40, backfilledPages: 40, stragglerPages: 0, indexed: true, indexReady: true, startedAt: '2026-08-06T10:00:00.000Z' },
    });
    const onLifecycleChange = vi.fn();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <EmbeddingShadowMigrationCard pending={null} onLifecycleChange={onLifecycleChange} />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Swap to the new model/i }));

    await waitFor(() => expect(onLifecycleChange).toHaveBeenCalled());
  });

  it('lands focus on Cancel when the cleanup confirmation arms (review r5)', async () => {
    // Arming unmounts the focused button; without a deliberate move, focus
    // drops to <body> (WCAG 2.4.3) and the warning is never announced.
    mockApi({
      active: true,
      migration: { phase: 'swapped', model: 'qwen3-embedding:4b', dimensions: 2560, totalPages: 40, backfilledPages: 40, stragglerPages: 0, indexed: true, indexReady: true, startedAt: '2026-08-06T10:00:00.000Z' },
    });
    renderCard(null);

    fireEvent.click(await screen.findByRole('button', { name: /^Clean up$/i }));

    const cancel = await screen.findByRole('button', { name: /^Cancel$/i });
    expect(cancel).toHaveFocus();
    expect(screen.getByRole('alert')).toHaveTextContent(/permanently deletes/i);
  });

  it('offers the zero-downtime path for a pending model change and starts it', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    mockApi({ active: false, migration: null }, calls);
    renderCard(PENDING);

    const startBtn = await screen.findByRole('button', { name: /zero-downtime re-embed/i });
    fireEvent.click(startBtn);

    await waitFor(() => {
      const start = calls.find(
        (c) => c.method === 'POST' && c.url.includes('/admin/embedding/shadow-migration') && !c.url.match(/swap|rollback|cleanup|backfill/),
      );
      expect(start).toBeDefined();
      // The body is load-bearing: StartBodySchema requires the pair, so a
      // missing body is a 400 and no migration (review r1).
      expect(JSON.parse(start!.body ?? '{}')).toEqual(PENDING);
    });
  });

  it('shows backfill progress and an abort control while backfilling', async () => {
    mockApi({
      active: true,
      migration: { phase: 'backfilling', model: 'qwen3-embedding:4b', dimensions: 2560, totalPages: 40, backfilledPages: 10, stragglerPages: 30, indexed: true, indexReady: true, startedAt: '2026-08-06T10:00:00.000Z' },
    });
    renderCard(null);

    expect(await screen.findByTestId('shadow-migration-card')).toHaveTextContent('10/40');
    expect(screen.getByRole('button', { name: /abort/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^swap/i })).not.toBeInTheDocument();
  });

  it('does not claim search is unaffected — the backfill shares the provider (#1114)', async () => {
    // This card is the surface an operator watches WHILE the backfill runs, and
    // it used to say "Search is unaffected". Correctness is unaffected: the live
    // column serves every query and nothing is deleted before the swap.
    // Availability is not. `runShadowBackfillJob` embeds through the same
    // process-wide LLM queue as a user's question and holds one of
    // `LLM_CONCURRENCY`'s slots for the whole run, so query-embedding latency
    // rises throughout, and at `LLM_MAX_QUEUE_DEPTH` a query embed is rejected
    // into `degraded_reason: 'embedding_failed'` — keyword-only `/api/search`
    // and a refused `/llm/ask` turn. `docs/runbooks/shadow-reembed.md` says all
    // of that; a card contradicting the runbook it belongs to is the worse of
    // the two, because it is the one on screen while it is happening.
    mockApi({
      active: true,
      migration: { phase: 'backfilling', model: 'qwen3-embedding:4b', dimensions: 2560, totalPages: 40, backfilledPages: 10, stragglerPages: 30, indexed: true, indexReady: true, startedAt: '2026-08-06T10:00:00.000Z' },
    });
    renderCard(null);

    const card = await screen.findByTestId('shadow-migration-card');
    expect(card).not.toHaveTextContent(/unaffected/i);
    // Both halves, or the qualifier reads as "your results are wrong now".
    expect(card).toHaveTextContent(/keeps serving/i);
    expect(card).toHaveTextContent(/slower/i);
    // And it names the QUEUE, not the provider. The queue is one module-level
    // `pLimit` in the API process, so slot contention holds in every
    // configuration. Provider identity does not: the migration takes its own
    // `providerId` in the start body and the SWAP is what rewrites
    // `llm_usecase_assignments`, so during the backfill live query embeds can
    // resolve a different provider row entirely — on those instances a card
    // blaming the provider names a coupling that is not there, while the real
    // one goes unmentioned. The user-visible conclusion is the same either way.
    expect(card).toHaveTextContent(/shares the embedding queue with this backfill/i);
    expect(card).not.toHaveTextContent(/shares the provider/i);
  });

  it('enables the swap only when ready', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    mockApi(
      {
        active: true,
        migration: { phase: 'ready', model: 'qwen3-embedding:4b', dimensions: 2560, totalPages: 40, backfilledPages: 40, stragglerPages: 0, indexed: true, indexReady: true, startedAt: '2026-08-06T10:00:00.000Z' },
      },
      calls,
    );
    renderCard(null);

    const swapBtn = await screen.findByRole('button', { name: /^swap/i });
    fireEvent.click(swapBtn);
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.url.includes('/swap'))).toBe(true);
    });
  });

  it('after the swap, cleanup demands an explicit confirmation naming the loss', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    mockApi(
      {
        active: true,
        migration: { phase: 'swapped', model: 'qwen3-embedding:4b', dimensions: 2560, totalPages: 40, backfilledPages: 40, stragglerPages: 0, indexed: true, indexReady: true, startedAt: '2026-08-06T10:00:00.000Z' },
      },
      calls,
    );
    renderCard(null);

    fireEvent.click(await screen.findByRole('button', { name: /clean up/i }));
    // First click arms the confirmation — nothing is posted yet.
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/cleanup'))).toBe(false);
    expect(screen.getByText(/permanently deletes the old vectors/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /confirm cleanup/i }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.url.includes('/cleanup'))).toBe(true);
    });
  });

  it('offers a backfill re-run while stragglers remain (review r1)', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    mockApi(
      {
        active: true,
        migration: { phase: 'backfilling', model: 'qwen3-embedding:4b', dimensions: 2560, totalPages: 40, backfilledPages: 10, stragglerPages: 30, indexed: true, indexReady: true, startedAt: '2026-08-06T10:00:00.000Z' },
      },
      calls,
    );
    renderCard(null);

    fireEvent.click(await screen.findByRole('button', { name: /re-run backfill/i }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.url.includes('/backfill'))).toBe(true);
    });
  });

  it('an interrupted abort offers a retry (review r1)', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    mockApi(
      {
        active: true,
        migration: { phase: 'aborting', model: 'qwen3-embedding:4b', dimensions: 2560, totalPages: 0, backfilledPages: 0, stragglerPages: 0, indexed: true, indexReady: true, startedAt: '2026-08-06T10:00:00.000Z' },
      },
      calls,
    );
    renderCard(null);

    fireEvent.click(await screen.findByRole('button', { name: /retry abort/i }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.url.includes('/rollback'))).toBe(true);
    });
  });

  it('invalidates the assignments/settings caches after a lifecycle action (review r1)', async () => {
    mockApi({
      active: true,
      migration: { phase: 'ready', model: 'qwen3-embedding:4b', dimensions: 2560, totalPages: 40, backfilledPages: 40, stragglerPages: 0, indexed: true, indexReady: true, startedAt: '2026-08-06T10:00:00.000Z' },
    });
    renderCard(null);
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    fireEvent.click(await screen.findByRole('button', { name: /^swap/i }));

    await waitFor(() => {
      const keys = spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey?: unknown })?.queryKey));
      expect(keys).toContain(JSON.stringify(['llm-usecases']));
      expect(keys).toContain(JSON.stringify(['admin-settings']));
    });
  });

  it('offers rollback after the swap', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    mockApi(
      {
        active: true,
        migration: { phase: 'swapped', model: 'qwen3-embedding:4b', dimensions: 2560, totalPages: 40, backfilledPages: 40, stragglerPages: 0, indexed: true, indexReady: true, startedAt: '2026-08-06T10:00:00.000Z' },
      },
      calls,
    );
    renderCard(null);

    fireEvent.click(await screen.findByRole('button', { name: /roll back/i }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.url.includes('/rollback'))).toBe(true);
    });
  });

  // ── #1260 — the comparison section rides the lifecycle phases ──────────

  it('ready: offers Compare on real queries beside the swap', async () => {
    mockApi({
      active: true,
      migration: { phase: 'ready', model: 'qwen3-embedding:4b', dimensions: 2560, totalPages: 40, backfilledPages: 40, stragglerPages: 0, indexed: true, indexReady: true, startedAt: '2026-08-06T10:00:00.000Z' },
    });
    renderCard(null);
    expect(await screen.findByTestId('shadow-compare-section')).toBeInTheDocument();
    expect(screen.getByTestId('shadow-compare-start')).toBeEnabled();
  });

  it('backfilling: the compare control is ABSENT, with a muted sentence saying why (#1260)', async () => {
    mockApi({
      active: true,
      migration: { phase: 'backfilling', model: 'qwen3-embedding:4b', dimensions: 2560, totalPages: 40, backfilledPages: 10, stragglerPages: 30, indexed: true, indexReady: false, startedAt: '2026-08-06T10:00:00.000Z' },
    });
    renderCard(null);
    await screen.findByText(/10\/40/);
    // Absent, not disabled-with-no-reason: a dead button explains nothing.
    expect(screen.queryByTestId('shadow-compare-section')).toBeNull();
    expect(screen.queryByTestId('shadow-compare-start')).toBeNull();
    const note = screen.getByTestId('shadow-compare-locked');
    expect(note.textContent).toMatch(/backfill/i);
    expect(note.textContent).toMatch(/compar/i);
    // Muted, never amber — waiting is the normal state of a backfill.
    expect(note.className).toMatch(/muted/);
    expect(note.className).not.toMatch(/warning/);
  });

  it('swapped: the comparison window is over and the section is gone', async () => {
    mockApi({
      active: true,
      migration: { phase: 'swapped', model: 'qwen3-embedding:4b', dimensions: 2560, totalPages: 40, backfilledPages: 40, stragglerPages: 0, indexed: true, indexReady: true, startedAt: '2026-08-06T10:00:00.000Z' },
    });
    renderCard(null);
    await screen.findByRole('button', { name: /roll back/i });
    expect(screen.queryByTestId('shadow-compare-section')).toBeNull();
    expect(screen.queryByTestId('shadow-compare-locked')).toBeNull();
  });

  it('speaks for a comparison its own Abort ends, because the section that would have is unmounted by it (r3)', async () => {
    // Browser-verified failure: a comparison observed at 7/16, Abort pressed,
    // and within one 5s poll the section, its progress line and any error
    // strip were all gone — while the run failed server-side with "The shadow
    // migration changed while the comparison ran…" and nothing rendered it.
    // The section lives inside the `ready` branch, so the card is the only
    // surface left standing at that moment.
    const ready = {
      active: true,
      migration: {
        phase: 'ready' as const,
        model: 'qwen3-embedding:4b',
        dimensions: 2560,
        totalPages: 40,
        backfilledPages: 40,
        stragglerPages: 0,
        indexed: true,
        indexReady: true,
        startedAt: '2026-08-06T10:00:00.000Z',
      },
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = init?.method ?? 'GET';
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/compare/') && method === 'GET' && !url.includes('/judgements')) {
        return json({
          id: 'run-1',
          status: 'running',
          progressDone: 7,
          progressTotal: 16,
          error: null,
          result: null,
        });
      }
      if (url.endsWith('/compare') && method === 'POST') return json({ runId: 'run-1' }, 202);
      if (url.endsWith('/compare') && method === 'GET') return json({ run: null });
      if (url.includes('/judgements')) return json({ judgements: {}, verdict: null });
      if (url.includes('/shadow-migration') && method === 'GET') return json(ready);
      return json({});
    });
    renderCard(null);

    fireEvent.click(await screen.findByTestId('shadow-compare-start'));
    await screen.findByTestId('shadow-compare-progress');

    fireEvent.click(screen.getByRole('button', { name: /^Abort$/ }));
    await waitFor(() =>
      expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
        expect.stringMatching(/comparison in progress ended/i),
      ),
    );
    // The action itself still reports success — the comparison is collateral,
    // not a failure of the abort.
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Shadow migration aborted');
  });

  it('says nothing about a comparison when none was running', async () => {
    // A warning every abort carries is a warning every admin learns to skip.
    mockApi({
      active: true,
      migration: { phase: 'ready', model: 'qwen3-embedding:4b', dimensions: 2560, totalPages: 40, backfilledPages: 40, stragglerPages: 0, indexed: true, indexReady: true, startedAt: '2026-08-06T10:00:00.000Z' },
    });
    renderCard(null);
    fireEvent.click(await screen.findByRole('button', { name: /^Abort$/ }));
    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalled());
    expect(vi.mocked(toast.warning)).not.toHaveBeenCalled();
  });
});
