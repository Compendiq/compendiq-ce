import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { FTS_LANGUAGES } from '@compendiq/contracts';
import { RetrievalTab } from './RetrievalTab';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

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

/** #1115 P3 — a VL model behind the `image_embedding` use case. */
function assignedImageEmbedding() {
  return {
    providerId: '99999999-8888-7777-6666-555555555555',
    model: 'Qwen/Qwen3-VL-Embedding-2B',
    resolved: {
      providerId: '99999999-8888-7777-6666-555555555555',
      providerName: 'vLLM pooling',
      model: 'Qwen/Qwen3-VL-Embedding-2B',
    },
  };
}

interface MockOptions {
  settings?: Record<string, unknown>;
  rerank?: ReturnType<typeof unassignedRerank>;
  /** #1115 P3 — the `image_embedding` assignment row; unassigned by default. */
  imageEmbedding?: ReturnType<typeof unassignedRerank>;
  /**
   * #1114 — lets a test model the half of the server the panel's remedy
   * depends on: saving a threshold RE-RECORDS its calibration, so the next
   * GET answers differently. Applied inside the PUT handler, before the
   * mutation's `invalidateQueries` can race a test-side mutation.
   */
  afterPut?: (body: Record<string, unknown>, settings: Record<string, unknown>) => void;
  /**
   * #1114 review r3 — the PUT's own answer. The route reports what it DID
   * with each threshold's calibration record, because it writes the threshold
   * row and answers 200 whether or not the record beside it landed. Default:
   * silent, which is what a server predating the field looks like.
   */
  putResult?: (body: Record<string, unknown>) => Record<string, unknown>;
}

/** Captures every PUT body so a test can assert what was actually sent. */
function mockApi({
  settings = defaultSettings,
  rerank = unassignedRerank(),
  imageEmbedding = unassignedRerank(),
  afterPut,
  putResult,
}: MockOptions = {}) {
  const puts: Record<string, unknown>[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = init?.method ?? (input as Request)?.method ?? 'GET';
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

    if (url.includes('/admin/llm-usecases')) {
      const row = { providerId: null, model: null, resolved: { providerId: NIL_UUID, providerName: '', model: '' } };
      return json({
        chat: row, summary: row, quality: row, auto_tag: row, embedding: row, rerank,
        // #1115 P3 — unassigned by default, the ordinary state for a
        // non-inheriting use case with no VL model behind it.
        image_embedding: imageEmbedding,
      });
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
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        puts.push(body);
        afterPut?.(body, settings);
        return json({ message: 'Admin settings updated', ...(putResult?.(body) ?? {}) });
      }
      return json(settings);
    }
    return new Response('Not found', { status: 404 });
  });
  return puts;
}

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    // Handed back so a test can fail a REFETCH of an already-loaded query —
    // the failed-with-cache state, which no first-load mock can reach.
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <RetrievalTab />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
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

/**
 * Every element on the panel that carries an `aria-describedby`.
 *
 * Review r3 — deliberately NOT `input[aria-describedby], select[...]`. The
 * rule is about the region, not about what points at it, and the narrow
 * selector certified the layer #1285 had just fixed while staying silent on
 * the one live offender: the calibration strip's `Keep` BUTTON.
 */
const describedRegions = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[aria-describedby]'));

