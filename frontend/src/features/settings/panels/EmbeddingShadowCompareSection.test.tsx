import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
  queryCount: 5,
  live: { providerId: 'p1', model: 'bge-m3' },
  candidate: { providerId: 'p2', model: 'qwen3-embedding:4b' },
  agreement: {
    queryCount: 5,
    top1ChangedQueries: 1,
    top1ChangeRate: 1 / 5,
    meanJaccard: 0.8,
    meanRbo: 0.74,
    disagreementCount: 4,
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
    {
      // Head agrees, sets differ (jaccard < 1): dropping the jaccard disjunct
      // from the list filter must lose exactly this row.
      id: 'query-4',
      query: 'permissions model',
      top1Changed: false,
      jaccard: 1 / 3,
      rbo: 0.7,
      live: { pageIds: [7, 8], pages: [{ pageId: 7, title: 'RBAC', spaceKey: null }, { pageId: 8, title: 'Roles', spaceKey: null }] },
      candidate: { pageIds: [7, 9], pages: [{ pageId: 7, title: 'RBAC', spaceKey: null }, { pageId: 9, title: 'Groups', spaceKey: null }] },
    },
    {
      // Same set, same head, below-head reorder (rbo < 1 alone): the movement
      // only RBO can see, which must still reach the judgeable list.
      id: 'query-5',
      query: 'backup schedule',
      top1Changed: false,
      jaccard: 1,
      rbo: 0.95,
      live: { pageIds: [10, 11, 12], pages: [{ pageId: 10, title: 'Backups', spaceKey: null }, { pageId: 11, title: 'Cron', spaceKey: null }, { pageId: 12, title: 'Restore', spaceKey: null }] },
      candidate: { pageIds: [10, 12, 11], pages: [{ pageId: 10, title: 'Backups', spaceKey: null }, { pageId: 12, title: 'Restore', spaceKey: null }, { pageId: 11, title: 'Cron', spaceKey: null }] },
    },
  ],
};

const EMPTY_VERDICT = {
  judgementCount: 0,
  liveBetter: 0,
  candidateBetter: 0,
  both: 0,
  neither: 0,
  mcnemar: null,
  recall: null,
  mrr: null,
  minJudgementsForP: 20,
};

