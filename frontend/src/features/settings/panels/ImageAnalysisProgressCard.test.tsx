import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ImageAnalysisStatus } from '@compendiq/contracts';
import { ImageAnalysisProgressCard } from './ImageAnalysisProgressCard';
import { imageAnalysisCoverage } from './image-analysis-coverage';
import { EmbeddingTab } from './EmbeddingTab';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

/**
 * #1618 (ADR-027 Stage 1) — the Embeddings-tab image analysis card.
 *
 * Fetch is mocked at the network boundary; the card runs its real logic.
 * Pinned here: the three fetch states, the pause-not-purge copy, the
 * partial-versus-awaiting-embed distinction, disclosure BEFORE a bulk
 * re-analysis, the ADR-010 colour rule, focus retention on retry, and the
 * draft isolation an unrelated tab depends on. Nothing here asserts wiring,
 * field copies or source text.
 */

let queryClient: QueryClient;

function renderCard() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ImageAnalysisProgressCard />
    </QueryClientProvider>,
  );
}

const NO_SKIPS: ImageAnalysisStatus['skipReasons'] = {
  missing: 0,
  unsupported: 0,
  oversized: 0,
  tooLarge: 0,
  external: 0,
  capped: 0,
};

const NO_ROWS: ImageAnalysisStatus['rows'] = {
  analyzed: 0,
  stale: 0,
  pending: 0,
  failed: 0,
  terminal: 0,
  skipped: 0,
};

const IDENTITY = {
  providerId: '00000000-0000-4000-8000-000000000001',
  model: 'Qwen/Qwen3-VL-8B-Instruct',
  baseUrl: 'http://vision.internal/v1',
  identityHash: 'a'.repeat(64),
  assignedAt: '2026-09-15T00:00:00.000Z',
};

function status(over: Partial<ImageAnalysisStatus> = {}): ImageAnalysisStatus {
  return {
    assigned: true,
    retainedIdentity: IDENTITY,
    identityMatchesAssignment: true,
    rows: { ...NO_ROWS, analyzed: 40 },
    skipReasons: NO_SKIPS,
    dirtyPages: 0,
    pagesAwaitingEmbed: 0,
    running: false,
    lastRun: null,
    ...over,
  };
}

function lastRun(over: Partial<NonNullable<ImageAnalysisStatus['lastRun']>> = {}) {
  return {
    at: '2026-09-16T08:00:00.000Z',
    processed: 3,
    reused: 1,
    skipped: 0,
    failed: 0,
    terminal: 0,
    repended: 0,
    returned: 0,
    reopened: 0,
    reconciledPages: 0,
    removed: 0,
    pagesFailed: 0,
    unreadableRefs: 0,
    ...over,
  };
}

interface MockOptions {
  statusResponse?: ImageAnalysisStatus;
  /** Make the status GET fail. */
  statusFails?: boolean;
  /** Later GETs, in order, after the first. */
  sequence?: ImageAnalysisStatus[];
  actionResult?: { rows?: number; started: boolean; alreadyRunning: boolean };
  capture?: Array<{ url: string; method: string }>;
}

