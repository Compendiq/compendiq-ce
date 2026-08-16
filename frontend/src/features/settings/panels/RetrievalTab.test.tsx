import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { FTS_LANGUAGES } from '@compendiq/contracts';
import { RetrievalTab } from './RetrievalTab';

const authState = { user: { role: 'admin' }, accessToken: 'test-token', setAuth: vi.fn(), clearAuth: vi.fn() };
vi.mock('../../../stores/auth-store', () => ({
  useAuthStore: Object.assign(
    (selector: (state: typeof authState) => unknown) => selector(authState),
    { getState: () => authState },
  ),
}));

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** GET /admin/settings answering with every knob at its reader default. */
const defaultSettings = {
  ftsLanguage: 'simple',
  ragFetchWidth: 10,
  ragRerankCandidates: 30,
  ragConfidenceThreshold: 0,
  ragConfidenceThresholdRerank: 0,
  ragContextCharsPerPage: 6000,
  ragPinIdentifiers: true,
  ragMmrEnabled: false,
  ragMmrLambda: 0.7,
  ragRankingPriorWeight: 0,
};

function unassignedRerank() {
  return { providerId: null, model: null, resolved: { providerId: NIL_UUID, providerName: '', model: '' } };
}
function assignedRerank() {
  return {
    providerId: '11111111-2222-3333-4444-555555555555',
    model: 'bge-reranker-v2-m3',
    resolved: {
      providerId: '11111111-2222-3333-4444-555555555555',
      providerName: 'Local llama.cpp',
      model: 'bge-reranker-v2-m3',
    },
  };
}

interface MockOptions {
  settings?: Record<string, unknown>;
  rerank?: ReturnType<typeof unassignedRerank>;
}

/** Captures every PUT body so a test can assert what was actually sent. */
function mockApi({ settings = defaultSettings, rerank = unassignedRerank() }: MockOptions = {}) {
  const puts: Record<string, unknown>[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = init?.method ?? (input as Request)?.method ?? 'GET';
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

    if (url.includes('/admin/llm-usecases')) {
      const row = { providerId: null, model: null, resolved: { providerId: NIL_UUID, providerName: '', model: '' } };
      return json({ chat: row, summary: row, quality: row, auto_tag: row, embedding: row, rerank });
    }
    if (url.includes('/admin/retrieval-benchmark')) {
      if (method === 'POST') return json({ runId: '11111111-1111-4111-8111-111111111111', status: 'queued' }, 202);
      return json({
        id: '11111111-1111-4111-8111-111111111111',
        status: 'completed',
        progressDone: 2,
        progressTotal: 2,
        error: null,
        result: {
          queryCount: 2,
          topK: 5,
          baseline: { averageLatencyMs: 10, p50LatencyMs: 9, p95LatencyMs: 15, emptyResultQueries: 0, labeledQueryCount: 0, recallAtK: null, mrr: null },
          deepSearch: { averageLatencyMs: 20, p50LatencyMs: 19, p95LatencyMs: 30, emptyResultQueries: 0, labeledQueryCount: 0, recallAtK: null, mrr: null, expansionParticipatingQueries: 1, expansionSkippedQueries: 1, expansionUnavailableQueries: 0 },
          paired: { top1ChangedQueries: 1, topKChangedQueries: 1, averageTopKOverlap: 0.75, deepOnlyPagesAtK: 1, baselineOnlyPagesAtK: 1 },
        },
      });
    }
    if (url.includes('/admin/settings')) {
      if (method === 'PUT') {
        puts.push(JSON.parse(String(init?.body ?? '{}')));
        return json({ message: 'Admin settings updated' });
      }
      return json(settings);
    }
    return new Response('Not found', { status: 404 });
  });
  return puts;
}

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <RetrievalTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function ready() {
  await waitFor(() => expect(screen.getByTestId('retrieval-tab')).toBeInTheDocument());
}

const input = (key: string) => screen.getByTestId(`retrieval-${key}`) as HTMLInputElement;

