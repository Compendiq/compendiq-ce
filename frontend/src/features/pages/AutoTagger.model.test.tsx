import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutoTagger } from './AutoTagger';

// Mock apiFetch at the module boundary so we can inspect the request body.
const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../shared/lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetchMock(...a) }));
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));

function renderWith(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <LazyMotion features={domAnimation}>{ui}</LazyMotion>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AutoTagger — model prop optional (#718)', () => {
  beforeEach(() => apiFetchMock.mockReset());

  it('omits model from the request body when no model prop is given', async () => {
    apiFetchMock.mockResolvedValue({ suggestedTags: [], existingLabels: [] });
    renderWith(<AutoTagger pageId="42" currentLabels={[]} />);
    fireEvent.click(screen.getByText('Auto-tag'));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    const [, opts] = apiFetchMock.mock.calls[0];
    expect(JSON.parse((opts as { body: string }).body)).toEqual({});
  });

  it('still sends model when provided', async () => {
    apiFetchMock.mockResolvedValue({ suggestedTags: [], existingLabels: [] });
    renderWith(<AutoTagger pageId="42" currentLabels={[]} model="bge-x" />);
    fireEvent.click(screen.getByText('Auto-tag'));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    const [, opts] = apiFetchMock.mock.calls[0];
    expect(JSON.parse((opts as { body: string }).body)).toEqual({ model: 'bge-x' });
  });
});
