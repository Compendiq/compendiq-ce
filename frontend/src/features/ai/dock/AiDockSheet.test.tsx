/**
 * The assistant's mobile bottom sheet (#1126, PR 3 of 3).
 *
 * Every suite here sets a phone-sized `window.innerWidth` in `beforeEach`.
 * `test-setup.ts` answers width queries from `window.innerWidth`, and jsdom
 * defaults it to 1024 — a suite that forgets silently exercises the desktop
 * column instead of the sheet and passes for the wrong reason.
 *
 * Mocked only at the network boundary (`apiFetch`, `streamSSE`), as the dock's
 * own suite is, so these describe what a user can observe.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { AiProvider } from '../AiContext';
import { AiDock } from './AiDock';
import { useAiDockStore } from '../../../stores/ai-dock-store';

Element.prototype.scrollIntoView = vi.fn();

const apiFetchMock = vi.fn();
vi.mock('../../../shared/lib/api', async () =>
  (await import('../../../test-utils')).apiModuleMock(() => apiFetchMock));

const streamSSEMock = vi.fn();
vi.mock('../../../shared/lib/sse', () => ({
  streamSSE: (...args: unknown[]) => streamSSEMock(...args),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const PAGE = {
  id: 'page-1',
  title: 'Onboarding Guide',
  bodyHtml: '<p>You need a PAT.</p>',
  bodyText: 'You need a PAT.',
  version: 4,
  hasChildren: false,
  labels: [],
  spaceKey: 'ENG',
};

/** A phone: 390 x 780 is an iPhone 14 in portrait. */
const PHONE_WIDTH = 390;
const PHONE_HEIGHT = 780;
// The detents these produce, from AiDockSheet's own ratios.
const REST_HEIGHT = Math.round(PHONE_HEIGHT * 0.52); // 406
const FULL_HEIGHT = Math.round(PHONE_HEIGHT * 0.92); // 718

function sse(...chunks: Array<Record<string, unknown>>) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

function renderSheet() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LazyMotion features={domAnimation}>
        <MemoryRouter initialEntries={['/pages/page-1']}>
          <AiProvider>
            <button data-testid="sheet-trigger">AI Improve</button>
            <main>
              <Routes>
                <Route path="/pages/:id" element={<div>article</div>} />
              </Routes>
            </main>
            <AiDock />
          </AiProvider>
        </MemoryRouter>
      </LazyMotion>
    </QueryClientProvider>,
  );
}

/** Open the assistant and wait until the panel is live. */
async function openAndSettle() {
  act(() => {
    useAiDockStore.getState().openDock();
  });
  await waitFor(() => expect(screen.getByTestId('ai-dock-input')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByTestId('ai-dock-chip-summarize')).not.toBeDisabled());
}

function sheet(): HTMLElement {
  return screen.getByTestId('ai-dock-sheet');
}

function grabber(): HTMLElement {
  return screen.getByTestId('ai-dock-sheet-grabber');
}

/**
 * One drag of the grab handle, in the shape a browser delivers it: pointerdown
 * on the handle, pointermove/pointerup on the window.
 */
function drag(fromY: number, toY: number) {
  fireEvent.pointerDown(grabber(), { clientY: fromY, button: 0 });
  fireEvent.pointerMove(window, { clientY: toY });
  fireEvent.pointerUp(window, { clientY: toY });
}