/** Type into a number field and commit it, the way a user leaving the field does. */
function type(key: string, value: string) {
  const el = input(key);
  fireEvent.change(el, { target: { value } });
  fireEvent.blur(el);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RetrievalTab — the nine knobs', () => {
  it('seeds every input from the server document', async () => {
    mockApi({
      settings: {
        ragFetchWidth: 40,
        ragRerankCandidates: 60,
        ragConfidenceThreshold: 0.35,
        ragConfidenceThresholdRerank: 0.2,
        ragContextCharsPerPage: 12_000,
        ragPinIdentifiers: false,
        ragMmrEnabled: true,
        ragMmrLambda: 0.5,
        ragRankingPriorWeight: 0.003,
      },
    });
    renderTab();
    await ready();

    await waitFor(() => expect(input('ragFetchWidth').value).toBe('40'));
    expect(input('ragRerankCandidates').value).toBe('60');
    expect(input('ragConfidenceThreshold').value).toBe('0.35');
    expect(input('ragConfidenceThresholdRerank').value).toBe('0.2');
    expect(input('ragContextCharsPerPage').value).toBe('12000');
    expect((screen.getByTestId('rag-pin-identifiers') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId('rag-mmr-enabled') as HTMLInputElement).checked).toBe(true);
    expect(input('ragMmrLambda').value).toBe('0.5');
    expect(input('ragRankingPriorWeight').value).toBe('0.003');
  });

  it('sends ONLY the fields that changed — an untouched knob gets no row', async () => {
    const puts = mockApi();
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragFetchWidth').value).toBe('10'));

    type('ragFetchWidth', '40');
    fireEvent.click(screen.getByTestId('retrieval-save-btn'));

    await waitFor(() => expect(puts).toHaveLength(1));
    // Not `{...everything}` — writing all nine would seed eight rows nobody
    // set, and `rag_context_chars_per_page`'s last-good fallback assumes no
    // phantom row exists.
    expect(puts[0]).toEqual({ ragFetchWidth: 40 });
  });

  it('sends booleans as booleans, in both directions', async () => {
    const puts = mockApi();
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragFetchWidth').value).toBe('10'));

    fireEvent.click(screen.getByTestId('rag-pin-identifiers')); // true → false
    fireEvent.click(screen.getByTestId('rag-mmr-enabled')); // false → true
    fireEvent.click(screen.getByTestId('retrieval-save-btn'));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ ragPinIdentifiers: false, ragMmrEnabled: true });
  });

  it('keeps Save disabled until something differs from the saved document', async () => {
    mockApi();
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragFetchWidth').value).toBe('10'));

    expect(screen.getByTestId('retrieval-save-btn')).toBeDisabled();
    type('ragFetchWidth', '40');
    expect(screen.getByTestId('retrieval-save-btn')).toBeEnabled();
    fireEvent.click(screen.getByTestId('retrieval-ragFetchWidth-reset'));
    expect(screen.getByTestId('retrieval-save-btn')).toBeDisabled();
  });

  it('clamps to the range the backend schema accepts — on commit', async () => {
    mockApi();
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragFetchWidth').value).toBe('10'));

    // The reader treats its MIN as a validity floor (sub-minimum falls back to
    // the DEFAULT), so the panel must never offer a value it would discard.
    type('ragFetchWidth', '5');
    expect(input('ragFetchWidth').value).toBe('10');
    type('ragFetchWidth', '900');
    expect(input('ragFetchWidth').value).toBe('200');

    // Confidence is half-open: the reader REJECTS '1'.
    type('ragConfidenceThreshold', '1');
    expect(Number(input('ragConfidenceThreshold').value)).toBeLessThan(1);

    type('ragRankingPriorWeight', '0.5');
    expect(input('ragRankingPriorWeight').value).toBe('0.05');
  });

  /**
   * Clamping on every keystroke is what the sibling rate-limits panel does,
   * and it makes a min-10 field untypeable: "4" snaps to 10 and the next digit
   * lands on "100". The draft is the keystroke; the range is the commit.
   */
  it('lets a value below the minimum be TYPED, and refuses it only on commit', async () => {
    mockApi();
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragFetchWidth').value).toBe('10'));

    // First digit of "40" — below the minimum, and must survive as typed.
    fireEvent.change(input('ragFetchWidth'), { target: { value: '4' } });
    expect(input('ragFetchWidth').value).toBe('4');
    // A half-typed number is not savable.
    expect(screen.getByTestId('retrieval-save-btn')).toBeDisabled();

    fireEvent.change(input('ragFetchWidth'), { target: { value: '40' } });
    fireEvent.blur(input('ragFetchWidth'));
    expect(input('ragFetchWidth').value).toBe('40');
    expect(screen.getByTestId('retrieval-save-btn')).toBeEnabled();
  });

  it('restores the committed value when the field is emptied', async () => {
    mockApi();
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragContextCharsPerPage').value).toBe('6000'));

    // Clearing must not become a 0, which this knob reads as "assembly off".
    type('ragContextCharsPerPage', '');
    expect(input('ragContextCharsPerPage').value).toBe('6000');
    expect(screen.getByTestId('retrieval-save-btn')).toBeDisabled();
  });

  it('marks the confidence inputs with the range the reader enforces', async () => {
    mockApi();
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragConfidenceThreshold').min).toBe('0'));
    expect(Number(input('ragConfidenceThreshold').max)).toBeLessThan(1);
    expect(Number(input('ragConfidenceThresholdRerank').max)).toBeLessThan(1);
    expect(input('ragRankingPriorWeight').max).toBe('0.05');
    expect(input('ragContextCharsPerPage').max).toBe('24000');
    expect(input('ragMmrLambda').max).toBe('1');
  });
});

