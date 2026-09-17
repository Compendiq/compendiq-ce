import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { LlmTab } from './LlmTab';
import { useAuthStore } from '../../../stores/auth-store';

// #1615 — a refused `image_analysis` assignment is reported as an error
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
  // #1417: same non-inheriting rule as rerank.
  inline_completion: {
    providerId: null,
    model: null,
    resolved: { providerId: '00000000-0000-0000-0000-000000000000', providerName: '', model: '' },
  },
  // #1615 — unassigned by default; `analysisAssigned` flips it.
  image_analysis: {
    providerId: null,
    model: null,
    resolved: { providerId: '00000000-0000-0000-0000-000000000000', providerName: '', model: '' },
  },
};

/** #1615 — the last detail a re-check wrote. */
let lastAnalysisCapability: Record<string, unknown> | null = null;
const DEFAULT_ANALYSIS_CAPABILITY = {
  providerId: providerB.id,
  model: 'qwen3-vl',
  vision: true,
  probedAt: '2026-09-15T10:00:00.000Z',
  probeError: null,
  identity: {
    providerId: providerB.id,
    model: 'qwen3-vl',
    baseUrl: 'http://localhost:11434/v1',
    identityHash: 'a'.repeat(64),
    assignedAt: '2026-09-15T10:00:00.000Z',
  },
  identityDrift: false,
};