function mockApi(opts: MockOptions = {}) {
  let call = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = init?.method ?? 'GET';
    opts.capture?.push({ url, method });
    if (url.includes('/admin/embedding/image-analysis') && method === 'GET') {
      if (opts.statusFails) return new Response('boom', { status: 500 });
      const body = opts.sequence
        ? (opts.sequence[Math.min(call++, opts.sequence.length - 1)] ?? status())
        : (opts.statusResponse ?? status());
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/admin/embedding/image-analysis') && method === 'POST') {
      return new Response(
        JSON.stringify(opts.actionResult ?? { rows: 12, started: true, alreadyRunning: false }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }
    // Everything else the Embeddings tab asks for (admin settings).
    return new Response(JSON.stringify({ embeddingChunkSize: 500, embeddingChunkOverlap: 50 }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.restoreAllMocks();
  queryClient?.clear();
});

describe('corpus coverage', () => {
  it('reads partial while any analysis is still outstanding, and complete only once none is', () => {
    expect(imageAnalysisCoverage({ rows: NO_ROWS, skipReasons: NO_SKIPS })).toBe('none');
    expect(
      imageAnalysisCoverage({ rows: { ...NO_ROWS, analyzed: 5 }, skipReasons: NO_SKIPS }),
    ).toBe('complete');
    expect(
      imageAnalysisCoverage({ rows: { ...NO_ROWS, analyzed: 5, pending: 1 }, skipReasons: NO_SKIPS }),
    ).toBe('partial');
    // A stale row is outstanding: valid to nobody until the sweep re-pends it.
    expect(
      imageAnalysisCoverage({ rows: { ...NO_ROWS, analyzed: 5, stale: 1 }, skipReasons: NO_SKIPS }),
    ).toBe('partial');
  });

  it('treats a missing image as a gap beside a valid row, and as a verdict alone', () => {
    // The page references evidence the index does not hold — `partial`.
    expect(
      imageAnalysisCoverage({
        rows: { ...NO_ROWS, analyzed: 5, skipped: 1 },
        skipReasons: { ...NO_SKIPS, missing: 1 },
      }),
    ).toBe('partial');
    // A policy or format skip is a decision already taken — still `complete`.
    expect(
      imageAnalysisCoverage({
        rows: { ...NO_ROWS, analyzed: 5, skipped: 1 },
        skipReasons: { ...NO_SKIPS, external: 1 },
      }),
    ).toBe('complete');
    // Alone, nothing is in the work window for it.
    expect(
      imageAnalysisCoverage({
        rows: { ...NO_ROWS, skipped: 1 },
        skipReasons: { ...NO_SKIPS, missing: 1 },
      }),
    ).toBe('skipped');
  });
});

describe('the three fetch states', () => {
  it('claims no number before the first payload lands', async () => {
    mockApi({ statusResponse: status() });
    renderCard();
    // Pre-fetch: em-dashes, not zeroes.
    expect(screen.getByTestId('image-analysis-counters').textContent).toContain('—');
    expect(screen.getByTestId('image-analysis-status')).toHaveTextContent(/Reading analysis status/);
    await waitFor(() =>
      expect(screen.getByTestId('image-analysis-counters').textContent).toContain('40'),
    );
  });

  it('says the status could not be READ, keeps the three actions live, and does not claim a run', async () => {
    mockApi({ statusFails: true });
    renderCard();

    await waitFor(() =>
      expect(screen.getByTestId('image-analysis-status')).toHaveTextContent(/could not be read/i),
    );
    const notice = screen.getByTestId('image-analysis-status');
    expect(notice).toHaveTextContent(/assignment and the stored analyses are unaffected/i);
    // A failed READ is a failure, not an attention state — destructive, not amber.
    expect(notice.className).toContain('text-destructive');
    expect(notice.className).not.toContain('text-warning');

    for (const id of ['image-analysis-process', 'image-analysis-retry-failed', 'image-analysis-reanalyze-all']) {
      expect(screen.getByTestId(id)).not.toHaveAttribute('aria-disabled');
    }
    expect(screen.queryByTestId('image-analysis-running')).toBeNull();
  });

  it('does not assert a run off a payload it can no longer observe', async () => {
    // First read says a batch is running; the refetch then fails. TanStack
    // retains the old data, but a record read through a failed GET claims
    // nothing — and the actions must not stay held on the strength of it.
    const fetchSpy = mockApi({ statusResponse: status({ running: true }) });
    renderCard();
    await waitFor(() => expect(screen.getByTestId('image-analysis-running')).toBeInTheDocument());

    fetchSpy.mockImplementation(async () => new Response('boom', { status: 500 }));
    await queryClient.refetchQueries({ queryKey: ['admin', 'image-analysis'] });

    await waitFor(() => expect(screen.queryByTestId('image-analysis-running')).toBeNull());
    expect(screen.getByTestId('image-analysis-process')).not.toHaveAttribute('aria-disabled');
  });

  it('keeps the retry control focusable and rehomes focus once the read succeeds', async () => {
    const fetchSpy = mockApi({ statusFails: true });
    renderCard();
    await waitFor(() => expect(screen.getByTestId('image-analysis-status-retry')).toBeInTheDocument());

    const retry = screen.getByRole('button', { name: /retry status read/i });
    retry.focus();
    expect(document.activeElement).toBe(retry);

    // The read succeeds on the retry, so the notice — with the pressed button
    // inside it — is removed. Focus must not fall to <body>.
    fetchSpy.mockImplementation(
      async () =>
        new Response(JSON.stringify(status()), { headers: { 'Content-Type': 'application/json' } }),
    );
    fireEvent.click(retry);

    await waitFor(() => expect(screen.queryByTestId('image-analysis-status-retry')).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId('image-analysis-status'));
  });

  it('refuses a press while a batch holds the lease, and never uses native disabled', async () => {
    const capture: Array<{ url: string; method: string }> = [];
    mockApi({ capture, statusResponse: status({ running: true }) });
    renderCard();
    await waitFor(() => expect(screen.getByTestId('image-analysis-running')).toBeInTheDocument());

    const process = screen.getByTestId('image-analysis-process');
    expect(process).toHaveAttribute('aria-disabled', 'true');
    // Native `disabled` would blur the focus the flag exists to hold.
    expect(process).not.toBeDisabled();

    fireEvent.click(process);
    expect(capture.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});

describe('what the card reports', () => {
  it('reports an unassigned instance as a pause and names the panel chain to fix it', async () => {
    mockApi({
      statusResponse: status({
        assigned: false,
        identityMatchesAssignment: null,
        rows: { ...NO_ROWS, analyzed: 12 },
      }),
    });
    renderCard();

    const line = await screen.findByText(/new analysis is paused, not purged/i);
    expect(line).toHaveTextContent(/still\s+valid stay searchable/i);
    expect(line).toHaveTextContent(/authored page text is\s+unaffected/i);
    // The remedy names the ROW and the full two-level panel chain, not a bare
    // tab name: `settings-wayfinding.test.ts` polices the chain against the
    // live rail, and a row name is not a third level of the settings IA.
    expect(line).toHaveTextContent(/Image analysis \(vision\) row/);
    expect(line).toHaveTextContent(/Settings → AI Models → LLM providers/);
    // A pause is a configuration, not an incident.
    expect(line.className).not.toContain('text-warning');
    expect(line.className).not.toContain('text-destructive');
    // No live pair, so nothing claims a mismatch either.
    expect(screen.queryByTestId('image-analysis-identity-mismatch')).toBeNull();
  });

  it('separates a partially analyzed corpus from one whose text embedding is merely pending', async () => {
    mockApi({
      statusResponse: status({
        rows: { ...NO_ROWS, analyzed: 40, pending: 4 },
        pagesAwaitingEmbed: 6,
      }),
    });
    renderCard();

    await waitFor(() =>
      expect(screen.getByTestId('image-analysis-status')).toHaveTextContent(
        /Some page images are described; the rest are still queued/i,
      ),
    );
    const embed = screen.getByTestId('image-analysis-awaiting-embed');
    expect(embed).toHaveTextContent(/6 pages analyzed, text embedding still pending/i);
    expect(embed).toHaveTextContent(/no\s+vision call is needed/i);
  });

  it('does not report an embedding backlog that does not exist', async () => {
    mockApi({ statusResponse: status({ pagesAwaitingEmbed: 0 }) });
    renderCard();
    await waitFor(() => expect(screen.getByTestId('image-analysis-counters')).toHaveTextContent('40'));
    expect(screen.queryByTestId('image-analysis-awaiting-embed')).toBeNull();
  });

  it('keeps stale rows out of the analyzed count', async () => {
    mockApi({ statusResponse: status({ rows: { ...NO_ROWS, analyzed: 30, stale: 7 } }) });
    renderCard();
    const counters = await screen.findByTestId('image-analysis-counters');
    await waitFor(() => expect(counters).toHaveTextContent('30'));
    expect(counters).toHaveTextContent('7');
  });

  it('names the skip reasons that fired and nothing else', async () => {
    mockApi({
      statusResponse: status({
        rows: { ...NO_ROWS, analyzed: 4, skipped: 3 },
        skipReasons: { ...NO_SKIPS, missing: 2, external: 1 },
      }),
    });
    renderCard();

    const skips = await screen.findByTestId('image-analysis-skip-reasons');
    expect(skips).toHaveTextContent(/2 missing from the store/);
    expect(skips).toHaveTextContent(/1 external URL/);
    expect(skips).not.toHaveTextContent(/unsupported/);
    // The one reason that is a gap rather than a decision says so.
    expect(skips).toHaveTextContent(/gap, not a policy decision/i);
  });

  it('reports a provider-side stop with its status, in amber', async () => {
    mockApi({
      statusResponse: status({ lastRun: lastRun({ processed: 0, reason: 'provider_status', httpStatus: 503 }) }),
    });
    renderCard();
    const stop = await screen.findByTestId('image-analysis-last-run-stop');
    expect(stop).toHaveTextContent(/vision endpoint answered 503/);
    expect(stop.className).toContain('text-warning');
  });

  it('reports a pause in the last run without an attention colour', async () => {
    mockApi({
      statusResponse: status({
        assigned: false,
        identityMatchesAssignment: null,
        lastRun: lastRun({ processed: 0, reason: 'unassigned', reconciledPages: 4 }),
      }),
    });
    renderCard();
    const stop = await screen.findByTestId('image-analysis-last-run-stop');
    expect(stop).toHaveTextContent(/Paused: no vision model is assigned/);
    expect(stop.className).not.toContain('text-warning');
    // The steps that did run are still reported.
    expect(screen.getByTestId('image-analysis-last-run-reconcile')).toHaveTextContent('4');
  });

  it('separates failed images from pages that could not be reconciled, and counts unreadable refs', async () => {
    mockApi({ statusResponse: status({ lastRun: lastRun({ failed: 2, pagesFailed: 1, unreadableRefs: 5 }) }) });
    renderCard();

    const failed = await screen.findByTestId('image-analysis-last-run-failed');
    expect(failed).toHaveTextContent(/2 images failed to analyze/);
    expect(failed.className).toContain('text-warning');

    const pages = screen.getByTestId('image-analysis-last-run-pages-failed');
    expect(pages).toHaveTextContent(/1 page could not\s+be reconciled/i);
    expect(pages).toHaveTextContent(/5 images present but unreadable/);
    expect(pages.className).toContain('text-warning');
  });

  it('warns when the stored analyses belong to a different model than the one assigned', async () => {
    mockApi({ statusResponse: status({ identityMatchesAssignment: false }) });
    renderCard();
    const strip = await screen.findByTestId('image-analysis-identity-mismatch');
    expect(strip).toHaveTextContent(/no new image is being analyzed/i);
    expect(strip).toHaveTextContent(/Re-check on the Image analysis row under\s+Settings → AI Models → LLM providers/);
    expect(strip.className).toContain('text-warning');
  });

  it('renders every measurement neutral when nothing needs attention', async () => {
    mockApi({ statusResponse: status({ lastRun: lastRun() }) });
    const { container } = renderCard();
    await waitFor(() => expect(screen.getByTestId('image-analysis-counters')).toHaveTextContent('40'));
    expect(container.querySelectorAll('.text-warning')).toHaveLength(0);
  });
});

describe('the three actions', () => {
  it('discloses the scope before a bulk re-analysis, and only posts once confirmed', async () => {
    const capture: Array<{ url: string; method: string }> = [];
    mockApi({
      capture,
      statusResponse: status({ rows: { ...NO_ROWS, analyzed: 30, stale: 5, failed: 2, terminal: 1 } }),
      actionResult: { rows: 38, started: true, alreadyRunning: false },
    });
    renderCard();
    await waitFor(() => expect(screen.getByTestId('image-analysis-counters')).toHaveTextContent('30'));

    fireEvent.click(screen.getByTestId('image-analysis-reanalyze-all'));

    // Analyzed + stale + failed + given up: the rows the action re-pends.
    const dialog = await screen.findByTestId('confirm-dialog');
    expect(dialog).toHaveTextContent(/re-analyzes 38 images — one vision call each/i);
    expect(dialog).toHaveTextContent(/clears their stored descriptions first/i);
    expect(dialog).toHaveTextContent(/Authored page text stays searchable/i);
    // Disclosure BEFORE execution: nothing has been posted yet.
    expect(capture.filter((c) => c.method === 'POST')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Re-analyze all' }));
    await waitFor(() =>
      expect(capture.filter((c) => c.url.endsWith('/reanalyze-all') && c.method === 'POST')).toHaveLength(1),
    );
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('38 images'));
  });

  it('abandons a bulk re-analysis on cancel', async () => {
    const capture: Array<{ url: string; method: string }> = [];
    mockApi({ capture });
    renderCard();
    await waitFor(() => expect(screen.getByTestId('image-analysis-counters')).toHaveTextContent('40'));

    fireEvent.click(screen.getByTestId('image-analysis-reanalyze-all'));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect(capture.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('reports a retry that found nothing as neither a success nor a failure', async () => {
    mockApi({ actionResult: { rows: 0, started: true, alreadyRunning: false } });
    renderCard();
    await waitFor(() => expect(screen.getByTestId('image-analysis-counters')).toHaveTextContent('40'));

    fireEvent.click(screen.getByTestId('image-analysis-retry-failed'));
    await waitFor(() => expect(toast.message).toHaveBeenCalledWith('No failed analyses to retry.'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('does not claim a batch started when the lease was already held', async () => {
    mockApi({ actionResult: { started: false, alreadyRunning: true } });
    renderCard();
    await waitFor(() => expect(screen.getByTestId('image-analysis-counters')).toHaveTextContent('40'));

    fireEvent.click(screen.getByTestId('image-analysis-process'));
    await waitFor(() =>
      expect(toast.message).toHaveBeenCalledWith('An analysis batch is already running.'),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('surfaces a refused bulk run rather than reporting it as queued', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify(status()), { headers: { 'Content-Type': 'application/json' } });
      }
      expect(url).toContain('reanalyze-all');
      return new Response(
        JSON.stringify({ message: 'A text re-embed of the whole corpus is running', statusCode: 409 }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      );
    });
    renderCard();
    await waitFor(() => expect(screen.getByTestId('image-analysis-counters')).toHaveTextContent('40'));

    fireEvent.click(screen.getByTestId('image-analysis-reanalyze-all'));
    fireEvent.click(await screen.findByRole('button', { name: 'Re-analyze all' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/re-embed of the whole corpus/i)),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('draft isolation on the Embeddings tab', () => {
  it('leaves an unsaved chunk-size draft alone when a card action runs', async () => {
    mockApi({ actionResult: { rows: 3, started: true, alreadyRunning: false } });
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <EmbeddingTab />
      </QueryClientProvider>,
    );

    const chunkInput = await screen.findByTestId('admin-chunk-size-input');
    fireEvent.change(chunkInput, { target: { value: '768' } });
    expect(chunkInput).toHaveValue(768);

    fireEvent.click(screen.getByTestId('image-analysis-retry-failed'));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());

    // The card invalidates its own query key only; a neighbouring draft on the
    // same tab must survive the refetch it triggers.
    expect(chunkInput).toHaveValue(768);
    expect(screen.getByTestId('admin-chunk-save-btn')).toBeEnabled();
  });
});
