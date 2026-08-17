import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { LlmTab } from './LlmTab';
import { useAuthStore } from '../../../stores/auth-store';

// #1115 — a refused `image_embedding` assignment is reported as an error
// toast, and the reason it carries is the thing under test.
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), message: vi.fn(), warning: vi.fn() },
}));

function createWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

/** Wrapper variant that exposes the QueryClient so assertions can observe
 *  cache invalidations triggered by mutations. Used by the #355 invalidation
 *  test (Finding 1, AC-3). */
function createWrapperWithClient(): {
  Wrapper: ({ children }: { children: React.ReactNode }) => React.ReactElement;
  qc: QueryClient;
} {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { Wrapper, qc };
}

const providerA = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Ollama',
  baseUrl: 'http://localhost:11434/v1',
  authType: 'bearer' as const,
  verifySsl: true,
  defaultModel: 'qwen3:4b',
  isDefault: true,
  hasApiKey: false,
  keyPreview: null,
  createdAt: '2026-04-20T00:00:00.000Z',
  updatedAt: '2026-04-20T00:00:00.000Z',
};
const providerB = {
  ...providerA,
  id: '22222222-2222-4222-8222-222222222222',
  name: 'OpenAI',
  isDefault: false,
  defaultModel: 'gpt-4o-mini',
};

const assignments = {
  chat: {
    providerId: null,
    model: null,
    resolved: { providerId: providerA.id, providerName: 'Ollama', model: 'qwen3:4b' },
  },
  summary: {
    providerId: null,
    model: null,
    resolved: { providerId: providerA.id, providerName: 'Ollama', model: 'qwen3:4b' },
  },
  quality: {
    providerId: null,
    model: null,
    resolved: { providerId: providerA.id, providerName: 'Ollama', model: 'qwen3:4b' },
  },
  auto_tag: {
    providerId: null,
    model: null,
    resolved: { providerId: providerA.id, providerName: 'Ollama', model: 'qwen3:4b' },
  },
  embedding: {
    providerId: null,
    model: null,
    resolved: { providerId: providerA.id, providerName: 'Ollama', model: 'bge-m3' },
  },
  // #1104: unassigned rerank renders the empty sentinel — the stage is
  // disabled, never inherited from the default provider.
  rerank: {
    providerId: null,
    model: null,
    resolved: { providerId: '00000000-0000-0000-0000-000000000000', providerName: '', model: '' },
  },
  // #1115: same non-inheriting rule as rerank.
  image_embedding: {
    providerId: providerB.id,
    model: 'Qwen/Qwen3-VL-Embedding-2B',
    resolved: { providerId: providerB.id, providerName: 'OpenAI', model: 'Qwen/Qwen3-VL-Embedding-2B' },
  },
};

/** #1115 — the last record a re-probe wrote, so GET reflects it (see below). */
let lastImageProbe: Record<string, unknown> | null = null;