describe('AiDockSheet (#1126)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAiDockStore.setState({ open: false, seed: null, seedPageId: null });
    window.innerWidth = PHONE_WIDTH;
    window.innerHeight = PHONE_HEIGHT;
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/pages/page-1') return Promise.resolve(PAGE);
      if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
      if (path.startsWith('/llm/usecase-default')) return Promise.resolve({ model: 'llama3' });
      if (path === '/llm/conversations') return Promise.resolve([]);
      if (path === '/embeddings/status') return Promise.resolve({ total: 1, embedded: 1, isProcessing: false });
      return Promise.resolve({});
    });
    streamSSEMock.mockImplementation(() => sse({ content: 'ok' }, { final: true, done: true }));
  });

  afterEach(() => {
    useAiDockStore.setState({ open: false, seed: null, seedPageId: null });
  });

  it('renders nothing until it is opened', () => {
    renderSheet();
    expect(screen.queryByTestId('ai-dock-sheet')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-dock-sheet-backdrop')).not.toBeInTheDocument();
  });

  it('opens as a modal sheet, not the desktop column', async () => {
    renderSheet();
    await openAndSettle();

    const dialog = sheet();
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', 'AI assistant');
    expect(screen.getByTestId('ai-dock-sheet-backdrop')).toBeInTheDocument();
    // The column form must not also be on screen.
    expect(screen.queryByTestId('ai-dock')).not.toBeInTheDocument();
  });

  it('is not the form used at md and up', async () => {
    window.innerWidth = 1400;
    renderSheet();
    act(() => {
      useAiDockStore.getState().openDock();
    });

    await waitFor(() => expect(screen.getByTestId('ai-dock')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-dock-sheet')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-dock-sheet-backdrop')).not.toBeInTheDocument();
  });

  it('opens at the resting detent with the composer in reach', async () => {
    renderSheet();
    await openAndSettle();

    expect(sheet()).toHaveStyle({ height: `${REST_HEIGHT}px` });
    expect(sheet()).toHaveAttribute('data-detent', 'rest');
    // The article is still on screen behind it — the point of docking at all.
    expect(REST_HEIGHT).toBeLessThan(PHONE_HEIGHT);
  });

  describe('drag to expand', () => {
    it('grows the sheet as the handle is dragged up, then settles on the full detent', async () => {
      renderSheet();
      await openAndSettle();

      // Mid-gesture the sheet tracks the finger rather than a detent: 200px of
      // upward travel from the resting height.
      fireEvent.pointerDown(grabber(), { clientY: 600, button: 0 });
      fireEvent.pointerMove(window, { clientY: 400 });
      expect(sheet()).toHaveStyle({ height: `${REST_HEIGHT + 200}px` });

      fireEvent.pointerUp(window, { clientY: 400 });
      expect(sheet()).toHaveStyle({ height: `${FULL_HEIGHT}px` });
      expect(sheet()).toHaveAttribute('data-detent', 'full');
    });

    it('falls back to the resting detent when the drag does not clear halfway', async () => {
      renderSheet();
      await openAndSettle();

      drag(600, 560); // 40px up — nowhere near the midpoint.
      expect(sheet()).toHaveStyle({ height: `${REST_HEIGHT}px` });
      expect(sheet()).toHaveAttribute('data-detent', 'rest');
    });

    it('collapses back from full when dragged down', async () => {
      renderSheet();
      await openAndSettle();

      drag(600, 300); // Up to full.
      expect(sheet()).toHaveAttribute('data-detent', 'full');

      drag(100, 400); // 300px back down.
      expect(sheet()).toHaveStyle({ height: `${REST_HEIGHT}px` });
      expect(sheet()).toHaveAttribute('data-detent', 'rest');
    });

    it('lets go of the sheet entirely when dragged well below the resting detent', async () => {
      renderSheet();
      await openAndSettle();

      drag(400, 650); // 250px down, past the dismiss threshold.

      await waitFor(() => expect(screen.queryByTestId('ai-dock-sheet')).not.toBeInTheDocument());
      expect(useAiDockStore.getState().open).toBe(false);
    });

    it('ignores travel below the slop threshold, so a jittery tap is still a tap', async () => {
      renderSheet();
      await openAndSettle();

      fireEvent.pointerDown(grabber(), { clientY: 600, button: 0 });
      fireEvent.pointerMove(window, { clientY: 598 });
      fireEvent.pointerUp(window, { clientY: 598 });
      // Not treated as a drag, so the click that follows still toggles.
      fireEvent.click(grabber());

      expect(sheet()).toHaveAttribute('data-detent', 'full');
    });

    // Touch does not reliably deliver a click after a drag, and a cancelled
    // gesture delivers none at all. A suppression left standing would swallow
    // the next tap instead of the one it was meant for.
    it('does not swallow the next tap when a drag is not followed by a click', async () => {
      renderSheet();
      await openAndSettle();

      fireEvent.pointerDown(grabber(), { clientY: 600, button: 0 });
      fireEvent.pointerMove(window, { clientY: 400 });
      fireEvent.pointerUp(window, { clientY: 400 });
      expect(sheet()).toHaveAttribute('data-detent', 'full');

      // A later, separate tap — no click ever arrived for the drag above.
      fireEvent.pointerDown(grabber(), { clientY: 100, button: 0 });
      fireEvent.pointerUp(window, { clientY: 100 });
      fireEvent.click(grabber());

      expect(sheet()).toHaveAttribute('data-detent', 'rest');
    });

    it('settles on a detent when the gesture is cancelled mid-drag', async () => {
      renderSheet();
      await openAndSettle();

      fireEvent.pointerDown(grabber(), { clientY: 600, button: 0 });
      fireEvent.pointerMove(window, { clientY: 400 });
      fireEvent.pointerCancel(window);

      // Not left stranded at the interrupted height.
      expect(sheet()).toHaveStyle({ height: `${FULL_HEIGHT}px` });
    });

    it('does not let the click that ends a drag re-toggle the detent', async () => {
      renderSheet();
      await openAndSettle();

      fireEvent.pointerDown(grabber(), { clientY: 600, button: 0 });
      fireEvent.pointerMove(window, { clientY: 400 });
      fireEvent.pointerUp(window, { clientY: 400 });
      // A real browser fires click after the pointerup that ended the drag.
      fireEvent.click(grabber());

      expect(sheet()).toHaveAttribute('data-detent', 'full');
    });
  });

  // WCAG 2.5.7: a drag gesture cannot be the only way to operate a control.
  describe('the non-drag path', () => {
    it('toggles between the two detents when the handle is activated', async () => {
      renderSheet();
      await openAndSettle();

      const handle = grabber();
      expect(handle).toHaveAttribute('aria-expanded', 'false');
      expect(handle).toHaveAccessibleName('Expand assistant');

      fireEvent.click(handle);
      expect(sheet()).toHaveStyle({ height: `${FULL_HEIGHT}px` });
      expect(grabber()).toHaveAttribute('aria-expanded', 'true');
      expect(grabber()).toHaveAccessibleName('Collapse assistant');

      fireEvent.click(grabber());
      expect(sheet()).toHaveStyle({ height: `${REST_HEIGHT}px` });
    });

    it('is a button, so Enter and Space reach it from the keyboard', async () => {
      renderSheet();
      await openAndSettle();

      expect(grabber().tagName).toBe('BUTTON');
      expect(grabber()).toHaveAttribute('aria-controls', 'ai-dock-sheet');
      expect(sheet()).toHaveAttribute('id', 'ai-dock-sheet');
    });
  });

  describe('dismissal', () => {
    it('closes on Escape and hands focus back to the trigger', async () => {
      renderSheet();
      const trigger = screen.getByTestId('sheet-trigger');
      act(() => trigger.focus());

      await openAndSettle();
      expect(document.activeElement).toBe(screen.getByTestId('ai-dock-input'));

      fireEvent.keyDown(screen.getByTestId('ai-dock-input'), { key: 'Escape' });

      await waitFor(() => {
        expect(screen.queryByTestId('ai-dock-sheet')).not.toBeInTheDocument();
        expect(document.activeElement).toBe(trigger);
      });
    });

    it('closes on Escape pressed from the grab handle, which sits outside the panel', async () => {
      renderSheet();
      await openAndSettle();

      act(() => grabber().focus());
      fireEvent.keyDown(grabber(), { key: 'Escape' });

      await waitFor(() => expect(screen.queryByTestId('ai-dock-sheet')).not.toBeInTheDocument());
    });

    it('closes when the backdrop is tapped', async () => {
      renderSheet();
      await openAndSettle();

      fireEvent.click(screen.getByTestId('ai-dock-sheet-backdrop'));

      await waitFor(() => expect(screen.queryByTestId('ai-dock-sheet')).not.toBeInTheDocument());
    });
  });

  // The sheet covers the article; the dock beside one does not. That is the
  // whole reason this form traps Tab and the column form deliberately does not.
  describe('focus containment', () => {
    it('pulls a stray Tab back into the sheet', async () => {
      renderSheet();
      await openAndSettle();

      act(() => screen.getByTestId('sheet-trigger').focus());
      fireEvent.keyDown(document, { key: 'Tab' });

      expect(sheet().contains(document.activeElement)).toBe(true);
    });

    it('cycles from the last control back to the grab handle', async () => {
      renderSheet();
      await openAndSettle();

      // Send is disabled while the composer is empty, so give it something to
      // send — otherwise it is not in the tab order and cannot be the last stop.
      fireEvent.change(screen.getByTestId('ai-dock-input'), { target: { value: 'hi' } });
      const send = screen.getByTestId('ai-dock-send');
      await waitFor(() => expect(send).not.toBeDisabled());

      act(() => send.focus());
      fireEvent.keyDown(document, { key: 'Tab' });

      expect(document.activeElement).toBe(grabber());
    });

    it('cycles backwards from the grab handle to the last control', async () => {
      renderSheet();
      await openAndSettle();

      fireEvent.change(screen.getByTestId('ai-dock-input'), { target: { value: 'hi' } });
      await waitFor(() => expect(screen.getByTestId('ai-dock-send')).not.toBeDisabled());

      act(() => grabber().focus());
      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });

      expect(document.activeElement).toBe(screen.getByTestId('ai-dock-send'));
    });
  });

  it('re-measures its detents when the viewport changes under it', async () => {
    renderSheet();
    await openAndSettle();
    expect(sheet()).toHaveStyle({ height: `${REST_HEIGHT}px` });

    // The URL bar collapsing, a rotation, or the on-screen keyboard opening.
    act(() => {
      window.innerHeight = 600;
      window.dispatchEvent(new Event('resize'));
    });

    expect(sheet()).toHaveStyle({ height: `${Math.round(600 * 0.52)}px` });
  });

  it('carries the same panel as the dock — chips, composer and thread', async () => {
    renderSheet();
    await openAndSettle();

    for (const id of ['improve', 'summarize', 'diagram', 'quality']) {
      expect(screen.getByTestId(`ai-dock-chip-${id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('ai-dock-thread')).toBeInTheDocument();
    expect(screen.getByTestId('ai-dock-empty')).toHaveTextContent('Onboarding Guide');

    fireEvent.click(screen.getByTestId('ai-dock-chip-summarize'));
    await waitFor(() => {
      expect(streamSSEMock).toHaveBeenCalledWith(
        '/llm/summarize',
        expect.objectContaining({ pageId: 'page-1' }),
        expect.anything(),
      );
    });
  });

  it('springs in and animates between detents when motion is not restricted', async () => {
    renderSheet();
    await openAndSettle();

    // The counterpart assertion — that both are stripped — lives in
    // AiDockSheet.reduced-motion.test.tsx, which forces the preference on.
    expect(sheet().className).toContain('transition-[height]');
  });
});
