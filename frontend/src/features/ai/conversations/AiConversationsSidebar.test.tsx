import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConversationListResponse, ConversationSummary } from '@compendiq/contracts';
import { AiConversationsSidebar, CONVERSATION_FILTER_THRESHOLD } from './AiConversationsSidebar';
import { useUiStore } from '../../../stores/ui-store';

const { startNewConversation, purgeConversation } = vi.hoisted(() => ({
  startNewConversation: vi.fn(),
  purgeConversation: vi.fn(),
}));

vi.mock('../AiContext', () => ({
  useAiContext: () => ({ startNewConversation, purgeConversation }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// No SidebarSessionChrome stub. Theme and account live in the header
// (HeaderSessionCluster) since #1377/#1378, the component has no consumer left,
// and the pane must not grow one — so there is nothing here to keep UserMenu's
// auth store out of. SidebarTreeView.test.tsx:19-20 still carries that stub; it
// is dead, and copying it here would imply a footer this pane does not have.

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual('framer-motion');
  return { ...actual, useReducedMotion: () => true };
});

function conversation(i: number): ConversationSummary {
  return {
    id: `1111111${i}-1111-4111-8111-111111111111`,
    title: `Conversation ${i}`,
    titleSource: 'question',
    model: 'llama3',
    pageId: null,
    pageTitle: null,
    createdAt: '2026-08-18T09:00:00.000Z',
    updatedAt: '2026-08-18T09:00:00.000Z',
  };
}

function mockList(count: number) {
  const page: ConversationListResponse = {
    items: Array.from({ length: count }, (_, i) => conversation(i)),
    nextCursor: null,
  };
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(typeof input === 'string' ? input : (input as Request).url ?? input);
    if (url.includes('/llm/conversations')) {
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('Not found', { status: 404 });
  });
}

function renderPane(props: { onNavigate?: () => void; embedMainNav?: boolean } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/ai']}>
        <AiConversationsSidebar {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AiConversationsSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUiStore.setState({ treeSidebarCollapsed: false, treeSidebarWidth: 282 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is a labelled complementary region in BOTH branches', async () => {
    mockList(3);
    const { unmount } = renderPane();
    const expanded = await screen.findByTestId('ai-conversations-sidebar');
    expect(expanded.tagName).toBe('ASIDE');
    expect(expanded).toHaveAttribute('aria-label', 'Conversations');
    unmount();

    useUiStore.setState({ treeSidebarCollapsed: true });
    renderPane();
    const collapsed = await screen.findByTestId('ai-conversations-sidebar');
    expect(collapsed.tagName).toBe('ASIDE');
    // Collapsing shrinks the region; it never deletes the landmark. (It does
    // not carry an account menu either — that lives in the app header since
    // #1377/#1378, on every route including this one.)
    expect(collapsed).toHaveAttribute('aria-label', 'Conversations');
    expect(within(collapsed).getByTestId('conversations-new-chat')).toBeInTheDocument();
    expect(within(collapsed).queryByRole('navigation', { name: 'Conversation history' })).toBeNull();
  });

  it('carries the rail resize contract verbatim', async () => {
    mockList(3);
    renderPane();
    const handle = await screen.findByRole('separator', { name: 'Resize conversations sidebar' });
    expect(handle).toHaveAttribute('aria-valuemin', '180');
    expect(handle).toHaveAttribute('aria-valuemax', '600');
    expect(handle).toHaveAttribute('aria-valuenow', '282');
    expect(handle).toHaveAttribute('aria-valuetext', '282 pixels');

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(useUiStore.getState().treeSidebarWidth).toBe(298);
    // 282, the store's own default and the tree's double-click reset — not 280.
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(useUiStore.getState().treeSidebarWidth).toBe(282);
  });

  // The desktop shell renders <MainNavChassisRail /> outside the workspace card
  // (AppLayout.tsx:509) and passes embedMainNav={false} to every sidebar in the
  // slot; a pane that painted the strip anyway would put a second Pages/AI/Graph
  // column beside it. The collapse control has to survive that branch, which is
  // why the tree keeps two of them (SidebarTreeView.tsx:875-883 and :1087-1096).
  it('drops the in-rail nav strip when the chassis owns it, and keeps Collapse', async () => {
    mockList(3);
    const { unmount } = renderPane();
    expect(await screen.findByRole('link', { name: /Pages/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument();
    unmount();

    renderPane({ embedMainNav: false });
    await screen.findByTestId('ai-conversations-sidebar');
    expect(screen.queryByRole('link', { name: /Pages/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument();
  });

  it('follows the shared collapse state (the "," shortcut is AppLayout\'s)', async () => {
    mockList(3);
    renderPane();
    expect(await screen.findByRole('navigation', { name: 'Conversation history' })).toBeInTheDocument();

    act(() => useUiStore.getState().toggleTreeSidebar());
    await waitFor(() => {
      expect(screen.queryByRole('navigation', { name: 'Conversation history' })).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute(
      'title',
      'Expand sidebar (,)',
    );
  });

  it('shows the filter only past the threshold', async () => {
    mockList(CONVERSATION_FILTER_THRESHOLD);
    const { unmount } = renderPane();
    await screen.findAllByRole('link');
    expect(screen.queryByLabelText('Filter conversations')).toBeNull();
    unmount();
    vi.restoreAllMocks();

    mockList(CONVERSATION_FILTER_THRESHOLD + 1);
    renderPane();
    await screen.findAllByRole('link');
    expect(await screen.findByLabelText('Filter conversations')).toHaveAttribute(
      'placeholder',
      'Filter conversations',
    );
  });

  it('filters the list, and Escape clears then blurs', async () => {
    mockList(9);
    renderPane();
    const filter = (await screen.findByLabelText('Filter conversations')) as HTMLInputElement;

    fireEvent.change(filter, { target: { value: 'Conversation 3' } });
    // Scoped to the conversation history landmark: the pane's own permanent
    // Pages/AI/Graph nav strip (MainNavStripExpanded) also renders three
    // `link`-role elements, unaffected by the filter, so an unscoped
    // getAllByRole('link') would count 4, not 1.
    const history = screen.getByRole('navigation', { name: 'Conversation history' });
    await waitFor(() => expect(within(history).getAllByRole('link')).toHaveLength(1));

    filter.focus();
    fireEvent.keyDown(filter, { key: 'Escape' });
    expect(filter.value).toBe('');
    expect(document.activeElement).toBe(filter);

    fireEvent.keyDown(filter, { key: 'Escape' });
    expect(document.activeElement).not.toBe(filter);
  });

  it('resets the filter when the pane collapses', async () => {
    mockList(9);
    renderPane();
    const filter = (await screen.findByLabelText('Filter conversations')) as HTMLInputElement;
    fireEvent.change(filter, { target: { value: 'Conversation 3' } });
    expect(filter.value).toBe('Conversation 3');

    act(() => useUiStore.getState().toggleTreeSidebar());
    act(() => useUiStore.getState().toggleTreeSidebar());

    await waitFor(() => {
      expect((screen.getByLabelText('Filter conversations') as HTMLInputElement).value).toBe('');
    });
  });

  it('New chat starts one and closes the drawer', async () => {
    mockList(3);
    const onNavigate = vi.fn();
    renderPane({ onNavigate });
    fireEvent.click(await screen.findByTestId('conversations-new-chat'));
    expect(startNewConversation).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('reports the loaded row count in the footer', async () => {
    mockList(3);
    renderPane();
    expect(await screen.findByText('3 conversations')).toBeInTheDocument();
  });

  it('leaves the footer count blank until the first page has loaded', async () => {
    // Never resolves — the pane stays in `query.isPending` for the life of
    // the test, the same state a freshly mounted pane is in for one tick.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    renderPane();
    await screen.findByTestId('ai-conversations-sidebar');
    expect(screen.getByTestId('conversations-footer-count')).toHaveTextContent('');
  });

  it('reflects the active filter in the footer count, not the loaded total', async () => {
    mockList(9);
    renderPane();
    const filter = (await screen.findByLabelText('Filter conversations')) as HTMLInputElement;
    fireEvent.change(filter, { target: { value: 'Conversation 3' } });

    await waitFor(() => {
      expect(screen.getByTestId('conversations-footer-count')).toHaveTextContent('1 conversation');
    });
  });

  it('fetches the list exactly once on mount', async () => {
    const fetchSpy = mockList(3);
    renderPane();
    await screen.findAllByRole('link');
    const listCalls = fetchSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('/llm/conversations'));
    expect(listCalls).toHaveLength(1);
  });
});
