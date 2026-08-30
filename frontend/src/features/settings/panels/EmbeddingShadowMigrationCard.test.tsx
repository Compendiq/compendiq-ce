import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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

  it('tells the operator not to save the assignment first', async () => {
    mockApi({ active: false, migration: null });
    renderCard(PENDING);
    const card = await screen.findByTestId('shadow-migration-card');
    expect(card).toHaveTextContent(/do not save the assignment/i);
    expect(card).toHaveTextContent(/start re-embed/i);
    expect(card.textContent ?? '').not.toMatch(/new vectors will not fit the current index/i);
    expect(card).not.toHaveAttribute('role', 'status');
    expect(screen.getByRole('button', { name: /^Start re-embed$/i })).toHaveClass('nm-button-primary');
  });

  it('offers the zero-downtime path for a pending model change and starts it', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    mockApi({ active: false, migration: null }, calls);
    renderCard(PENDING);

    const startBtn = await screen.findByRole('button', { name: /^Start re-embed$/i });
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

  it('speaks for a comparison ended by a migration change made ELSEWHERE (r1)', async () => {
    // The from-another-tab case, which no code path covered: the card's own 5s
    // status poll flips the branch with no POST involved, the `ready` branch
    // and the whole compare section go with it, and the section's compensating
    // toast requires observing `failed` while still mounted — which it loses,
    // because the server only fails the run at its next query boundary, one or
    // more polls later. The comparison then died with no notice on any
    // surface, and the pair-scoped re-attachment cannot recover it by design.
    const migration = {
      phase: 'ready' as const,
      model: 'qwen3-embedding:4b',
      dimensions: 2560,
      totalPages: 40,
      backfilledPages: 40,
      stragglerPages: 0,
      indexed: true,
      indexReady: true,
      startedAt: '2026-08-06T10:00:00.000Z',
    };
    let phase: 'ready' | 'swapped' = 'ready';
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = init?.method ?? 'GET';
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/compare/') && method === 'GET' && !url.includes('/judgements')) {
        return json({ id: 'run-1', status: 'running', progressDone: 7, progressTotal: 16, error: null, result: null });
      }
      if (url.endsWith('/compare') && method === 'POST') return json({ runId: 'run-1' }, 202);
      if (url.endsWith('/compare') && method === 'GET') return json({ run: null });
      if (url.includes('/judgements')) return json({ judgements: {}, verdict: null });
      if (url.includes('/shadow-migration') && method === 'GET') {
        return json({ active: true, migration: { ...migration, phase } });
      }
      return json({});
    });
    renderCard(null);

    fireEvent.click(await screen.findByTestId('shadow-compare-start'));
    await screen.findByTestId('shadow-compare-progress');

    // Another tab swaps. Nothing on THIS card was pressed — only the card's
    // own 5s status poll observes it.
    phase = 'swapped';
    await vi.advanceTimersByTimeAsync(6_000);
    expect(screen.queryByTestId('shadow-compare-section')).toBeNull();
    await waitFor(() =>
      expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
        expect.stringMatching(/comparison in progress ended/i),
      ),
    );
    // Once — the poll keeps answering the new phase.
    await vi.advanceTimersByTimeAsync(12_000);
    expect(vi.mocked(toast.warning).mock.calls).toHaveLength(1);
    vi.useRealTimers();
  });

  it('warns on an Abort pressed before the first status poll answers (r1)', async () => {
    // The window between the compare POST's 202 and its first GET. The shipped
    // guard stepped past it by awaiting the progress line, which is the very
    // thing that used to arm the report.
    const migration = {
      phase: 'ready' as const,
      model: 'qwen3-embedding:4b',
      dimensions: 2560,
      totalPages: 40,
      backfilledPages: 40,
      stragglerPages: 0,
      indexed: true,
      indexReady: true,
      startedAt: '2026-08-06T10:00:00.000Z',
    };
    let releasePoll = () => {};
    const gate = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = init?.method ?? 'GET';
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/compare/') && method === 'GET' && !url.includes('/judgements')) {
        await gate;
        return json({ id: 'run-1', status: 'running', progressDone: 1, progressTotal: 16, error: null, result: null });
      }
      if (url.endsWith('/compare') && method === 'POST') return json({ runId: 'run-1' }, 202);
      if (url.endsWith('/compare') && method === 'GET') return json({ run: null });
      if (url.includes('/judgements')) return json({ judgements: {}, verdict: null });
      if (url.includes('/shadow-migration') && method === 'GET') return json({ active: true, migration });
      return json({});
    });
    renderCard(null);

    fireEvent.click(await screen.findByTestId('shadow-compare-start'));
    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Comparison started'));
    fireEvent.click(screen.getByRole('button', { name: /^Abort$/ }));
    await waitFor(() =>
      expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
        expect.stringMatching(/comparison in progress ended/i),
      ),
    );
    releasePoll();
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

  it('does NOT report an ending when a straggler drops the phase back to backfilling (r2)', async () => {
    // The card's ending signal used to key on leaving the `ready` PHASE, but
    // the server ends a run on the migration FINGERPRINT
    // (`status:startedAt:swappedAt:revertedAt`). `phase` is recomputed from a
    // LIVE straggler count on every poll, so a page whose shadow embed failed
    // mid-window flips ready → backfilling with the state row untouched: the
    // comparison is still running, still holds the one-active slot, and the
    // card told the admin it had ended and to start another one — which the
    // compare route's own 409 then refuses.
    const migration = {
      model: 'qwen3-embedding:4b',
      dimensions: 2560,
      totalPages: 40,
      backfilledPages: 40,
      stragglerPages: 0,
      indexed: true,
      indexReady: true,
      startedAt: '2026-08-06T10:00:00.000Z',
    };
    let phase: 'ready' | 'backfilling' = 'ready';
    let stragglers = 0;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = init?.method ?? 'GET';
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      const running = { id: 'run-1', status: 'running', progressDone: 7, progressTotal: 16, error: null, result: null };
      if (url.includes('/compare/') && method === 'GET' && !url.includes('/judgements')) return json(running);
      if (url.endsWith('/compare') && method === 'POST') return json({ runId: 'run-1' }, 202);
      // The re-attachment lookup answers the live run, which is how the
      // section adopts it again once `ready` returns.
      if (url.endsWith('/compare') && method === 'GET') return json({ run: running });
      if (url.includes('/judgements')) return json({ judgements: {}, verdict: null });
      if (url.includes('/shadow-migration') && method === 'GET') {
        return json({ active: true, migration: { ...migration, phase, stragglerPages: stragglers, backfilledPages: 40 - stragglers, indexReady: phase === 'ready' } });
      }
      return json({});
    });
    renderCard(null);

    fireEvent.click(await screen.findByTestId('shadow-compare-start'));
    await screen.findByTestId('shadow-compare-progress');

    // A straggler reappears. No swap, no abort, no rollback — the run is
    // untouched.
    phase = 'backfilling';
    stragglers = 1;
    await vi.advanceTimersByTimeAsync(6_000);
    await waitFor(() => expect(screen.queryByTestId('shadow-compare-section')).toBeNull());
    expect(vi.mocked(toast.warning)).not.toHaveBeenCalled();
    expect(screen.queryByTestId('shadow-compare-ended')).toBeNull();
    // And the locked sentence must not claim comparing is merely "not yet
    // possible" while one is running behind it.
    const note = screen.getByTestId('shadow-compare-locked');
    expect(note.textContent).toMatch(/still running/i);

    // Re-run backfill is the ONE control in this branch that does not end the
    // migration window — it leaves `status:startedAt:swappedAt:revertedAt`
    // untouched, so the comparison keeps going. It is also the button a
    // path-blind `endsMigrationWindow` would fire on, in exactly the state
    // this test has already built: `backfilling`, with the run still in
    // flight.
    fireEvent.click(screen.getByRole('button', { name: /re-run backfill/i }));
    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalled());
    expect(vi.mocked(toast.warning)).not.toHaveBeenCalled();
    expect(screen.queryByTestId('shadow-compare-ended')).toBeNull();
    expect(screen.getByTestId('shadow-compare-locked').textContent).toMatch(/still running/i);

    // Backfill catches up: the section re-adopts the run it never lost.
    phase = 'ready';
    stragglers = 0;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await screen.findByTestId('shadow-compare-progress')).toHaveTextContent('7/16');
    expect(vi.mocked(toast.warning)).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('reports ONE ending when the POST and the poll both observe it (r2)', async () => {
    // `post()` snapshots the in-flight id BEFORE its request; the 5s status
    // poll can raise the same ending inside that window. A real abort takes a
    // table lock and drops columns, so the POST losing that race is the
    // ordinary case, not the exotic one — and the admin got the same sentence
    // twice for one ending.
    const migration = {
      phase: 'ready' as const,
      model: 'qwen3-embedding:4b',
      dimensions: 2560,
      totalPages: 40,
      backfilledPages: 40,
      stragglerPages: 0,
      indexed: true,
      indexReady: true,
      startedAt: '2026-08-06T10:00:00.000Z',
    };
    let phase: 'ready' | 'swapped' = 'ready';
    let releaseRollback = () => {};
    const rollbackGate = new Promise<void>((resolve) => {
      releaseRollback = resolve;
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = init?.method ?? 'GET';
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/compare/') && method === 'GET' && !url.includes('/judgements')) {
        return json({ id: 'run-1', status: 'running', progressDone: 7, progressTotal: 16, error: null, result: null });
      }
      if (url.endsWith('/compare') && method === 'POST') return json({ runId: 'run-1' }, 202);
      if (url.endsWith('/compare') && method === 'GET') return json({ run: null });
      if (url.includes('/judgements')) return json({ judgements: {}, verdict: null });
      if (url.includes('/rollback') && method === 'POST') {
        await rollbackGate;
        return json({ ok: true });
      }
      if (url.includes('/shadow-migration') && method === 'GET') {
        return json({ active: true, migration: { ...migration, phase } });
      }
      return json({});
    });
    renderCard(null);

    fireEvent.click(await screen.findByTestId('shadow-compare-start'));
    await screen.findByTestId('shadow-compare-progress');
    fireEvent.click(screen.getByRole('button', { name: /^Abort$/ }));
    // The abort lands server-side while its own POST is still open; two polls
    // see the new state before the response arrives.
    phase = 'swapped';
    await vi.advanceTimersByTimeAsync(12_000);
    releaseRollback();
    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(6_000);
    expect(vi.mocked(toast.warning).mock.calls).toHaveLength(1);
    vi.useRealTimers();
  });

  it('the ending notice OUTLIVES the branch that raised it (browser verify F3)', async () => {
    // The whole point of moving this up to the card: a toast is gone in
    // seconds, and the surface that would have shown the failure — the compare
    // section and its amber strip — is unmounted by the very action that
    // caused it. Something has to still be on screen afterwards saying the
    // run's N x 2 embedding calls were spent for nothing.
    const migration = {
      phase: 'ready' as const,
      model: 'qwen3-embedding:4b',
      dimensions: 2560,
      totalPages: 40,
      backfilledPages: 40,
      stragglerPages: 0,
      indexed: true,
      indexReady: true,
      startedAt: '2026-08-06T10:00:00.000Z',
    };
    let phase: 'ready' | 'swapped' = 'ready';
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = init?.method ?? 'GET';
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/compare/') && method === 'GET' && !url.includes('/judgements')) {
        return json({ id: 'run-1', status: 'running', progressDone: 7, progressTotal: 16, error: null, result: null });
      }
      if (url.endsWith('/compare') && method === 'POST') return json({ runId: 'run-1' }, 202);
      if (url.endsWith('/compare') && method === 'GET') return json({ run: null });
      if (url.includes('/judgements')) return json({ judgements: {}, verdict: null });
      if (url.includes('/shadow-migration') && method === 'GET') {
        return json({ active: true, migration: { ...migration, phase } });
      }
      return json({});
    });
    renderCard(null);

    fireEvent.click(await screen.findByTestId('shadow-compare-start'));
    await screen.findByTestId('shadow-compare-progress');
    phase = 'swapped';
    await vi.advanceTimersByTimeAsync(6_000);

    const strip = await screen.findByTestId('shadow-compare-ended');
    expect(strip).toHaveAttribute('role', 'status');
    expect(strip.textContent).toMatch(/comparison in progress ended/i);
    // Rendered in the branch the swap moved the card into — it survived the
    // unmount that took the section away.
    expect(screen.queryByTestId('shadow-compare-section')).toBeNull();
    expect(screen.getByRole('button', { name: /roll back/i })).toBeInTheDocument();
    // Amber: degraded, not failed — the action the admin asked for succeeded.
    expect(strip.className).toMatch(/warning/);

    // It is dismissible, or it stands at rest forever on a card the admin
    // still has to finish using.
    const dismiss = screen.getByRole('button', { name: /dismiss/i });
    dismiss.focus();
    fireEvent.click(dismiss);
    expect(screen.queryByTestId('shadow-compare-ended')).toBeNull();
    // …and dismissing does not drop the keyboard admin to <body> in a ~30-stop
    // settings panel (WCAG 2.4.3, r1). This is the fourth self-removing
    // control on the surface: the cleanup confirm rehomes to Cancel and the
    // section's four notices rehome to their prose — a Dismiss that unmounts
    // itself under the pressed finger has the same defect and needs the same
    // treatment. Focus lands on the branch's own phase prose, which is what
    // the admin is reading now that the notice is gone.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.textContent).toMatch(/is live/i);
    vi.useRealTimers();
  });

  it('leaves focus alone when the admin moved on before dismissing (r1)', async () => {
    // The guard `useNoticeRetry` carries, on the card's own self-removing
    // control: rehoming is for a dismiss that really did orphan the caret, not
    // a licence to yank it away from whatever the admin reached for next.
    const migration = {
      phase: 'ready' as const,
      model: 'qwen3-embedding:4b',
      dimensions: 2560,
      totalPages: 40,
      backfilledPages: 40,
      stragglerPages: 0,
      indexed: true,
      indexReady: true,
      startedAt: '2026-08-06T10:00:00.000Z',
    };
    let phase: 'ready' | 'swapped' = 'ready';
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = init?.method ?? 'GET';
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/compare/') && method === 'GET' && !url.includes('/judgements')) {
        return json({ id: 'run-1', status: 'running', progressDone: 7, progressTotal: 16, error: null, result: null });
      }
      if (url.endsWith('/compare') && method === 'POST') return json({ runId: 'run-1' }, 202);
      if (url.endsWith('/compare') && method === 'GET') return json({ run: null });
      if (url.includes('/judgements')) return json({ judgements: {}, verdict: null });
      if (url.includes('/shadow-migration') && method === 'GET') {
        return json({ active: true, migration: { ...migration, phase } });
      }
      return json({});
    });
    renderCard(null);

    fireEvent.click(await screen.findByTestId('shadow-compare-start'));
    await screen.findByTestId('shadow-compare-progress');
    phase = 'swapped';
    await vi.advanceTimersByTimeAsync(6_000);
    await screen.findByTestId('shadow-compare-ended');

    // Focus is on a control the admin chose, and the notice is dismissed by
    // pointer — jsdom's `click` moves no focus, exactly as a mouse dismiss
    // leaves a caret parked elsewhere. Nothing was orphaned, so nothing moves.
    const rollback = screen.getByRole('button', { name: /roll back/i });
    rollback.focus();
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByTestId('shadow-compare-ended')).toBeNull();
    expect(document.activeElement).toBe(rollback);
    vi.useRealTimers();
  });

  describe('the ending strip prescribes only what its own branch offers (#1533)', () => {
    // `EmbeddingShadowCompareSection` — the only surface carrying a Run
    // control — is mounted by the `ready` branch alone, while the ending arm
    // fires on a migration WINDOW that closed (`swapped`, `aborting`, or the
    // migration gone entirely). So the strip is by construction shown where
    // that control is gone, and a fixed "Start a new comparison from the
    // current migration." named a control the card does not offer on the
    // primary path: swap while a comparison runs.
    //
    // One cell per branch the strip can render in — five — plus the one place
    // no sentence is possible at all. The sentence is a pure function of the
    // snapshot each branch is rendered from (`endedRecoveryFor`), so these
    // cells ARE its truth table.
    const MIGRATION = {
      phase: 'ready' as const,
      model: 'qwen3-embedding:4b',
      dimensions: 2560,
      totalPages: 40,
      backfilledPages: 40,
      stragglerPages: 0,
      indexed: true,
      indexReady: true,
      startedAt: '2026-08-06T10:00:00.000Z',
    };

    /** A comparison started in `ready` and still running, over a status the caller moves. */
    function mockRunning(statusFor: () => Status) {
      return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        const method = init?.method ?? 'GET';
        const json = (body: unknown, init2 = 200) =>
          new Response(JSON.stringify(body), { status: init2, headers: { 'Content-Type': 'application/json' } });
        if (url.includes('/compare/') && method === 'GET' && !url.includes('/judgements')) {
          return json({ id: 'run-1', status: 'running', progressDone: 7, progressTotal: 16, error: null, result: null });
        }
        if (url.endsWith('/compare') && method === 'POST') return json({ runId: 'run-1' }, 202);
        if (url.endsWith('/compare') && method === 'GET') return json({ run: null });
        if (url.includes('/judgements')) return json({ judgements: {}, verdict: null });
        if (url.includes('/shadow-migration') && method === 'GET') return json(statusFor());
        return json({});
      });
    }

    it('names what comparing needs, not an absent control, in the swapped branch', async () => {
      let phase: 'ready' | 'swapped' = 'ready';
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockRunning(() => ({ active: true, migration: { ...MIGRATION, phase } }));
      renderCard(null);

      fireEvent.click(await screen.findByTestId('shadow-compare-start'));
      await screen.findByTestId('shadow-compare-progress');
      phase = 'swapped';
      await vi.advanceTimersByTimeAsync(6_000);

      const strip = await screen.findByTestId('shadow-compare-ended');
      // The ending itself is true in every branch and still announced.
      expect(strip.textContent).toMatch(/comparison in progress ended/i);
      // The control the old second sentence pointed at is not on this card…
      expect(screen.queryByTestId('shadow-compare-section')).toBeNull();
      expect(screen.getByRole('button', { name: /roll back/i })).toBeInTheDocument();
      expect(strip.textContent).not.toMatch(/start a new comparison/i);
      // …so it names what comparing needs instead, which the swapped branch's
      // own prose (clean up or roll back) composes with. It is also checkable
      // from the card on screen: no Swap control anywhere on it.
      expect(strip.textContent).toMatch(/needs a migration waiting at the swap/i);
      expect(screen.queryByRole('button', { name: /swap to the new model/i })).toBeNull();
      // The toast covers the one case the strip cannot — a rollback with no
      // pending change takes the whole card away — and every path that fires
      // it has closed the migration window server-side, so it may not
      // prescribe the comparison either.
      expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
        expect.not.stringMatching(/start a new comparison/i),
      );
      expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
        expect.stringMatching(/has closed on the server/i),
      );
      vi.useRealTimers();
    });

    it('names it in the aborting branch too — the fix is not special-cased to one phase', async () => {
      let phase: 'ready' | 'aborting' = 'ready';
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockRunning(() => ({ active: true, migration: { ...MIGRATION, phase } }));
      renderCard(null);

      fireEvent.click(await screen.findByTestId('shadow-compare-start'));
      await screen.findByTestId('shadow-compare-progress');
      phase = 'aborting';
      await vi.advanceTimersByTimeAsync(6_000);

      const strip = await screen.findByTestId('shadow-compare-ended');
      expect(screen.getByRole('button', { name: /retry abort/i })).toBeInTheDocument();
      expect(screen.queryByTestId('shadow-compare-section')).toBeNull();
      expect(strip.textContent).toMatch(/comparison in progress ended/i);
      expect(strip.textContent).not.toMatch(/start a new comparison/i);
      expect(strip.textContent).toMatch(/needs a migration waiting at the swap/i);
      // …and it may not name a condition THIS migration already satisfies:
      // `MIGRATION` has zero stragglers and a built index, so a sentence about
      // a finished backfill or a built index would describe the card on screen
      // while the compare route answers 409 on the phase alone
      // (`llm-embedding-shadow.ts`: `status.phase !== 'ready'`). "Waiting at
      // the swap" is the phase, and this branch offers no Swap control.
      expect(MIGRATION.stragglerPages).toBe(0);
      expect(MIGRATION.indexReady).toBe(true);
      expect(strip.textContent).not.toMatch(/backfill|index/i);
      expect(screen.queryByRole('button', { name: /swap to the new model/i })).toBeNull();
      vi.useRealTimers();
    });

    it('names it in the backfilling branch, where the strip outlives its own migration', async () => {
      // A comparison ends when the migration is rolled back elsewhere, the
      // notice is never dismissed, and a FRESH re-embed starts under it. The
      // muted `shadow-compare-locked` note one line above says what the
      // BACKFILL is waiting for; the strip says what COMPARING needs, and the
      // two do not contradict each other.
      let status: Status = { active: true, migration: { ...MIGRATION } };
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockRunning(() => status);
      renderCard(null);

      fireEvent.click(await screen.findByTestId('shadow-compare-start'));
      await screen.findByTestId('shadow-compare-progress');
      status = { active: false, migration: null }; // rolled back elsewhere
      await vi.advanceTimersByTimeAsync(6_000);
      await waitFor(() => expect(vi.mocked(toast.warning)).toHaveBeenCalledTimes(1));

      status = {
        active: true,
        migration: {
          ...MIGRATION,
          phase: 'backfilling',
          backfilledPages: 10,
          stragglerPages: 30,
          indexed: false,
          indexReady: false,
          startedAt: '2026-08-07T09:00:00.000Z',
        },
      };
      await vi.advanceTimersByTimeAsync(6_000);

      const strip = await screen.findByTestId('shadow-compare-ended');
      expect(screen.queryByTestId('shadow-compare-section')).toBeNull();
      expect(screen.getByTestId('shadow-compare-locked').textContent).toMatch(
        /unlocks when the backfill completes/i,
      );
      expect(strip.textContent).toMatch(/comparison in progress ended/i);
      expect(strip.textContent).not.toMatch(/start a new comparison/i);
      expect(strip.textContent).toMatch(/needs a migration waiting at the swap/i);
      expect(screen.queryByRole('button', { name: /swap to the new model/i })).toBeNull();
      vi.useRealTimers();
    });

    it('names it in the pending branch, where the migration is gone but the card is not', async () => {
      // The fifth render site, and the only one reached with no migration at
      // all: a rollback elsewhere while the admin still holds an unsaved
      // model change, so the card falls back to "Start a re-embed". Nothing
      // here is waiting at the swap either, and there is no Run control.
      let status: Status = { active: true, migration: { ...MIGRATION } };
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockRunning(() => status);
      renderCard(PENDING);

      fireEvent.click(await screen.findByTestId('shadow-compare-start'));
      await screen.findByTestId('shadow-compare-progress');
      status = { active: false, migration: null };
      await vi.advanceTimersByTimeAsync(6_000);

      const strip = await screen.findByTestId('shadow-compare-ended');
      expect(screen.getByRole('button', { name: /start re-embed/i })).toBeInTheDocument();
      expect(screen.queryByTestId('shadow-compare-section')).toBeNull();
      expect(strip.textContent).toMatch(/comparison in progress ended/i);
      expect(strip.textContent).not.toMatch(/start a new comparison/i);
      expect(strip.textContent).toMatch(/needs a migration waiting at the swap/i);
      vi.useRealTimers();
    });

    it('keeps the prescription in the one branch that does mount the Run control', async () => {
      // No contrivance needed to get the strip and the section on screen at
      // once: another admin rolls the migration back mid-comparison (with no
      // pending change the card renders nothing at all then, which is why the
      // toast exists), the notice is never dismissed, and a fresh re-embed
      // reaches `ready` under the same card. Here the prescription is TRUE,
      // and pinning it is what stops the fix from wording the reachable
      // branch as a dead end — the mirror of #1533, which an earlier head of
      // this branch shipped.
      let status: Status = { active: true, migration: { ...MIGRATION } };
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockRunning(() => status);
      renderCard(PENDING);

      fireEvent.click(await screen.findByTestId('shadow-compare-start'));
      await screen.findByTestId('shadow-compare-progress');
      status = { active: false, migration: null };
      await vi.advanceTimersByTimeAsync(6_000);
      await waitFor(() => expect(vi.mocked(toast.warning)).toHaveBeenCalled());

      status = { active: true, migration: { ...MIGRATION, startedAt: '2026-08-07T09:00:00.000Z' } };
      await vi.advanceTimersByTimeAsync(6_000);

      // The section first: switching branch remounts the card's whole subtree,
      // so a strip handle taken before the `ready` poll lands is a DETACHED
      // node with the previous branch's text on it.
      expect(await screen.findByTestId('shadow-compare-section')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /swap to the new model/i })).toBeInTheDocument();
      const strip = screen.getByTestId('shadow-compare-ended');
      expect(strip.textContent).toMatch(/start a new comparison from the current migration/i);
      expect(strip.textContent).not.toMatch(/needs a migration waiting at the swap/i);
      vi.useRealTimers();
    });

    it('renders no strip where the snapshot can support no sentence at all', async () => {
      // The sixth site is not a site: a rollback with NO pending change takes
      // the whole card away (`!migration && !pending` → null), so there is no
      // branch left to word a sentence from. Keeping the card alive just to
      // carry the strip would put an amber notice — and its Dismiss — on a
      // surface with no phase prose, no controls and nothing to rehome focus
      // to. The toast is the surface for that ending, which is why it says the
      // window closed rather than pointing at a card.
      let status: Status = { active: true, migration: { ...MIGRATION } };
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockRunning(() => status);
      renderCard(null);

      fireEvent.click(await screen.findByTestId('shadow-compare-start'));
      await screen.findByTestId('shadow-compare-progress');
      status = { active: false, migration: null };
      await vi.advanceTimersByTimeAsync(6_000);

      await waitFor(() => expect(vi.mocked(toast.warning)).toHaveBeenCalledTimes(1));
      expect(screen.queryByTestId('shadow-migration-card')).toBeNull();
      expect(screen.queryByTestId('shadow-compare-ended')).toBeNull();
      vi.useRealTimers();
    });

    it('re-words an undismissed strip when the branch under it changes', async () => {
      // The sentence is derived per render rather than latched at warn time,
      // which is the whole of #1533: a notice raised in `ready` that is still
      // on screen when the swap lands must stop prescribing a comparison. The
      // `role="status"` text therefore MUTATES in place, and the polite region
      // re-announces it — deliberately, because what it then says is true of
      // the branch now on screen.
      let phase: 'ready' | 'swapped' = 'ready';
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockRunning(() => ({ active: true, migration: { ...MIGRATION, phase } }));
      renderCard(null);

      fireEvent.click(await screen.findByTestId('shadow-compare-start'));
      await screen.findByTestId('shadow-compare-progress');
      // End the run without leaving `ready`: the section reports the run gone,
      // and the card's own notice is raised by the swap below.
      phase = 'swapped';
      await vi.advanceTimersByTimeAsync(6_000);
      const strip = await screen.findByTestId('shadow-compare-ended');
      expect(strip.textContent).toMatch(/needs a migration waiting at the swap/i);

      // A new migration reaches `ready` under the same undismissed strip.
      phase = 'ready';
      await vi.advanceTimersByTimeAsync(6_000);
      await waitFor(() =>
        expect(screen.getByTestId('shadow-compare-ended').textContent).toMatch(
          /start a new comparison from the current migration/i,
        ),
      );
      // Same element, re-worded — not a second notice.
      expect(screen.getAllByTestId('shadow-compare-ended')).toHaveLength(1);
      vi.useRealTimers();
    });
  });

  describe('the backfilling note asks the server, not this session (r1)', () => {
    const MIGRATION = {
      phase: 'backfilling' as const,
      model: 'qwen3-embedding:4b',
      dimensions: 2560,
      totalPages: 40,
      backfilledPages: 39,
      stragglerPages: 1,
      indexed: true,
      indexReady: false,
      startedAt: '2026-08-06T10:00:00.000Z',
    };

    function mockBackfilling(latest: () => unknown) {
      return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        const method = init?.method ?? 'GET';
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
        if (url.endsWith('/compare') && method === 'GET') return json(latest());
        if (url.includes('/shadow-migration') && method === 'GET') {
          return json({ active: true, migration: MIGRATION });
        }
        return json({});
      });
    }

    it('a FRESH mount in backfilling finds the run that is holding the slot', async () => {
      // `compareRunning` was raised only by the compare section, and the
      // section exists only in the `ready` branch — so a reload, or a Settings
      // sub-tab switch away and back, landed here having watched nothing and
      // told the admin that comparing "unlocks when the backfill completes"
      // while their own comparison was running and holding the one-active
      // slot. Their next Run press is then 409'd by a run this card never
      // mentioned.
      mockBackfilling(() => ({
        run: { id: 'run-1', status: 'running', progressDone: 7, progressTotal: 16 },
      }));
      renderCard(null);
      const note = await screen.findByTestId('shadow-compare-locked');
      await waitFor(() => expect(note.textContent).toMatch(/still running/i));
    });

    it('stops saying "still running" once the run settles behind the note', async () => {
      // The mirror case: nothing on this side could clear the flag, because
      // the only thing that ever set it is unmounted. A straggler that keeps
      // failing holds this branch indefinitely (the runbook's own case), so
      // the sentence stayed wrong for as long as that lasted.
      let status = 'running';
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockBackfilling(() => ({
        run: { id: 'run-1', status, progressDone: 16, progressTotal: 16 },
      }));
      renderCard(null);
      await waitFor(() =>
        expect(screen.getByTestId('shadow-compare-locked').textContent).toMatch(/still running/i),
      );

      status = 'completed';
      await vi.advanceTimersByTimeAsync(6_000);
      await waitFor(() =>
        expect(screen.getByTestId('shadow-compare-locked').textContent).toMatch(
          /unlocks when the backfill completes/i,
        ),
      );
      vi.useRealTimers();
    });

    it('a run that COMPLETED behind the note does not make the next abort report an ending', async () => {
      // Same stale id, one layer on: `compareRunInFlight` fed the window-close
      // warning, so aborting after a comparison had finished warned that "the
      // comparison in progress ended" about a run that produced its report.
      let status = 'running';
      let phase: 'backfilling' | 'swapped' = 'backfilling';
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        const method = init?.method ?? 'GET';
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
        if (url.endsWith('/compare') && method === 'GET') {
          return json({ run: { id: 'run-1', status, progressDone: 16, progressTotal: 16 } });
        }
        if (url.includes('/shadow-migration') && method === 'GET') {
          return json({ active: true, migration: { ...MIGRATION, phase } });
        }
        return json({});
      });
      renderCard(null);
      await waitFor(() =>
        expect(screen.getByTestId('shadow-compare-locked').textContent).toMatch(/still running/i),
      );

      status = 'completed';
      await vi.advanceTimersByTimeAsync(6_000);
      await waitFor(() =>
        expect(screen.getByTestId('shadow-compare-locked').textContent).not.toMatch(
          /still running/i,
        ),
      );

      // The migration window now closes from another tab.
      phase = 'swapped';
      await vi.advanceTimersByTimeAsync(6_000);
      await waitFor(() => expect(screen.queryByTestId('shadow-compare-locked')).toBeNull());
      expect(vi.mocked(toast.warning)).not.toHaveBeenCalled();
      expect(screen.queryByTestId('shadow-compare-ended')).toBeNull();
      vi.useRealTimers();
    });

    it('does not adopt the PREVIOUS migration\'s comparison across the same model name (#1526)', async () => {
      // This card COMPOSES the re-attachment cache key that both halves read
      // (`compareCacheKey`, handed to the section as `candidateKey`), so the
      // migration window has to be in it here: the app's QueryClient keeps an
      // unobserved entry for five minutes, and an admin who aborted migration A
      // and started migration B on the SAME model name inside that window
      // remounts into this branch onto A's cached run — told a comparison of B
      // "is still running" for as long as the round trip lasts, and holding a
      // slot id from a migration that is gone. The section's own remount cases
      // cannot see this: the section is HANDED the key, and this is where it is
      // built.
      const shared = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      let startedAt = MIGRATION.startedAt;
      let holdLatest = false;
      const neverResolves = new Promise<void>(() => {});
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        const method = init?.method ?? 'GET';
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
        if (url.endsWith('/compare') && method === 'GET') {
          if (holdLatest) await neverResolves;
          return json({ run: { id: 'run-a', status: 'running', progressDone: 7, progressTotal: 16 } });
        }
        if (url.includes('/shadow-migration') && method === 'GET') {
          return json({ active: true, migration: { ...MIGRATION, startedAt } });
        }
        return json({});
      });

      const first = render(
        <QueryClientProvider client={shared}>
          <EmbeddingShadowMigrationCard pending={null} />
        </QueryClientProvider>,
      );
      await waitFor(() =>
        expect(screen.getByTestId('shadow-compare-locked').textContent).toMatch(/still running/i),
      );
      first.unmount();

      // Migration B, same model name, new window — and its own lookup is still
      // in flight, which is the window the cache is read in.
      startedAt = '2026-08-09T11:00:00.000Z';
      holdLatest = true;
      render(
        <QueryClientProvider client={shared}>
          <EmbeddingShadowMigrationCard pending={null} />
        </QueryClientProvider>,
      );
      // Let the mount SETTLE before asserting: a cache-served run reaches the
      // note one effect later, so an assertion that resolves on the first
      // synchronous poll passes no matter which key was used.
      const settled = Promise.withResolvers<void>();
      setTimeout(settled.resolve, 50);
      await act(() => settled.promise);
      expect(screen.getByTestId('shadow-compare-locked').textContent).toMatch(
        /unlocks when the backfill completes/i,
      );
    });
  });

  it('HANDS the ready branch\'s section that same migration-scoped key (#1526 r1)', async () => {
    // The composition at `compareCacheKey` and the hand-off to the section are
    // two separate surfaces, and only the hand-off carries the data-integrity
    // half of #1526. The card's own re-attachment lookup is enabled ONLY in
    // `backfilling`, so in `ready` the sole reader of that key is the prop —
    // and `ready` is the branch that renders the disagreement rows and their
    // LIVE judgement radios. A pick made in that window POSTs against the
    // adopted run's id, which `recordShadowCompareJudgement` keys to the OLD
    // migration's candidate pair: the judgement lands in migration A's
    // evidence while the admin believes they judged B. The test above pins how
    // the key is BUILT; this one pins that the section is given it.
    const REPORT = {
      kind: 'shadow-compare',
      generatedAt: '2026-08-06T10:30:00.000Z',
      topK: 10,
      queryCount: 1,
      live: { providerId: 'p1', model: 'bge-m3' },
      candidate: { providerId: 'p2', model: 'qwen3-embedding:4b' },
      agreement: {
        queryCount: 1,
        top1ChangedQueries: 1,
        top1ChangeRate: 1,
        meanJaccard: 0.5,
        meanRbo: 0.4,
        disagreementCount: 1,
      },
      queries: [
        {
          id: 'query-1',
          query: 'how to configure sync',
          top1Changed: true,
          jaccard: 0.5,
          rbo: 0.4,
          live: { pageIds: [1], pages: [{ pageId: 1, title: 'Sync setup', spaceKey: null }] },
          candidate: {
            pageIds: [2],
            pages: [{ pageId: 2, title: 'Sync troubleshooting', spaceKey: null }],
          },
        },
      ],
    };
    const EMPTY_VERDICT = {
      judgementCount: 0,
      scoredJudgementCount: 0,
      liveBetter: 0,
      candidateBetter: 0,
      both: 0,
      neither: 0,
      mcnemar: null,
      recall: null,
      mrr: null,
      minJudgementsForP: 20,
    };
    const READY = {
      phase: 'ready' as const,
      model: 'qwen3-embedding:4b',
      dimensions: 2560,
      totalPages: 40,
      backfilledPages: 40,
      stragglerPages: 0,
      indexed: true,
      indexReady: true,
      startedAt: '2026-08-06T10:00:00.000Z',
    };

    let startedAt = READY.startedAt;
    let holdLatest = false;
    const neverResolves = new Promise<void>(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = init?.method ?? 'GET';
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/judgements')) return json({ judgements: {}, verdict: EMPTY_VERDICT });
      if (url.includes('/compare/') && method === 'GET') {
        return json({
          id: 'run-a',
          status: 'completed',
          progressDone: 1,
          progressTotal: 1,
          error: null,
          result: REPORT,
        });
      }
      if (url.endsWith('/compare') && method === 'GET') {
        // Migration B's own lookup answers `{run: null}` (the server's pair
        // predicate refuses A's run) — but only after a round trip, and that
        // round trip is the whole window a stale cache entry fills.
        if (holdLatest) await neverResolves;
        return json({ run: { id: 'run-a', status: 'completed', progressDone: 1, progressTotal: 1 } });
      }
      if (url.includes('/shadow-migration') && method === 'GET') {
        return json({ active: true, migration: { ...READY, startedAt } });
      }
      return json({});
    });

    const shared = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const first = render(
      <QueryClientProvider client={shared}>
        <EmbeddingShadowMigrationCard pending={null} />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('shadow-compare-basis')).toHaveTextContent(
        REPORT.candidate.model,
      ),
    );
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    first.unmount();

    // Migration B: same model NAME, a new window, inside the five-minute
    // gcTime that still holds A's entry.
    startedAt = '2026-08-09T11:00:00.000Z';
    holdLatest = true;
    render(
      <QueryClientProvider client={shared}>
        <EmbeddingShadowMigrationCard pending={null} />
      </QueryClientProvider>,
    );
    await screen.findByTestId('shadow-compare-section');
    // Settle before asserting absence: a cache-served run reaches the report
    // an effect and a poll later, so an assertion resolving on the first
    // synchronous tick passes no matter which key the prop carried.
    const settled = Promise.withResolvers<void>();
    setTimeout(settled.resolve, 50);
    await act(() => settled.promise);
    expect(screen.queryByTestId('shadow-compare-result')).toBeNull();
    expect(screen.queryByTestId('shadow-compare-basis')).toBeNull();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });
});