function mockApi(opts: {
  run?: Partial<Run>;
  capture?: Array<{ url: string; method: string; body?: string }>;
  runSequence?: Array<Partial<Run>>;
  judgements?: Record<string, string>;
  verdict?: object;
  judgementResponse?: object;
  /** When set, the judgement POST does not answer until this resolves —
   *  holds the mutation pending so the in-flight UI state can be asserted. */
  judgementGate?: Promise<void>;
  /** Every status poll answers HTTP 500 (the POST still 202s). */
  pollError?: boolean;
}) {
  let polls = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = init?.method ?? 'GET';
    opts.capture?.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
    if (opts.pollError && url.includes('/compare/') && method === 'GET' && !url.includes('/judgements')) {
      return new Response(JSON.stringify({ message: 'boom' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/judgements')) {
      if (method === 'POST' && opts.judgementResponse) {
        if (opts.judgementGate) await opts.judgementGate;
        return new Response(JSON.stringify(opts.judgementResponse), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ judgements: opts.judgements ?? {}, verdict: opts.verdict ?? EMPTY_VERDICT }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }
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

    expect(within(result).getByText(/1\/5 queries/)).toBeInTheDocument();

    // Four disagreement rows — every way two lists can differ is listed
    // (head moved, rank-only head swap, head-stable set change, below-head
    // reorder that only RBO sees); the fully agreeing query-3 is not.
    const rows = within(result).getAllByTestId('shadow-compare-disagreement');
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent('how to configure sync');
    expect(rows[0]).toHaveTextContent('Sync setup');
    expect(rows[0]).toHaveTextContent('Sync troubleshooting');
    expect(rows[1]).toHaveTextContent('reset password');
    expect(rows[2]).toHaveTextContent('permissions model');
    expect(rows[3]).toHaveTextContent('backup schedule');
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
    // With nothing judged and nothing to judge, no verdict line prompts the
    // user to "pick the better side on a disagreement below" — there is none.
    // Flush the judgements query first, or its zero-judgement prompt would be
    // asserted absent before it ever had the chance to render.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(within(result).queryByTestId('shadow-compare-verdict')).toBeNull();
  });

  it('keeps the judged verdict visible on a fully agreeing run when the pair carries earlier judgements', async () => {
    mockApi({
      run: {
        result: {
          ...COMPLETED_RESULT,
          agreement: { ...COMPLETED_RESULT.agreement, top1ChangedQueries: 0, disagreementCount: 0 },
          queries: [COMPLETED_RESULT.queries[2]],
          queryCount: 1,
        },
      },
      verdict: { ...EMPTY_VERDICT, judgementCount: 5, liveBetter: 3, candidateBetter: 2 },
    });
    renderSection();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    await screen.findByTestId('shadow-compare-result');
    const verdict = await screen.findByTestId('shadow-compare-verdict');
    expect(verdict).toHaveTextContent(/5 judgements/i);
  });

  it('states that ties cannot produce a p-value instead of counting down past the floor', async () => {
    // 25 judgements, all 'both'/'neither': the server scores nothing and
    // sends mcnemar null. "25 of 20 judgements before a p-value is quoted"
    // is nonsense — the real reason is that ties carry no discordant pairs.
    mockApi({
      verdict: { ...EMPTY_VERDICT, judgementCount: 25, both: 20, neither: 5 },
    });
    renderSection();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    await screen.findByTestId('shadow-compare-result');
    const verdict = await screen.findByTestId('shadow-compare-verdict');
    expect(verdict).toHaveTextContent(/ties alone cannot produce a p-value/i);
    expect(verdict).not.toHaveTextContent(/25 of 20/);
    expect(verdict).not.toHaveTextContent(/p =/);
  });

  it('a failed status poll is reported, not rendered as the idle state', async () => {
    const capture: Array<{ url: string; method: string; body?: string }> = [];
    mockApi({ capture, pollError: true });
    renderSection();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));

    // The run started (202) but its status cannot be read: the section must
    // say so rather than showing no progress, no error and a re-enabled Run
    // — which would present a live server-side run as if nothing happened.
    const strip = await screen.findByTestId('shadow-compare-poll-error');
    expect(strip).toHaveAttribute('role', 'status');
    expect(strip.className).toMatch(/warning/);
    expect(strip).toHaveTextContent(/could not be fetched/i);
    expect(screen.getByTestId('shadow-compare-start')).toBeDisabled();
    expect(screen.queryByTestId('shadow-compare-progress')).toBeNull();

    // The strip offers an explicit re-poll.
    const before = capture.filter((c) => c.method === 'GET' && c.url.includes('/compare/')).length;
    fireEvent.click(within(strip).getByRole('button', { name: /check again/i }));
    await waitFor(() =>
      expect(capture.filter((c) => c.method === 'GET' && c.url.includes('/compare/')).length).toBeGreaterThan(before),
    );
  });

  it('each disagreement offers the four judgement sides; a pick posts and renders pressed from the response (Mode 2)', async () => {
    const capture: Array<{ url: string; method: string; body?: string }> = [];
    mockApi({
      capture,
      judgementResponse: {
        judgements: { 'query-1': 'candidate' },
        verdict: { ...EMPTY_VERDICT, judgementCount: 1, candidateBetter: 1 },
      },
    });
    renderSection();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    const rows = await screen.findAllByTestId('shadow-compare-disagreement');

    // Each row's controls are one labelled group, so twenty "Candidate"
    // buttons stay tellable apart for a screen reader.
    const group = within(rows[0]!).getByRole('group', { name: /how to configure sync/ });
    for (const name of ['Live', 'Candidate', 'Neither', 'Both']) {
      expect(within(group).getByRole('button', { name })).toBeInTheDocument();
    }

    fireEvent.click(within(group).getByRole('button', { name: 'Candidate' }));
    await waitFor(() => {
      const post = capture.find((c) => c.method === 'POST' && c.url.includes('/judgements'));
      expect(post?.body).toBe(JSON.stringify({ queryId: 'query-1', side: 'candidate' }));
    });
    await waitFor(() => {
      expect(within(group).getByRole('button', { name: 'Candidate' })).toHaveAttribute('aria-pressed', 'true');
    });
    expect(within(group).getByRole('button', { name: 'Live' })).toHaveAttribute('aria-pressed', 'false');
    // The verdict updates from the same response.
    expect(screen.getByTestId('shadow-compare-verdict')).toHaveTextContent(/1 judgement/i);
  });

  it('a pending pick never disables the judgement buttons — focus survives the POST and re-entry is guarded instead', async () => {
    // In Chromium, disabling the focused element drops focus to <body>;
    // `disabled={judging}` would make a keyboard admin re-Tab from the top
    // of the panel after every one of the ~20 picks the verdict needs. The
    // buttons therefore stay enabled (aria-disabled while pending) and the
    // click handler no-ops instead. jsdom does not blur on disable, so the
    // falsifiable property here is the ABSENCE of `disabled` — plus the
    // no-second-POST guard that replaces it.
    const capture: Array<{ url: string; method: string; body?: string }> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockApi({
      capture,
      judgementGate: gate,
      judgementResponse: {
        judgements: { 'query-1': 'candidate' },
        verdict: { ...EMPTY_VERDICT, judgementCount: 1, candidateBetter: 1 },
      },
    });
    renderSection();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    const rows = await screen.findAllByTestId('shadow-compare-disagreement');
    const group = within(rows[0]!).getByRole('group', { name: /how to configure sync/ });
    const candidateBtn = within(group).getByRole('button', { name: 'Candidate' });
    const judgementPosts = () =>
      capture.filter((c) => c.method === 'POST' && c.url.includes('/judgements')).length;

    candidateBtn.focus();
    fireEvent.click(candidateBtn);
    await waitFor(() => expect(candidateBtn).toHaveAttribute('aria-disabled', 'true'));
    for (const name of ['Live', 'Candidate', 'Neither', 'Both']) {
      expect(within(group).getByRole('button', { name })).not.toBeDisabled();
    }
    expect(candidateBtn).toHaveFocus();

    // Re-entry is guarded in the handler: a second pick while the first is
    // in flight posts nothing. Flush timers/microtasks before counting —
    // TanStack starts the mutation's fetch asynchronously, so a synchronous
    // count would pass even with the guard deleted.
    expect(judgementPosts()).toBe(1);
    fireEvent.click(within(group).getByRole('button', { name: 'Live' }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(judgementPosts()).toBe(1);

    release();
    await waitFor(() => expect(candidateBtn).toHaveAttribute('aria-pressed', 'true'));
    expect(candidateBtn).not.toHaveAttribute('aria-disabled');
    // …and once resolved, the next pick posts again.
    fireEvent.click(within(group).getByRole('button', { name: 'Live' }));
    await waitFor(() => expect(judgementPosts()).toBe(2));
  });

  it('two picks landing before React re-renders post once — the re-entry gate is synchronous (r3)', async () => {
    // The test above interposes a `waitFor` between the two clicks, which
    // flushes a re-render — so a guard reading the RENDERED `judge.isPending`
    // passes it while still double-POSTing on a real double-click, where both
    // activations run before TanStack's async pending notification lands.
    // The gate must therefore be a ref set synchronously in the handler.
    const capture: Array<{ url: string; method: string; body?: string }> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockApi({
      capture,
      judgementGate: gate,
      judgementResponse: {
        judgements: { 'query-1': 'candidate' },
        verdict: { ...EMPTY_VERDICT, judgementCount: 1, candidateBetter: 1 },
      },
    });
    renderSection();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    const rows = await screen.findAllByTestId('shadow-compare-disagreement');
    const group = within(rows[0]!).getByRole('group', { name: /how to configure sync/ });
    const candidateBtn = within(group).getByRole('button', { name: 'Candidate' });

    // Back-to-back, no interleaved flush: a double-click, or two buttons in
    // one frame.
    fireEvent.click(candidateBtn);
    fireEvent.click(within(group).getByRole('button', { name: 'Live' }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(capture.filter((c) => c.method === 'POST' && c.url.includes('/judgements'))).toHaveLength(1);

    release();
    await waitFor(() => expect(candidateBtn).toHaveAttribute('aria-pressed', 'true'));
  });

  it('renders stored judgements as pressed on load, and names N-of-20 instead of quoting a premature p', async () => {
    mockApi({
      judgements: { 'query-2': 'live' },
      verdict: {
        ...EMPTY_VERDICT,
        judgementCount: 5,
        liveBetter: 3,
        candidateBetter: 2,
        mcnemar: { wins: 2, losses: 3, pValue: null, significant: false, direction: 'none' },
      },
    });
    renderSection();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    const rows = await screen.findAllByTestId('shadow-compare-disagreement');
    const group = within(rows[1]!).getByRole('group', { name: /reset password/ });
    await waitFor(() => {
      expect(within(group).getByRole('button', { name: 'Live' })).toHaveAttribute('aria-pressed', 'true');
    });
    const verdict = screen.getByTestId('shadow-compare-verdict').textContent ?? '';
    expect(verdict).toMatch(/5 judgements/i);
    expect(verdict).toMatch(/candidate better on 2/i);
    expect(verdict).toMatch(/live better on 3/i);
    expect(verdict).toMatch(/5 of 20 judgements/i);
    expect(verdict).not.toMatch(/p =/);
  });

  it('quotes McNemar p with its direction once the pair has enough judgements', async () => {
    mockApi({
      verdict: {
        ...EMPTY_VERDICT,
        judgementCount: 24,
        liveBetter: 4,
        candidateBetter: 18,
        both: 1,
        neither: 1,
        mcnemar: { wins: 15, losses: 2, pValue: 0.0023, significant: true, direction: 'improvement' },
        recall: { live: 0.4, candidate: 0.95 },
        mrr: { live: 0.35, candidate: 0.9 },
      },
    });
    renderSection();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    await screen.findByTestId('shadow-compare-result');
    const verdict = await screen.findByTestId('shadow-compare-verdict');
    expect(verdict).toHaveTextContent(/24 judgements/i);
    expect(verdict).toHaveTextContent(/p = 0.002/);
    expect(verdict).toHaveTextContent(/favouring the candidate/i);
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
