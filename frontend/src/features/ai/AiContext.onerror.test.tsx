import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AiProvider, useAiContext } from './AiContext';
import { useAuthStore } from '../../stores/auth-store';
import { ApiError } from '../../shared/lib/api';

Element.prototype.scrollIntoView = vi.fn();

const apiFetchMock = vi.fn();
vi.mock('../../shared/lib/api', async () =>
  (await import('../../test-utils')).apiModuleMock(() => apiFetchMock));

const streamSSEMock = vi.fn();
vi.mock('../../shared/lib/sse', () => ({
  streamSSE: (...args: unknown[]) => streamSSEMock(...args),
}));

vi.mock('../../shared/hooks/use-pages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/hooks/use-pages')>();
  return { ...actual, usePage: () => ({ data: undefined }), useEmbeddingStatus: () => ({ data: undefined }) };
});

const toastErrorMock = vi.fn();
vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => toastErrorMock(...args), success: vi.fn() },
}));

/**
 * #1154: `runStream`'s `onError` seam, tested where it lives rather than only
 * through Generate.
 *
 * Generate hand-seeds its own user turn and never passes `userMessage`, so no
 * test that goes through Generate can exercise the branch that withdraws a turn
 * `runStream` seeded. Improve, Summarize, Quality and Diagram all pass
 * `userMessage` (e.g. `ImproveMode.tsx:183`), so that branch is exactly what
 * Tasks 8 and 9 will rely on — and neither id is reachable from a caller, which
 * is why `runStream` has to do the removing.
 */

const SEEDED_TURN = 'Improve (clarity): My Page';

function Harness({ claim, userMessage }: { claim: boolean; userMessage?: string }) {
  const { runStream, messages } = useAiContext();
  return (
    <>
      <button
        onClick={() => void runStream('/llm/improve', { pageId: '1' }, {
          ...(userMessage ? { userMessage } : {}),
          onError: () => claim,
        })}
      >
        run
      </button>
      <ul data-testid="messages">
        {messages.map((m) => <li key={m.id}>{m.role}:{m.content}</li>)}
      </ul>
    </>
  );
}

function rows(): string[] {
  return Array.from(screen.getByTestId('messages').querySelectorAll('li'))
    .map((li) => li.textContent ?? '');
}

function renderHarness(props: { claim: boolean; userMessage?: string }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/ai']}>
        <AiProvider><Harness {...props} /></AiProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function run() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'run' })); });
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchMock.mockResolvedValue([]);
  useAuthStore.getState().setAuth('t', { id: '1', username: 'u', role: 'user' });
  streamSSEMock.mockImplementation(() => {
    throw new ApiError(410, 'The staged image has expired. Attach it again.');
  });
});

afterEach(() => {
  useAuthStore.getState().clearAuth();
});

describe('runStream onError (#1154)', () => {
  it('withdraws the user turn IT seeded, not just the placeholder', async () => {
    renderHarness({ claim: true, userMessage: SEEDED_TURN });
    await run();

    // Removing only the placeholder would leave the seeded turn stranded with
    // nothing under it — the same defect the placeholder removal exists to
    // prevent, one row up.
    await waitFor(() => expect(rows()).toEqual([]));
  });

  it('removes the placeholder when no turn was seeded', async () => {
    renderHarness({ claim: true });
    await run();

    await waitFor(() => expect(rows()).toEqual([]));
  });

  it('suppresses the toast when the caller claims the error', async () => {
    renderHarness({ claim: true, userMessage: SEEDED_TURN });
    await run();

    await waitFor(() => expect(rows()).toEqual([]));
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('leaves an unclaimed error entirely alone', async () => {
    renderHarness({ claim: false, userMessage: SEEDED_TURN });
    await run();

    // Both rows survive and the placeholder becomes the inline error, which is
    // the behaviour every caller that passes no onError still gets.
    await waitFor(() => {
      expect(rows()).toEqual([
        `user:${SEEDED_TURN}`,
        'assistant:The staged image has expired. Attach it again.',
      ]);
    });
    expect(toastErrorMock).toHaveBeenCalledWith('The staged image has expired. Attach it again.');
  });
});
