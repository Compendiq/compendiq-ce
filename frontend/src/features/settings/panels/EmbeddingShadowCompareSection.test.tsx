import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmbeddingShadowCompareSection } from './EmbeddingShadowCompareSection';
import { useAuthStore } from '../../../stores/auth-store';

// #1260 — the "Compare on real queries" section inside the shadow card's
// ready branch. Fetch is mocked at the network boundary.

let queryClient: QueryClient;
function renderSection() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <EmbeddingShadowCompareSection candidateModel="qwen3-embedding:4b" />
    </QueryClientProvider>,
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

type Run = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progressDone: number;
  progressTotal: number;
  error: string | null;
  result: unknown;
};

const COMPLETED_RESULT = {
  kind: 'shadow-compare',
  generatedAt: '2026-08-22T10:00:00.000Z',
  topK: 10,
  queryCount: 3,
  live: { providerId: 'p1', model: 'bge-m3' },
  candidate: { providerId: 'p2', model: 'qwen3-embedding:4b' },
  agreement: {
    queryCount: 3,
    top1ChangedQueries: 1,
    top1ChangeRate: 1 / 3,
    meanJaccard: 0.8,
    meanRbo: 0.74,
    disagreementCount: 2,
  },
  queries: [
    {
      id: 'query-1',
      query: 'how to configure sync',
      top1Changed: true,
      jaccard: 0.5,
      rbo: 0.4,
      live: { pageIds: [1, 2], pages: [{ pageId: 1, title: 'Sync setup', spaceKey: null }, { pageId: 2, title: 'Spaces', spaceKey: null }] },
      candidate: { pageIds: [3, 2], pages: [{ pageId: 3, title: 'Sync troubleshooting', spaceKey: null }, { pageId: 2, title: 'Spaces', spaceKey: null }] },
    },
    {
      // A rank-only disagreement: same set, reversed order — the backend
      // computes top1Changed true, jaccard 1, and it must still be listed.
      id: 'query-2',
      query: 'reset password',
      top1Changed: true,
      jaccard: 1,
      rbo: 0.9,
      live: { pageIds: [4, 5], pages: [{ pageId: 4, title: 'Accounts', spaceKey: null }, { pageId: 5, title: 'Security', spaceKey: null }] },
      candidate: { pageIds: [4, 5].reverse(), pages: [{ pageId: 5, title: 'Security', spaceKey: null }, { pageId: 4, title: 'Accounts', spaceKey: null }] },
    },
    {
      id: 'query-3',
      query: 'export pdf',
      top1Changed: false,
      jaccard: 1,
      rbo: 1,
      live: { pageIds: [6], pages: [{ pageId: 6, title: 'Exporting', spaceKey: null }] },
      candidate: { pageIds: [6], pages: [{ pageId: 6, title: 'Exporting', spaceKey: null }] },
    },
  ],
};

