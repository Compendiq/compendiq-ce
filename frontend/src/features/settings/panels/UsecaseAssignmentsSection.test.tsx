import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LlmProvider, UsecaseAssignments } from '@compendiq/contracts';
import { IMAGE_EMBEDDING_TARGET_DIMENSIONS_MIN } from '@compendiq/contracts';
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
    rerank: {
      providerId: null,
      model: null,
      resolved: { providerId: '00000000-0000-0000-0000-000000000000', providerName: '', model: '' },
    },
    // #1115 — unassigned, like rerank: the image leg never inherits, so the
    // row renders with the strip and without a probe. It belongs in the
    // fixture because the schema requires it, and the section renders `null`
    // for a row the document omits — which silently took the truncation field
    // out of every test in this file.
    image_embedding: {
      providerId: null,
      model: null,
      resolved: { providerId: '00000000-0000-0000-0000-000000000000', providerName: '', model: '' },
    },
    inline_completion: {
      providerId: null,
      model: null,
      resolved: { providerId: '00000000-0000-0000-0000-000000000000', providerName: '', model: '' },
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

  it('renders the rerank row with disabled-not-inherited semantics (#1104)', () => {
    const Wrapper = createWrapper();
    render(
      <UsecaseAssignmentsSection
        assignments={makeAssignments()}
        savedAssignments={makeAssignments()}
        providers={[providerA, providerB]}
        imageTargetDimensions={null}
        onImageTargetDimensionsChange={() => {}}
        onChange={() => {}}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByText('Rerank')).toBeTruthy();
    // The unassigned option must NOT read "Inherit default" — unassigned
    // rerank means the stage is off, and the copy has to say so.
    const select = screen.getByTestId('usecase-rerank-provider') as HTMLSelectElement;
    expect(select.options[0]!.text).toBe('Disabled (no reranking)');
    expect(screen.getByLabelText('rerank-info')).toBeTruthy();
  });

  it('renders every contract-defined use case', () => {
    const Wrapper = createWrapper();
    render(
      <UsecaseAssignmentsSection
        assignments={makeAssignments()}
        savedAssignments={makeAssignments()}
        providers={[providerA, providerB]}
        imageTargetDimensions={null}
        onImageTargetDimensionsChange={() => {}}
        onChange={() => {}}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByText('Chat')).toBeTruthy();
    expect(screen.getByText('Summary worker')).toBeTruthy();
    expect(screen.getByText('Quality worker')).toBeTruthy();
    expect(screen.getByText('Auto-tag')).toBeTruthy();
    expect(screen.getByText('Embedding')).toBeTruthy();
    expect(screen.getByText('Inline completion')).toBeTruthy();
  });

  it('renders inline completion as explicitly disabled with a fast-model warning', () => {
    const Wrapper = createWrapper();
    render(
      <UsecaseAssignmentsSection
        assignments={makeAssignments()}
        savedAssignments={makeAssignments()}
        providers={[providerA, providerB]}
        imageTargetDimensions={null}
        onImageTargetDimensionsChange={() => {}}
        onChange={() => {}}
      />,
      { wrapper: Wrapper },
    );
    const select = screen.getByTestId('usecase-inline_completion-provider') as HTMLSelectElement;
    expect(select.options[0]!.text).toBe('Disabled (no inline suggestions)');
    expect(screen.getByLabelText('inline-completion-info')).toHaveAttribute('title', expect.stringContaining('small, fast model'));
  });

  it('provider dropdown shows Inherit + all providers', () => {
    const Wrapper = createWrapper();
    render(
      <UsecaseAssignmentsSection
        assignments={makeAssignments()}
        savedAssignments={makeAssignments()}
        providers={[providerA, providerB]}
        imageTargetDimensions={null}
        onImageTargetDimensionsChange={() => {}}
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
        savedAssignments={makeAssignments()}
        providers={[providerA, providerB]}
        imageTargetDimensions={null}
        onImageTargetDimensionsChange={() => {}}
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
        savedAssignments={makeAssignments()}
        providers={[providerA, providerB]}
        imageTargetDimensions={null}
        onImageTargetDimensionsChange={() => {}}
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

  /**
   * #1115 final review, nit 2 — the truncation field is controlled by `LlmTab`,
   * and until now the only clamp ran at Save. That left the field showing a
   * number that was not the one about to be sent. The component's own contract
   * is what this pins: on BLUR it reports the clamped value back, and on every
   * keystroke before that it reports exactly what was typed — a per-keystroke
   * clamp rewrites `4` to `64` and makes `4000`, the largest indexable width,
   * unreachable from an empty field.
   */
  it('reports the truncation width clamped on blur and verbatim while typing', () => {
    const Wrapper = createWrapper();
    const onImageTargetDimensionsChange = vi.fn();
    const { rerender } = render(
      <UsecaseAssignmentsSection
        assignments={makeAssignments()}
        savedAssignments={makeAssignments()}
        providers={[providerA, providerB]}
        imageTargetDimensions={null}
        onImageTargetDimensionsChange={onImageTargetDimensionsChange}
        onChange={() => {}}
      />,
      { wrapper: Wrapper },
    );
    const field = screen.getByTestId('image-embedding-target-dimensions');

    // Mid-entry: passed through untouched, below the floor and all.
    fireEvent.change(field, { target: { value: '4' } });
    expect(onImageTargetDimensionsChange).toHaveBeenLastCalledWith(4);

    // Blur settles it on the value that will actually be sent.
    rerender(
      <UsecaseAssignmentsSection
        assignments={makeAssignments()}
        savedAssignments={makeAssignments()}
        providers={[providerA, providerB]}
        imageTargetDimensions={4}
        onImageTargetDimensionsChange={onImageTargetDimensionsChange}
        onChange={() => {}}
      />,
    );
    fireEvent.blur(screen.getByTestId('image-embedding-target-dimensions'));
    expect(onImageTargetDimensionsChange).toHaveBeenLastCalledWith(
      IMAGE_EMBEDDING_TARGET_DIMENSIONS_MIN,
    );

    // An in-range width is left alone, and an empty field still means "native".
    rerender(
      <UsecaseAssignmentsSection
        assignments={makeAssignments()}
        savedAssignments={makeAssignments()}
        providers={[providerA, providerB]}
        imageTargetDimensions={4000}
        onImageTargetDimensionsChange={onImageTargetDimensionsChange}
        onChange={() => {}}
      />,
    );
    fireEvent.blur(screen.getByTestId('image-embedding-target-dimensions'));
    expect(onImageTargetDimensionsChange).toHaveBeenLastCalledWith(4000);

    rerender(
      <UsecaseAssignmentsSection
        assignments={makeAssignments()}
        savedAssignments={makeAssignments()}
        providers={[providerA, providerB]}
        imageTargetDimensions={null}
        onImageTargetDimensionsChange={onImageTargetDimensionsChange}
        onChange={() => {}}
      />,
    );
    fireEvent.blur(screen.getByTestId('image-embedding-target-dimensions'));
    expect(onImageTargetDimensionsChange).toHaveBeenLastCalledWith(null);
  });

  it('shows resolved provider/model summary', () => {
    const Wrapper = createWrapper();
    render(
      <UsecaseAssignmentsSection
        assignments={makeAssignments()}
        savedAssignments={makeAssignments()}
        providers={[providerA, providerB]}
        imageTargetDimensions={null}
        onImageTargetDimensionsChange={() => {}}
        onChange={() => {}}
      />,
      { wrapper: Wrapper },
    );
    const matches = screen.getAllByText(/Ollama \/ qwen3:4b/);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Ollama \/ bge-m3/)).toBeTruthy();
  });
});
