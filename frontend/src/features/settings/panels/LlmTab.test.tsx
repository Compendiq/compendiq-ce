import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LlmTab } from './LlmTab';
import { useAuthStore } from '../../../stores/auth-store';

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
};

function mockRoutes(options?: { concurrentStreamsCap?: number }) {
  const cap = options?.concurrentStreamsCap ?? 3;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    if (url.endsWith('/admin/llm-providers') && (init as RequestInit).method !== 'POST') {
      return new Response(JSON.stringify([providerA, providerB]), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/admin/llm-usecases') && !(init as RequestInit).method) {
      return new Response(JSON.stringify(assignments), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/admin/llm-usecases') && (init as RequestInit).method === 'PUT') {
      return new Response(JSON.stringify(assignments), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/admin/settings') && (init as RequestInit).method !== 'PUT') {
      return new Response(
        JSON.stringify({
          embeddingDimensions: 1024,
          ftsLanguage: 'simple',
          embeddingChunkSize: 500,
          embeddingChunkOverlap: 50,
          drawioEmbedUrl: null,
          llmMaxConcurrentStreamsPerUser: cap,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.endsWith('/admin/settings') && (init as RequestInit).method === 'PUT') {
      return new Response(JSON.stringify({ message: 'Admin settings updated' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/admin/embedding/dimensions')) {
      return new Response(JSON.stringify({ dimensions: 1024 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/admin/llm-providers/') && url.endsWith('/models')) {
      return new Response(JSON.stringify([{ name: 'qwen3:4b' }, { name: 'gpt-4o-mini' }]), {
        headers: { 'Content-Type': 'application/json' },
      });
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
    await waitFor(() => {
      const usecaseEntry = qc.getQueryState(['llm', 'usecase-default', 'chat']);
      const modelsEntry = qc.getQueryState(['llm', 'models', 'chat']);
      expect(usecaseEntry?.isInvalidated).toBe(true);
      expect(modelsEntry?.isInvalidated).toBe(true);
    });
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
      if (url.endsWith('/admin/embedding/dimensions')) {
        return new Response(JSON.stringify({ dimensions: 1024 }), {
          headers: { 'Content-Type': 'application/json' },
        });
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
});