/** `"<describer> -> #<region>: <the controls it wrongly contains>"`, one per violation. */
function describedRegionOffenders(): string[] {
  const offenders: string[] = [];
  for (const el of describedRegions()) {
    for (const id of (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)) {
      const region = document.getElementById(id);
      if (!region) continue;
      const interactive = region.querySelectorAll('button, a[href], input, select, textarea');
      if (interactive.length === 0) continue;
      offenders.push(
        `${el.getAttribute('data-testid') ?? el.id} -> #${id}: ` +
          Array.from(interactive)
            .map((n) => `<${n.tagName.toLowerCase()}>${(n.textContent ?? '').trim()}`)
            .join(', '),
      );
    }
  }
  return offenders;
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
    const values = [...select().options].map((option) => option.value);
    expect([...values].sort()).toEqual([...FTS_LANGUAGES].sort());
  });

  it('leads with simple and sorts the languages by the label people scan', async () => {
    mockApi();
    renderTab();
    await ready();

    const options = [...select().options];
    // `simple` is not a language and it is the default, so it leads. The
    // other sixteen are alphabetical: the contracts order is a validation
    // list, and rendering it verbatim made "Romanian" the seventeenth thing
    // to read. Order here is presentation — `FTS_LANGUAGES` stays canonical.
    expect(options[0]!.value).toBe('simple');
    const labels = options.slice(1).map((option) => option.textContent ?? '');
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
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

  it('does not promise a recall gain for switching language — that was measured, and there is none', async () => {
    // The hint used to end "pick the language most of your content is written
    // in", which reads as a recommendation with an upside behind it. Measured
    // on a technical German corpus on 2026-08-16 (#1114), `german` vs `simple`
    // moved a handful of queries either way and Recall@10 was bit-identical
    // query-for-query on BOTH embedding models; the only nominally
    // significant cell was a small regression that dies under correction. So
    // the control costs a corpus-wide rebuild and buys nothing measurable
    // here, and the copy has to say that rather than dangle a gain. The
    // rebuild cost stays — it is why this control is not one of the cheap
    // knobs below it.
    mockApi();
    renderTab();
    await ready();
    await waitFor(() => expect(select().value).toBe('simple'));

    const hint = screen.getByTestId('retrieval-fts-simple-hint');
    expect(hint).toHaveTextContent(/within noise/i);
    expect(hint).not.toHaveTextContent(/pick the language most of your content/i);
    // The whole control still names its cost, and the hint must not undercut
    // it by implying the rebuild buys ranking.
    expect(screen.getByTestId('retrieval-fts-language')).toHaveTextContent(
      /rebuilds the keyword index for every page/i,
    );
  });

  it('says the measured corpus was translated, so the null result is not read as advice about German pages', async () => {
    // The hint states a null result as guidance about an admin's OWN content,
    // and the corpus behind it is the #1102 fixture's vendored English OSS
    // docs run through a translation pass — not pages a German speaker wrote.
    // That matters in exactly one direction: a translation holds less of the
    // compounding and inflection a Snowball German stemmer exists to fold, so
    // "measured within noise" bounds the upside an operator may assume rather
    // than showing the stemmer inert on native German. Without the word, this
    // reads as "german buys nothing", which is a stronger claim than anything
    // that was run. The ADR carries the caveat ten lines from the conclusion;
    // this is the surface where the conclusion is acted on.
    mockApi();
    renderTab();
    await ready();
    await waitFor(() => expect(select().value).toBe('simple'));

    const hint = screen.getByTestId('retrieval-fts-simple-hint');
    expect(hint).toHaveTextContent(/translated from English/i);
    // Still the quiet, permanent-condition treatment (ADR-010) and still short
    // — the caveat may not turn a one-line hint into a paragraph.
    expect(hint.className).toContain('text-muted-foreground');
    expect(hint.textContent?.length ?? 0).toBeLessThan(400);
  });

  it('wires the cost sentence and the simple hint to the control itself', async () => {
    mockApi();
    renderTab();
    await ready();
    await waitFor(() => expect(select().value).toBe('simple'));

    // ADR-010's `DeepSearchToggle` rule: the copy that makes a control safe is
    // wired to it, not merely printed beside it. This is the only control on
    // the panel whose save re-indexes the corpus, so a screen-reader user must
    // hear the cost before choosing.
    const described = (select().getAttribute('aria-describedby') ?? '').split(/\s+/);
    const text = described
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(text).toMatch(/rebuilds the keyword index for every page/i);
    expect(text).toMatch(/does no stemming/i);

    // The hint leaves the description with the hint.
    fireEvent.change(select(), { target: { value: 'german' } });
    const afterIds = (select().getAttribute('aria-describedby') ?? '').split(/\s+/);
    for (const id of afterIds) expect(document.getElementById(id)).not.toBeNull();
    expect(
      afterIds.map((id) => document.getElementById(id)?.textContent ?? '').join(' '),
    ).toMatch(/rebuilds the keyword index for every page/i);
  });

  it('re-reads the server when a save fails, so it cannot show a value the database lacks', async () => {
    // Two ways a failed PUT still changes something: the nine knobs are
    // written before the keyword-index transaction runs, and the rebuild is
    // unbounded server-side while the edge caps `/api/` at 300s — a corpus
    // that outruns that answers 504 to the browser and commits anyway. Either
    // way the panel must go back to the server rather than keep rendering the
    // value it optimistically holds.
    let settings: Record<string, unknown> = { ...defaultSettings };
    let gets = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const method = init?.method ?? 'GET';
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/admin/llm-usecases')) {
        const row = { providerId: null, model: null, resolved: { providerId: NIL_UUID, providerName: '', model: '' } };
        return json({ chat: row, summary: row, quality: row, auto_tag: row, embedding: row, rerank: unassignedRerank() });
      }
      if (url.includes('/admin/settings')) {
        if (method === 'PUT') {
          // The rebuild ran and committed; the response never made it back.
          settings = { ...settings, ftsLanguage: 'german' };
          return json({ message: 'Gateway Time-out' }, 504);
        }
        gets++;
        return json(settings);
      }
      return new Response('Not found', { status: 404 });
    });

    renderTab();
    await ready();
    await waitFor(() => expect(select().value).toBe('simple'));
    const getsBeforeSave = gets;

    fireEvent.change(select(), { target: { value: 'german' } });
    fireEvent.click(screen.getByTestId('retrieval-save-btn'));

    await waitFor(() => expect(gets).toBeGreaterThan(getsBeforeSave));
    // The committed value is what the panel now compares against, so Save
    // stops offering to re-run a corpus-wide rebuild that already happened.
    await waitFor(() => expect(screen.getByTestId('retrieval-save-btn')).toBeDisabled());

    // …and says so on screen (review r3). Re-reading silently leaves the admin
    // with an error toast beside a dead Save button, which is "it failed" and
    // "there is nothing left to save" at the same time. The resolution used to
    // live only in the admin guide.
    const strip = await screen.findByTestId('retrieval-fts-save-failed');
    expect(strip).toHaveTextContent(/server now reports/i);
    expect(strip).toHaveTextContent(/German/);
    expect(strip).toHaveTextContent(/believe the value shown here, not the error/i);
  });

  it('says the language was NOT changed when the rebuild rolled back', async () => {
    // The other half of the same failure: a 503 from the rebuild leaves the
    // row untouched, the admin's unsent choice on screen and Save still
    // offered. Reporting "believe what you see" there would be a lie — the
    // refetched value is what distinguishes the two, so the panel reads it.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const method = init?.method ?? 'GET';
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/admin/llm-usecases')) {
        const row = { providerId: null, model: null, resolved: { providerId: NIL_UUID, providerName: '', model: '' } };
        return json({ chat: row, summary: row, quality: row, auto_tag: row, embedding: row, rerank: unassignedRerank() });
      }
      if (url.includes('/admin/settings')) {
        if (method === 'PUT') {
          return json({ message: 'Keyword index rebuild failed — the language was not changed' }, 503);
        }
        return json(defaultSettings);
      }
      return new Response('Not found', { status: 404 });
    });

    renderTab();
    await ready();
    await waitFor(() => expect(select().value).toBe('simple'));

    fireEvent.change(select(), { target: { value: 'german' } });
    fireEvent.click(screen.getByTestId('retrieval-save-btn'));

    const strip = await screen.findByTestId('retrieval-fts-save-failed');
    expect(strip).toHaveTextContent(/still reports/i);
    expect(strip).toHaveTextContent(/Simple \(no stemming\)/);
    expect(strip).toHaveTextContent(/was not changed/i);
    // The unsent choice survives, so Save is still the way to retry — which is
    // what the strip tells the admin to do.
    expect(select().value).toBe('german');
    expect(screen.getByTestId('retrieval-save-btn')).toBeEnabled();
  });

  it('keeps the rollback wording when the admin edits the select after the failure', async () => {
    // The strip reports what the SERVER did with what was SENT, so its
    // evidence is `mutation.variables`, not the live select. Comparing the
    // refetched value against a mutable draft lets the admin flip the verdict
    // by abandoning their own edit: putting the select back to `simple` made
    // the two sides match, and the panel announced a commit — "believe the
    // value shown here, not the error" — for a transaction that rolled back
    // and a proxy timeout that never happened.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const method = init?.method ?? 'GET';
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/admin/llm-usecases')) {
        const row = { providerId: null, model: null, resolved: { providerId: NIL_UUID, providerName: '', model: '' } };
        return json({ chat: row, summary: row, quality: row, auto_tag: row, embedding: row, rerank: unassignedRerank() });
      }
      if (url.includes('/admin/settings')) {
        if (method === 'PUT') {
          return json({ message: 'Keyword index rebuild failed — the language was not changed' }, 503);
        }
        return json(defaultSettings); // still `simple`: the rebuild rolled back
      }
      return new Response('Not found', { status: 404 });
    });

    renderTab();
    await ready();
    await waitFor(() => expect(select().value).toBe('simple'));

    fireEvent.change(select(), { target: { value: 'german' } });
    fireEvent.click(screen.getByTestId('retrieval-save-btn'));

    const strip = await screen.findByTestId('retrieval-fts-save-failed');
    expect(strip).toHaveTextContent(/was not changed/i);

    // The admin gives up on the change and puts the select back. Nothing about
    // the failed request changed, so neither may the verdict.
    fireEvent.change(select(), { target: { value: 'simple' } });
    expect(screen.getByTestId('retrieval-fts-save-failed')).toHaveTextContent(/was not changed/i);
    expect(screen.getByTestId('retrieval-fts-save-failed')).not.toHaveTextContent(
      /believe the value shown here/i,
    );
  });

  it('carries the amber strip glyph, not colour alone', async () => {
    // ADR-010: every amber strip in the app pairs this class recipe with a
    // 16px AlertTriangle. Colour is the weaker channel under `forced-colors`
    // and for a colour-blind admin, and this strip is the only thing on screen
    // resolving "it failed" against a Save button that just went dead.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const method = init?.method ?? 'GET';
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/admin/llm-usecases')) {
        const row = { providerId: null, model: null, resolved: { providerId: NIL_UUID, providerName: '', model: '' } };
        return json({ chat: row, summary: row, quality: row, auto_tag: row, embedding: row, rerank: unassignedRerank() });
      }
      if (url.includes('/admin/settings')) {
        if (method === 'PUT') return json({ message: 'Rebuild failed' }, 503);
        return json(defaultSettings);
      }
      return new Response('Not found', { status: 404 });
    });

    renderTab();
    await ready();
    await waitFor(() => expect(select().value).toBe('simple'));

    fireEvent.change(select(), { target: { value: 'german' } });
    fireEvent.click(screen.getByTestId('retrieval-save-btn'));

    const strip = await screen.findByTestId('retrieval-fts-save-failed');
    expect(strip.querySelector('svg')).not.toBeNull();
  });

  it('withholds the verdict when the re-read that would prove it also failed', async () => {
    // The strip's entire basis is "the refetched value is the evidence". When
    // the backend is down, the PUT fails and the `onError` re-read fails with
    // it — so the cached value is the value from BEFORE the save, and
    // announcing "the server still reports Simple — the language was not
    // changed" from it states a verdict nothing confirmed. The degraded strip
    // says what is actually known: the settings could not be re-read.
    let getsAfterPut = 0;
    let putDone = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const method = init?.method ?? 'GET';
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/admin/llm-usecases')) {
        const row = { providerId: null, model: null, resolved: { providerId: NIL_UUID, providerName: '', model: '' } };
        return json({ chat: row, summary: row, quality: row, auto_tag: row, embedding: row, rerank: unassignedRerank() });
      }
      if (url.includes('/admin/settings')) {
        if (method === 'PUT') {
          putDone = true;
          return json({ message: 'Service Unavailable' }, 503);
        }
        if (putDone) {
          getsAfterPut++;
          return json({ message: 'Service Unavailable' }, 503);
        }
        return json(defaultSettings);
      }
      return new Response('Not found', { status: 404 });
    });

    renderTab();
    await ready();
    await waitFor(() => expect(select().value).toBe('simple'));

    fireEvent.change(select(), { target: { value: 'german' } });
    fireEvent.click(screen.getByTestId('retrieval-save-btn'));

    await waitFor(() => expect(getsAfterPut).toBeGreaterThan(0));
    // Degraded, not torn down — and not a verdict either.
    expect(await screen.findByTestId('retrieval-settings-stale')).toBeInTheDocument();
    expect(screen.queryByTestId('retrieval-fts-save-failed')).not.toBeInTheDocument();
    expect(screen.queryByTestId('retrieval-tab-error')).not.toBeInTheDocument();
    expect(select().value).toBe('german');
  });

  it('says nothing about a failed save that never carried the language', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const method = init?.method ?? 'GET';
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/admin/llm-usecases')) {
        const row = { providerId: null, model: null, resolved: { providerId: NIL_UUID, providerName: '', model: '' } };
        return json({ chat: row, summary: row, quality: row, auto_tag: row, embedding: row, rerank: unassignedRerank() });
      }
      if (url.includes('/admin/settings')) {
        if (method === 'PUT') return json({ message: 'Nope' }, 500);
        return json(defaultSettings);
      }
      return new Response('Not found', { status: 404 });
    });

    renderTab();
    await ready();
    type('ragFetchWidth', '40');
    fireEvent.click(screen.getByTestId('retrieval-save-btn'));

    await waitFor(() => expect(screen.getByTestId('retrieval-save-btn')).toBeEnabled());
    expect(screen.queryByTestId('retrieval-fts-save-failed')).not.toBeInTheDocument();
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

  it('survives "Reset all to defaults" — a bulk reset must not re-index the corpus', async () => {
    // Every other control here is a number or a checkbox: resetting one costs
    // nothing and is undone by resetting it back. This one is the whole
    // corpus's `tsv`, and its default is `simple` — the value this issue
    // exists to move German deployments OFF. One click among nine cheap
    // resets, then Save, and the keyword leg is back to no stemming.
    const puts = mockApi({
      settings: { ...defaultSettings, ftsLanguage: 'german', ragFetchWidth: 40 },
    });
    renderTab();
    await ready();
    await waitFor(() => expect(select().value).toBe('german'));

    fireEvent.click(screen.getByTestId('retrieval-reset-all-btn'));

    expect(select().value).toBe('german');
    fireEvent.click(screen.getByTestId('retrieval-save-btn'));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ ragFetchWidth: 10 });
  });

  it('does not report a delay for a save that already rebuilt the index', async () => {
    const puts = mockApi();
    renderTab();
    await ready();
    await waitFor(() => expect(select().value).toBe('simple'));

    fireEvent.change(select(), { target: { value: 'german' } });
    fireEvent.click(screen.getByTestId('retrieval-save-btn'));

    await waitFor(() => expect(puts).toHaveLength(1));
    // The nine knobs converge on a 60-second read cache; this one was rebuilt
    // inside the request that just returned.
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(String(toastSuccess.mock.calls.at(-1)?.[0])).not.toMatch(/within a minute/i);
  });

  it('says on screen that the bulk reset leaves it alone', async () => {
    mockApi();
    renderTab();
    await ready();
    // A button labelled "all" that skips one field has to say so where the
    // click happens, not in a tooltip.
    expect(screen.getByTestId('retrieval-reset-all-scope')).toHaveTextContent(
      /keyword index language/i,
    );
  });
});

