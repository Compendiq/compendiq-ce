/**
 * The mobile sheet under `prefers-reduced-motion: reduce` (#1126).
 *
 * A separate file because the preference is forced with a file-level
 * framer-motion mock — the same technique `SidebarTreeView.test.tsx` uses, and
 * the only reliable one: framer reads the media query once into a module-level
 * motion value, so reassigning `window.matchMedia` per test does not reach it.
 *
 * `<MotionConfig reducedMotion="user">` in App.tsx would already suppress the
 * sheet's y-slide in production, but it reaches neither the CSS height
 * transition nor the hand-rolled drag — so the component decides for itself
 * rather than depending on an ancestor two levels up.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { AiProvider } from '../AiContext';
import { AiDock } from './AiDock';
import { useAiDockStore } from '../../../stores/ai-dock-store';

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion');
  return { ...actual, useReducedMotion: () => true };
});

Element.prototype.scrollIntoView = vi.fn();

const apiFetchMock = vi.fn();
vi.mock('../../../shared/lib/api', async () =>
  (await import('../../../test-utils')).apiModuleMock(() => apiFetchMock));

vi.mock('../../../shared/lib/sse', () => ({ streamSSE: vi.fn() }));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const PHONE_HEIGHT = 780;

function renderSheet() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LazyMotion features={domAnimation}>
        <MemoryRouter initialEntries={['/pages/page-1']}>
          <AiProvider>
            <main>article</main>
            <AiDock />
          </AiProvider>
        </MemoryRouter>
      </LazyMotion>
    </QueryClientProvider>,
  );
}

describe('AiDockSheet under prefers-reduced-motion (#1126)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAiDockStore.setState({ open: false });
    window.innerWidth = 390;
    window.innerHeight = PHONE_HEIGHT;
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/pages/page-1') {
        return Promise.resolve({ id: 'page-1', title: 'Onboarding Guide', bodyHtml: '<p>x</p>', bodyText: 'x', version: 1, hasChildren: false, labels: [], spaceKey: 'ENG' });
      }
      if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
      if (path.startsWith('/llm/usecase-default')) return Promise.resolve({ model: 'llama3' });
      if (path === '/llm/conversations') return Promise.resolve([]);
      if (path === '/embeddings/status') return Promise.resolve({ total: 1, embedded: 1, isProcessing: false });
      return Promise.resolve({});
    });
  });

  afterEach(() => {
    useAiDockStore.setState({ open: false });
  });

  it('strips the height transition, so moving between detents is instant', async () => {
    renderSheet();
    act(() => useAiDockStore.getState().openDock());
    await waitFor(() => expect(screen.getByTestId('ai-dock-sheet')).toBeInTheDocument());

    const sheet = screen.getByTestId('ai-dock-sheet');
    expect(sheet.className).not.toContain('transition-[height]');

    // The detent still changes — reduced motion removes the animation, not the
    // behavior.
    fireEvent.click(screen.getByTestId('ai-dock-sheet-grabber'));
    expect(screen.getByTestId('ai-dock-sheet')).toHaveStyle({
      height: `${Math.round(PHONE_HEIGHT * 0.92)}px`,
    });
  });

  it('does not slide in from off-screen', async () => {
    renderSheet();
    act(() => useAiDockStore.getState().openDock());
    await waitFor(() => expect(screen.getByTestId('ai-dock-sheet')).toBeInTheDocument());

    // `initial={false}` means framer never writes the entrance transform: the
    // sheet is simply there, at its resting height.
    expect(screen.getByTestId('ai-dock-sheet').style.transform).not.toContain('100%');
  });

  it('still drags — direct manipulation is not motion', async () => {
    renderSheet();
    act(() => useAiDockStore.getState().openDock());
    await waitFor(() => expect(screen.getByTestId('ai-dock-sheet')).toBeInTheDocument());

    const grabber = screen.getByTestId('ai-dock-sheet-grabber');
    fireEvent.pointerDown(grabber, { clientY: 600, button: 0 });
    fireEvent.pointerMove(window, { clientY: 400 });
    fireEvent.pointerUp(window, { clientY: 400 });

    expect(screen.getByTestId('ai-dock-sheet')).toHaveAttribute('data-detent', 'full');
  });
});
