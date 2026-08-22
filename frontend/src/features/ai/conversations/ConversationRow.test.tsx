import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ConversationSummary } from '@compendiq/contracts';
import { ConversationRow } from './ConversationRow';

const { purgeConversation } = vi.hoisted(() => ({ purgeConversation: vi.fn() }));

// The mutation hooks reach AiContext for `purgeConversation` — that is the row's
// boundary to the shell, not an internal component, so it is stubbed here
// (Global Constraints; the same allowance Task 9's hook tests use).
vi.mock('../AiContext', () => ({
  useAiContext: () => ({ purgeConversation }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const CONVERSATION: ConversationSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Rollout plan',
  titleSource: 'question',
  model: 'llama3',
  pageId: null,
  pageTitle: null,
  createdAt: '2026-08-18T09:00:00.000Z',
  updatedAt: '2026-08-18T09:00:00.000Z',
};

const DOCK_CONVERSATION: ConversationSummary = {
  ...CONVERSATION,
  id: '22222222-2222-4222-8222-222222222222',
  title: 'Why does sync stall?',
  pageId: 42,
  pageTitle: 'Sync runbook',
};

/** Radix menus open on pointerdown; fire click too so either primitive works. */
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
  fireEvent.click(trigger);
}

function mockApi() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (/\/api\/llm\/conversations\/[^/]+$/.test(url) && method === 'PATCH') {
      const title = (JSON.parse(String(init?.body)) as { title: string }).title;
      return new Response(JSON.stringify({ ...CONVERSATION, title }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (/\/api\/llm\/conversations\/[^/]+$/.test(url) && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    return new Response('Not found', { status: 404 });
  });
}

const onRowFocus = vi.fn();
const onRowKeyDown = vi.fn();
const onNavigate = vi.fn();

function renderRow(
  conversation: ConversationSummary = CONVERSATION,
  path = '/ai',
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <ul>
          <ConversationRow
            conversation={conversation}
            tabIndex={0}
            onRowFocus={onRowFocus}
            onRowKeyDown={onRowKeyDown}
            onNavigate={onNavigate}
          />
        </ul>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const link = () => screen.getByRole('link');
const kebab = () => screen.getByRole('button', { name: `Actions for ${CONVERSATION.title}` });

describe('ConversationRow', () => {
  let fetchSpy: ReturnType<typeof mockApi>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = mockApi();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('carries the full title in `title` — the 320px drawer truncates, this is the recovery path', () => {
    renderRow();
    expect(link()).toHaveAttribute('title', 'Rollout plan');
    expect(link()).toHaveAttribute('data-row-id', CONVERSATION.id);
    expect(link()).toHaveAttribute('href', `/ai/c/${CONVERSATION.id}`);
  });

  it('marks the open conversation with aria-current="page" and nothing else with it', () => {
    const { unmount } = renderRow(CONVERSATION, `/ai/c/${CONVERSATION.id}`);
    expect(link()).toHaveAttribute('aria-current', 'page');
    unmount();

    renderRow(CONVERSATION, '/ai');
    expect(link()).not.toHaveAttribute('aria-current');
  });

  it('renders no per-row icon', () => {
    renderRow();
    expect(link().querySelector('svg')).toBeNull();
  });

  it('renders the page chip only for a dock-origin row, with an sr-only "Page: " prefix', () => {
    const { unmount } = renderRow();
    expect(link().querySelector('[title="Sync runbook"]')).toBeNull();
    unmount();

    renderRow(DOCK_CONVERSATION);
    const chip = link().querySelector<HTMLElement>('[title="Sync runbook"]');
    expect(chip).not.toBeNull();
    // The prefix is real text, not an aria-label on a span (prohibited naming),
    // so the link's accessible name reads "<title> Page: <page>".
    expect(chip!.textContent).toBe('Page: Sync runbook');
    expect(chip!.querySelector('.sr-only')?.textContent).toBe('Page: ');
    expect(chip!.className).toContain('max-w-[45%]');
  });

  it('names the kebab after the row it acts on', () => {
    renderRow();
    expect(kebab()).toHaveAttribute('aria-label', 'Actions for Rollout plan');
    expect(kebab()).toHaveAttribute('tabindex', '-1');
    expect(kebab().className).toContain('size-6');
  });

  it('hides the kebab until hover/focus, and never on the active row', () => {
    const { unmount } = renderRow(CONVERSATION, '/ai');
    expect(kebab().className).toContain('opacity-0');
    expect(kebab().className).toContain('group-focus-within/row:opacity-100');
    unmount();

    renderRow(CONVERSATION, `/ai/c/${CONVERSATION.id}`);
    expect(kebab().className).not.toContain('opacity-0');
  });

  it('ArrowRight reaches the kebab and ArrowLeft returns to the link', () => {
    renderRow();
    link().focus();
    fireEvent.keyDown(link(), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(kebab());

    fireEvent.keyDown(kebab(), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(link());
  });

  it('forwards other keys to the list handler, but never a key pressed on the kebab', () => {
    renderRow();
    fireEvent.keyDown(link(), { key: 'ArrowDown' });
    expect(onRowKeyDown).toHaveBeenCalledTimes(1);
    expect(onRowKeyDown.mock.calls[0]![1]).toBe(CONVERSATION.id);

    onRowKeyDown.mockClear();
    // ArrowDown on the kebab is Radix's Trigger contract; the list must not move.
    fireEvent.keyDown(kebab(), { key: 'ArrowDown' });
    expect(onRowKeyDown).not.toHaveBeenCalled();
  });

  it('opens the menu on Shift+F10', async () => {
    renderRow();
    fireEvent.keyDown(link(), { key: 'F10', shiftKey: true });
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('keeps arrows pressed inside the open (portalled) menu away from the list', async () => {
    renderRow();
    openMenu(kebab());
    const rename = await screen.findByRole('menuitem', { name: 'Rename' });
    onRowKeyDown.mockClear();

    // Radix portals content out of the DOM but not out of the React tree and
    // replays events up it, so this keydown really does reach the <li>'s handler.
    fireEvent.keyDown(rename, { key: 'ArrowDown' });
    expect(onRowKeyDown).not.toHaveBeenCalled();
  });

  it('uses the one destructive treatment on Delete', async () => {
    renderRow();
    openMenu(kebab());
    const del = await screen.findByRole('menuitem', { name: 'Delete' });
    expect(del.className).toContain('nm-action-destructive');
    expect(del.className).not.toContain('hover:bg-destructive/');
  });

  it('Delete confirms, sends the DELETE, purges the thread and reports it', async () => {
    renderRow();
    openMenu(kebab());
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));

    const dialog = await screen.findByTestId('confirm-dialog');
    expect(within(dialog).getByText('Delete conversation?')).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        '"Rollout plan" will be permanently deleted. This can\'t be undone.',
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

    await waitFor(() => {
      expect(purgeConversation).toHaveBeenCalledWith(CONVERSATION.id);
    });
    const deletes = fetchSpy.mock.calls.filter(
      ([, init]) => (init?.method ?? '').toUpperCase() === 'DELETE',
    );
    expect(deletes).toHaveLength(1);
    expect(String(deletes[0]![0])).toContain(`/llm/conversations/${CONVERSATION.id}`);
    expect(toast.success).toHaveBeenCalledWith('Conversation deleted');
  });

  it('cancelling the confirm sends nothing', async () => {
    renderRow();
    openMenu(kebab());
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(await screen.findByTestId('confirm-dialog-cancel'));

    await waitFor(() => {
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    });
    expect(
      fetchSpy.mock.calls.some(([, init]) => (init?.method ?? '').toUpperCase() === 'DELETE'),
    ).toBe(false);
  });

  async function startRename() {
    openMenu(kebab());
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    return screen.findByRole('textbox', { name: 'Rename Rollout plan' });
  }

  it('renames in place on Enter and never inside a role="menu"', async () => {
    renderRow();
    const input = await startRename();
    expect(input.closest('[role="menu"]')).toBeNull();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'Rollout plan v2' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      const patches = fetchSpy.mock.calls.filter(
        ([, init]) => (init?.method ?? '').toUpperCase() === 'PATCH',
      );
      expect(patches).toHaveLength(1);
      expect(JSON.parse(String(patches[0]![1]!.body))).toEqual({ title: 'Rollout plan v2' });
    });
    await waitFor(() => expect(document.activeElement).toBe(link()));
  });

  it('commits on blur', async () => {
    renderRow();
    const input = await startRename();
    fireEvent.change(input, { target: { value: 'Renamed by blur' } });
    fireEvent.blur(input);

    await waitFor(() => {
      const patches = fetchSpy.mock.calls.filter(
        ([, init]) => (init?.method ?? '').toUpperCase() === 'PATCH',
      );
      expect(patches).toHaveLength(1);
      expect(JSON.parse(String(patches[0]![1]!.body))).toEqual({ title: 'Renamed by blur' });
    });
  });

  it('Escape cancels, does not commit, and does not reach a document keydown listener', async () => {
    const documentListener = vi.fn();
    document.addEventListener('keydown', documentListener);
    try {
      renderRow();
      const input = await startRename();
      fireEvent.change(input, { target: { value: 'Discard me' } });
      fireEvent.keyDown(input, { key: 'Escape' });

      await waitFor(() => expect(document.activeElement).toBe(link()));
      expect(documentListener).not.toHaveBeenCalled();
      expect(
        fetchSpy.mock.calls.some(([, init]) => (init?.method ?? '').toUpperCase() === 'PATCH'),
      ).toBe(false);
    } finally {
      document.removeEventListener('keydown', documentListener);
    }
  });

  it('treats an empty or unchanged title as a silent cancel', async () => {
    renderRow();
    let input = await startRename();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('link')).toBeInTheDocument());

    input = await startRename();
    fireEvent.change(input, { target: { value: '  Rollout plan  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('link')).toBeInTheDocument());

    expect(
      fetchSpy.mock.calls.some(([, init]) => (init?.method ?? '').toUpperCase() === 'PATCH'),
    ).toBe(false);
  });

  it('stays in edit mode and reports a failed rename', async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({ message: 'Conversation not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    renderRow();
    const input = await startRename();
    fireEvent.change(input, { target: { value: 'Nope' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Conversation not found'));
    expect(screen.getByRole('textbox', { name: 'Rename Rollout plan' })).toBeInTheDocument();
  });

  it('closes the drawer through onNavigate when the row is clicked', () => {
    renderRow();
    fireEvent.click(link());
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('a blur while a rename PATCH is still pending does not send a second one', async () => {
    let resolvePatch: (() => void) | undefined;
    fetchSpy.mockImplementation(
      (input, init) =>
        new Promise((resolve) => {
          const method = (init?.method ?? 'GET').toUpperCase();
          if (method === 'PATCH') {
            resolvePatch = () =>
              resolve(
                new Response(JSON.stringify({ ...CONVERSATION, title: 'In flight' }), {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                }),
              );
            return;
          }
          resolve(new Response('Not found', { status: 404 }));
        }),
    );

    renderRow();
    const input = await startRename();
    fireEvent.change(input, { target: { value: 'In flight' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    // Focus moves while the request is in flight — the blur this triggers must
    // not issue a second PATCH.
    fireEvent.blur(input);

    resolvePatch?.();
    await waitFor(() => expect(document.activeElement).toBe(link()));

    const patches = fetchSpy.mock.calls.filter(
      ([, init]) => (init?.method ?? '').toUpperCase() === 'PATCH',
    );
    expect(patches).toHaveLength(1);
  });
});
