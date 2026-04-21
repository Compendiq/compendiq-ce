import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LlmProvider, UsecaseAssignments } from '@compendiq/contracts';
import { UsecaseAssignmentsSection } from './UsecaseAssignmentsSection';
import { useAuthStore } from '../../../stores/auth-store';

function createWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const providerA: LlmProvider = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Ollama',
  baseUrl: 'http://localhost:11434/v1',
  authType: 'bearer',
  verifySsl: true,
  defaultModel: 'qwen3:4b',
  isDefault: true,
  hasApiKey: false,
  keyPreview: null,
  createdAt: '2026-04-20T00:00:00.000Z',
  updatedAt: '2026-04-20T00:00:00.000Z',
};
const providerB: LlmProvider = {
  ...providerA,
  id: '22222222-2222-2222-2222-222222222222',
  name: 'OpenAI',
  isDefault: false,
};

function makeAssignments(): UsecaseAssignments {
  const base = {
    providerId: null,
    model: null,
    resolved: { providerId: providerA.id, providerName: providerA.name, model: 'qwen3:4b' },
  };
  return {
    chat: { ...base },
    summary: { ...base },
    quality: { ...base },
    auto_tag: { ...base },
    embedding: {
      providerId: null,
      model: null,
      resolved: { providerId: providerA.id, providerName: providerA.name, model: 'bge-m3' },
    },
  };
}

describe('UsecaseAssignmentsSection', () => {
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

  it('renders all 5 use-cases including embedding', () => {
    const Wrapper = createWrapper();
    render(
      <UsecaseAssignmentsSection
        assignments={makeAssignments()}
        providers={[providerA, providerB]}
        onChange={() => {}}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByText('Chat')).toBeTruthy();
    expect(screen.getByText('Summary worker')).toBeTruthy();
    expect(screen.getByText('Quality worker')).toBeTruthy();
    expect(screen.getByText('Auto-tag')).toBeTruthy();
    expect(screen.getByText('Embedding')).toBeTruthy();
  });

  it('provider dropdown shows Inherit + all providers', () => {
    const Wrapper = createWrapper();
    render(
      <UsecaseAssignmentsSection
        assignments={makeAssignments()}
        providers={[providerA, providerB]}
        onChange={() => {}}
      />,
      { wrapper: Wrapper },
    );
    const chatProviderSelect = screen.getByTestId('usecase-chat-provider') as HTMLSelectElement;
    const options = Array.from(chatProviderSelect.options).map((o) => o.textContent);
    expect(options).toContain('Inherit default');
    expect(options).toContain('Ollama');
    expect(options).toContain('OpenAI');
  });

  it('changing provider fetches models for that provider', async () => {
    const Wrapper = createWrapper();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes(`/admin/llm-providers/${providerB.id}/models`)) {
        return new Response(JSON.stringify([{ name: 'gpt-4o-mini' }]), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    });
    const onChange = vi.fn();
    render(
      <UsecaseAssignmentsSection
        assignments={makeAssignments()}
        providers={[providerA, providerB]}
        onChange={onChange}
      />,
      { wrapper: Wrapper },
    );
    // Change chat provider to providerB
    fireEvent.change(screen.getByTestId('usecase-chat-provider'), { target: { value: providerB.id } });
    expect(onChange).toHaveBeenCalled();
    // A caller would normally pass the updated assignments back; simulate that by re-rendering.
    const updated = makeAssignments();
    updated.chat.providerId = providerB.id;
    render(
      <UsecaseAssignmentsSection
        assignments={updated}
        providers={[providerA, providerB]}
        onChange={onChange}
      />,
      { wrapper: Wrapper },
    );
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/admin/llm-providers/${providerB.id}/models`),
        expect.anything(),
      );
    });
  });

  it('shows resolved provider/model summary', () => {
    const Wrapper = createWrapper();
    render(
      <UsecaseAssignmentsSection
        assignments={makeAssignments()}
        providers={[providerA, providerB]}
        onChange={() => {}}
      />,
      { wrapper: Wrapper },
    );
    const matches = screen.getAllByText(/Ollama \/ qwen3:4b/);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Ollama \/ bge-m3/)).toBeTruthy();
  });
});