function mockRoutes(options?: {
  concurrentStreamsCap?: number;
  /** `null` → field omitted from the settings payload (legacy backend). */
  embeddingDimensions?: number | null;
  probeDimensions?: number;
  /** #1615 — make the assignments PUT fail with this 422 body. */
  putError?: string;
  /** #1615 — what `PUT /admin/llm-usecases` answers with on success. */
  putResult?: Record<string, unknown>;
  /** #1615 — the machine-readable reason beside `putError`. */
  putReason?: string;
  /** Hold the assignments PUT open this long, so the in-flight state is observable. */
  putDelayMs?: number;
  /** #1615 — serve `image_analysis` as ASSIGNED to providerB / qwen3-vl. */
  analysisAssigned?: boolean;
  /** #1615 — the capability detail, or `null` for a 404. */
  analysisCapability?: Record<string, unknown> | null;
  /** #1615 — what `POST …/image_analysis/recheck` answers with. */
  analysisRecheckResult?: Record<string, unknown>;
  /** #1615 — the stored ceiling in the settings document. */
  imageAnalysisMaxOutputTokens?: number;
}) {
  lastAnalysisCapability = null;
  const cap = options?.concurrentStreamsCap ?? 3;
  const settingsBody: Record<string, unknown> = {
    ftsLanguage: 'simple',
    embeddingChunkSize: 500,
    embeddingChunkOverlap: 50,
    drawioEmbedUrl: null,
    llmMaxConcurrentStreamsPerUser: cap,
    // #1615 — the image-analysis output-token ceiling, at its default.
    imageAnalysisMaxOutputTokens: options?.imageAnalysisMaxOutputTokens ?? 8192,
  };
  if (options?.embeddingDimensions !== null) {
    settingsBody.embeddingDimensions = options?.embeddingDimensions ?? 1024;
  }
  const servedAssignments = {
    ...assignments,
    ...(options?.analysisAssigned
      ? {
          image_analysis: {
            providerId: providerB.id,
            model: 'qwen3-vl',
            resolved: { providerId: providerB.id, providerName: 'OpenAI', model: 'qwen3-vl' },
          },
        }
      : {}),
  };
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
      if (options?.putDelayMs) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, options.putDelayMs);
        await promise;
      }
      if (options?.putError) {
        return new Response(
          JSON.stringify({ error: options.putError, statusCode: 422, ...(options.putReason ? { reason: options.putReason } : {}) }),
          { status: 422, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify(options?.putResult ?? servedAssignments), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // #1615 — the image-analysis capability detail for the SAVED pair.
    if (url.endsWith('/admin/llm-usecases/image_analysis/capability')) {
      if (options?.analysisCapability === null) {
        return new Response(JSON.stringify({ error: 'unassigned' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify(lastAnalysisCapability ?? options?.analysisCapability ?? DEFAULT_ANALYSIS_CAPABILITY),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.endsWith('/admin/llm-usecases/image_analysis/recheck')) {
      lastAnalysisCapability = options?.analysisRecheckResult ?? { ...DEFAULT_ANALYSIS_CAPABILITY, probedAt: '2026-09-15T11:00:00.000Z' };
      return new Response(JSON.stringify(lastAnalysisCapability), {
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

  it('changing the embedding assignment reveals Start re-embed and hides Wipe', async () => {
    const Wrapper = createWrapper();
    mockRoutes();
    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByText('Use case assignments');
    // Wipe rebuilds the live index, so it is offered at rest. Start re-embed
    // is the apply path for an unsaved model change.
    expect(screen.queryByRole('button', { name: /start re-embed/i })).toBeNull();
    expect(screen.getByRole('button', { name: /^Wipe current index$/i })).toBeTruthy();
    fireEvent.change(screen.getByTestId('usecase-embedding-provider'), {
      target: { value: providerB.id },
    });
    const row = await screen.findByTestId('usecase-row-embedding');
    expect(await within(row).findByRole('button', { name: /start re-embed/i })).toBeTruthy();
    expect(within(row).queryByRole('button', { name: /wipe current index/i })).toBeNull();
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
    expect(save).toHaveClass('nm-button-ghost');
    expect(screen.getByRole('button', { name: /start re-embed/i })).toHaveClass('nm-button-primary');
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

    // The #949 re-seed must not wipe the embedding draft: that hid Start
    // re-embed after a mixed save and left the assignment unmigrated.
    await waitFor(() => {
      expect((screen.getByTestId('usecase-embedding-provider') as HTMLSelectElement).value).toBe(
        providerB.id,
      );
    });
    const row = screen.getByTestId('usecase-row-embedding');
    expect(within(row).getByRole('button', { name: /start re-embed/i })).toBeTruthy();
  });

  it('saves Inherit default on Embedding when it still resolves to the live model', async () => {
    const Wrapper = createWrapper();
    const pinned = {
      ...assignments,
      embedding: {
        providerId: providerA.id,
        model: 'bge-m3',
        resolved: { providerId: providerA.id, providerName: 'Ollama', model: 'bge-m3' },
      },
    };
    const providers = [{ ...providerA, defaultModel: 'bge-m3' }, providerB];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.endsWith('/admin/llm-providers') && (init as RequestInit).method !== 'POST') {
        return new Response(JSON.stringify(providers), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/admin/llm-usecases') && (init as RequestInit).method === 'PUT') {
        return new Response(JSON.stringify(pinned), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/admin/llm-usecases')) {
        return new Response(JSON.stringify(pinned), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/admin/settings') && (init as RequestInit).method !== 'PUT') {
        return new Response(
          JSON.stringify({
            ftsLanguage: 'simple',
            embeddingChunkSize: 500,
            embeddingChunkOverlap: 50,
            drawioEmbedUrl: null,
            llmMaxConcurrentStreamsPerUser: 3,
            embeddingDimensions: 1024,
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/admin/llm-providers/') && url.endsWith('/models')) {
        return new Response(JSON.stringify([{ name: 'bge-m3' }, { name: 'gpt-4o-mini' }]), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/llm/usecase-default?usecase=chat')) {
        return new Response(
          JSON.stringify({
            usecase: 'chat',
            providerId: providerA.id,
            providerName: 'Ollama',
            model: 'bge-m3',
            vision: true,
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } });
    });
    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByText('Use case assignments');

    fireEvent.change(screen.getByTestId('usecase-embedding-provider'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('usecase-embedding-model'), { target: { value: '' } });

    expect(screen.queryByRole('button', { name: /start re-embed/i })).toBeNull();
    const save = screen.getByRole('button', { name: /save use-case assignments/i });
    expect(save).not.toBeDisabled();
    fireEvent.click(save);

    await waitFor(() => {
      const put = spy.mock.calls.find(
        ([input, init]) =>
          String(typeof input === 'string' ? input : (input as URL).toString()).endsWith(
            '/admin/llm-usecases',
          ) && (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(put).toBeTruthy();
      expect(JSON.parse(String((put![1] as RequestInit).body)).embedding).toEqual({
        providerId: null,
        model: null,
      });
    });
  });

  it('Start re-embed for Inherit default names the default provider model, not the saved pair', async () => {
    const Wrapper = createWrapper();
    const pinned = {
      ...assignments,
      embedding: {
        providerId: providerB.id,
        model: providerB.defaultModel,
        resolved: {
          providerId: providerB.id,
          providerName: 'OpenAI',
          model: providerB.defaultModel,
        },
      },
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.endsWith('/admin/llm-providers') && (init as RequestInit).method !== 'POST') {
        return new Response(JSON.stringify([providerA, providerB]), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/admin/llm-usecases')) {
        return new Response(JSON.stringify(pinned), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/admin/settings') && (init as RequestInit).method !== 'PUT') {
        return new Response(
          JSON.stringify({
            ftsLanguage: 'simple',
            embeddingChunkSize: 500,
            embeddingChunkOverlap: 50,
            drawioEmbedUrl: null,
            llmMaxConcurrentStreamsPerUser: 3,
            embeddingDimensions: 1024,
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/admin/llm-providers/') && url.endsWith('/models')) {
        return new Response(JSON.stringify([{ name: 'qwen3:4b' }, { name: 'gpt-4o-mini' }]), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
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
    render(<LlmTab />, { wrapper: Wrapper });
    await screen.findByText('Use case assignments');

    fireEvent.change(screen.getByTestId('usecase-embedding-provider'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('usecase-embedding-model'), { target: { value: '' } });

    const card = within(await screen.findByTestId('shadow-migration-card'));
    expect(card.getByText(providerA.defaultModel)).toBeInTheDocument();
    expect(card.queryByText(providerB.defaultModel)).toBeNull();
    expect(screen.getByRole('button', { name: /save use-case assignments/i })).toBeDisabled();
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

    fireEvent.click(await screen.findByRole('button', { name: /^Wipe current index$/i }));
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

    fireEvent.click(await screen.findByRole('button', { name: /^Wipe current index$/i }));
    await screen.findByText(/dimension stays at 1024/i);
  });
});

/**
 * #1615 — the image-analysis card's save paths, one layer above the card.
 */
describe('LlmTab — image analysis (#1615)', () => {
  beforeEach(() => {
    useAuthStore.getState().setAuth('test-token', { id: '1', username: 'admin', role: 'admin' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  const putsOf = (spy: ReturnType<typeof mockRoutes>) =>
    spy.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
  const urlOf = (c: unknown[]) => (typeof c[0] === 'string' ? (c[0] as string) : (c[0] as URL).toString());

  it('renders the row with its non-inheriting option and the card beneath it', async () => {
    mockRoutes();
    render(<LlmTab />, { wrapper: createWrapper() });
    const row = await screen.findByTestId('usecase-row-image_analysis');
    expect(within(row).getByText('Image analysis (vision)')).toBeInTheDocument();
    expect(within(row).getByRole('option', { name: 'Disabled (no image analysis)' })).toBeInTheDocument();
    expect(within(row).getByTestId('image-analysis-egress')).toHaveTextContent(/no page image leaves this host/i);
    expect(within(row).getByLabelText('Max output tokens')).toHaveValue(8192);
  });

  it('saves the ceiling through /admin/settings alone — no assignment re-send, no probe', async () => {
    const spy = mockRoutes({ analysisAssigned: true });
    render(<LlmTab />, { wrapper: createWrapper() });
    const input = await screen.findByLabelText('Max output tokens');
    fireEvent.change(input, { target: { value: '6000' } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByText('Save use-case assignments'));

    await waitFor(() => expect(putsOf(spy)).toHaveLength(1));
    const [put] = putsOf(spy);
    expect(urlOf(put!)).toMatch(/\/admin\/settings$/);
    expect(JSON.parse((put![1] as RequestInit).body as string)).toEqual({ imageAnalysisMaxOutputTokens: 6000 });
    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Use-case assignments saved'));
    // Nothing re-probed: the recheck route was never called.
    expect(spy.mock.calls.some(([u]) => String(u).endsWith('/image_analysis/recheck'))).toBe(false);
    // The field re-hydrates from the stored value, not the default.
    await waitFor(() => expect(screen.getByLabelText('Max output tokens')).toHaveValue(6000));
  });

  it('saves the ceiling BEFORE the assignment PUT when both changed', async () => {
    const spy = mockRoutes();
    render(<LlmTab />, { wrapper: createWrapper() });
    const input = await screen.findByLabelText('Max output tokens');
    fireEvent.change(input, { target: { value: '4096' } });
    fireEvent.blur(input);
    fireEvent.change(screen.getByTestId('usecase-image_analysis-provider'), { target: { value: providerB.id } });
    fireEvent.click(screen.getByText('Save use-case assignments'));

    await waitFor(() => expect(putsOf(spy)).toHaveLength(2));
    const puts = putsOf(spy);
    expect(urlOf(puts[0]!)).toMatch(/\/admin\/settings$/);
    expect(urlOf(puts[1]!)).toMatch(/\/admin\/llm-usecases$/);
    expect(JSON.parse((puts[1]![1] as RequestInit).body as string)).toEqual({
      image_analysis: { providerId: providerB.id },
    });
  });

  it.each([
    ['text_only', /refused the test image/],
    ['unconfirmed', /could not be confirmed/],
    ['no_model', /no model resolves/],
    ['no_provider', /provider not found/],
  ])('a 422 %s keeps every other draft and toasts the reason headline over the server sentence', async (reason, headline) => {
    mockRoutes({ putError: 'Server sentence naming the remedy.', putReason: reason });
    render(<LlmTab />, { wrapper: createWrapper() });
    await screen.findByTestId('usecase-row-image_analysis');

    // An unrelated draft beside the refused one.
    fireEvent.change(screen.getByTestId('usecase-summary-provider'), { target: { value: providerB.id } });
    fireEvent.change(screen.getByTestId('usecase-image_analysis-provider'), { target: { value: providerB.id } });
    fireEvent.click(screen.getByText('Save use-case assignments'));

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        expect.stringMatching(headline),
        expect.objectContaining({ description: expect.stringContaining('Server sentence naming the remedy.') }),
      ),
    );
    expect(screen.getByTestId('usecase-summary-provider')).toHaveValue(providerB.id);
    expect(screen.getByTestId('usecase-image_analysis-provider')).toHaveValue(providerB.id);
  });

  // Measured in a real browser on #1615's refusal paths: Save was natively
  // `disabled` while the mutation ran, and disabling the element the admin had
  // just pressed with Enter blurs it — the browser moves focus to <body>, so
  // they lost their place exactly when a 422 needed reading. jsdom does not
  // move focus on `disabled`, so what this pins is the mechanism: in flight
  // the control is `aria-disabled` and NEVER natively disabled, and the press
  // that is in flight is still refused.
  it('marks Save aria-disabled in flight instead of natively disabling the focused control', async () => {
    const spy = mockRoutes({ putError: 'Server sentence naming the remedy.', putReason: 'text_only', putDelayMs: 80 });
    render(<LlmTab />, { wrapper: createWrapper() });
    await screen.findByTestId('usecase-row-image_analysis');
    fireEvent.change(screen.getByTestId('usecase-image_analysis-provider'), { target: { value: providerB.id } });

    const save = screen.getByRole('button', { name: /save use-case assignments/i });
    save.focus();
    fireEvent.click(save);

    const inFlight = await screen.findByRole('button', { name: /saving…/i });
    expect(inFlight).toBe(save);
    expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(save).not.toBeDisabled();
    expect(save).toHaveFocus();

    // A second press while the first is in flight sends no second PUT: the
    // handler guards it, because the element is deliberately still clickable.
    fireEvent.click(save);
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalled());
    expect(putsOf(spy).filter((c) => urlOf(c).endsWith('/admin/llm-usecases'))).toHaveLength(1);
    expect(save).toHaveFocus();
  });

  it('discloses reanalyzeRows in amber when the save adopted a new identity, and not on a resume', async () => {
    const spy = mockRoutes({ putResult: { ok: true, reanalyzeRows: 3 } });
    render(<LlmTab />, { wrapper: createWrapper() });
    await screen.findByTestId('usecase-row-image_analysis');
    fireEvent.change(screen.getByTestId('usecase-image_analysis-provider'), { target: { value: providerB.id } });
    fireEvent.click(screen.getByText('Save use-case assignments'));
    await waitFor(() =>
      expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(expect.stringMatching(/^3 image analyses are no longer valid/)),
    );
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    spy.mockRestore();

    vi.mocked(toast.warning).mockClear();
    mockRoutes({ putResult: { ok: true, reanalyzeRows: 0 } });
    render(<LlmTab />, { wrapper: createWrapper() });
    const rows = await screen.findAllByTestId('usecase-row-image_analysis');
    const select = within(rows[rows.length - 1]!).getByTestId('usecase-image_analysis-provider');
    fireEvent.change(select, { target: { value: providerB.id } });
    fireEvent.click(screen.getAllByText('Save use-case assignments').at(-1)!);
    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Use-case assignments saved'));
    expect(vi.mocked(toast.warning)).not.toHaveBeenCalled();
  });
});
