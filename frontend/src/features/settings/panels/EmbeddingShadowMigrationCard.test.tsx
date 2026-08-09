import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmbeddingShadowMigrationCard } from './EmbeddingShadowMigrationCard';
import { useAuthStore } from '../../../stores/auth-store';

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

  it('shows an ETA from measured throughput while backfilling, and names the index phase instead (review r9)', async () => {
    // The issue asks for progress AND an ETA. Half done after an hour → about
    // an hour left.
    vi.setSystemTime(new Date('2026-08-06T11:00:00.000Z'));
    mockApi({
      active: true,
      migration: { phase: 'backfilling', model: 'm', dimensions: 1024, totalPages: 100, backfilledPages: 50, stragglerPages: 50, indexed: true, indexReady: false, startedAt: '2026-08-06T10:00:00.000Z' },
    });
    const { unmount } = renderCard(null);
    expect(await screen.findByText(/1\.0 h remaining/i)).toBeInTheDocument();
    unmount();

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
});