function mockRoutes(options?: {
  concurrentStreamsCap?: number;
  /** `null` → field omitted from the settings payload (legacy backend). */
  embeddingDimensions?: number | null;
  probeDimensions?: number;
  /** #1115 — the stored image-embedding probe, or `null` for a 404. */
  imageProbe?: Record<string, unknown> | null;
  /** #1115 — make the assignments PUT fail with this 422 body. */
  putError?: string;
  /**
   * #1115 — serve an `image_embedding` row with NO provider assigned, which is
   * every instance that has not configured the leg. The strip still renders;
   * the probe status and Re-check inside it do not.
   */
  imageUnassigned?: boolean;
  /** #1115 — what `POST …/reprobe` answers with. */
  reprobeResult?: Record<string, unknown>;
}) {
  lastImageProbe = null;
  const cap = options?.concurrentStreamsCap ?? 3;
  const settingsBody: Record<string, unknown> = {
    ftsLanguage: 'simple',
    embeddingChunkSize: 500,
    embeddingChunkOverlap: 50,
    drawioEmbedUrl: null,
    llmMaxConcurrentStreamsPerUser: cap,
  };
  if (options?.embeddingDimensions !== null) {
    settingsBody.embeddingDimensions = options?.embeddingDimensions ?? 1024;
  }
  const servedAssignments = options?.imageUnassigned
    ? {
        ...assignments,
        image_embedding: {
          providerId: null,
          model: null,
          resolved: {
            providerId: '00000000-0000-0000-0000-000000000000',
            providerName: '',
            model: '',
          },
        },
      }
    : assignments;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    if (url.endsWith('/admin/llm-providers') && (init as RequestInit).method !== 'POST') {
      return new Response(JSON.stringify([providerA, providerB]), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/admin/llm-usecases') && !(init as RequestInit).method) {
      return new Response(JSON.stringify(servedAssignments), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/admin/llm-usecases') && (init as RequestInit).method === 'PUT') {
      if (options?.putError) {
        return new Response(JSON.stringify({ error: options.putError, statusCode: 422 }), {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(servedAssignments), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // #1115 — the admin-only image-embedding probe detail + its Re-check.
    // Stateful, because the server is: a successful re-probe overwrites the
    // stored record, so the invalidation the component fires must see the NEW
    // verdict rather than the old one.
    if (url.endsWith('/admin/llm-usecases/image_embedding/probe')) {
      if (options?.imageProbe === null) {
        return new Response(JSON.stringify({ error: 'unassigned' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify(lastImageProbe ?? options?.imageProbe ?? {
          providerId: providerB.id,
          model: 'Qwen/Qwen3-VL-Embedding-2B',
          dimensions: 2048,
          tier: 'halfvec',
          probedAt: '2026-08-17T10:00:00.000Z',
          error: null,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.endsWith('/admin/llm-usecases/image_embedding/reprobe')) {
      lastImageProbe = options?.reprobeResult ?? {
        providerId: providerB.id,
        model: 'Qwen/Qwen3-VL-Embedding-2B',
        dimensions: 1024,
        tier: 'vector',
        probedAt: '2026-08-17T11:00:00.000Z',
        error: null,
      };
      return new Response(JSON.stringify(lastImageProbe), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/admin/settings') && (init as RequestInit).method !== 'PUT') {
      return new Response(JSON.stringify(settingsBody), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/admin/settings') && (init as RequestInit).method === 'PUT') {
      return new Response(JSON.stringify({ message: 'Admin settings updated' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/admin/embedding/probe') && (init as RequestInit).method === 'POST') {
      return new Response(JSON.stringify({ dimensions: options?.probeDimensions ?? 1024 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/admin/llm-providers/') && url.endsWith('/models')) {
      return new Response(JSON.stringify([{ name: 'qwen3:4b' }, { name: 'gpt-4o-mini' }]), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // #1154: UsecaseAssignmentsSection's VisionBadge reads this same key live,
    // so it must resolve to a valid UsecaseDefault shape, not the catch-all [].
    if (url.endsWith('/llm/usecase-default?usecase=chat')) {
      return new Response(
        JSON.stringify({
          usecase: 'chat',
          providerId: providerA.id,
          providerName: 'Ollama',
          model: 'qwen3:4b',
          vision: true,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } });
  });
}

describe('LlmTab', () => {
  beforeEach(() => {
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'admin',
      role: 'admin',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('renders ProviderListSection + UsecaseAssignmentsSection after data loads', async () => {
    const Wrapper = createWrapper();
    mockRoutes();
    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByText('Providers');
    await screen.findByText('Use case assignments');
    // All 5 use-case rows rendered.
    expect(screen.getByText('Chat')).toBeTruthy();
    expect(screen.getByText('Embedding')).toBeTruthy();
  });

  it('a rerank-only change reaches the PUT body — the save diff must not drop it (#1267 B1)', async () => {
    // LlmTab used to keep a private five-element use-case list; the rerank
    // row rendered and edited but diffUsecaseAssignments iterated the stale
    // list, so a rerank-only save became "No changes" and sent nothing. Both
    // lists now derive from LlmUsecaseSchema.options; this test pins the
    // SAVE path, one layer above the section component's onChange.
    const Wrapper = createWrapper();
    const spy = mockRoutes();
    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByText('Use case assignments');

    fireEvent.change(screen.getByTestId('usecase-rerank-provider'), {
      target: { value: providerB.id },
    });
    fireEvent.click(screen.getByRole('button', { name: /save use-case assignments/i }));

    await waitFor(() => {
      const put = spy.mock.calls.find(
        ([input, init]) =>
          String(typeof input === 'string' ? input : (input as URL).toString()).endsWith('/admin/llm-usecases')
          && (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(put).toBeTruthy();
      const body = JSON.parse(String((put![1] as RequestInit).body));
      expect(body.rerank).toEqual({ providerId: providerB.id });
    });
  });

  it('changing the embedding assignment reveals the re-embed banner', async () => {
    const Wrapper = createWrapper();
    mockRoutes();
    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByText('Use case assignments');
    // No banner initially.
    expect(screen.queryByRole('button', { name: /probe/i })).toBeNull();
    // Change embedding provider to providerB.
    fireEvent.change(screen.getByTestId('usecase-embedding-provider'), {
      target: { value: providerB.id },
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /probe/i })).toBeTruthy();
    });
  });

  it('names the newly selected provider\'s own default model in the pending change (review r5)', async () => {
    // `resolved` is the server's resolution of the SAVED assignment, so it
    // still says bge-m3 after switching to provider B with the model left on
    // inherit. #1116's shadow path pins whatever name it is handed into the
    // assignment at swap, so the stale one would migrate to a model the admin
    // never chose.
    const Wrapper = createWrapper();
    mockRoutes();
    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByText('Use case assignments');

    fireEvent.change(screen.getByTestId('usecase-embedding-provider'), {
      target: { value: providerB.id },
    });

    // Scoped: 'gpt-4o-mini' is also an <option> in the model dropdown.
    const card = within(await screen.findByTestId('shadow-migration-card'));
    expect(card.getByText(providerB.defaultModel)).toBeInTheDocument();
    expect(card.queryByText('bge-m3')).toBeNull();
  });

  it('stops offering the destructive re-embed while a shadow migration runs (review r9)', async () => {
    // `pending` stays non-null for the whole migration — the assignment PUT is
    // deliberately 409'd — so without this the replaced path sits under its
    // own replacement offering the same intent.
    const Wrapper = createWrapper();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.endsWith('/admin/llm-providers') && (init as RequestInit).method !== 'POST') {
        return new Response(JSON.stringify([providerA, providerB]), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/admin/embedding/shadow-migration')) {
        return new Response(
          JSON.stringify({
            active: true,
            migration: { phase: 'backfilling', model: 'gpt-4o-mini', dimensions: 1024, totalPages: 10, backfilledPages: 2, stragglerPages: 8, indexed: true, indexReady: false, startedAt: '2026-08-06T10:00:00.000Z' },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/admin/llm-usecases')) {
        return new Response(JSON.stringify(assignments), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/admin/settings')) {
        return new Response(
          JSON.stringify({ ftsLanguage: 'simple', embeddingChunkSize: 500, embeddingChunkOverlap: 50, drawioEmbedUrl: null, llmMaxConcurrentStreamsPerUser: 3, embeddingDimensions: 1024 }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    });

    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByText('Use case assignments');
    fireEvent.change(screen.getByTestId('usecase-embedding-provider'), { target: { value: providerB.id } });

    // The shadow card is up…
    expect(await screen.findByText(/pages backfilled/i)).toBeInTheDocument();
    // …and the destructive path it replaces is not offered beside it.
    await waitFor(() => expect(screen.queryByRole('button', { name: /probe/i })).toBeNull());
    expect(screen.queryByText(/Embedding provider\/model changed/i)).toBeNull();
  });

  it('a completed swap does not re-raise the destructive re-embed banner (review r8)', async () => {
    // The r7 fix reset the hydration guard synchronously, before the
    // invalidated query had refetched — so the form re-seeded from the STALE
    // document, re-armed the guard against it, and the banner came back over
    // a migration that had just succeeded. This drives the real integration:
    // swap, then assert the banner stays away.
    const Wrapper = createWrapper();
    const swapped = {
      ...assignments,
      embedding: {
        providerId: providerB.id,
        model: providerB.defaultModel,
        resolved: { providerId: providerB.id, providerName: 'OpenAI', model: providerB.defaultModel },
      },
    };
    let usecasesBody = assignments;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      const method = (init as RequestInit).method;
      if (url.endsWith('/admin/llm-providers') && method !== 'POST') {
        return new Response(JSON.stringify([providerA, providerB]), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/admin/embedding/shadow-migration') && method === 'POST') {
        usecasesBody = swapped; // the swap repoints the assignment server-side
        return new Response('{"swapped":true}', { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/admin/embedding/shadow-migration')) {
        return new Response(
          JSON.stringify({
            active: true,
            migration: { phase: 'ready', model: providerB.defaultModel, dimensions: 1024, totalPages: 3, backfilledPages: 3, stragglerPages: 0, indexed: true },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/admin/llm-usecases')) {
        return new Response(JSON.stringify(usecasesBody), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/admin/settings')) {
        return new Response(
          JSON.stringify({ ftsLanguage: 'simple', embeddingChunkSize: 500, embeddingChunkOverlap: 50, drawioEmbedUrl: null, llmMaxConcurrentStreamsPerUser: 3, embeddingDimensions: 1024 }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    });

    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByText('Use case assignments');

    fireEvent.click(await screen.findByRole('button', { name: /Swap to the new model/i }));

    await waitFor(() => expect(screen.queryByRole('button', { name: /Swap to the new model/i })).toBeNull());
    // Positive control: the form must show the pair the swap wrote. Asserting
    // only the banner's absence would pass on a harness where it never
    // renders at all.
    await waitFor(() =>
      expect((screen.getByTestId('usecase-embedding-provider') as HTMLSelectElement).value).toBe(providerB.id),
    );
    expect(screen.queryByText(/Embedding (provider\/model|model) changed/i)).toBeNull();
  });

  // #949: a background refetch (window focus, or a concurrent admin save)
  // returns a new object whenever its payload differs from cache. The old
  // no-guard hydration effect re-ran setAssignments on every reference change,
  // silently reverting the admin's unsaved dropdown edits. The one-shot guard
  // must keep the working copy under the admin's control.
  it('preserves unsaved use-case edits when the query refetches with changed data (#949)', async () => {
    const { Wrapper, qc } = createWrapperWithClient();
    mockRoutes();

    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByText('Use case assignments');

    // Admin pins Chat to providerB but has NOT saved yet.
    const chatSelect = screen.getByTestId('usecase-chat-provider') as HTMLSelectElement;
    fireEvent.change(chatSelect, { target: { value: providerB.id } });
    expect(chatSelect.value).toBe(providerB.id);

    // Simulate a background refetch landing changed data (e.g. a concurrent
    // admin pins Summary to providerB): the ['llm-usecases'] cache receives a
    // NEW object with different contents. setQueryData drives the exact code
    // path a window-focus/refetch would. The macrotask flush lets TanStack
    // Query's (async) store notification propagate and React run the resulting
    // render + hydration effect, so any un-guarded reset has fully applied
    // before we assert — a plain synchronous check would observe the pre-clobber
    // value and pass spuriously.
    await act(async () => {
      qc.setQueryData(['llm-usecases'], {
        ...assignments,
        summary: { ...assignments.summary, providerId: providerB.id },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The admin's unsaved Chat edit must survive the refetch.
    expect((screen.getByTestId('usecase-chat-provider') as HTMLSelectElement).value).toBe(
      providerB.id,
    );
  });

  // #949 (companion): the concurrent-streams cap input is hydrated from the
  // shared ['admin-settings'] cache. A background refetch must not clobber an
  // unsaved edit to the cap either.
  it('preserves an unsaved concurrent-streams cap edit when settings refetch (#949)', async () => {
    const { Wrapper, qc } = createWrapperWithClient();
    mockRoutes({ concurrentStreamsCap: 3 });

    render(<LlmTab />, { wrapper: Wrapper });
    const input = (await screen.findByTestId(
      'llm-max-concurrent-streams-per-user',
    )) as HTMLInputElement;

    // Admin edits the cap to 8 but has NOT saved yet.
    fireEvent.change(input, { target: { value: '8' } });
    expect(input.value).toBe('8');

    // A background settings refetch lands a changed cap. See the assignments
    // test above for why setQueryData + a macrotask flush reproduces this
    // deterministically.
    await act(async () => {
      qc.setQueryData(['admin-settings'], {
        ftsLanguage: 'simple',
        embeddingChunkSize: 500,
        embeddingChunkOverlap: 50,
        drawioEmbedUrl: null,
        embeddingDimensions: 1024,
        llmMaxConcurrentStreamsPerUser: 5,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The admin's unsaved edit must survive.
    expect(
      (screen.getByTestId('llm-max-concurrent-streams-per-user') as HTMLInputElement).value,
    ).toBe('8');
  });

  // #949 (review follow-up): the one-shot guard must be dropped again after a
  // successful Save (IpAllowlistTab's onSuccess setInitialized(false) pattern)
  // so the post-save refetch re-hydrates the form from the fresh server state.
  it('re-hydrates the form from the refetched server state after a successful Save (#949)', async () => {
    const Wrapper = createWrapper();
    // Stateful mock: PUT persists the diff server-side AND simulates a
    // concurrent admin having pinned Summary meanwhile. The post-save GET
    // returns the merged document; the form must reflect it — including the
    // Summary row this admin never edited, which only happens if the guard
    // was reset and the form re-seeded.
    let serverAssignments = assignments;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      const method = (init as RequestInit).method;
      if (url.endsWith('/admin/llm-providers')) {
        return new Response(JSON.stringify([providerA, providerB]), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/admin/llm-usecases') && method === 'PUT') {
        serverAssignments = {
          ...serverAssignments,
          chat: { ...serverAssignments.chat, providerId: providerB.id },
          summary: { ...serverAssignments.summary, providerId: providerB.id },
        };
        return new Response(JSON.stringify(serverAssignments), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/admin/llm-usecases')) {
        return new Response(JSON.stringify(serverAssignments), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/admin/settings')) {
        return new Response(
          JSON.stringify({
            ftsLanguage: 'simple',
            embeddingChunkSize: 500,
            embeddingChunkOverlap: 50,
            drawioEmbedUrl: null,
            embeddingDimensions: 1024,
            llmMaxConcurrentStreamsPerUser: 3,
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify([]), {
        headers: { 'Content-Type': 'application/json' },
      });
    });

    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByText('Use case assignments');

    fireEvent.change(screen.getByTestId('usecase-chat-provider'), {
      target: { value: providerB.id },
    });
    fireEvent.click(screen.getByRole('button', { name: /save use-case assignments/i }));

    // After Save + refetch, the form mirrors the server document again.
    await waitFor(() => {
      expect(
        (screen.getByTestId('usecase-summary-provider') as HTMLSelectElement).value,
      ).toBe(providerB.id);
    });
    // The admin's own saved edit is reflected too (round-tripped via server).
    expect((screen.getByTestId('usecase-chat-provider') as HTMLSelectElement).value).toBe(
      providerB.id,
    );
  });

  // #949 (review follow-up, companion): the cap guard is likewise dropped
  // after a successful runtime-limits save so the input re-hydrates from the
  // refetched settings (which may include a concurrent admin's newer value).
  it('re-hydrates the concurrent-streams cap from the refetched settings after Save (#949)', async () => {
    const Wrapper = createWrapper();
    // First GET returns cap 3; after the PUT the "server" holds 12 (simulating
    // a concurrent admin save that won). The post-save refetch must win over
    // the local working copy of 8.
    let serverCap = 3;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      const method = (init as RequestInit).method;
      if (url.endsWith('/admin/llm-providers')) {
        return new Response(JSON.stringify([providerA, providerB]), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/admin/llm-usecases')) {
        return new Response(JSON.stringify(assignments), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/admin/settings') && method === 'PUT') {
        serverCap = 12;
        return new Response(JSON.stringify({ message: 'Admin settings updated' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/admin/settings')) {
        return new Response(
          JSON.stringify({
            ftsLanguage: 'simple',
            embeddingChunkSize: 500,
            embeddingChunkOverlap: 50,
            drawioEmbedUrl: null,
            embeddingDimensions: 1024,
            llmMaxConcurrentStreamsPerUser: serverCap,
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify([]), {
        headers: { 'Content-Type': 'application/json' },
      });
    });

    render(<LlmTab />, { wrapper: Wrapper });
    const input = (await screen.findByTestId(
      'llm-max-concurrent-streams-per-user',
    )) as HTMLInputElement;

    fireEvent.change(input, { target: { value: '8' } });
    fireEvent.click(screen.getByTestId('llm-runtime-limits-save'));

    // After Save + refetch, the input reflects the authoritative server value.
    await waitFor(() => {
      expect(
        (screen.getByTestId('llm-max-concurrent-streams-per-user') as HTMLInputElement).value,
      ).toBe('12');
    });
  });

  it('Save button PUTs diff to /admin/llm-usecases', async () => {
    const Wrapper = createWrapper();
    const spy = mockRoutes();
    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByText('Use case assignments');
    fireEvent.change(screen.getByTestId('usecase-chat-provider'), {
      target: { value: providerB.id },
    });
    fireEvent.click(screen.getByRole('button', { name: /save use-case assignments/i }));
    await waitFor(() => {
      const putCall = spy.mock.calls.find(
        ([url, init]) =>
          typeof url === 'string' &&
          url.endsWith('/admin/llm-usecases') &&
          (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      expect(body.chat.providerId).toBe(providerB.id);
    });
  });

  // #355 Finding 1, AC-3: saving the use-case assignments must invalidate
  // the chat-default + use-case-scoped models query keys so the AI chat
  // input pane (AiContext.tsx) refetches without a hard reload.
  it('invalidates [llm, usecase-default] and [llm, models] after a successful save', async () => {
    const { Wrapper, qc } = createWrapperWithClient();
    mockRoutes();

    // Pre-seed the cache with stale data on the keys we expect to be
    // invalidated. After save.onSuccess fires, both should be refetched
    // (i.e. their queryState should be marked invalid/stale).
    qc.setQueryData(['llm', 'usecase-default', 'chat'], {
      usecase: 'chat',
      providerId: providerA.id,
      providerName: 'Ollama',
      model: 'qwen3:4b',
    });
    qc.setQueryData(['llm', 'models', 'chat'], [{ name: 'qwen3:4b' }]);

    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByText('Use case assignments');
    fireEvent.change(screen.getByTestId('usecase-chat-provider'), {
      target: { value: providerB.id },
    });
    fireEvent.click(screen.getByRole('button', { name: /save use-case assignments/i }));

    // After the mutation succeeds, both seeded entries must be invalidated.
    // ['llm', 'models', 'chat'] has no active observer in this render tree,
    // so it just sits invalidated. ['llm', 'usecase-default', 'chat'] *does*
    // have one now — UsecaseAssignmentsSection's VisionBadge query (#1154)
    // shares this exact key — so invalidating it triggers an immediate
    // refetch and `isInvalidated` flips back to `false` once that resolves.
    // Assert the refetch actually happened (stale seed replaced by the fresh
    // mocked response) instead of the transient invalidated flag.
    await waitFor(() => {
      const modelsEntry = qc.getQueryState(['llm', 'models', 'chat']);
      expect(modelsEntry?.isInvalidated).toBe(true);
      expect(qc.getQueryData(['llm', 'usecase-default', 'chat'])).toEqual({
        usecase: 'chat',
        providerId: providerA.id,
        providerName: 'Ollama',
        model: 'qwen3:4b',
        vision: true,
      });
    });
  });

  // ── Error state — a failed assignments query must not skeleton forever ──

  it('renders an error card with a retry button when the assignments query fails', async () => {
    const Wrapper = createWrapper();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.endsWith('/admin/llm-providers')) {
        return new Response(JSON.stringify([providerA, providerB]), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/admin/llm-usecases')) {
        return new Response(JSON.stringify({ message: 'boom' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/admin/settings')) {
        return new Response(JSON.stringify({}), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } });
    });

    render(<LlmTab />, { wrapper: Wrapper });

    // The error state renders instead of an infinite skeleton.
    await screen.findByTestId('llm-tab-error');
    expect(screen.getByTestId('llm-tab-retry')).toBeInTheDocument();
  });

  // ── Runtime limits card — per-user concurrent-SSE-stream cap (#268) ──

  it('renders the per-user concurrent stream cap with the server value', async () => {
    const Wrapper = createWrapper();
    mockRoutes({ concurrentStreamsCap: 7 });
    render(<LlmTab />, { wrapper: Wrapper });

    const input = (await screen.findByTestId(
      'llm-max-concurrent-streams-per-user',
    )) as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.type).toBe('number');
    expect(input.value).toBe('7');
    expect(input.min).toBe('1');
    expect(input.max).toBe('20');
  });

  it('falls back to the default of 3 when the server omits the value', async () => {
    const Wrapper = createWrapper();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.endsWith('/admin/llm-providers')) {
        return new Response(JSON.stringify([providerA, providerB]), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/admin/llm-usecases')) {
        return new Response(JSON.stringify(assignments), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/admin/settings')) {
        // Server omits `llmMaxConcurrentStreamsPerUser` — UI must fall back to 3.
        return new Response(
          JSON.stringify({
            embeddingDimensions: 1024,
            ftsLanguage: 'simple',
            embeddingChunkSize: 500,
            embeddingChunkOverlap: 50,
            drawioEmbedUrl: null,
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } });
    });

    render(<LlmTab />, { wrapper: Wrapper });
    const input = (await screen.findByTestId(
      'llm-max-concurrent-streams-per-user',
    )) as HTMLInputElement;
    expect(input.value).toBe('3');
  });

  it('PUTs the new cap to /admin/settings when Save is clicked', async () => {
    const Wrapper = createWrapper();
    const spy = mockRoutes({ concurrentStreamsCap: 3 });
    render(<LlmTab />, { wrapper: Wrapper });

    const input = (await screen.findByTestId(
      'llm-max-concurrent-streams-per-user',
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '8' } });
    fireEvent.click(screen.getByTestId('llm-runtime-limits-save'));

    await waitFor(() => {
      const putCall = spy.mock.calls.find(
        ([url, init]) =>
          typeof url === 'string' &&
          url.endsWith('/admin/settings') &&
          (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      expect(body.llmMaxConcurrentStreamsPerUser).toBe(8);
    });
  });

  // ── Embedding dimensions source (UX fix, Task 10) ──
  // GET /api/admin/embedding/dimensions does not exist on the backend, so the
  // old dedicated query 404'd on every visit to Settings → AI Models. The
  // value must come from the shared /admin/settings payload instead.

  it('reads embedding dimensions from /admin/settings and never requests /admin/embedding/dimensions', async () => {
    const Wrapper = createWrapper();
    const spy = mockRoutes({ embeddingDimensions: 768, probeDimensions: 768 });
    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByText('Use case assignments');

    // Reveal the re-embed banner and probe so currentDimensions is displayed.
    fireEvent.change(screen.getByTestId('usecase-embedding-provider'), {
      target: { value: providerB.id },
    });
    fireEvent.click(await screen.findByRole('button', { name: /probe/i }));
    // Probe returns the same dims → confirm copy renders the settings value.
    await screen.findByText(/dimension stays at 768/i);

    // The dead endpoint must never be requested.
    const deadCalls = spy.mock.calls.filter(([input]) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      return url.includes('/admin/embedding/dimensions');
    });
    expect(deadCalls).toHaveLength(0);
  });

  it('falls back to 1024 dimensions when the settings payload omits embeddingDimensions', async () => {
    const Wrapper = createWrapper();
    mockRoutes({ embeddingDimensions: null, probeDimensions: 1024 });
    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByText('Use case assignments');

    fireEvent.change(screen.getByTestId('usecase-embedding-provider'), {
      target: { value: providerB.id },
    });
    fireEvent.click(await screen.findByRole('button', { name: /probe/i }));
    await screen.findByText(/dimension stays at 1024/i);
  });

  // ── #1115: the image-embedding row ──────────────────────────────────────
  //
  // A seventh use case that never inherits the default provider. Everything an
  // admin needs to judge it has to be ON SCREEN, not in a hover tooltip: the
  // non-support list is the difference between "this will work" and "this
  // silently indexes garbage", and a caveat reachable only by hover is
  // unreachable by touch, keyboard and screen readers (#1119's rule).

  it('renders the Image embedding row with its scope copy and the non-support note', async () => {
    const Wrapper = createWrapper();
    mockRoutes();
    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByText('Use case assignments');

    const row = await screen.findByTestId('usecase-row-image_embedding');
    expect(within(row).getByText('Image embedding')).toBeTruthy();
    expect(within(row).getByText(/never inherits the default provider/i)).toBeTruthy();
    expect(within(row).getByText(/unassigned means image search is off/i)).toBeTruthy();
    const note = within(row).getByTestId('image-embedding-support-note');
    expect(note.textContent).toMatch(/Ollama, LM Studio and TEI do not/i);
    // "Disabled", not "Inherit default" — the select must not offer a fallback
    // that does not exist.
    const select = within(row).getByTestId('usecase-image_embedding-provider') as HTMLSelectElement;
    expect(select.options[0]!.text).toMatch(/disabled/i);
  });

  it('shows the probed width and index tier', async () => {
    const Wrapper = createWrapper();
    mockRoutes();
    render(<LlmTab />, { wrapper: Wrapper });
    const status = await screen.findByTestId('image-embedding-probe-status');
    await waitFor(() => expect(status.textContent).toMatch(/2048-dim/));
    expect(status.textContent).toMatch(/halfvec HNSW/);
  });

  it('states that an unindexed width is sequentially scanned', async () => {
    const Wrapper = createWrapper();
    mockRoutes({
      imageProbe: {
        providerId: providerB.id,
        model: 'Qwen/Qwen3-VL-Embedding-8B',
        dimensions: 4096,
        tier: 'unindexed',
        probedAt: '2026-08-17T10:00:00.000Z',
        error: null,
      },
    });
    render(<LlmTab />, { wrapper: Wrapper });
    const status = await screen.findByTestId('image-embedding-probe-status');
    await waitFor(() => expect(status.textContent).toMatch(/4096-dim/));
    expect(status.textContent).toMatch(/no index/i);
    expect(await screen.findByTestId('image-embedding-unindexed-note')).toBeTruthy();
  });

  it('keeps the provider body behind a disclosure, as plain text', async () => {
    const Wrapper = createWrapper();
    mockRoutes({
      imageProbe: {
        providerId: providerB.id,
        model: 'nomic-embed-text',
        dimensions: null,
        tier: null,
        probedAt: '2026-08-17T10:00:00.000Z',
        error: 'vlEmbedding HTTP 422: Extra inputs are not permitted: messages',
      },
    });
    render(<LlmTab />, { wrapper: Wrapper });
    const details = await screen.findByTestId('image-embedding-probe-error');
    expect(details.tagName).toBe('DETAILS');
    expect(
      within(details).getByTestId('image-embedding-probe-error-text').textContent,
    ).toContain('Extra inputs are not permitted');
  });

  it('Re-check posts to the reprobe route and renders the new verdict', async () => {
    const Wrapper = createWrapper();
    const spy = mockRoutes();
    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByTestId('image-embedding-probe-status');

    fireEvent.click(screen.getByTestId('image-embedding-recheck'));

    await waitFor(() => {
      const posted = spy.mock.calls.filter(([input, init]) => {
        const url = typeof input === 'string' ? input : (input as URL).toString();
        return url.endsWith('/admin/llm-usecases/image_embedding/reprobe')
          && (init as RequestInit | undefined)?.method === 'POST';
      });
      expect(posted).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId('image-embedding-probe-status').textContent).toMatch(/1024-dim/);
    });
  });

  /**
   * The strip is deliberately rendered whether or not the leg is assigned —
   * its two sentences are what tell an operator whether the row is usable on
   * their stack at all, and the instance that most needs to read them is the
   * one that has not assigned it yet. Gating the whole strip on `providerId`
   * left every earlier assertion green, because the only fixture had the leg
   * assigned (review round 1).
   */
  it('keeps the scope copy and the non-support note when the leg is unassigned', async () => {
    const Wrapper = createWrapper();
    const spy = mockRoutes({ imageUnassigned: true });
    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByText('Use case assignments');

    const row = await screen.findByTestId('usecase-row-image_embedding');
    expect(within(row).getByTestId('image-embedding-support-note')).toBeTruthy();
    expect(within(row).getByText(/unassigned means image search is off/i)).toBeTruthy();
    // No assignment: nothing to report a verdict about, and no route to ask.
    expect(within(row).queryByTestId('image-embedding-probe-status')).toBeNull();
    expect(within(row).queryByTestId('image-embedding-recheck')).toBeNull();
    expect(
      spy.mock.calls.filter(([input]) =>
        (typeof input === 'string' ? input : (input as URL).toString())
          .endsWith('/admin/llm-usecases/image_embedding/probe'),
      ),
    ).toHaveLength(0);
  });

  /**
   * The probe strip describes the SAVED leg, so an unsaved dropdown change must
   * not summon it. It used to read LlmTab's draft: picking a provider fired the
   * admin probe route and rendered a Re-check whose POST answers 404 "Assign
   * one in Settings → AI Models" — an error toast telling the admin to do the
   * thing they are on the page doing.
   */
  it('does not probe or offer Re-check for an unsaved provider choice', async () => {
    const Wrapper = createWrapper();
    const spy = mockRoutes({ imageUnassigned: true });
    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByText('Use case assignments');

    fireEvent.change(screen.getByTestId('usecase-image_embedding-provider'), {
      target: { value: providerB.id },
    });

    await waitFor(() => {
      expect(
        (screen.getByTestId('usecase-image_embedding-provider') as HTMLSelectElement).value,
      ).toBe(providerB.id);
    });
    expect(screen.queryByTestId('image-embedding-recheck')).toBeNull();
    expect(
      spy.mock.calls.filter(([input]) =>
        (typeof input === 'string' ? input : (input as URL).toString())
          .endsWith('/admin/llm-usecases/image_embedding/probe'),
      ),
    ).toHaveLength(0);
  });

  // The mirror image: clearing the select without saving must not hide a strip
  // that still describes a live, assigned leg.
  it('keeps the probe status when an unsaved edit clears the provider', async () => {
    const Wrapper = createWrapper();
    mockRoutes();
    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByTestId('image-embedding-probe-status');

    fireEvent.change(screen.getByTestId('usecase-image_embedding-provider'), {
      target: { value: '' },
    });

    expect(screen.getByTestId('image-embedding-probe-status')).toBeTruthy();
    expect(screen.getByTestId('image-embedding-recheck')).toBeTruthy();
  });

  /**
   * ADR-010 reserves green for connected/succeeded. A probe that did not
   * complete at all — unreachable endpoint, open breaker — was announced in the
   * success treatment (review round 1).
   */
  it('reports a re-check that established no width as an error', async () => {
    const Wrapper = createWrapper();
    mockRoutes({
      reprobeResult: {
        providerId: providerB.id,
        model: 'Qwen/Qwen3-VL-Embedding-2B',
        dimensions: null,
        tier: null,
        probedAt: '2026-08-17T11:00:00.000Z',
        error: 'vlEmbedding HTTP 422: Extra inputs are not permitted: messages',
      },
    });
    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByTestId('image-embedding-probe-status');

    // The sonner module mock is shared across this file's cases, so clear the
    // success channel here rather than asserting a global never-called.
    vi.mocked(toast.success).mockClear();
    fireEvent.click(screen.getByTestId('image-embedding-recheck'));

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        expect.stringContaining('refused the probe'),
      );
    });
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  /**
   * "Re-check" reads as diagnostic, and on a width or endpoint change it is
   * not: the server truncates `page_image_embeddings` and re-dirties every
   * non-folder page. The consequence has to be named where the operator reads
   * it, not only in the audit log.
   */
  it('names the emptied index and the queued re-scan when the re-check rebuilt', async () => {
    const Wrapper = createWrapper();
    mockRoutes({
      reprobeResult: {
        providerId: providerB.id,
        model: 'Qwen/Qwen3-VL-Embedding-2B',
        dimensions: 2560,
        tier: 'halfvec',
        probedAt: '2026-08-17T11:00:00.000Z',
        error: null,
        rebuilt: true,
        dirtiedPages: 12,
      },
    });
    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByTestId('image-embedding-probe-status');

    fireEvent.click(screen.getByTestId('image-embedding-recheck'));

    await waitFor(() => {
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
        expect.stringMatching(/emptied/i),
      );
    });
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      expect.stringContaining('12 pages were queued'),
    );
  });

  it('surfaces the refusal reason when the probe blocks the assignment', async () => {
    const Wrapper = createWrapper();
    mockRoutes({
      putError:
        "This endpoint refused the request. Image embedding needs a server that accepts vLLM's chat-embeddings shape on /v1/embeddings — Ollama, LM Studio and TEI do not.",
    });
    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByText('Use case assignments');

    fireEvent.change(screen.getByTestId('usecase-image_embedding-provider'), {
      target: { value: providerA.id },
    });
    fireEvent.click(screen.getByText('Save use-case assignments'));

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        expect.stringContaining('chat-embeddings shape'),
      );
    });
  });
});
