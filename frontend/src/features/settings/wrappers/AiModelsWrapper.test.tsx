import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AiModelsWrapper } from './AiModelsWrapper';

vi.mock('../../../shared/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue({}),
}));

describe('AiModelsWrapper client inference tab (#1418 SPEC-042)', () => {
  it('places Client inference after Retrieval and before Workers', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <AiModelsWrapper />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const tabs = screen.getAllByRole('tab').map((el) => el.textContent);
    expect(tabs).toEqual([
      'LLM providers',
      'Embeddings',
      'Retrieval',
      'Client inference',
      'Workers',
    ]);
  });
});