/**
 * #1114 — the keyword-index language.
 *
 * It has been an `admin_settings` row since migration 049 with no control
 * anywhere: the documented way to change it was `FTS_LANGUAGE`, which that
 * same migration made inert. So a German deployment that "set the language"
 * has been running the keyword leg on `simple` — no stemming, no stop words —
 * ever since. This panel is now the only place it is set.
 */
describe('RetrievalTab — keyword index language (#1114)', () => {
  const select = () => screen.getByTestId('retrieval-ftsLanguage') as HTMLSelectElement;

  it('shows the stored language and offers exactly the contracts allow-list', async () => {
    mockApi({ settings: { ...defaultSettings, ftsLanguage: 'german' } });
    renderTab();
    await ready();

    await waitFor(() => expect(select().value).toBe('german'));
    // The reader discards anything outside this list, so the control must not
    // offer a language that would silently read back as `simple`.
    expect([...select().options].map((option) => option.value)).toEqual([...FTS_LANGUAGES]);
  });

  it('sends only the language when nothing else changed', async () => {
    const puts = mockApi();
    renderTab();
    await ready();
    await waitFor(() => expect(select().value).toBe('simple'));

    fireEvent.change(select(), { target: { value: 'german' } });
    fireEvent.click(screen.getByTestId('retrieval-save-btn'));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ ftsLanguage: 'german' });
  });

  it('names the cost of saving: every page is re-indexed', async () => {
    mockApi();
    renderTab();
    await ready();
    // Unlike the nine numeric knobs, this one does corpus-wide work inside the
    // request that saves it. A control that does not say so is a trap.
    expect(screen.getByTestId('retrieval-fts-language')).toHaveTextContent(
      /rebuilds the keyword index for every page/i,
    );
  });

  it('warns that simple does no stemming — and only while simple is selected', async () => {
    mockApi();
    renderTab();
    await ready();
    await waitFor(() => expect(select().value).toBe('simple'));

    const hint = screen.getByTestId('retrieval-fts-simple-hint');
    expect(hint).toHaveTextContent(/does no stemming/i);
    // ADR-010: this is a permanent condition on a default install, not an
    // attention state. Amber would be spent on something that never clears.
    expect(hint.className).toContain('text-muted-foreground');
    expect(hint.className).not.toMatch(/warning|status-syncing/);

    fireEvent.change(select(), { target: { value: 'german' } });
    expect(screen.queryByTestId('retrieval-fts-simple-hint')).not.toBeInTheDocument();
  });

  it('keeps Save disabled until the language actually differs', async () => {
    mockApi({ settings: { ...defaultSettings, ftsLanguage: 'german' } });
    renderTab();
    await ready();
    await waitFor(() => expect(select().value).toBe('german'));

    expect(screen.getByTestId('retrieval-save-btn')).toBeDisabled();
    fireEvent.change(select(), { target: { value: 'french' } });
    expect(screen.getByTestId('retrieval-save-btn')).toBeEnabled();
    fireEvent.change(select(), { target: { value: 'german' } });
    expect(screen.getByTestId('retrieval-save-btn')).toBeDisabled();
  });

  it('re-reads the server after a save instead of trusting its own state (#1118)', async () => {
    const puts = mockApi();
    renderTab();
    await ready();
    await waitFor(() => expect(select().value).toBe('simple'));

    fireEvent.change(select(), { target: { value: 'german' } });
    fireEvent.click(screen.getByTestId('retrieval-save-btn'));
    await waitFor(() => expect(puts).toHaveLength(1));

    // The mocked GET still answers `simple`, so a panel that re-hydrates from
    // the invalidated query lands back on it. One that kept its optimistic
    // value would show `german` for a save the server never applied.
    await waitFor(() => expect(select().value).toBe('simple'));
  });
});

