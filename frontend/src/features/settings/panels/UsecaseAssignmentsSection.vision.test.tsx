import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LlmProvider, UsecaseAssignments } from '@compendiq/contracts';

const mockApiFetch = vi.fn();
vi.mock('../../../shared/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/lib/api')>()),
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

import { UsecaseAssignmentsSection } from './UsecaseAssignmentsSection';

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
  };
}

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <UsecaseAssignmentsSection
        assignments={makeAssignments()}
        savedAssignments={makeAssignments()}
        providers={[providerA]}
        imageTargetDimensions={null}
        onImageTargetDimensionsChange={() => {}}
        onChange={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe('UsecaseAssignmentsSection vision badge (#1154)', () => {
  beforeEach(() => {
    mockApiFetch.mockReset().mockImplementation(async (path: string) => {
      if (path === '/admin/llm-usecases') return makeAssignments();
      if (path === '/llm/usecase-default?usecase=chat') {
        return {
          usecase: 'chat',
          providerId: providerA.id,
          providerName: providerA.name,
          model: 'qwen3:4b',
          vision: true,
        };
      }
      if (path.includes('/models')) return [];
      return {};
    });
  });

  it('renders the badge on the chat row only', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByTestId('vision-badge')).toBeInTheDocument());
    expect(screen.getAllByTestId('vision-badge')).toHaveLength(1);
    expect(screen.getByTestId('usecase-row-chat')).toContainElement(screen.getByTestId('vision-badge'));
  });

  /**
   * Probing costs a chat completion. Reading the resolved chat verdict is one
   * cached lookup; badging the model dropdown would fire one probe per option.
   */
  it('fetches usecase-default exactly once, not per model', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByTestId('vision-badge')).toBeInTheDocument());
    const calls = mockApiFetch.mock.calls.filter(([p]) => String(p).includes('usecase-default'));
    expect(calls).toHaveLength(1);
  });

  /**
   * Two observers of one query key do not each keep their own stale time — the
   * cache entry takes the configuration of whichever observer is active — so a
   * divergence here would let this badge decide refetch scheduling for the chat
   * pane whenever `AiContext`'s observer unmounts first. Asserted against the
   * sources because the effect is a scheduling decision inside react-query,
   * with no rendered consequence to hang an assertion on.
   */
  it('configures the shared chat-default query the same way AiContext does', () => {
    const files = [
      resolve(__dirname, 'UsecaseAssignmentsSection.tsx'),
      resolve(__dirname, '../../ai/AiContext.tsx'),
    ];

    for (const file of files) {
      const source = readFileSync(file, 'utf-8');
      const block = /queryKey: \['llm', 'usecase-default', 'chat'\][\s\S]*?\n {2}\}\);/.exec(source);
      expect(block, `no chat usecase-default query found in ${file}`).not.toBeNull();
      expect(block![0], `stale time diverges in ${file}`).toContain('staleTime: 30_000');
    }
  });
});