/**
 * Review r3. Every field on this panel falls back to `DEFAULTS` when the
 * settings document is missing, and react-query settles a failed query with
 * `data === undefined` and `isLoading === false` — so a failed GET used to
 * render a complete, plausible, WRONG settings page. `ftsLanguage` is where
 * that stops being cosmetic: it reports `simple` on an instance whose row says
 * `german`, under a hint telling the admin to pick a language, and acting on
 * that costs a corpus-wide re-index that was never needed. Same failure
 * CLAUDE.md pins for `usePageTree`, reached on a settings surface.
 */
describe('RetrievalTab — a failed settings fetch is a failure, not a defaults document', () => {
  function mockFailingSettings() {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes('/admin/llm-usecases')) {
        const row = { providerId: null, model: null, resolved: { providerId: NIL_UUID, providerName: '', model: '' } };
        return new Response(
          JSON.stringify({ chat: row, summary: row, quality: row, auto_tag: row, embedding: row, rerank: unassignedRerank() }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/admin/settings')) {
        return new Response(JSON.stringify({ message: 'Service Unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    });
  }

  it('renders a retryable error instead of a form full of defaults', async () => {
    mockFailingSettings();
    renderTab();

    await waitFor(() => expect(screen.getByTestId('retrieval-tab-error')).toBeInTheDocument());
    expect(screen.getByTestId('retrieval-tab-retry')).toBeInTheDocument();
    expect(screen.queryByTestId('retrieval-tab')).not.toBeInTheDocument();
  });

  it('never reports a keyword-index language it did not read', async () => {
    mockFailingSettings();
    renderTab();

    await waitFor(() => expect(screen.getByTestId('retrieval-tab-error')).toBeInTheDocument());
    // The two things a fabricated `simple` would put on screen: the value
    // itself, and the hint that invites the admin to change it.
    expect(screen.queryByTestId('retrieval-ftsLanguage')).not.toBeInTheDocument();
    expect(screen.queryByTestId('retrieval-fts-simple-hint')).not.toBeInTheDocument();
  });

  /**
   * Three states, not two (CLAUDE.md's `usePageTree` rule): failed-with-
   * nothing-cached is destructive and the error IS the content; failed-with-
   * cache is DEGRADED — amber `role="status"` over an intact form. react-query
   * settles a failed REFETCH with `status: 'error'` while keeping `data`, so
   * gating the destructive card on `isError` alone threw away a known-good
   * settings document plus the admin's unsent edit. It is reachable from the
   * mutation's own `onError`, which invalidates this very query: when the
   * backend is down, the follow-on GET fails too.
   */
  it('keeps the form and degrades to amber when a REFETCH fails over cached settings', async () => {
    let fail = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/admin/llm-usecases')) {
        const row = { providerId: null, model: null, resolved: { providerId: NIL_UUID, providerName: '', model: '' } };
        return json({ chat: row, summary: row, quality: row, auto_tag: row, embedding: row, rerank: unassignedRerank() });
      }
      if (url.includes('/admin/settings')) {
        if (fail) return json({ message: 'Service Unavailable' }, 503);
        return json({ ...defaultSettings, ftsLanguage: 'german' });
      }
      return new Response('Not found', { status: 404 });
    });

    const { queryClient } = renderTab();
    await ready();
    const select = () => screen.getByTestId('retrieval-ftsLanguage') as HTMLSelectElement;
    await waitFor(() => expect(select().value).toBe('german'));

    // An unsent edit the admin would lose if the panel swapped itself out.
    fireEvent.change(select(), { target: { value: 'english' } });

    fail = true;
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['admin-settings'] });
    });

    // Red is failure; amber is degraded. Nothing was lost, so nothing is torn down.
    const strip = await screen.findByTestId('retrieval-settings-stale');
    expect(screen.queryByTestId('retrieval-tab-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('retrieval-tab')).toBeInTheDocument();
    expect(select().value).toBe('english');

    expect(strip).toHaveAttribute('role', 'status');
    expect(strip.className).toMatch(/border-warning\/30/);
    expect(strip.className).toMatch(/bg-warning\/10/);
    expect(strip).toHaveTextContent(/could not be re-read/i);
    expect(strip).toHaveTextContent(/stale/i);
    // Same ADR-010 recipe as every other amber strip: colour is not the only channel.
    expect(strip.querySelector('svg')).not.toBeNull();
  });

  it('recovers into the real document when the retry succeeds', async () => {
    let fail = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/admin/llm-usecases')) {
        const row = { providerId: null, model: null, resolved: { providerId: NIL_UUID, providerName: '', model: '' } };
        return json({ chat: row, summary: row, quality: row, auto_tag: row, embedding: row, rerank: unassignedRerank() });
      }
      if (url.includes('/admin/settings')) {
        if (fail) return json({ message: 'Service Unavailable' }, 503);
        return json({ ...defaultSettings, ftsLanguage: 'german' });
      }
      return new Response('Not found', { status: 404 });
    });

    renderTab();
    await waitFor(() => expect(screen.getByTestId('retrieval-tab-error')).toBeInTheDocument());

    fail = false;
    fireEvent.click(screen.getByTestId('retrieval-tab-retry'));

    await waitFor(() =>
      expect((screen.getByTestId('retrieval-ftsLanguage') as HTMLSelectElement).value).toBe('german'),
    );
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

/**
 * #1114 — a threshold remembers the model it was tuned on.
 *
 * A cosine threshold is a number on a scale the EMBEDDER decides, and a
 * rerank threshold on one the reranker decides. Nothing used to connect a
 * model swap to the knob measured against it, so 0.35 tuned on bge-m3 quietly
 * became a different gate the day the corpus moved to Qwen3.
 *
 * The ruling is warn-don't-mutate, so this panel is where an operator finds
 * out. Three states, and the third is the one that is easy to get wrong: no
 * record at all is the ABSENCE of evidence, not evidence of a change.
 */
describe('RetrievalTab — confidence calibration (#1114)', () => {
  const BGE = {
    providerId: '11111111-2222-3333-4444-555555555555',
    model: 'bge-m3',
    setAt: '2026-08-01T10:00:00.000Z',
  };

  function calibration(
    over: Partial<Record<'similarity' | 'rerank', Record<string, unknown> | null>> = {},
  ) {
    return { similarity: null, rerank: null, ...over };
  }

  const staleSimilarity = {
    ...BGE,
    liveProviderId: BGE.providerId,
    liveModel: 'Qwen3-Embedding-4B',
    liveResolved: true,
    stale: true,
  };
  const freshSimilarity = {
    ...BGE,
    liveProviderId: BGE.providerId,
    liveModel: 'bge-m3',
    liveResolved: true,
    stale: false,
  };
  /** What the route answers when it really recorded the pair. */
  const recorded = (model: string | null) => () => ({
    ragConfidenceCalibrationWrite: { similarity: { outcome: 'recorded', model }, rerank: null },
  });

  const stripId = 'retrieval-ragConfidenceThreshold-calibration-stale';
  const unknownId = 'retrieval-ragConfidenceThreshold-calibration-unknown';

  it('names the old model, the live one and the remedy when the calibration is stale', async () => {
    mockApi({
      settings: {
        ...defaultSettings,
        ragConfidenceThreshold: 0.35,
        ragConfidenceCalibration: calibration({ similarity: staleSimilarity }),
      },
    });
    renderTab();
    await ready();

    const strip = await screen.findByTestId(stripId);
    expect(strip).toHaveTextContent(/Similarity basis 0\.35 was set while/);
    expect(strip).toHaveTextContent(/bge-m3 was the embedding model/);
    expect(strip).toHaveTextContent(/The live model is Qwen3-Embedding-4B/);
    // Naming the mechanism is the point: an operator who is told only "stale"
    // has no way to judge whether the number is now too strict or too loose.
    expect(strip).toHaveTextContent(/similarity scale differs/);
    expect(strip).toHaveTextContent(/re-tune it below, or keep it and record it against the live model/);
    // Both remedies are reachable: the number itself, and a control that
    // records the number the operator already chose.
    const keep = within(strip).getByTestId('retrieval-ragConfidenceThreshold-calibration-keep');
    expect(keep).toHaveTextContent(/Keep 0\.35/);
    // WCAG 2.5.3: the accessible name carries the visible label, and the
    // strip's own sentence is what disambiguates two identically-labelled
    // controls, via aria-describedby rather than an overriding aria-label.
    expect(keep).not.toHaveAttribute('aria-label');
    expect(strip.querySelector(`#${keep.getAttribute('aria-describedby')}`)).not.toBeNull();
  });

  it('renders it as the panel amber strip: role=status, the recipe classes and the 16px glyph', async () => {
    // ADR-010 / the panel's own failed-save strip: colour is the weaker
    // channel under `forced-colors` and for a colour-blind admin.
    const { container } = (() => {
      mockApi({
        settings: {
          ...defaultSettings,
          ragConfidenceThreshold: 0.35,
          ragConfidenceCalibration: calibration({ similarity: staleSimilarity }),
        },
      });
      return renderTab();
    })();
    await ready();

    const strip = await screen.findByTestId(stripId);
    expect(strip).toHaveAttribute('role', 'status');
    expect(strip.className).toMatch(/border-warning\/30/);
    expect(strip.className).toMatch(/bg-warning\/10/);
    expect(strip.className).toMatch(/text-warning/);
    const glyph = strip.querySelector('svg');
    expect(glyph).not.toBeNull();
    expect(glyph!.getAttribute('width')).toBe('16');
    expect(glyph!.getAttribute('aria-hidden')).toBe('true');
    expect(container).toBeTruthy();
  });

  it('sits directly above the control it is about', async () => {
    mockApi({
      settings: {
        ...defaultSettings,
        ragConfidenceThreshold: 0.35,
        ragConfidenceCalibration: calibration({ similarity: staleSimilarity }),
      },
    });
    renderTab();
    await ready();

    const strip = await screen.findByTestId(stripId);
    const control = input('ragConfidenceThreshold');
    // Review r1: `compareDocumentPosition` alone only asserts ORDER, and
    // passes for a strip parked four sections earlier in the panel. What the
    // deliverable asks for is adjacency, so assert adjacency: the strip is
    // the immediately-preceding element sibling of the row that owns the
    // input, inside the same section.
    const row = control.closest('div.space-y-1\\.5');
    expect(row).not.toBeNull();
    expect(row!.previousElementSibling).toBe(strip);
    // And still the right way round.
    expect(strip.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says nothing when the recorded pair is still the live one', async () => {
    mockApi({
      settings: {
        ...defaultSettings,
        ragConfidenceThreshold: 0.35,
        ragConfidenceCalibration: calibration({ similarity: freshSimilarity }),
      },
    });
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragConfidenceThreshold').value).toBe('0.35'));

    expect(screen.queryByTestId(stripId)).not.toBeInTheDocument();
    expect(screen.queryByTestId(unknownId)).not.toBeInTheDocument();
  });

  it('says nothing when the gate is OFF, however stale the record', async () => {
    // 0 means the gate does not run. Warning about the calibration of a
    // threshold that gates nothing is noise on the most reserved colour.
    mockApi({
      settings: {
        ...defaultSettings,
        ragConfidenceThreshold: 0,
        ragConfidenceCalibration: calibration({ similarity: staleSimilarity }),
      },
    });
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragConfidenceThreshold').value).toBe('0'));

    expect(screen.queryByTestId(stripId)).not.toBeInTheDocument();
    expect(screen.queryByTestId(unknownId)).not.toBeInTheDocument();
  });

  it('reports an unrecorded calibration MUTED, not amber', async () => {
    // Every threshold set before this feature existed lands here. Absence of
    // evidence is not evidence of a change, and an amber strip on every
    // upgraded instance is how amber stops meaning anything.
    mockApi({
      settings: {
        ...defaultSettings,
        ragConfidenceThreshold: 0.35,
        ragConfidenceCalibration: calibration(),
      },
    });
    renderTab();
    await ready();

    const note = await screen.findByTestId(unknownId);
    expect(note).toHaveTextContent(/Calibration unknown/i);
    // Review r2 — it states what is MISSING, never why. A record write that
    // failed and one that never happened are the same absence here, and
    // "set before models were recorded" is a false claim about the first.
    expect(note).not.toHaveTextContent(/set before models were recorded/i);
    expect(note.className).toContain('text-muted-foreground');
    expect(note.className).not.toMatch(/warning/);
    expect(note).not.toHaveAttribute('role', 'status');
    expect(screen.queryByTestId(stripId)).not.toBeInTheDocument();
  });

  it('the muted note names a remedy the panel can actually perform', async () => {
    // Review r2, the blocking one. The note used to say "save to record it
    // against the live model" while Save is a pure value diff and this branch
    // rendered no control — so recording the number you already have was
    // reachable only by changing the gate to a different number and back.
    // Every upgraded instance with a live threshold lands here, which made a
    // permanent note out of a false instruction.
    const settings: Record<string, unknown> = {
      ...defaultSettings,
      ragConfidenceThreshold: 0.35,
      ragConfidenceCalibration: calibration(),
    };
    const puts = mockApi({
      settings,
      afterPut: (body, current) => {
        if (body.ragConfidenceThreshold === undefined) return;
        current.ragConfidenceCalibration = calibration({ similarity: freshSimilarity });
      },
    });
    renderTab();
    await ready();

    const note = await screen.findByTestId(unknownId);
    const record = within(note).getByTestId('retrieval-ragConfidenceThreshold-calibration-record');
    expect(record).toHaveTextContent(/Record 0\.35/);
    // Same WCAG 2.5.3 wiring as the amber strip's button: the visible label is
    // the accessible name, and the sentence above disambiguates the two.
    expect(record).not.toHaveAttribute('aria-label');
    expect(note.querySelector(`#${record.getAttribute('aria-describedby')}`)).not.toBeNull();

    fireEvent.click(record);

    await waitFor(() => expect(puts).toHaveLength(1));
    // Exactly the one threshold, exactly the SERVER's number: recording a
    // calibration must not smuggle a value change through.
    expect(puts[0]).toEqual({ ragConfidenceThreshold: 0.35 });
    await waitFor(() => expect(screen.queryByTestId(unknownId)).not.toBeInTheDocument());
  });

  it('warns per basis — the rerank threshold gets its own strip and its own scale word', async () => {
    mockApi({
      settings: {
        ...defaultSettings,
        ragConfidenceThresholdRerank: 0.2,
        ragConfidenceCalibration: calibration({
          rerank: {
            providerId: '99999999-9999-4999-8999-999999999999',
            model: 'bge-reranker-v2-m3',
            setAt: '2026-08-01T10:00:00.000Z',
            liveProviderId: '99999999-9999-4999-8999-999999999999',
            liveModel: 'jina-reranker-v2',
            liveResolved: true,
            stale: true,
          },
        }),
      },
    });
    renderTab();
    await ready();

    const strip = await screen.findByTestId('retrieval-ragConfidenceThresholdRerank-calibration-stale');
    expect(strip).toHaveTextContent(/Rerank basis 0\.2 was set while/);
    expect(strip).toHaveTextContent(/bge-reranker-v2-m3 was the rerank model/);
    expect(strip).toHaveTextContent(/relevance scale differs/);
    // The similarity threshold is 0 and unrecorded — nothing about it.
    expect(screen.queryByTestId(stripId)).not.toBeInTheDocument();
    expect(screen.queryByTestId(unknownId)).not.toBeInTheDocument();
  });

  it('says the basis gates nothing when its model is gone entirely', async () => {
    mockApi({
      settings: {
        ...defaultSettings,
        ragConfidenceThresholdRerank: 0.2,
        ragConfidenceCalibration: calibration({
          rerank: {
            providerId: '99999999-9999-4999-8999-999999999999',
            model: 'bge-reranker-v2-m3',
            setAt: '2026-08-01T10:00:00.000Z',
            liveProviderId: null,
            liveModel: null,
            liveResolved: true,
            stale: true,
          },
        }),
      },
    });
    renderTab();
    await ready();

    const strip = await screen.findByTestId('retrieval-ragConfidenceThresholdRerank-calibration-stale');
    expect(strip).toHaveTextContent(/No rerank model is assigned now/);
    expect(strip).not.toHaveTextContent(/The live model is/);
  });

  it('says so when the threshold was recorded against NOTHING, and a model has since appeared', async () => {
    // Review r1: saving a rerank threshold while the stage is unassigned is a
    // normal ADR-021 state, and it used to be stored as a literal `null` that
    // read back as "no record" — so the panel claimed the number predated the
    // feature and offered a remedy that could never clear the note. A record
    // with a null pair is a real record: it says "tuned against nothing", and
    // it goes stale the moment something is assigned.
    mockApi({
      settings: {
        ...defaultSettings,
        ragConfidenceThresholdRerank: 0.2,
        ragConfidenceCalibration: calibration({
          rerank: {
            providerId: null,
            model: null,
            setAt: '2026-08-01T10:00:00.000Z',
            liveProviderId: '99999999-9999-4999-8999-999999999999',
            liveModel: 'jina-reranker-v2',
            liveResolved: true,
            stale: true,
          },
        }),
      },
    });
    renderTab();
    await ready();

    const strip = await screen.findByTestId('retrieval-ragConfidenceThresholdRerank-calibration-stale');
    expect(strip).toHaveTextContent(/Rerank basis 0\.2 was set while no rerank model was assigned/);
    expect(strip).toHaveTextContent(/The live model is jina-reranker-v2/);
    // Never the pre-#1114 wording: this one WAS recorded.
    expect(
      screen.queryByTestId('retrieval-ragConfidenceThresholdRerank-calibration-unknown'),
    ).not.toBeInTheDocument();
  });

  it('says nothing when the threshold was recorded against nothing and nothing is assigned still', async () => {
    // Recorded, matching, and the disabled stage is already announced by the
    // rerank pool's own status line. Nothing has changed under this number.
    mockApi({
      settings: {
        ...defaultSettings,
        ragConfidenceThresholdRerank: 0.2,
        ragConfidenceCalibration: calibration({
          rerank: {
            providerId: null,
            model: null,
            setAt: '2026-08-01T10:00:00.000Z',
            liveProviderId: null,
            liveModel: null,
            liveResolved: true,
            stale: false,
          },
        }),
      },
    });
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragConfidenceThresholdRerank').value).toBe('0.2'));

    expect(
      screen.queryByTestId('retrieval-ragConfidenceThresholdRerank-calibration-stale'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('retrieval-ragConfidenceThresholdRerank-calibration-unknown'),
    ).not.toBeInTheDocument();
  });

  it('clears once the threshold is RE-TUNED and saved — the other remedy the copy promises', async () => {
    const settings: Record<string, unknown> = {
      ...defaultSettings,
      ragConfidenceThreshold: 0.35,
      ragConfidenceCalibration: calibration({ similarity: staleSimilarity }),
    };
    const puts = mockApi({
      settings,
      // The server records the LIVE pair on every write of the threshold.
      afterPut: (body, current) => {
        if (body.ragConfidenceThreshold === undefined) return;
        current.ragConfidenceThreshold = body.ragConfidenceThreshold;
        current.ragConfidenceCalibration = calibration({
          similarity: {
            ...staleSimilarity,
            model: 'Qwen3-Embedding-4B',
            setAt: '2026-08-16T12:00:00.000Z',
            stale: false,
          },
        });
      },
    });
    renderTab();
    await ready();
    await screen.findByTestId(stripId);

    type('ragConfidenceThreshold', '0.5');
    fireEvent.click(screen.getByTestId('retrieval-save-btn'));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toHaveProperty('ragConfidenceThreshold', 0.5);
    await waitFor(() => expect(screen.queryByTestId(stripId)).not.toBeInTheDocument());
  });

  it('keeping the number is its own control, aimed at that one threshold', async () => {
    // The strip's remedy changes no VALUE, so the panel's value-diffed Save
    // can never carry it. Review r1 settled which way that gets fixed: not by
    // arming Save (see the test below), but by a control inside the strip
    // that PUTs exactly the threshold the strip is about.
    const settings: Record<string, unknown> = {
      ...defaultSettings,
      ragConfidenceThreshold: 0.35,
      ragConfidenceCalibration: calibration({ similarity: staleSimilarity }),
    };
    const puts = mockApi({
      settings,
      afterPut: (body, current) => {
        if (body.ragConfidenceThreshold === undefined) return;
        current.ragConfidenceCalibration = calibration({
          similarity: { ...staleSimilarity, model: 'Qwen3-Embedding-4B', stale: false },
        });
      },
    });
    renderTab();
    await ready();
    const strip = await screen.findByTestId(stripId);

    fireEvent.click(within(strip).getByTestId(`retrieval-${'ragConfidenceThreshold'}-calibration-keep`));

    await waitFor(() => expect(puts).toHaveLength(1));
    // ONLY that threshold: the panel still writes no row nobody set.
    expect(puts[0]).toEqual({ ragConfidenceThreshold: 0.35 });
    await waitFor(() => expect(screen.queryByTestId(stripId)).not.toBeInTheDocument());
  });

  it('keeping a threshold leaves an unsaved edit elsewhere on the panel alone', async () => {
    // Keep is aimed at one row, so it must not behave like Save. The panel's
    // one-shot hydration exists because re-seeding from the server silently
    // reverts the admin's unsaved edits (#949); a control that has nothing to
    // do with those edits must not trigger it.
    const settings: Record<string, unknown> = {
      ...defaultSettings,
      ragConfidenceThreshold: 0.35,
      ragConfidenceCalibration: calibration({ similarity: staleSimilarity }),
    };
    const puts = mockApi({
      settings,
      afterPut: (body, current) => {
        if (body.ragConfidenceThreshold === undefined) return;
        current.ragConfidenceCalibration = calibration({
          similarity: { ...staleSimilarity, model: 'Qwen3-Embedding-4B', stale: false },
        });
      },
    });
    renderTab();
    await ready();
    const strip = await screen.findByTestId(stripId);

    type('ragFetchWidth', '40');
    fireEvent.click(within(strip).getByTestId('retrieval-ragConfidenceThreshold-calibration-keep'));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ ragConfidenceThreshold: 0.35 });
    await waitFor(() => expect(screen.queryByTestId(stripId)).not.toBeInTheDocument());
    // The draft survives, and is still what Save would send.
    expect(input('ragFetchWidth').value).toBe('40');
    expect(screen.getByTestId('retrieval-save-btn')).not.toBeDisabled();
  });

  it('a save of an UNRELATED knob never certifies a stale threshold', async () => {
    // Review r1, the blocking one. `admin.ts` deliberately re-records only a
    // threshold the PUT actually carried — re-dating an untouched one
    // certifies it against a model nobody tuned it on. The panel must not
    // hand it one: an operator who edited the fetch width made no judgement
    // about the refuse gate, and clearing the strip for them retires the only
    // standing surface saying the gate needs re-tuning (the swap's log line is
    // long gone by then).
    const settings: Record<string, unknown> = {
      ...defaultSettings,
      ragConfidenceThreshold: 0.35,
      ragConfidenceCalibration: calibration({ similarity: staleSimilarity }),
    };
    const puts = mockApi({
      settings,
      afterPut: (body, current) => {
        Object.assign(current, body);
        if (body.ragConfidenceThreshold === undefined) return;
        current.ragConfidenceCalibration = calibration({
          similarity: { ...staleSimilarity, model: 'Qwen3-Embedding-4B', stale: false },
        });
      },
    });
    renderTab();
    await ready();
    await screen.findByTestId(stripId);

    type('ragFetchWidth', '40');
    fireEvent.click(screen.getByTestId('retrieval-save-btn'));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ ragFetchWidth: 40 });
    await waitFor(() => expect(input('ragFetchWidth').value).toBe('40'));
    expect(screen.getByTestId(stripId)).toBeInTheDocument();
  });

  it('does NOT arm Save while a calibration is stale', async () => {
    // Save is a value diff and nothing else. Arming it on staleness is what
    // let an unrelated edit ride the threshold along.
    mockApi({
      settings: {
        ...defaultSettings,
        ragConfidenceThreshold: 0.35,
        ragConfidenceCalibration: calibration({ similarity: staleSimilarity }),
      },
    });
    renderTab();
    await ready();
    await screen.findByTestId(stripId);

    expect(screen.getByTestId('retrieval-save-btn')).toBeDisabled();
  });

  it('does NOT arm Save for an unrecorded calibration', async () => {
    // Every pre-#1114 threshold is unrecorded. Arming Save there would be a
    // permanent nag on every upgraded instance for a change nobody observed.
    mockApi({
      settings: {
        ...defaultSettings,
        ragConfidenceThreshold: 0.35,
        ragConfidenceCalibration: calibration(),
      },
    });
    renderTab();
    await ready();
    await screen.findByTestId(unknownId);

    expect(screen.getByTestId('retrieval-save-btn')).toBeDisabled();
  });

  it('keeps the panel free of amber at rest, with the calibration wired in', async () => {
    // The default document: both gates off, nothing ever recorded. The
    // panel's standing no-amber guard has to survive this feature.
    mockApi({ settings: { ...defaultSettings, ragConfidenceCalibration: calibration() } });
    const { container } = renderTab();
    await ready();
    await waitFor(() => expect(input('ragConfidenceThreshold').value).toBe('0'));

    expect(container.innerHTML).not.toMatch(/\b(text|bg|border)-warning\b/);
  });

  it('survives a server that has not shipped the field yet, and claims nothing', async () => {
    // A frontend deployed ahead of its backend must render the panel, not
    // crash on `settings.ragConfidenceCalibration.similarity` — and it must
    // not report "calibration unknown" either (review r2): a server that has
    // not shipped the field has told us nothing, and the note's own remedy
    // would be a dead end against a backend that records nothing.
    mockApi({ settings: { ...defaultSettings, ragConfidenceThreshold: 0.35 } });
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragConfidenceThreshold').value).toBe('0.35'));
    expect(screen.queryByTestId(stripId)).not.toBeInTheDocument();
    expect(screen.queryByTestId(unknownId)).not.toBeInTheDocument();
  });

  it('reads the SERVER value, never the draft in the field', async () => {
    // Review r2 — the rule the component comment, CLAUDE.md and
    // 09-flow-rag-chat.md all call load-bearing, and which nothing tested:
    // swapping `saved` for `values` left the suite green. Two regressions
    // ride on it — typing 0 would make the notice vanish while the server is
    // still gated at 0.35, and Keep would certify a number nobody submitted.
    const settings: Record<string, unknown> = {
      ...defaultSettings,
      ragConfidenceThreshold: 0.35,
      ragConfidenceCalibration: calibration({ similarity: staleSimilarity }),
    };
    const puts = mockApi({ settings });
    renderTab();
    await ready();
    await screen.findByTestId(stripId);

    type('ragConfidenceThreshold', '0.5');

    const strip = screen.getByTestId(stripId);
    expect(strip).toHaveTextContent(/Similarity basis 0\.35 was set while/);
    const keep = within(strip).getByTestId('retrieval-ragConfidenceThreshold-calibration-keep');
    expect(keep).toHaveTextContent(/Keep 0\.35/);

    fireEvent.click(keep);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ ragConfidenceThreshold: 0.35 });
    // And the draft is still the admin's to save or abandon.
    expect(input('ragConfidenceThreshold').value).toBe('0.5');
  });

  it('names the model when the server says it recorded one, instead of asserting a generic success', async () => {
    // Review r3. The route answers 200 whether or not the record beside the
    // threshold landed, so a toast fired on the status code alone is the
    // panel claiming an outcome it never observed.
    toastSuccess.mockClear();
    toastError.mockClear();
    const settings: Record<string, unknown> = {
      ...defaultSettings,
      ragConfidenceThreshold: 0.35,
      ragConfidenceCalibration: calibration({ similarity: staleSimilarity }),
    };
    mockApi({
      settings,
      putResult: recorded('Qwen3-Embedding-4B'),
      afterPut: (body, current) => {
        if (body.ragConfidenceThreshold === undefined) return;
        current.ragConfidenceCalibration = calibration({
          similarity: { ...staleSimilarity, model: 'Qwen3-Embedding-4B', stale: false },
        });
      },
    });
    renderTab();
    await ready();

    fireEvent.click(
      within(await screen.findByTestId(stripId)).getByTestId(
        'retrieval-ragConfidenceThreshold-calibration-keep',
      ),
    );

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(String(toastSuccess.mock.calls.at(-1)?.[0])).toMatch(/recorded against Qwen3-Embedding-4B/);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('does NOT report success when the server declined to record — the notice stays and says why', async () => {
    // The one persistent failure mode: the route abstains whenever the live
    // model cannot be resolved, and `resolved: false` is not always transient
    // (an undecryptable provider key after a `PAT_ENCRYPTION_KEY` rotation, an
    // EE policy naming a deleted provider). Told "recorded", the operator
    // watches the same notice come back with no explanation.
    toastSuccess.mockClear();
    toastError.mockClear();
    mockApi({
      settings: {
        ...defaultSettings,
        ragConfidenceThreshold: 0.35,
        ragConfidenceCalibration: calibration({ similarity: staleSimilarity }),
      },
      putResult: () => ({
        ragConfidenceCalibrationWrite: {
          similarity: { outcome: 'unresolved', model: null },
          rerank: null,
        },
      }),
    });
    renderTab();
    await ready();

    fireEvent.click(
      within(await screen.findByTestId(stripId)).getByTestId(
        'retrieval-ragConfidenceThreshold-calibration-keep',
      ),
    );

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls.at(-1)?.[0])).toMatch(
      /Could not resolve the live embedding model/i,
    );
    expect(toastSuccess).not.toHaveBeenCalled();
    // And the strip is still standing, because nothing was recorded.
    expect(await screen.findByTestId(stripId)).toBeInTheDocument();
  });

  it('says the live model could not be RESOLVED, never that none is assigned', async () => {
    // Review r3. Both states reach the panel with a null live pair, and only
    // one is a fact about the assignment. Naming the wrong one sends the
    // operator to the assignment grid instead of the provider row — for good,
    // since both causes throw on every read.
    mockApi({
      settings: {
        ...defaultSettings,
        ragConfidenceThreshold: 0.35,
        ragConfidenceCalibration: calibration({
          similarity: { ...BGE, liveProviderId: null, liveModel: null, liveResolved: false, stale: true },
        }),
      },
    });
    renderTab();
    await ready();

    const strip = await screen.findByTestId(stripId);
    expect(strip).toHaveTextContent(/could not be resolved/i);
    expect(strip).not.toHaveTextContent(/No embedding model is assigned now/i);
    // And it points at the row that can actually be wrong.
    expect(within(strip).getByRole('link', { name: /LLM providers/i })).toBeInTheDocument();
  });

  it('the muted note promises an ACTION, not a live model it cannot see', async () => {
    // Review r3. This branch has no calibration object, so it has no live
    // pair to name — and the reachable case is ordinary (a rerank threshold
    // set before #1114 on an instance whose rerank stage is unassigned),
    // where pressing the button records "tuned against nothing" rather than
    // any live model. Its amber sibling was given separate copy for exactly
    // that state.
    mockApi({
      settings: {
        ...defaultSettings,
        ragConfidenceThresholdRerank: 0.2,
        ragConfidenceCalibration: calibration(),
      },
    });
    renderTab();
    await ready();

    const note = await screen.findByTestId('retrieval-ragConfidenceThresholdRerank-calibration-unknown');
    expect(note).toHaveTextContent(/Record the model behind it now/i);
    expect(note).not.toHaveTextContent(/against the live model/i);
  });

  it('reports "no rerank model is assigned" as a SUCCESS when that is what the server recorded', async () => {
    // The muted note's own reachable case: a rerank threshold predating #1114
    // on an instance whose stage is unassigned (ADR-021's ordinary state).
    // Pressing Record there records a null pair — a real outcome, not a
    // failure — so the toast must name it and must not be an error. This is
    // the branch the note's copy is deliberately worded for ("record the model
    // behind it now", never "against the live model"), because there is no
    // live pair to name; asserting only the model-named branch left the panel
    // free to word this one as anything at all.
    toastSuccess.mockClear();
    toastError.mockClear();
    mockApi({
      settings: {
        ...defaultSettings,
        ragConfidenceThresholdRerank: 0.2,
        ragConfidenceCalibration: calibration(),
      },
      putResult: () => ({
        ragConfidenceCalibrationWrite: {
          similarity: null,
          rerank: { outcome: 'recorded', model: null },
        },
      }),
    });
    renderTab();
    await ready();

    const note = await screen.findByTestId('retrieval-ragConfidenceThresholdRerank-calibration-unknown');
    fireEvent.click(
      within(note).getByTestId('retrieval-ragConfidenceThresholdRerank-calibration-record'),
    );

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(String(toastSuccess.mock.calls.at(-1)?.[0])).toMatch(/no rerank model is assigned/i);
    // "Recorded against nothing" is still recorded. Routing it to the error
    // toast would tell the operator their one remedy had failed.
    expect(toastError).not.toHaveBeenCalled();
  });

  it('the muted note reads the SERVER value too', async () => {
    const settings: Record<string, unknown> = {
      ...defaultSettings,
      ragConfidenceThreshold: 0.35,
      ragConfidenceCalibration: calibration(),
    };
    const puts = mockApi({ settings });
    renderTab();
    await ready();
    await screen.findByTestId(unknownId);

    type('ragConfidenceThreshold', '0.5');

    const note = screen.getByTestId(unknownId);
    expect(note).toHaveTextContent(/Similarity basis 0\.35/);
    fireEvent.click(within(note).getByTestId('retrieval-ragConfidenceThreshold-calibration-record'));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ ragConfidenceThreshold: 0.35 });
  });
});