describe('RetrievalTab — the rerank stage belongs to the assignment, not this panel', () => {
  it('reports the stage disabled with the exact assignment-grid wording, and links to it', async () => {
    mockApi({ rerank: unassignedRerank() });
    renderTab();
    await ready();

    const status = await screen.findByTestId('retrieval-rerank-stage-status');
    // Same string UsecaseAssignmentsSection renders for the unassigned option,
    // so an operator reading both surfaces sees one vocabulary.
    expect(status).toHaveTextContent('Disabled (no reranking)');
    expect(within(status).getByRole('link')).toHaveAttribute(
      'href',
      '/settings/ai/models?sub=llm',
    );
  });

  it('leaves the candidate-pool input usable while the stage is off', async () => {
    mockApi({ rerank: unassignedRerank() });
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragRerankCandidates').value).toBe('30'));
    // Pre-setting the pool before assigning a provider is legitimate.
    expect(input('ragRerankCandidates')).toBeEnabled();
  });

  it('names the resolved provider when the stage IS on', async () => {
    mockApi({ rerank: assignedRerank() });
    renderTab();
    await ready();
    const status = await screen.findByTestId('retrieval-rerank-stage-status');
    await waitFor(() => expect(status).toHaveTextContent('Local llama.cpp'));
    expect(status).not.toHaveTextContent('Disabled (no reranking)');
  });

  it('offers no rerank provider control of its own', async () => {
    mockApi({ rerank: unassignedRerank() });
    renderTab();
    await ready();
    expect(screen.queryByTestId('usecase-rerank-provider')).not.toBeInTheDocument();
  });
});

describe('RetrievalTab — optional stages are visible, measured and off', () => {
  it('renders both optional stages without a disclosure', async () => {
    mockApi();
    renderTab();
    await ready();
    // Present in the initial DOM: no <details>, no "Show advanced" step.
    expect(screen.getByTestId('retrieval-optional-stages')).toBeInTheDocument();
    expect(screen.getByTestId('rag-mmr-enabled')).toBeInTheDocument();
    expect(screen.getByTestId('retrieval-ragRankingPriorWeight')).toBeInTheDocument();
    expect(document.querySelectorAll('details')).toHaveLength(0);
  });

  it('carries the measurement that decided each default', async () => {
    mockApi();
    renderTab();
    await ready();
    expect(screen.getByTestId('retrieval-mmr-measurement')).toHaveTextContent(
      /no Recall@1 gain measured/i,
    );
    expect(screen.getByTestId('retrieval-mmr-measurement')).toHaveTextContent(/53%/);
    expect(screen.getByTestId('retrieval-prior-measurement')).toHaveTextContent(
      /zero effect when a rerank provider is assigned/i,
    );
    expect(screen.getByTestId('retrieval-prior-measurement')).toHaveTextContent(
      /2 of\s+164 queries, one gain and one regression/i,
    );
  });

  it('does not pre-fill the tuned prior — it offers it', async () => {
    const puts = mockApi();
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragRankingPriorWeight').value).toBe('0'));

    fireEvent.click(screen.getByTestId('retrieval-prior-use-measured'));
    expect(input('ragRankingPriorWeight').value).toBe('0.003');

    fireEvent.click(screen.getByTestId('retrieval-save-btn'));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ ragRankingPriorWeight: 0.003 });
  });

  it('says so inline when a rerank assignment makes the prior a no-op', async () => {
    mockApi({ rerank: assignedRerank() });
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragRankingPriorWeight').value).toBe('0'));

    // Silent at 0 — nothing is being discarded yet.
    expect(screen.queryByTestId('retrieval-prior-discarded-note')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('retrieval-prior-use-measured'));
    expect(screen.getByTestId('retrieval-prior-discarded-note')).toHaveTextContent(
      /no effect here/i,
    );
  });

  it('stays silent about the no-op when no rerank provider is assigned', async () => {
    mockApi({ rerank: unassignedRerank() });
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragRankingPriorWeight').value).toBe('0'));
    fireEvent.click(screen.getByTestId('retrieval-prior-use-measured'));
    expect(screen.queryByTestId('retrieval-prior-discarded-note')).not.toBeInTheDocument();
  });
});

