import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  IMAGE_EMBEDDING_TARGET_DIMENSIONS_MIN,
  IMAGE_EMBEDDING_TARGET_DIMENSIONS_MAX,
} from '@compendiq/contracts';
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
  inline_completion: {
    providerId: null,
    model: null,
    resolved: { providerId: '00000000-0000-0000-0000-000000000000', providerName: '', model: '' },
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
  /** #1115 — what `PUT /admin/llm-usecases` answers with on success. */
  putResult?: Record<string, unknown>;
  /** #1115 — the stored MRL truncation width in the settings document. */
  imageTargetDimensions?: number | null;
}) {
  lastImageProbe = null;
  const cap = options?.concurrentStreamsCap ?? 3;
  const settingsBody: Record<string, unknown> = {
    ftsLanguage: 'simple',
    embeddingChunkSize: 500,
    embeddingChunkOverlap: 50,
    drawioEmbedUrl: null,
    llmMaxConcurrentStreamsPerUser: cap,
    // #1115 — null on every instance that has not asked for MRL truncation.
    imageEmbeddingTargetDimensions: options?.imageTargetDimensions ?? null,
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
      return new Response(JSON.stringify(options?.putResult ?? servedAssignments), {
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
      // Stateful, because the server is: `PUT /admin/settings` and `PUT
      // /admin/llm-usecases` are two requests, and the first one LANDS even
      // when the second is refused. A mock that answered a fixed document
      // could not show what the panel does after that partial save.
      Object.assign(settingsBody, JSON.parse((init as RequestInit).body as string));
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
    expect(screen.queryByRole('button', { name: /start re-embed/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /wipe current index/i })).toBeNull();
    // Change embedding provider to providerB.
    fireEvent.change(screen.getByTestId('usecase-embedding-provider'), {
      target: { value: providerB.id },
    });
    const row = await screen.findByTestId('usecase-row-embedding');
    expect(await within(row).findByRole('button', { name: /start re-embed/i })).toBeTruthy();
    expect(within(row).getByRole('button', { name: /wipe current index/i })).toBeTruthy();
  });

  it('an embedding-only change disables Save so it cannot go live without a re-embed', async () => {
    const Wrapper = createWrapper();
    const spy = mockRoutes();
    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByText('Use case assignments');

    fireEvent.change(screen.getByTestId('usecase-embedding-provider'), {
      target: { value: providerB.id },
    });

    const save = await screen.findByRole('button', { name: /save use-case assignments/i });
    expect(save).toBeDisabled();
    expect(screen.getByTestId('usecase-save-embedding-hint')).toHaveTextContent(
      /start the re-embed from the Embedding row/i,
    );

    fireEvent.click(save);
    await waitFor(() => {
      const put = spy.mock.calls.find(
        ([input, init]) =>
          String(typeof input === 'string' ? input : (input as URL).toString()).endsWith('/admin/llm-usecases')
          && (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(put).toBeUndefined();
    });
  });

  it('saving other use cases while embedding is pending omits the embedding assignment', async () => {
    const Wrapper = createWrapper();
    const spy = mockRoutes();
    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByText('Use case assignments');

    fireEvent.change(screen.getByTestId('usecase-embedding-provider'), {
      target: { value: providerB.id },
    });
    fireEvent.change(screen.getByTestId('usecase-chat-provider'), {
      target: { value: providerB.id },
    });

    const save = await screen.findByRole('button', { name: /save other use-case assignments/i });
    expect(save).not.toBeDisabled();
    fireEvent.click(save);

    await waitFor(() => {
      const put = spy.mock.calls.find(
        ([input, init]) =>
          String(typeof input === 'string' ? input : (input as URL).toString()).endsWith('/admin/llm-usecases')
          && (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(put).toBeTruthy();
      const body = JSON.parse(String((put![1] as RequestInit).body));
      expect(body.chat).toEqual({ providerId: providerB.id });
      expect(body.embedding).toBeUndefined();
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
    await waitFor(() => expect(screen.queryByRole('button', { name: /wipe current index/i })).toBeNull());
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
    fireEvent.click(await screen.findByRole('button', { name: /wipe current index/i }));
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
    fireEvent.click(await screen.findByRole('button', { name: /wipe current index/i }));
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

  /**
   * Review round 2 — the ONE surface that tells an admin the assignment saved
   * but the image column was not retyped. Deleting the branch left the whole
   * suite green, so the server's honest sentence was discarded and the admin
   * saw the green "Use-case assignments saved" for a leg whose column is still
   * at the previous width: exactly the misreport a bare 500 was rejected for.
   */
  it('warns instead of celebrating when the server could not retype the index', async () => {
    const Wrapper = createWrapper();
    mockRoutes({
      putResult: {
        ok: true,
        imageIndexWarning:
          'The assignment was saved, but the image index could not be retyped — it is still at its previous width. Use Re-check on the Image embedding row to retry.',
      },
    });
    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByText('Use case assignments');

    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.warning).mockClear();
    fireEvent.change(screen.getByTestId('usecase-image_embedding-provider'), {
      target: { value: providerA.id },
    });
    fireEvent.click(screen.getByText('Save use-case assignments'));

    await waitFor(() => {
      expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(expect.stringMatching(/Re-check/i));
    });
    expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
      expect.stringContaining('previous width'),
    );
    // The green "saved" must not run beside it: the row landed and the leg is
    // misconfigured behind it.
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  // ── #1115 review round 2: the MRL truncation width ──────────────────────
  //
  // `dimensions` is a per-REQUEST parameter — the vLLM override only makes the
  // server accept it — so the remedy the unindexed note names is only real if
  // there is somewhere to put the number and something that sends it.

  it('renders the truncation field, empty, with its caveat visible at rest', async () => {
    const Wrapper = createWrapper();
    mockRoutes();
    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByText('Use case assignments');

    const field = (await screen.findByTestId(
      'image-embedding-target-dimensions',
    )) as HTMLInputElement;
    expect(field.value).toBe('');
    // Not a `title` (#1119's rule): the contract of the field is on screen.
    const help = document.getElementById('image-embedding-target-dimensions-help');
    expect(help?.textContent).toMatch(/native width/i);
    expect(field.getAttribute('aria-describedby')).toBe('image-embedding-target-dimensions-help');
  });

  it('hydrates the truncation field from the stored setting', async () => {
    const Wrapper = createWrapper();
    mockRoutes({ imageTargetDimensions: 2048 });
    render(<LlmTab />, { wrapper: Wrapper });
    const field = (await screen.findByTestId(
      'image-embedding-target-dimensions',
    )) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe('2048'));
  });

  /**
   * The order is load-bearing: the width has to be stored BEFORE the
   * assignment PUT, because that PUT re-probes and the probe sends this
   * number. And the assignment has to be re-sent at all — otherwise the width
   * lands in `admin_settings`, nothing re-probes, and the column keeps a type
   * that no later writer will match.
   */
  it('saves the width first, then re-probes the saved assignment with it', async () => {
    const Wrapper = createWrapper();
    const spy = mockRoutes();
    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByTestId('image-embedding-target-dimensions');

    fireEvent.change(screen.getByTestId('image-embedding-target-dimensions'), {
      target: { value: '2048' },
    });
    fireEvent.click(screen.getByText('Save use-case assignments'));

    await waitFor(() => {
      const puts = spy.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(puts).toHaveLength(2);
    });
    const puts = spy.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
    );
    const urlOf = (c: unknown[]) =>
      typeof c[0] === 'string' ? (c[0] as string) : (c[0] as URL).toString();
    expect(urlOf(puts[0]!)).toMatch(/\/admin\/settings$/);
    expect(JSON.parse((puts[0]![1] as RequestInit).body as string)).toEqual({
      imageEmbeddingTargetDimensions: 2048,
    });
    expect(urlOf(puts[1]!)).toMatch(/\/admin\/llm-usecases$/);
    // The saved provider, re-sent: a changed width IS a change to the leg, and
    // the probe + column DDL hang off the assignment PUT.
    expect(JSON.parse((puts[1]![1] as RequestInit).body as string)).toEqual({
      image_embedding: { providerId: providerB.id },
    });
  });

  it('clears the width with an explicit null when the field is emptied', async () => {
    const Wrapper = createWrapper();
    const spy = mockRoutes({ imageTargetDimensions: 2048 });
    render(<LlmTab />, { wrapper: Wrapper });
    const field = (await screen.findByTestId(
      'image-embedding-target-dimensions',
    )) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe('2048'));

    fireEvent.change(field, { target: { value: '' } });
    fireEvent.click(screen.getByText('Save use-case assignments'));

    await waitFor(() => {
      const settingsPut = spy.mock.calls.find(
        ([input, init]) =>
          (typeof input === 'string' ? input : (input as URL).toString()).endsWith(
            '/admin/settings',
          ) && (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(settingsPut).toBeTruthy();
      expect(JSON.parse((settingsPut![1] as RequestInit).body as string)).toEqual({
        imageEmbeddingTargetDimensions: null,
      });
    });
  });

  it('does not touch the settings route when the width was not edited', async () => {
    const Wrapper = createWrapper();
    const spy = mockRoutes({ imageTargetDimensions: 2048 });
    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByTestId('image-embedding-target-dimensions');

    fireEvent.change(screen.getByTestId('usecase-summary-provider'), {
      target: { value: providerB.id },
    });
    fireEvent.click(screen.getByText('Save use-case assignments'));

    await waitFor(() => {
      expect(
        spy.mock.calls.filter(
          ([input, init]) =>
            (typeof input === 'string' ? input : (input as URL).toString()).endsWith(
              '/admin/llm-usecases',
            ) && (init as RequestInit | undefined)?.method === 'PUT',
        ),
      ).toHaveLength(1);
    });
    expect(
      spy.mock.calls.filter(
        ([input, init]) =>
          (typeof input === 'string' ? input : (input as URL).toString()).endsWith(
            '/admin/settings',
          ) && (init as RequestInit | undefined)?.method === 'PUT',
      ),
    ).toHaveLength(0);
  });

  /**
   * Review round 3 — the two PUTs are not atomic, and the refused half is the
   * DESIGNED outcome: the probe gate answers 422 whenever the endpoint will
   * not serve the width. The settings PUT in front of it has already landed by
   * then, so `docs/runbooks/image-index.md` §2 tells the operator to clear the
   * field and save again. That remedy only works if the panel's comparison
   * baseline names what the server actually stored — invalidating
   * `['admin-settings']` only on success left it on the PRE-save value, so
   * reverting the field read as unchanged and reported "No changes" over a
   * width the server still held, silently, until a reload.
   */
  it('re-reads the stored width after a refused save, so reverting it is a real change', async () => {
    const Wrapper = createWrapper();
    const spy = mockRoutes({
      putError:
        "This endpoint refused the request. Image embedding needs a server that accepts vLLM's chat-embeddings shape on /v1/embeddings.",
    });
    render(<LlmTab />, { wrapper: Wrapper });
    const field = (await screen.findByTestId(
      'image-embedding-target-dimensions',
    )) as HTMLInputElement;

    const urlOf = (c: unknown[]) =>
      typeof c[0] === 'string' ? (c[0] as string) : (c[0] as URL).toString();
    const settingsCalls = (method: string | undefined) =>
      spy.mock.calls.filter(
        (c) =>
          urlOf(c).endsWith('/admin/settings')
          && (c[1] as RequestInit | undefined)?.method === method,
      );

    fireEvent.change(field, { target: { value: '4000' } });
    fireEvent.click(screen.getByText('Save use-case assignments'));

    // The width landed; the assignment PUT behind it was refused.
    await waitFor(() => expect(settingsCalls('PUT')).toHaveLength(1));
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalled());
    // …and the panel re-read the document anyway, which is the fix.
    await waitFor(() => expect(settingsCalls(undefined).length).toBeGreaterThan(1));
    // The typed value survives the refusal — the admin corrects it in place.
    expect(field.value).toBe('4000');

    // The runbook's remedy: clear the field, save again.
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.click(screen.getByText('Save use-case assignments'));

    await waitFor(() => expect(settingsCalls('PUT')).toHaveLength(2));
    expect(JSON.parse((settingsCalls('PUT')[1]![1] as RequestInit).body as string)).toEqual({
      imageEmbeddingTargetDimensions: null,
    });
    expect(vi.mocked(toast.message)).not.toHaveBeenCalledWith('No changes');
  });

  /**
   * Review round 3 — `min`/`max` on a bare `type="number"` input constrain
   * nothing about the value read off `e.target.value`, so an out-of-range
   * entry reached `ImageEmbeddingTargetDimensionsSchema` and came back as a
   * raw Zod issue path. The sibling control one function away has clamped for
   * exactly this reason since #268.
   */
  it('clamps an out-of-range truncation width instead of letting Zod refuse it', async () => {
    const Wrapper = createWrapper();
    const spy = mockRoutes();
    render(<LlmTab />, { wrapper: Wrapper });
    const field = await screen.findByTestId('image-embedding-target-dimensions');

    fireEvent.change(field, { target: { value: '32' } });
    fireEvent.click(screen.getByText('Save use-case assignments'));

    await waitFor(() => {
      const settingsPut = spy.mock.calls.find(
        ([input, init]) =>
          (typeof input === 'string' ? input : (input as URL).toString()).endsWith(
            '/admin/settings',
          ) && (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(settingsPut).toBeTruthy();
      expect(JSON.parse((settingsPut![1] as RequestInit).body as string)).toEqual({
        imageEmbeddingTargetDimensions: 64,
      });
    });
  });

  /**
   * Final review, nit 3 — the `min`/`max` attributes are the schema's own
   * bounds, read from the contract rather than typed in. A hand-copied pair
   * would let the field advertise a range the server refuses (or, worse, refuse
   * one it accepts) the first time either bound is retuned.
   */
  it('advertises the contract bounds on the truncation field', async () => {
    const Wrapper = createWrapper();
    mockRoutes();
    render(<LlmTab />, { wrapper: Wrapper });
    const field = await screen.findByTestId('image-embedding-target-dimensions');

    expect(field.getAttribute('min')).toBe(String(IMAGE_EMBEDDING_TARGET_DIMENSIONS_MIN));
    expect(field.getAttribute('max')).toBe(String(IMAGE_EMBEDDING_TARGET_DIMENSIONS_MAX));
  });

  /**
   * Final review, nit 2 — the clamp above runs at SAVE, so until the admin
   * pressed the button the field sat showing a number that was not the one
   * about to be sent. It now settles on blur, and only on blur: clamping per
   * keystroke rewrites `4` to `64` the moment it is typed, which makes `4000`
   * — the largest indexable width, and the one the unindexed note tells the
   * operator to enter — unreachable from an empty field.
   */
  it('clamps the truncation width on blur while keeping keystrokes typeable', async () => {
    const Wrapper = createWrapper();
    mockRoutes();
    render(<LlmTab />, { wrapper: Wrapper });
    const field = (await screen.findByTestId(
      'image-embedding-target-dimensions',
    )) as HTMLInputElement;

    // Mid-entry: below the floor, and left exactly as typed.
    fireEvent.change(field, { target: { value: '4' } });
    expect(field.value).toBe('4');
    fireEvent.change(field, { target: { value: '40' } });
    expect(field.value).toBe('40');
    // …all the way to a legal width, which a per-keystroke clamp would have
    // made unreachable.
    fireEvent.change(field, { target: { value: '4000' } });
    fireEvent.blur(field);
    await waitFor(() => expect(field.value).toBe('4000'));

    // Leaving the field on an out-of-range value settles it on what will be
    // sent, rather than arguing with the admin at Save time.
    fireEvent.change(field, { target: { value: '32' } });
    fireEvent.blur(field);
    await waitFor(() =>
      expect(field.value).toBe(String(IMAGE_EMBEDDING_TARGET_DIMENSIONS_MIN)),
    );

    fireEvent.change(field, { target: { value: '99999' } });
    fireEvent.blur(field);
    await waitFor(() =>
      expect(field.value).toBe(String(IMAGE_EMBEDDING_TARGET_DIMENSIONS_MAX)),
    );

    // An empty field still means "native width", not the floor.
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    await waitFor(() => expect(field.value).toBe(''));
  });

  /**
   * P1's "nothing is indexed yet" sentence was true while no worker consumed
   * the assignment. P2 ships one, so the row must stop saying it — a caveat
   * that has become false is worse than none — and must instead point at the
   * surface that reports the index (#1115 P2).
   */
  it('points at the Embeddings tab for index status, and no longer claims nothing is indexed', async () => {
    const Wrapper = createWrapper();
    mockRoutes();
    render(<LlmTab />, { wrapper: Wrapper });
    const row = await screen.findByTestId('usecase-row-image_embedding');
    const note = within(row).getByTestId('image-embedding-index-pointer');
    expect(note.textContent).toMatch(/Embeddings tab/i);
    expect(row.textContent).not.toMatch(/not indexed yet/i);
    expect(within(row).queryByTestId('image-embedding-inert-note')).toBeNull();
  });

  /**
   * The chip renders the PROBE, not the column — they diverge on the
   * guarded-DDL branch above, where the assignment saves and the column keeps
   * its previous width. Labelling it "Image index" made it assert a width the
   * column does not have.
   */
  it('labels the probe chip as the last probe, not as the index', async () => {
    const Wrapper = createWrapper();
    mockRoutes();
    render(<LlmTab />, { wrapper: Wrapper });
    const row = await screen.findByTestId('usecase-row-image_embedding');
    await screen.findByTestId('image-embedding-probe-status');
    expect(within(row).getByText('Last probe')).toBeTruthy();
    expect(within(row).queryByText('Image index')).toBeNull();
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