describe('RetrievalTab — image retrieval (#1115 P3)', () => {
  it('seeds all three image knobs from the server document', async () => {
    mockApi({
      settings: {
        ...defaultSettings,
        ragImageLegEnabled: false,
        ragImagesPerPageMax: 7,
        ragImageIndexExternal: false,
      },
    });
    renderTab();
    await ready();

    await waitFor(() =>
      expect((screen.getByTestId('rag-image-leg-enabled') as HTMLInputElement).checked).toBe(false),
    );
    expect(input('ragImagesPerPageMax').value).toBe('7');
    expect((screen.getByTestId('rag-image-index-external') as HTMLInputElement).checked).toBe(false);
  });

  it('defaults to the leg ON when the server document predates the knob', async () => {
    // An instance upgraded into this release has no row, and the reader's
    // default is on. A panel defaulting to OFF would report a leg that is
    // running as switched off.
    mockApi({ settings: defaultSettings });
    renderTab();
    await ready();
    await waitFor(() =>
      expect((screen.getByTestId('rag-image-leg-enabled') as HTMLInputElement).checked).toBe(true),
    );
    expect(input('ragImagesPerPageMax').value).toBe('20');
    expect((screen.getByTestId('rag-image-index-external') as HTMLInputElement).checked).toBe(true);
  });

  it('saves ONLY the image knob that changed', async () => {
    const puts = mockApi();
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragFetchWidth').value).toBe('10'));

    fireEvent.click(screen.getByTestId('rag-image-leg-enabled'));
    fireEvent.click(screen.getByTestId('retrieval-save-btn'));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ ragImageLegEnabled: false });
  });

  it('saves the intake knobs through the same PUT', async () => {
    const puts = mockApi();
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragImagesPerPageMax').value).toBe('20'));

    type('ragImagesPerPageMax', '5');
    fireEvent.click(screen.getByTestId('rag-image-index-external'));
    fireEvent.click(screen.getByTestId('retrieval-save-btn'));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ ragImagesPerPageMax: 5, ragImageIndexExternal: false });
  });

  it('names the unassigned state in MUTED copy, keeps the controls live, and points at the panel', async () => {
    mockApi();
    renderTab();
    await ready();

    const note = await screen.findByTestId('retrieval-image-unassigned');
    expect(note).toHaveTextContent(/Image embedding is not assigned; the image leg does not run\./);
    // ADR-010: a permanent, correct state is not a warning. Amber that is
    // always on is amber that stops meaning anything.
    expect(note.className).toContain('text-muted-foreground');
    expect(note.className).not.toMatch(/warning|amber/);
    expect(note).not.toHaveAttribute('role', 'status');
    // Wayfinding: the link goes to the panel that owns the assignment.
    const link = within(note).getByRole('link');
    expect(link.getAttribute('href')).toContain('?sub=llm');
    // Settings, not actions — an operator may configure the leg before
    // assigning the model.
    expect((screen.getByTestId('rag-image-leg-enabled') as HTMLInputElement).disabled).toBe(false);
    expect(input('ragImagesPerPageMax').disabled).toBe(false);
  });

  it('drops the notice once a vision-language model is assigned', async () => {
    mockApi({ imageEmbedding: assignedImageEmbedding() });
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragFetchWidth').value).toBe('10'));
    expect(screen.queryByTestId('retrieval-image-unassigned')).not.toBeInTheDocument();
  });

  it('says nothing at all while the assignment query has not answered', async () => {
    // Telling an operator the leg is off on evidence the panel has not
    // collected is worse than saying nothing — `usePageTree`'s rule, one
    // surface over. An absent assignments document is silence, not a verdict.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (inputArg) => {
      const url = typeof inputArg === 'string' ? inputArg : (inputArg as Request).url;
      if (url.includes('/admin/llm-usecases')) return new Response('boom', { status: 500 });
      if (url.includes('/admin/settings')) {
        return new Response(JSON.stringify(defaultSettings), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    });
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragFetchWidth').value).toBe('10'));
    expect(screen.queryByTestId('retrieval-image-unassigned')).not.toBeInTheDocument();
  });

  it('states the cost of the leg on screen, at rest', async () => {
    // #1119's rule: a caveat that lives in a tooltip is unreachable by touch,
    // keyboard and screen readers. The leg costs one extra embedding call per
    // question, and an operator deciding whether to leave it on needs that
    // beside the switch rather than in a runbook.
    mockApi();
    renderTab();
    await ready();
    const group = screen.getByTestId('rag-image-leg-enabled').closest('section')!;
    expect(group.textContent).toMatch(/one extra embedding call per question/i);
  });
});