function mockApi(opts: {
  run?: Partial<Run>;
  capture?: Array<{ url: string; method: string; body?: string }>;
  runSequence?: Array<Partial<Run>>;
}) {
  let polls = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = init?.method ?? 'GET';
    opts.capture?.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
    if (url.includes('/compare/') && method === 'GET') {
      const seq = opts.runSequence;
      const override = seq ? seq[Math.min(polls++, seq.length - 1)] : opts.run;
      const body: Run = {
        id: 'run-1',
        status: 'completed',
        progressDone: 3,
        progressTotal: 3,
        error: null,
        result: COMPLETED_RESULT,
        ...override,
      };
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/compare') && method === 'POST') {
      return new Response(JSON.stringify({ runId: 'run-1', status: 'queued' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  });
}

describe('EmbeddingShadowCompareSection (#1260)', () => {
  it('states at rest that this measures agreement on the vector leg, and that the run slot is shared', () => {
    mockApi({});
    renderSection();
    expect(screen.getByText(/Compare on real queries/i)).toBeInTheDocument();
    const copy = screen.getByTestId('shadow-compare-intro').textContent ?? '';
    expect(copy).toMatch(/vector leg only/i);
    expect(copy).toMatch(/not.*quality/i);
    expect(copy).toMatch(/production retrieval benchmark/i);
  });

  it('starts a run with the chosen knobs and renders progress from the poll', async () => {
    const capture: Array<{ url: string; method: string; body?: string }> = [];
    mockApi({ capture, run: { status: 'running', progressDone: 2, progressTotal: 5, result: null } });
    renderSection();

    fireEvent.change(screen.getByTestId('shadow-compare-days'), { target: { value: '14' } });
    fireEvent.change(screen.getByTestId('shadow-compare-limit'), { target: { value: '20' } });
    fireEvent.change(screen.getByTestId('shadow-compare-topk'), { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('shadow-compare-start'));

    await waitFor(() => {
      const post = capture.find((c) => c.method === 'POST');
      expect(post?.body).toBe(JSON.stringify({ days: 14, limit: 20, topK: 5 }));
    });
    expect(await screen.findByTestId('shadow-compare-progress')).toHaveTextContent('2/5');
    // The control must not offer a second concurrent run.
    expect(screen.getByTestId('shadow-compare-start')).toBeDisabled();
  });

  it('polls no faster than every 5 seconds — two admin-rate-limited requests share the card', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const capture: Array<{ url: string; method: string; body?: string }> = [];
    mockApi({ capture, run: { status: 'running', progressDone: 1, progressTotal: 3, result: null } });
    renderSection();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    await screen.findByTestId('shadow-compare-progress');

    const pollsAfterFirst = capture.filter((c) => c.method === 'GET' && c.url.includes('/compare/')).length;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(capture.filter((c) => c.method === 'GET' && c.url.includes('/compare/')).length).toBe(pollsAfterFirst);
    await vi.advanceTimersByTimeAsync(1_500);
    await waitFor(() =>
      expect(capture.filter((c) => c.method === 'GET' && c.url.includes('/compare/')).length).toBeGreaterThan(pollsAfterFirst),
    );
  });

  it('renders the agreement figures with their basis, and only the disagreeing queries', async () => {
    mockApi({});
    renderSection();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));

    const result = await screen.findByTestId('shadow-compare-result');
    // The verdict names its basis: agreement, not quality.
    const basis = within(result).getByTestId('shadow-compare-basis').textContent ?? '';
    expect(basis).toMatch(/agreement/i);
    expect(basis).toMatch(/not/i);
    expect(basis).toContain('bge-m3');
    expect(basis).toContain('qwen3-embedding:4b');

    expect(within(result).getByText(/1\/3 queries/)).toBeInTheDocument();

    // Two disagreement rows (query-2 disagrees on rank alone and must be
    // listed); the fully agreeing query-3 is not.
    const rows = within(result).getAllByTestId('shadow-compare-disagreement');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('how to configure sync');
    expect(rows[0]).toHaveTextContent('Sync setup');
    expect(rows[0]).toHaveTextContent('Sync troubleshooting');
    expect(rows[1]).toHaveTextContent('reset password');
    expect(result).not.toHaveTextContent('export pdf');

    // Both sides name their model, so the two lists cannot be read swapped.
    expect(within(rows[0]!).getByText(/Live · bge-m3/)).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/Candidate · qwen3-embedding:4b/)).toBeInTheDocument();
  });

  it('says so when the two models fully agree instead of rendering an empty list', async () => {
    mockApi({
      run: {
        result: {
          ...COMPLETED_RESULT,
          agreement: { ...COMPLETED_RESULT.agreement, top1ChangedQueries: 0, disagreementCount: 0 },
          queries: [COMPLETED_RESULT.queries[2]],
          queryCount: 1,
        },
      },
    });
    renderSection();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    const result = await screen.findByTestId('shadow-compare-result');
    expect(within(result).getByText(/same pages/i)).toBeInTheDocument();
    expect(within(result).queryAllByTestId('shadow-compare-disagreement')).toHaveLength(0);
  });

  it('a failed run is an amber status strip carrying the server sentence', async () => {
    mockApi({
      run: {
        status: 'failed',
        result: null,
        error: 'The shadow migration changed while the comparison ran (swap, abort or rollback) — start a new comparison from the current migration',
      },
    });
    renderSection();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    const strip = await screen.findByTestId('shadow-compare-error');
    expect(strip).toHaveAttribute('role', 'status');
    expect(strip.className).toMatch(/warning/);
    expect(strip).toHaveTextContent(/changed while the comparison ran/);
    // A finished (failed) run frees the control for the retry.
    expect(screen.getByTestId('shadow-compare-start')).not.toBeDisabled();
  });
});
