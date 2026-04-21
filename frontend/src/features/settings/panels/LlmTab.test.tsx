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

function mockRoutes() {
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
});