describe('RetrievalTab — ADR-010: the off state is neutral, and amber is not borrowed', () => {
  it('marks a disabled optional stage in the slate "inactive" treatment, never amber', async () => {
    mockApi();
    const { container } = renderTab();
    await ready();

    const offChips = screen.getAllByText('Off');
    expect(offChips.length).toBeGreaterThan(0);
    for (const chip of offChips) {
      expect(chip.className).toContain('status-inactive');
    }
    // Amber is reserved for warning/attention. A settings panel that is
    // permanently amber teaches users to ignore amber.
    expect(container.innerHTML).not.toMatch(/\b(text|bg|border)-warning\b/);
    expect(container.innerHTML).not.toMatch(/status-syncing/);
  });

  it('gives the panel no "Recommended" badge for the shipped defaults', async () => {
    mockApi();
    renderTab();
    await ready();
    expect(screen.queryByText(/recommended/i)).not.toBeInTheDocument();
  });

  it('never presents a bare ranking-prior number without its scale', async () => {
    mockApi();
    renderTab();
    await ready();
    // 0.003 means nothing on its own: the useful statement is what it moves
    // against, which is the adjacent-rank delta and the leg-agreement gap.
    const panel = screen.getByTestId('retrieval-tab');
    expect(panel).toHaveTextContent(/0\.00026/);
    expect(panel).toHaveTextContent(/14 positions/);
    expect(panel).toHaveTextContent(/leg-agreement tier/);
  });

  it('labels each confidence threshold by its BASIS and admits no universal value', async () => {
    mockApi();
    renderTab();
    await ready();
    const panel = screen.getByTestId('retrieval-tab');
    expect(panel).toHaveTextContent(/max cosine similarity of the best chunk, 0–1/);
    expect(panel).toHaveTextContent(/max reranker relevance, 0–1/);
    expect(panel).toHaveTextContent(/no universal value/i);
    // The raw-logit caveat sits with the rerank basis, not in a footnote.
    expect(panel).toHaveTextContent(/raw-logit/i);
  });

  it('tells the admin when a saved value takes effect', async () => {
    mockApi();
    renderTab();
    await ready();
    expect(screen.getByTestId('retrieval-tab')).toHaveTextContent(/within a minute/i);
  });

  it('starts and displays a paired benchmark over production questions', async () => {
    mockApi();
    renderTab();
    await ready();

    expect(screen.getByTestId('retrieval-tab')).toHaveTextContent(/read-only paired measurement/i);
    fireEvent.click(screen.getByTestId('retrieval-benchmark-start'));

    await waitFor(() => expect(screen.getByTestId('retrieval-benchmark-summary')).toBeInTheDocument());
    expect(screen.getByTestId('retrieval-benchmark-summary')).toHaveTextContent('2 production questions compared');
    expect(screen.getByTestId('retrieval-benchmark-summary')).toHaveTextContent('19 / 30 ms');
  });
});