describe('RetrievalTab — images shown to the model (#1115 P4)', () => {
  it('seeds the cap from the server document', async () => {
    mockApi({ settings: { ...defaultSettings, ragAnswerMaxImages: 5 } });
    renderTab();
    await ready();

    await waitFor(() => expect(input('ragAnswerMaxImages').value).toBe('5'));
  });

  it('defaults to 2 when the server document predates the knob', async () => {
    mockApi({ settings: defaultSettings });
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragAnswerMaxImages').value).toBe('2'));
  });

  it('saves 0 — the off switch is a value, not an absence', async () => {
    // The one number that a "falsy means unchanged" diff would drop, and the
    // only way an operator turns this off without unassigning the model that
    // fills the index.
    const puts = mockApi({ settings: { ...defaultSettings, ragAnswerMaxImages: 2 } });
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragAnswerMaxImages').value).toBe('2'));

    type('ragAnswerMaxImages', '0');
    fireEvent.click(screen.getByTestId('retrieval-save-btn'));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ ragAnswerMaxImages: 0 });
  });

  it('lives in the Image retrieval group, beside the leg it depends on', async () => {
    mockApi();
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragFetchWidth').value).toBe('10'));

    const group = screen.getByTestId('rag-image-leg-enabled').closest('section')!;
    expect(within(group as HTMLElement).getByTestId('retrieval-ragAnswerMaxImages')).toBeInTheDocument();
  });

  it('says on screen that a text-only chat model never receives images', async () => {
    // ADR-025 D8: a text-only answer is unqualified — nothing on the answer
    // says a picture was withheld. This is therefore the ONLY place an
    // operator can learn that the cap does nothing without a vision-capable
    // chat model, so it has to be beside the control rather than in a
    // runbook.
    mockApi();
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragFetchWidth').value).toBe('10'));

    // Scoped to the ROW that owns the input, not to the whole Image
    // retrieval section: read off the section, both assertions passed for
    // copy sitting under the leg toggle or the intake cap three controls
    // away — which is the one thing this case is meant to pin, since the
    // sentence is only findable where the control is. Same row-scoping
    // recipe as the calibration-strip adjacency case above.
    const row = input('ragAnswerMaxImages').closest('div.space-y-1\\.5');
    expect(row).not.toBeNull();
    expect(row!.textContent).toMatch(/Text-only chat models never receive images/i);
    expect(row!.textContent).toMatch(/0 turns this off/i);
  });

  it('points at the row where that verdict is shown, instead of leaving it unanswerable', async () => {
    // Review r2. The sentence above is the only surface stating the vision
    // dependency, and without a destination it leaves the reader at "can
    // mine?" — while the verdict, and #1184's Re-check that corrects a wrong
    // one, sit on the chat row two clicks away. The unassigned notice at the
    // top of this same Section already links there; the copy that depends on
    // the answer should too.
    // Assigned, so the Section's unassigned notice — which carries its own
    // link to the same route — is not rendered: this asserts the link inside
    // the helper copy itself, on the deployment where an operator is actually
    // reading this control.
    mockApi({ imageEmbedding: assignedImageEmbedding() });
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragFetchWidth').value).toBe('10'));
    expect(screen.queryByTestId('retrieval-image-unassigned')).not.toBeInTheDocument();

    const helper = screen.getByText(/Text-only chat models never receive images/i);
    // Review r2 of #1285 — the pointer is now the paragraph immediately AFTER
    // the description rather than its last sentence: this row's help text is
    // the input's `aria-describedby` region, which flattens to a text string,
    // so a link inside it announces as wayfinding the reader cannot follow
    // from the announcement. It still has to sit with the sentence it
    // answers, which is what the sibling assertion below pins.
    const help = helper.closest('[id$="-help"]');
    expect(help, 'the sentence stays the input’s own description').not.toBeNull();
    const pointer = help!.nextElementSibling as HTMLElement | null;
    expect(pointer, 'the destination sits directly under it').not.toBeNull();
    const link = within(pointer!).getByRole('link', { name: /LLM providers/i });
    expect(link.getAttribute('href')).toContain('?sub=llm');
  });
});

