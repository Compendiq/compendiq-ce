import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { EmbeddingShadowCompareSection } from './EmbeddingShadowCompareSection';
import { createQueryClient } from '../../../shared/lib/query-client';
import { useAuthStore } from '../../../stores/auth-store';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

// #1260 — the "Compare on real queries" section inside the shadow card's
// ready branch. Fetch is mocked at the network boundary.

let queryClient: QueryClient;
function renderSection(props: { onRunInFlightChange?: (runId: string | null) => void } = {}) {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <EmbeddingShadowCompareSection candidateModel="qwen3-embedding:4b" {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAuthStore.getState().setAuth('t', { id: '1', username: 'admin', role: 'admin' });
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.warning).mockClear();
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

function mockApi(opts: {
  run?: Partial<Run>;
  capture?: Array<{ url: string; method: string; body?: string }>;
  runSequence?: Array<Partial<Run>>;
  judgements?: Record<string, string>;
  verdict?: object;
  judgementResponse?: object;
  /** Successive judgement POST responses, in order. */
  judgementResponses?: object[];
  /** When set, the judgement POST does not answer until this resolves —
   *  holds the mutation pending so the in-flight UI state can be asserted. */
  judgementGate?: Promise<void>;
  /** Every status poll answers HTTP 500 (the POST still 202s). */
  pollError?: boolean;
  /** What `GET …/compare` (no id) answers — the card's re-attachment lookup. */
  latestRun?: Partial<Run> | null;
  /** The re-attachment lookup answers HTTP 500. */
  latestError?: boolean;
}) {
  let polls = 0;
  let posts = 0;
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
      if (method === 'POST' && (opts.judgementResponse || opts.judgementResponses)) {
        if (opts.judgementGate) await opts.judgementGate;
        const body =
          opts.judgementResponses?.[Math.min(posts++, opts.judgementResponses.length - 1)] ??
          opts.judgementResponse;
        return new Response(JSON.stringify(body), {
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
    if (url.endsWith('/compare') && method === 'GET' && opts.latestError) {
      return new Response(JSON.stringify({ message: 'boom' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/compare') && method === 'GET') {
      const run = opts.latestRun
        ? {
            id: 'run-1',
            status: 'completed' as const,
            progressDone: 3,
            progressTotal: 3,
            error: null,
            result: COMPLETED_RESULT,
            ...opts.latestRun,
          }
        : null;
      return new Response(JSON.stringify({ run }), {
        headers: { 'Content-Type': 'application/json' },
      });
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
  it('states at rest that this measures agreement on the vector leg, that the run slot is shared, and what a run costs', () => {
    mockApi({});
    renderSection();
    expect(screen.getByText(/Compare on real queries/i)).toBeInTheDocument();
    const copy = screen.getByTestId('shadow-compare-intro').textContent ?? '';
    expect(copy).toMatch(/vector leg only/i);
    expect(copy).toMatch(/not.*quality/i);
    expect(copy).toMatch(/production retrieval benchmark/i);
    // The run's real cost, on the screen the operator is standing on: two
    // embedding calls per query through the queue that embeds live questions,
    // at a Queries field defaulting to 50. The sibling card one phase earlier
    // says exactly this about the backfill, and the runbook says it about the
    // comparison — omitting it here left the one surface that starts the run
    // silent about what it spends.
    expect(copy).toMatch(/two embedding calls per query/i);
    expect(copy).toMatch(/slower/i);
  });

  it('is a labelled region with a heading, so it can be reached and skipped', () => {
    // The longest interactive block on the tab — a completed run renders four
    // judgement buttons per disagreeing query, up to the 100-query cap — and
    // it sits ABOVE the use-case assignments, their Save and the runtime
    // limits card in both tab order and reading order. Without a heading or a
    // landmark there is no way to jump to it or past it (WCAG 1.3.1).
    mockApi({});
    renderSection();
    const heading = screen.getByRole('heading', { name: /Compare on real queries/i });
    expect(heading).toBeInTheDocument();
    const region = screen.getByRole('region', { name: /Compare on real queries/i });
    expect(region).toContainElement(heading);
    expect(region).toContainElement(screen.getByTestId('shadow-compare-start'));
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
    const group = within(rows[0]!).getByRole('radiogroup', { name: /how to configure sync/ });
    for (const name of ['Live', 'Candidate', 'Neither', 'Both']) {
      expect(within(group).getByRole('radio', { name })).toBeInTheDocument();
    }

    fireEvent.click(within(group).getByRole('radio', { name: 'Candidate' }));
    await waitFor(() => {
      const post = capture.find((c) => c.method === 'POST' && c.url.includes('/judgements'));
      expect(post?.body).toBe(JSON.stringify({ queryId: 'query-1', side: 'candidate' }));
    });
    await waitFor(() => {
      expect(within(group).getByRole('radio', { name: 'Candidate' })).toHaveAttribute('aria-checked', 'true');
    });
    expect(within(group).getByRole('radio', { name: 'Live' })).toHaveAttribute('aria-checked', 'false');
    // The verdict updates from the same response.
    expect(screen.getByTestId('shadow-compare-verdict')).toHaveTextContent(/1 judgement/i);

    // …and the pick is VISIBLY the chosen one, not merely `aria-pressed`. A
    // pressed `nm-button-ghost` changed only its fill, over a ground it
    // matched to 1.03:1, identically on hover and invisibly under
    // `forced-colors` — so the one signal that a judgement registered could
    // not be seen. jsdom measures no colour, so what is pinned here is that
    // the chosen side wears the design system's named selected recipe and its
    // siblings do not.
    const chosen = within(group).getByRole('radio', { name: 'Candidate' });
    const sibling = within(group).getByRole('radio', { name: 'Live' });
    expect(chosen.className).toMatch(/nm-pill-active/);
    expect(sibling.className).not.toMatch(/nm-pill-active/);
    expect(chosen.className).not.toBe(sibling.className);
  });

  it('wires the four bare labels to the visible caption that explains them', async () => {
    // Without it "Live" is the entire accessible name of twenty buttons.
    mockApi({});
    renderSection();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    const rows = await screen.findAllByTestId('shadow-compare-disagreement');
    const row = rows[0]!;
    const caption = within(row).getByText('Which answered better?');
    expect(caption.id).toBeTruthy();
    for (const name of ['Live', 'Candidate', 'Neither', 'Both']) {
      expect(within(row).getByRole('radio', { name })).toHaveAttribute(
        'aria-describedby',
        caption.id,
      );
    }
    // The group's own name still carries the query, so the twenty groups are
    // tellable apart.
    expect(
      within(row).getByRole('radiogroup', { name: /how to configure sync/ }),
    ).toBeInTheDocument();
  });

  it('a heavily thinned sample states its share with more weight than a clean run\'s note', async () => {
    // The run may skip up to half its sample and still publish. At 2% the
    // neutral one-liner is right; at 44% the coverage is part of the claim,
    // and it read with exactly the same emphasis. Neutral either way — amber
    // stays reserved for a failed run.
    mockApi({ run: { result: { ...COMPLETED_RESULT, sampledQueryCount: 50, failedQueries: 22 } } });
    renderSection();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    const note = await screen.findByTestId('shadow-compare-failed-queries');
    expect(note).toHaveTextContent(/22 of 50 sampled queries were skipped/i);
    expect(note).toHaveTextContent(/44%/);
    expect(note.className).toMatch(/font-medium/);
    expect(note.className).not.toMatch(/warning|destructive/);
  });

  it('a pending pick never disables the judgement buttons — focus survives the POST', async () => {
    // In Chromium, disabling the focused element drops focus to <body>;
    // `disabled={judging}` would make a keyboard admin re-Tab from the top
    // of the panel after every one of the ~20 picks the verdict needs. jsdom
    // does not blur on disable, so the falsifiable property here is the
    // ABSENCE of `disabled` — and that the row announces itself as busy
    // rather than unavailable, since every click is still recorded.
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
        verdict: { ...EMPTY_VERDICT, judgementCount: 1, scoredJudgementCount: 1, candidateBetter: 1 },
      },
    });
    renderSection();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    const rows = await screen.findAllByTestId('shadow-compare-disagreement');
    const group = within(rows[0]!).getByRole('radiogroup', { name: /how to configure sync/ });
    const candidateBtn = within(group).getByRole('radio', { name: 'Candidate' });
    const judgementPosts = () =>
      capture.filter((c) => c.method === 'POST' && c.url.includes('/judgements')).length;

    candidateBtn.focus();
    fireEvent.click(candidateBtn);
    await waitFor(() => expect(group).toHaveAttribute('aria-busy', 'true'));
    for (const name of ['Live', 'Candidate', 'Neither', 'Both']) {
      expect(within(group).getByRole('radio', { name })).not.toBeDisabled();
    }
    expect(candidateBtn).toHaveFocus();
    // The pick reads back immediately, before the round trip: what the admin
    // sees always matches what they clicked.
    expect(candidateBtn).toHaveAttribute('aria-checked', 'true');

    // A REPEAT of the pick already showing changes nothing — the double-click.
    expect(judgementPosts()).toBe(1);
    fireEvent.click(candidateBtn);
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(judgementPosts()).toBe(1);

    release();
    await waitFor(() => expect(group).not.toHaveAttribute('aria-busy'));
    expect(candidateBtn).toHaveAttribute('aria-checked', 'true');
    // …and a change of mind still posts.
    fireEvent.click(within(group).getByRole('radio', { name: 'Live' }));
    await waitFor(() => expect(judgementPosts()).toBe(2));
  });

  it('two identical picks landing before React re-renders post once — the gate is synchronous (r3)', async () => {
    // A real double-click runs both activations before TanStack's async
    // pending notification lands, so a guard reading a RENDERED value would
    // still double-POST. The gate must be synchronous.
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
        verdict: { ...EMPTY_VERDICT, judgementCount: 1, scoredJudgementCount: 1, candidateBetter: 1 },
      },
    });
    renderSection();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    const rows = await screen.findAllByTestId('shadow-compare-disagreement');
    const group = within(rows[0]!).getByRole('radiogroup', { name: /how to configure sync/ });
    const candidateBtn = within(group).getByRole('radio', { name: 'Candidate' });

    fireEvent.click(candidateBtn);
    fireEvent.click(candidateBtn);
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(capture.filter((c) => c.method === 'POST' && c.url.includes('/judgements'))).toHaveLength(1);

    release();
    await waitFor(() => expect(candidateBtn).toHaveAttribute('aria-checked', 'true'));
  });

  it('a deliberate pick on ANOTHER row mid-save is recorded, not silently dropped', async () => {
    // One shared in-flight flag guarding every row meant the second of two
    // deliberate picks vanished with no feedback at all: the admin believes
    // twenty rows are judged, the table holds fewer, and the verdict's N can
    // never be reconciled with what they clicked. Writes are serialised (two
    // concurrent POSTs race in the cache), but the click is QUEUED.
    const capture: Array<{ url: string; method: string; body?: string }> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockApi({
      capture,
      judgementGate: gate,
      judgementResponses: [
        {
          judgements: { 'query-1': 'candidate' },
          verdict: { ...EMPTY_VERDICT, judgementCount: 1, scoredJudgementCount: 1, candidateBetter: 1 },
        },
        {
          judgements: { 'query-1': 'candidate', 'query-2': 'live' },
          verdict: {
            ...EMPTY_VERDICT,
            judgementCount: 2,
            scoredJudgementCount: 2,
            candidateBetter: 1,
            liveBetter: 1,
          },
        },
      ],
    });
    renderSection();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    const rows = await screen.findAllByTestId('shadow-compare-disagreement');
    const first = within(rows[0]!).getByRole('radiogroup', { name: /how to configure sync/ });
    const second = within(rows[1]!).getByRole('radiogroup', { name: /reset password/ });
    const judgementPosts = () =>
      capture.filter((c) => c.method === 'POST' && c.url.includes('/judgements'));

    fireEvent.click(within(first).getByRole('radio', { name: 'Candidate' }));
    await waitFor(() => expect(first).toHaveAttribute('aria-busy', 'true'));

    // The second row's pick lands while the first is still saving.
    fireEvent.click(within(second).getByRole('radio', { name: 'Live' }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    // Serialised: still one POST in flight…
    expect(judgementPosts()).toHaveLength(1);
    // …but the pick is already visible, so nothing looks lost.
    expect(within(second).getByRole('radio', { name: 'Live' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    release();
    // …and it is genuinely sent once the first write settles.
    await waitFor(() => expect(judgementPosts()).toHaveLength(2));
    expect(judgementPosts()[1]!.body).toBe(JSON.stringify({ queryId: 'query-2', side: 'live' }));
    await waitFor(() =>
      expect(screen.getByTestId('shadow-compare-verdict')).toHaveTextContent(/2 judgements/i),
    );
  });

  it('renders stored judgements as pressed on load, and names N-of-20 instead of quoting a premature p', async () => {
    mockApi({
      judgements: { 'query-2': 'live' },
      verdict: {
        ...EMPTY_VERDICT,
        judgementCount: 5,
        scoredJudgementCount: 5,
        liveBetter: 3,
        candidateBetter: 2,
        mcnemar: { wins: 2, losses: 3, pValue: null, significant: false, direction: 'none' },
      },
    });
    renderSection();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    const rows = await screen.findAllByTestId('shadow-compare-disagreement');
    const group = within(rows[1]!).getByRole('radiogroup', { name: /reset password/ });
    await waitFor(() => {
      expect(within(group).getByRole('radio', { name: 'Live' })).toHaveAttribute('aria-checked', 'true');
    });
    const verdict = screen.getByTestId('shadow-compare-verdict').textContent ?? '';
    expect(verdict).toMatch(/5 judgements/i);
    expect(verdict).toMatch(/candidate better on 2/i);
    expect(verdict).toMatch(/live better on 3/i);
    expect(verdict).toMatch(/5 of 20 live-or-candidate picks/i);
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
    // Recall and MRR are the two most legible quality numbers this surface
    // has, the backend computes and ships both, and the runbook's go/no-go
    // step promises them beside the p — they were on the wire and rendered
    // nowhere (r2).
    const metrics = screen.getByTestId('shadow-compare-verdict-metrics');
    expect(metrics).toHaveTextContent(/recall/i);
    expect(metrics).toHaveTextContent(/0\.40/);
    expect(metrics).toHaveTextContent(/0\.95/);
    expect(metrics).toHaveTextContent(/MRR/);
    expect(metrics).toHaveTextContent(/0\.35/);
    expect(metrics).toHaveTextContent(/0\.90/);
    // A measurement, so neutral — never a status hue.
    expect(metrics.className).not.toMatch(/warning|destructive|success|primary/);
  });

  it('withholds Recall and MRR below the p-value floor, exactly as it withholds the p', async () => {
    // Both come from the same scored picks. Quoting them under a withheld p
    // would publish the quality half of a verdict the server has declined to
    // state, on the surface a swap decision is made from.
    mockApi({
      verdict: {
        ...EMPTY_VERDICT,
        judgementCount: 5,
        scoredJudgementCount: 5,
        candidateBetter: 5,
        mcnemar: { wins: 5, losses: 0, pValue: null, significant: false, direction: 'none' },
        recall: { live: 0.4, candidate: 0.95 },
        mrr: { live: 0.35, candidate: 0.9 },
      },
    });
    renderSection();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    await screen.findByTestId('shadow-compare-result');
    await screen.findByTestId('shadow-compare-verdict');
    expect(screen.queryByTestId('shadow-compare-verdict-metrics')).toBeNull();
  });

  it('re-attaches to this admin\'s latest comparison on mount, without a start', async () => {
    // The run id is component state and a comparison outlives a tab switch,
    // a route change and a reload. With no lookup the finished report, its
    // disagreement list and the whole Mode 2 workflow are unreachable while
    // the run still holds the one-active slot against a replacement.
    const capture: Array<{ url: string; method: string; body?: string }> = [];
    mockApi({ capture, latestRun: { id: 'run-1', status: 'completed' } });
    renderSection();

    expect(await screen.findByTestId('shadow-compare-result')).toBeInTheDocument();
    expect(capture.some((c) => c.method === 'POST')).toBe(false);
  });

  it('a number field can be cleared and retyped — clamping happens on blur, not per keystroke', async () => {
    // `value || min` treated a cleared field (Number('') === 0) as "use the
    // minimum" and rewrote it, so backspacing 50 → '' gave 1 and typing 25
    // after it gave 125 → clamped to 100, the opposite of the intent.
    const capture: Array<{ url: string; method: string; body?: string }> = [];
    mockApi({ capture });
    renderSection();
    const queries = screen.getByTestId('shadow-compare-limit') as HTMLInputElement;

    fireEvent.change(queries, { target: { value: '' } });
    expect(queries.value).toBe('');
    fireEvent.change(queries, { target: { value: '2' } });
    fireEvent.change(queries, { target: { value: '25' } });
    expect(queries.value).toBe('25');

    // Out of range is still corrected — at the boundary, not under the caret.
    fireEvent.change(queries, { target: { value: '400' } });
    fireEvent.blur(queries);
    expect(queries.value).toBe('100');

    // An empty field at submit falls back to the minimum rather than 0.
    fireEvent.change(queries, { target: { value: '' } });
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    await waitFor(() => {
      const post = capture.find((c) => c.method === 'POST');
      expect(post?.body).toBe(JSON.stringify({ days: 30, limit: 1, topK: 10 }));
    });
  });

  it('states how many sampled queries were skipped, so the denominator is never silently thinned', async () => {
    mockApi({
      run: {
        result: { ...COMPLETED_RESULT, sampledQueryCount: 50, failedQueries: 1 },
      },
    });
    renderSection();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    const note = await screen.findByTestId('shadow-compare-failed-queries');
    expect(note).toHaveTextContent(/1 of 50 sampled query was skipped/i);
    // Neutral AND quiet at a small share: a coverage measurement, not a
    // warning state, and not competing with the figures it qualifies.
    expect(note.className).toMatch(/muted-foreground/);
    expect(note.className).not.toMatch(/warning|destructive/);
  });

  it('counts the SCORED picks against the p-value floor, not every stored judgement', async () => {
    // 20 stored judgements of which six are picks: the server withholds the
    // p, and "20 of 20" beside a withheld p reads as a server bug.
    mockApi({
      verdict: {
        ...EMPTY_VERDICT,
        judgementCount: 20,
        scoredJudgementCount: 6,
        candidateBetter: 6,
        both: 14,
        mcnemar: { wins: 6, losses: 0, pValue: null, significant: false, direction: 'none' },
      },
    });
    renderSection();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    await screen.findByTestId('shadow-compare-result');
    const verdict = await screen.findByTestId('shadow-compare-verdict');
    expect(verdict).toHaveTextContent(/6 of 20 live-or-candidate picks/i);
    expect(verdict).not.toHaveTextContent(/20 of 20/);
    expect(verdict).not.toHaveTextContent(/p =/);
  });

  it('keeps a started run across an unmount and remount on the APP\'s QueryClient', async () => {
    // The section unmounts on a Settings sub-tab switch (SubTabs renders only
    // the active tab). The app client keeps an unobserved entry for five
    // minutes and `staleTime: Infinity` suppressed the refetch, so the first
    // mount's `{ run: null }` was served back to the second one: no run, no
    // progress, no Mode 2 workflow, and a re-enabled Run that then 409s. Only
    // a full reload recovered. `renderSection()` builds a FRESH client per
    // render and cannot see this, so this case shares one client on purpose.
    let latestCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/compare') && method === 'GET') {
        latestCalls += 1;
        return new Response(JSON.stringify({ run: null }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/compare') && method === 'POST') {
        return new Response(JSON.stringify({ runId: 'run-1', status: 'queued' }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/compare/') && method === 'GET' && !url.includes('/judgements')) {
        return new Response(
          JSON.stringify({
            id: 'run-1',
            status: 'running',
            progressDone: 2,
            progressTotal: 5,
            error: null,
            result: null,
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    });

    const shared = createQueryClient();
    const ui = (
      <QueryClientProvider client={shared}>
        <EmbeddingShadowCompareSection candidateModel="qwen3-embedding:4b" />
      </QueryClientProvider>
    );
    const first = render(ui);
    await waitFor(() => expect(latestCalls).toBe(1));
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    // The seeded `queued · 0/?` renders on the 202 itself (r1); the server's
    // own counts replace it on the first poll.
    await waitFor(() =>
      expect(screen.getByTestId('shadow-compare-progress')).toHaveTextContent('2/5'),
    );

    first.unmount();
    render(ui);

    expect(await screen.findByTestId('shadow-compare-progress')).toHaveTextContent('2/5');
    expect(screen.getByTestId('shadow-compare-start')).toBeDisabled();
    // …and the lookup is re-asked, so a run started in another tab is found
    // too rather than being masked by an infinitely fresh cache entry.
    await waitFor(() => expect(latestCalls).toBe(2));
  });

  it('reports a failed re-attachment lookup instead of reading it as "no earlier comparison"', async () => {
    // Absence would silently hide a finished report, its disagreement list and
    // an accumulated Mode 2 workflow — and a re-run costs another N x 2
    // provider calls. Muted, not amber: nothing is wrong with the migration.
    mockApi({ latestError: true });
    renderSection();
    const notice = await screen.findByTestId('shadow-compare-latest-error');
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice.className).not.toMatch(/warning|destructive/);
    expect(notice).toHaveTextContent(/could not check/i);
    expect(screen.getByTestId('shadow-compare-start')).not.toBeDisabled();
  });

  it('a poll failure on a run ADOPTED on mount leaves Run available', async () => {
    // `pollUnavailable` used to fire for any runId, so one transient 500 on a
    // comparison that finished last week disabled the section's only action
    // under copy claiming "it may still be running".
    mockApi({ latestRun: { id: 'old-run', status: 'completed' }, pollError: true });
    renderSection();
    const notice = await screen.findByTestId('shadow-compare-adopted-error');
    expect(notice).toHaveTextContent(/could not be loaded/i);
    expect(notice.className).not.toMatch(/warning|destructive/);
    expect(screen.queryByTestId('shadow-compare-poll-error')).toBeNull();
    expect(screen.getByTestId('shadow-compare-start')).not.toBeDisabled();
  });

  it('a comparison that failed in an EARLIER sitting is stated quietly, never in standing amber', async () => {
    // Adopted on every fresh mount, this strip would stand in amber until the
    // admin happened to start another comparison — the permanent-banner
    // pattern ADR-010 rules against.
    mockApi({
      latestRun: {
        id: 'old-run',
        status: 'failed',
        result: null,
        error: 'The comparison worker stopped before the run completed. Start a new comparison.',
      },
      run: {
        status: 'failed',
        result: null,
        error: 'The comparison worker stopped before the run completed. Start a new comparison.',
      },
    });
    renderSection();
    const quiet = await screen.findByTestId('shadow-compare-error-adopted');
    expect(quiet).toHaveTextContent(/worker stopped/i);
    expect(quiet.className).toMatch(/muted-foreground/);
    expect(quiet.className).not.toMatch(/warning/);
    expect(screen.queryByTestId('shadow-compare-error')).toBeNull();
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

  it('also TOASTS the failure of a run started here, because the strip lives inside a branch that is about to unmount (r3)', async () => {
    // The section renders only while the migration is `ready`. The card's own
    // 5s status poll races this one, so a migration swapped or aborted from
    // another tab takes the whole branch — strip included — away within a poll
    // of the run failing. A toast renders at the app root and outlives that.
    const message =
      'The shadow migration changed while the comparison ran (swap, abort or rollback) — start a new comparison from the current migration';
    mockApi({ run: { status: 'failed', result: null, error: message } });
    renderSection();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    await screen.findByTestId('shadow-compare-error');
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith(message));
    // Once per run, not once per poll — the poll keeps answering `failed`.
    expect(vi.mocked(toast.error).mock.calls.filter(([m]) => m === message)).toHaveLength(1);
  });

  it('a failure ADOPTED on mount is not toasted — it is history, not news', async () => {
    mockApi({
      latestRun: { id: 'old-run', status: 'failed', result: null, error: 'it failed' },
      run: { status: 'failed', result: null, error: 'it failed' },
    });
    renderSection();
    await screen.findByTestId('shadow-compare-error-adopted');
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it('reports an in-flight run UP to the card, and clears it when the run settles (r3)', async () => {
    // The card is the only surface that survives its own Abort/Swap, so it is
    // the one that must know a comparison was running when the migration
    // moved. Without this the run's failure has nowhere to appear at all.
    const seen: Array<string | null> = [];
    mockApi({
      runSequence: [
        { status: 'running', progressDone: 7, progressTotal: 16, result: null },
        { status: 'completed' },
      ],
    });
    renderSection({ onRunInFlightChange: (id) => seen.push(id) });
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    await waitFor(() => expect(seen).toContain('run-1'));
    await screen.findByTestId('shadow-compare-progress');
    // The poll's second answer completes the run; the card must stop
    // attributing an in-flight comparison to a lifecycle action after that.
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['shadow-compare', 'run-1'] });
    });
    await waitFor(() => expect(seen[seen.length - 1]).toBeNull());
  });

  it('a run ADOPTED on mount and still running is reported as in-flight too (r1)', async () => {
    // Provenance is the wrong test here, and gating on it made the whole
    // reporting channel dead on exactly the path re-attachment exists for: a
    // Settings sub-tab switch, a route change or a reload re-adopts a live
    // comparison, and the admin's next Abort then ended it with no toast, no
    // strip and no progress line anywhere. `GET …/compare` resolves through
    // `latestBenchmarkRun(..., requestedBy, ...)`, whose SQL is
    // `WHERE requested_by = $1`, so an adopted run is ALWAYS this admin's own
    // — the card's sentence can never blame them for someone else's run.
    const seen: Array<string | null> = [];
    mockApi({
      latestRun: { id: 'old-run', status: 'running', progressDone: 2, progressTotal: 9, result: null },
      run: { id: 'old-run', status: 'running', progressDone: 2, progressTotal: 9, result: null },
    });
    renderSection({ onRunInFlightChange: (id) => seen.push(id) });
    await screen.findByTestId('shadow-compare-progress');
    await waitFor(() => expect(seen).toContain('old-run'));
  });

  it('a run adopted on mount that has already SETTLED is never reported as in-flight', async () => {
    // The invariant that actually matters: only a queued/running run arms the
    // card's warning, or a week-old finished report would make every Abort
    // claim it ended a comparison.
    const seen: Array<string | null> = [];
    mockApi({
      latestRun: { id: 'old-run', status: 'completed' },
      run: { id: 'old-run', status: 'completed' },
    });
    renderSection({ onRunInFlightChange: (id) => seen.push(id) });
    await screen.findByTestId('shadow-compare-result');
    expect(seen.every((id) => id === null)).toBe(true);
  });

  it('arms the in-flight report on the 202, before the first status poll answers (r1)', async () => {
    // Between the POST's 202 and the first GET resolving, `run` was undefined:
    // Run re-enabled, no progress line rendered, a second click fired a
    // duplicate POST the server 409s, and an Abort in that window produced no
    // warning at all — the whole reporting channel bypassed by the window it
    // is needed in most.
    const seen: Array<string | null> = [];
    let releaseFirstPoll = () => {};
    const firstPoll = new Promise<void>((resolve) => {
      releaseFirstPoll = resolve;
    });
    let posts = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = init?.method ?? 'GET';
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/judgements')) return json({ judgements: {}, verdict: EMPTY_VERDICT });
      if (url.includes('/compare/') && method === 'GET') {
        await firstPoll;
        return json({ id: 'run-1', status: 'running', progressDone: 1, progressTotal: 4, error: null, result: null });
      }
      if (url.endsWith('/compare') && method === 'GET') return json({ run: null });
      if (url.includes('/compare') && method === 'POST') {
        posts += 1;
        return json({ runId: 'run-1' }, 202);
      }
      return json({});
    });
    renderSection({ onRunInFlightChange: (id) => seen.push(id) });
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Comparison started'));

    // Still inside the window — the first status GET has not answered.
    expect(seen).toContain('run-1');
    expect(screen.getByTestId('shadow-compare-progress')).toBeInTheDocument();
    expect(screen.getByTestId('shadow-compare-start')).toBeDisabled();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    expect(posts).toBe(1);
    releaseFirstPoll();
  });

  it('toasts and ambers a failure the section WATCHED happen on an adopted run (r1)', async () => {
    // Adopted-already-failed is history and stays quiet. A run that was
    // showing live progress one poll earlier is news by any reading, and it is
    // the run whose N x 2 embedding calls were just spent.
    const message = 'The shadow migration changed while the comparison ran — start a new comparison';
    mockApi({
      latestRun: { id: 'old-run', status: 'running', progressDone: 2, progressTotal: 9, result: null },
      runSequence: [
        { id: 'old-run', status: 'running', progressDone: 2, progressTotal: 9, result: null },
        { id: 'old-run', status: 'failed', result: null, error: message },
      ],
    });
    renderSection();
    await screen.findByTestId('shadow-compare-progress');
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['shadow-compare', 'old-run'] });
    });
    const strip = await screen.findByTestId('shadow-compare-error');
    expect(strip.className).toMatch(/warning/);
    expect(screen.queryByTestId('shadow-compare-error-adopted')).toBeNull();
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith(message));
  });

  it('announces the completed report politely — every failure on this surface already announces', async () => {
    // A run takes minutes. Without this a screen-reader admin hears
    // "Comparison started", then silence, and nothing when four metric chips,
    // the disagreement list and the whole Mode 2 workflow appear. Polite, not
    // an alert: a finished measurement is not worth interrupting for.
    mockApi({});
    renderSection();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    const done = await screen.findByTestId('shadow-compare-complete');
    expect(done).toHaveAttribute('role', 'status');
    expect(done.textContent).toMatch(/complete/i);
    expect(done.textContent).toMatch(/5/);
    expect(done.textContent).toMatch(/4/);
  });

  it('marks the pages unique to each side, so the admin does not diff two lists by eye (r3)', async () => {
    mockApi({});
    renderSection();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    const rows = await screen.findAllByTestId('shadow-compare-disagreement');
    // query-1: live [Sync setup, Spaces] vs candidate [Sync troubleshooting, Spaces].
    const first = rows[0]!;
    const unique = within(first)
      .getAllByRole('listitem')
      .filter((li) => li.dataset.unique === 'true')
      .map((li) => li.textContent);
    expect(unique).toHaveLength(2);
    expect(unique.join(' ')).toMatch(/Sync setup/);
    expect(unique.join(' ')).toMatch(/Sync troubleshooting/);
    // `Spaces` is on both sides and must NOT be marked.
    expect(unique.join(' ')).not.toMatch(/Spaces/);
    // The marker is WORDS, not a hue or a rule: `forced-colors` flattens both
    // inks to CanvasText and a colour-blind reader sees one grey.
    expect(within(first).getAllByText(/\(only here\)/).length).toBe(2);
    // …and the side header counts them, so the movement reads without a scan.
    expect(within(first).getByText(/Live · bge-m3 · 1 only here/)).toBeInTheDocument();

    // query-2 is a pure REORDER — same set both sides. Nothing is unique, and
    // marking a reorder as a set change would misdescribe it.
    const second = rows[1]!;
    expect(
      within(second).getAllByRole('listitem').filter((li) => li.dataset.unique === 'true'),
    ).toHaveLength(0);
    expect(within(second).queryByText(/only here/)).toBeNull();
  });

  it('caps the disagreement list and expands it on request (r3)', async () => {
    // 100 queries x 20 titles a side is ~4000 lines inside a settings card,
    // which puts the migration's own Swap and Abort thousands of pixels above
    // the fold. Twelve rows is enough to see the cap engage.
    const queries = Array.from({ length: 12 }, (_, i) => ({
      id: `q-${i}`,
      query: `query number ${i}`,
      top1Changed: true,
      jaccard: 0.5,
      rbo: 0.4,
      live: { pageIds: [100 + i], pages: [{ pageId: 100 + i, title: `Live ${i}`, spaceKey: null }] },
      candidate: {
        pageIds: [200 + i],
        pages: [{ pageId: 200 + i, title: `Candidate ${i}`, spaceKey: null }],
      },
    }));
    mockApi({
      run: {
        result: {
          ...COMPLETED_RESULT,
          queryCount: 12,
          agreement: { ...COMPLETED_RESULT.agreement, queryCount: 12, disagreementCount: 12 },
          queries,
        },
      },
    });
    renderSection();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    await waitFor(() =>
      expect(screen.getAllByTestId('shadow-compare-disagreement')).toHaveLength(10),
    );
    // The total is never hidden — the chip above already states it.
    expect(screen.getByTestId('shadow-compare-result')).toHaveTextContent(/12\/12/);
    const showAll = screen.getByTestId('shadow-compare-show-all');
    expect(showAll).toHaveTextContent(/Show all 12 disagreements/);
    fireEvent.click(showAll);
    expect(screen.getAllByTestId('shadow-compare-disagreement')).toHaveLength(12);
    fireEvent.click(screen.getByTestId('shadow-compare-show-all'));
    expect(screen.getAllByTestId('shadow-compare-disagreement')).toHaveLength(10);
  });

  it('offers no expander when everything already fits', async () => {
    mockApi({});
    renderSection();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    await screen.findAllByTestId('shadow-compare-disagreement');
    expect(screen.queryByTestId('shadow-compare-show-all')).toBeNull();
  });

  it('the four sides are ONE radio group with one tab stop, and arrows move focus without recording a judgement (r3)', async () => {
    const capture: Array<{ url: string; method: string; body?: string }> = [];
    mockApi({ capture });
    renderSection();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    const rows = await screen.findAllByTestId('shadow-compare-disagreement');
    const group = within(rows[0]!).getByRole('radiogroup', { name: /how to configure sync/ });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(4);
    // Four `aria-pressed` toggles announced four independent switches and put
    // four tab stops on every disagreeing row — ten rows was forty stops
    // between the report and the migration's Swap and Abort.
    expect(radios.filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(radios[0]).toHaveAttribute('tabindex', '0');

    radios[0]!.focus();
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(radios[1]);
    fireEvent.keyDown(group, { key: 'End' });
    expect(document.activeElement).toBe(radios[3]);
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(radios[0]);
    // Selection does NOT follow focus: every selection is a POST that becomes
    // a row in the McNemar count, so arrowing across twenty rows would record
    // judgements nobody made.
    expect(capture.filter((c) => c.method === 'POST' && c.url.includes('/judgements'))).toHaveLength(
      0,
    );
    for (const radio of radios) expect(radio).toHaveAttribute('aria-checked', 'false');
  });

  it('the chosen side carries a SHAPE channel, not only a fill (r3)', async () => {
    // `nm-pill-active` on a `bg-muted` track measures 1.07:1 in Graphite and
    // 1.11:1 in Paper, and even its ink step is 2.06:1 in Graphite — all under
    // WCAG 1.4.11's 3:1. A glyph survives forced-colors, colour blindness and
    // a retune of every token. jsdom measures no colour; what is pinned is
    // that a non-text marker exists on the chosen side and only there.
    mockApi({
      judgements: { 'query-1': 'candidate' },
      verdict: { ...EMPTY_VERDICT, judgementCount: 1, candidateBetter: 1 },
    });
    renderSection();
    fireEvent.click(screen.getByTestId('shadow-compare-start'));
    const rows = await screen.findAllByTestId('shadow-compare-disagreement');
    const group = within(rows[0]!).getByRole('radiogroup', { name: /how to configure sync/ });
    await waitFor(() =>
      expect(within(group).getByRole('radio', { name: 'Candidate' })).toHaveAttribute(
        'aria-checked',
        'true',
      ),
    );
    const chosen = within(group).getByRole('radio', { name: 'Candidate' });
    const sibling = within(group).getByRole('radio', { name: 'Live' });
    expect(chosen.querySelector('svg')).not.toBeNull();
    expect(sibling.querySelector('svg')).toBeNull();
    // The glyph is decoration for a state `aria-checked` already carries, so
    // it must not be announced a second time.
    expect(chosen.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    // The chosen radio is also the group's single tab stop.
    expect(chosen).toHaveAttribute('tabindex', '0');
    expect(sibling).toHaveAttribute('tabindex', '-1');
  });
});