describe('RetrievalTab — the ef_search floor (#1285)', () => {
  it('seeds the input from the server document and sends only what changed', async () => {
    const puts = mockApi({ settings: { ...defaultSettings, ragEfSearch: 250 } });
    renderTab();
    await ready();

    await waitFor(() => expect(input('ragEfSearch').value).toBe('250'));

    type('ragEfSearch', '400');
    fireEvent.click(screen.getByTestId('retrieval-save-btn'));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ ragEfSearch: 400 });
  });

  it('renders the reader default when the server has no row', async () => {
    // The panel must never invent its own default: 100 is what the reader
    // resolves, so DEFAULTS has to mirror it or the control reports a number
    // the kNN probes are not running at.
    mockApi();
    renderTab();
    await ready();

    await waitFor(() => expect(input('ragEfSearch').value).toBe('100'));
  });

  it("clamps to pgvector's own [1, 1000] bound on commit", async () => {
    mockApi();
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragEfSearch').value).toBe('100'));

    type('ragEfSearch', '0');
    expect(input('ragEfSearch').value).toBe('1');
    type('ragEfSearch', '5000');
    expect(input('ragEfSearch').value).toBe('1000');
  });

  it('is covered by Reset all to defaults', async () => {
    // `DEFAULTS` is what that button spreads, so a field missing from it is
    // silently skipped by a control labelled "all".
    mockApi({ settings: { ...defaultSettings, ragEfSearch: 400 } });
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragEfSearch').value).toBe('400'));

    fireEvent.click(screen.getByTestId('retrieval-reset-all-btn'));
    expect(input('ragEfSearch').value).toBe('100');
  });

  it('states that it is a FLOOR, and quotes the measurement, on screen and to the control', async () => {
    // The two things an operator cannot work out from the number: raising it
    // does not raise the per-query value on its own (each probe already takes
    // 2x its own row count), and raising it is not measured to buy recall. A
    // caveat that lives only in a `title` is unreachable by touch, keyboard
    // and screen readers — ADR-010's `DeepSearchToggle` precedent — so it is
    // wired to the input with `aria-describedby`.
    mockApi();
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragEfSearch').value).toBe('100'));

    const describedBy = input('ragEfSearch').getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const help = document.getElementById(describedBy!);
    expect(help).toBeTruthy();
    expect(help!.textContent).toMatch(/floor/i);
    expect(help!.textContent).toMatch(/twice/i);
    expect(help!.textContent).toMatch(/1,?000/);
    // The measured no-gain, so nobody raises this hoping for recall.
    expect(help!.textContent).toMatch(/0\.9995/);
    // Review r1 — the cost named must be one this control can move.
    // `hnsw.ef_search` is a QUERY-time setting; index footprint is fixed by
    // how the index was built, so quoting it here both named a cost that does
    // not exist and inverted the measurement, which says to leave this alone
    // and watch footprint INSTEAD.
    expect(help!.textContent).toMatch(/query time/i);
    expect(help!.textContent).toMatch(/1\.74 ms/);
    expect(help!.textContent).not.toMatch(/footprint/i);
  });

  it('keeps every described region prose \u2014 no control folded into a field\u2019s description', async () => {
    // Review r2 \u2014 the wiring above is on EVERY NumberRow, and three rows
    // carried interactive children: the rerank-stage link, the vision
    // wayfinding link, and `Use measured value`. `aria-describedby` flattens
    // its region to a text string, so a button in there announces as prose
    // with nothing saying it can be pressed, and a link announces as
    // wayfinding the reader cannot follow from the announcement. It is the
    // same rule the RAG_EF_SEARCH note is placed outside its row to obey, so
    // it is enforced across the panel rather than stated once in a comment.
    //
    // Rendered with rerank UNASSIGNED and the prior at its 0 default, which
    // is what makes the link and the button render at all.
    mockApi();
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragEfSearch').value).toBe('100'));

    expect(describedRegions().length).toBeGreaterThan(0);
    expect(
      describedRegionOffenders(),
      'a description is read as one flat string \u2014 put operable controls and wayfinding links in `aside`, beside it',
    ).toEqual([]);

    // \u2026and the three that moved are still on screen, so this is a relocation
    // rather than a deletion.
    expect(screen.getByTestId('retrieval-rerank-stage-status')).toBeInTheDocument();
    expect(screen.getByTestId('retrieval-prior-use-measured')).toBeInTheDocument();
  });

  it('holds the rule for a described BUTTON too, not only a described field', async () => {
    // Review r3 \u2014 the sweep above read `input[aria-describedby],
    // select[aria-describedby]`, so it certified the layer that was never at
    // risk and stayed silent about the one live counterexample on the panel:
    // the #1114 calibration strip's `Keep` button is described by the strip's
    // sentence, and that sentence's unresolved branch carried a `<Link>` to
    // LLM providers \u2014 the exact "a link announces as wayfinding the reader
    // cannot act on from the announcement" case. The selector now reads every
    // `[aria-describedby]`, and this renders the branch that produced it.
    mockApi({
      settings: {
        ...defaultSettings,
        ragConfidenceThreshold: 0.35,
        ragConfidenceCalibration: {
          similarity: {
            providerId: '11111111-2222-3333-4444-555555555555',
            model: 'bge-m3',
            setAt: '2026-08-01T10:00:00.000Z',
            liveProviderId: null,
            liveModel: null,
            liveResolved: false,
            stale: true,
          },
          rerank: null,
        },
      },
    });
    renderTab();
    await ready();

    const keep = await screen.findByTestId('retrieval-ragConfidenceThreshold-calibration-keep');
    expect(keep.getAttribute('aria-describedby')).toBeTruthy();
    expect(
      describedRegionOffenders(),
      'a description is read as one flat string \u2014 put operable controls and wayfinding links in `aside`, beside it',
    ).toEqual([]);

    // Relocation, not deletion: the strip still points at the row that can
    // actually be wrong, on its own line beside the sentence.
    const strip = screen.getByTestId('retrieval-ragConfidenceThreshold-calibration-stale');
    expect(within(strip).getByRole('link', { name: /LLM providers/i })).toBeInTheDocument();
  });

  it('pairs min with a step the field\u2019s own values satisfy', async () => {
    // Review r1 — for `type=number` the step BASE is `min`, so `min: 1` with
    // `step: 10` made 100 (this field's default), 1000 (its max) and every
    // number the help text names a `stepMismatch`: the control renders
    // `:invalid` at rest and the spinner walks 101 / 111.
    mockApi();
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragEfSearch').value).toBe('100'));

    const el = input('ragEfSearch');
    expect(el.min).toBe('1');
    expect(el.max).toBe('1000');
    expect(el.validity.stepMismatch).toBe(false);
    for (const v of ['250', '400', '1000']) {
      type('ragEfSearch', v);
      expect(input('ragEfSearch').validity.stepMismatch, v).toBe(false);
    }
  });

  it('names the environment variable it supersedes, in muted copy and never amber', async () => {
    // Nothing seeds `rag_ef_search`, so `RAG_EF_SEARCH` stays live until this
    // panel is saved once. An operator upgrading has to be able to find that
    // out here rather than from a log line that has scrolled away — and it is
    // a fact at rest, not an attention state, so ADR-010 keeps it muted.
    mockApi({ settings: { ...defaultSettings, ragEfSearch: 250, ragEfSearchFromEnv: true } });
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragEfSearch').value).toBe('250'));

    const note = screen.getByTestId('retrieval-ef-search-env-note');
    expect(note.textContent).toMatch(/RAG_EF_SEARCH/);
    expect(note.className).toContain('text-muted-foreground');
    expect(note.className).not.toMatch(/warning|amber|destructive/);

    // Review r3 — the note's own sentence says "the setting below", and its
    // `Keep` button writes THAT field's saved value, so drifting away from
    // the row makes the copy false and the button unattributable. This is the
    // #1114 strip's adjacency guard, which exists because ORDER alone passes
    // for a notice parked four sections away.
    const row = input('ragEfSearch').closest('div.space-y-1\\.5');
    expect(row).not.toBeNull();
    expect(row!.previousElementSibling).toBe(note);
  });

  it('renders that note ONLY while the variable is what produced the value', async () => {
    // Review r1 — it used to render on every instance, including the ones
    // holding a saved row where the variable is already inert. A standing
    // notice that is false for most readers is how the panel's
    // no-notice-at-rest rule gets hollowed out.
    mockApi({ settings: { ...defaultSettings, ragEfSearch: 250, ragEfSearchFromEnv: false } });
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragEfSearch').value).toBe('250'));

    expect(screen.queryByTestId('retrieval-ef-search-env-note')).not.toBeInTheDocument();
  });

  it('offers a remedy the panel can perform: Save is dead, so the note carries the write', async () => {
    // Review r1 — the dead end this fixes. GET resolves the env value, the
    // field is seeded with it, `changed` is empty and Save is disabled: the
    // note said "set it here" while nothing here could write the row. Reset
    // to default writes 100, a DIFFERENT depth, and on an instance whose
    // variable already reads 100 there was no reachable value at all.
    const puts = mockApi({
      settings: { ...defaultSettings, ragEfSearch: 250, ragEfSearchFromEnv: true },
    });
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragEfSearch').value).toBe('250'));

    expect(
      (screen.getByTestId('retrieval-save-btn') as HTMLButtonElement).disabled,
      'Save is a pure value diff, so it cannot be the remedy here',
    ).toBe(true);

    // An unsaved edit elsewhere on the panel must survive it — this is its own
    // mutation precisely so it does not release `hydrated` (#949, #1114).
    type('ragFetchWidth', '30');

    fireEvent.click(screen.getByTestId('retrieval-ef-search-env-pin'));

    await waitFor(() => expect(puts).toHaveLength(1));
    // Exactly the resolved number, exactly one key.
    expect(puts[0]).toEqual({ ragEfSearch: 250 });
    expect(input('ragFetchWidth').value).toBe('30');
  });

  it('pins the number the SERVER resolved, never the draft in the field', async () => {
    // Review r2 — the #1114 discipline this control copies verbatim
    // ("`saved`, never the draft in the field") had nothing enforcing it here:
    // the test above types into a DIFFERENT field, so swapping
    // `pinEfSearchMutation.mutate(saved.ragEfSearch)` for
    // `values.ragEfSearch` left the whole panel suite green.
    //
    // The failure it admits is a button that lies about what it does: on an
    // env-sourced instance the field is editable, so an operator who types
    // 400 into Index search depth and then presses the button labelled
    // `Keep 250` would PUT 400 — and the note beside it would disappear,
    // certifying a depth nobody chose.
    const puts = mockApi({
      settings: { ...defaultSettings, ragEfSearch: 250, ragEfSearchFromEnv: true },
    });
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragEfSearch').value).toBe('250'));

    type('ragEfSearch', '400');
    expect(input('ragEfSearch').value).toBe('400');

    const pin = screen.getByTestId('retrieval-ef-search-env-pin');
    // The visible label still promises the server's number…
    expect(pin.textContent).toContain('250');
    fireEvent.click(pin);

    // …and that is what it writes.
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ ragEfSearch: 250 });
    // The draft is untouched — this mutation submits one row, not the form.
    expect(input('ragEfSearch').value).toBe('400');
  });

  it('describes that button with the sentence above it (WCAG 2.5.3 / 4.1.2)', async () => {
    mockApi({ settings: { ...defaultSettings, ragEfSearch: 250, ragEfSearchFromEnv: true } });
    renderTab();
    await ready();
    await waitFor(() => expect(input('ragEfSearch').value).toBe('250'));

    const button = screen.getByTestId('retrieval-ef-search-env-pin');
    // The visible label IS the name — no `aria-label` overriding it.
    expect(button.getAttribute('aria-label')).toBeNull();
    expect(button.textContent).toContain('250');
    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)!.textContent).toMatch(/RAG_EF_SEARCH/);
  });

  it('states that fuzzy title matching is fixed, where the keyword index is configured', async () => {
    // #1285's other half: 0.3 stays a source constant, and the panel that owns
    // everything around it says so rather than staying silent.
    mockApi();
    renderTab();
    await ready();

    const note = screen.getByTestId('retrieval-trgm-fixed');
    expect(note.textContent).toMatch(/fuzzy title/i);
    expect(note.textContent).toMatch(/0\.3/);
    expect(note.className).toContain('text-muted-foreground');
  });
});
