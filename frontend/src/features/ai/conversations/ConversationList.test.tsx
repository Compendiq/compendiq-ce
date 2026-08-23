import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConversationListResponse, ConversationSummary } from '@compendiq/contracts';
import { ConversationList } from './ConversationList';
import { useConversationList } from './use-conversation-list';

const { purgeConversation } = vi.hoisted(() => ({ purgeConversation: vi.fn() }));

vi.mock('../AiContext', () => ({
  useAiContext: () => ({ purgeConversation }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

/**
 * A fixed clock, and item dates built from it with LOCAL calendar arithmetic
 * (`setDate`), so "yesterday" is the previous local calendar day in every time
 * zone rather than "24 hours earlier in UTC".
 */
const NOW = new Date('2026-08-18T12:00:00.000Z');
const now = () => NOW;

function daysAgo(n: number): string {
  const d = new Date(NOW);
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function conversation(over: Partial<ConversationSummary> & { id: string }): ConversationSummary {
  return {
    title: `Conversation ${over.id}`,
    titleSource: 'question',
    model: 'llama3',
    pageId: null,
    pageTitle: null,
    createdAt: daysAgo(0),
    updatedAt: daysAgo(0),
    ...over,
  };
}

const PAGE_ONE: ConversationListResponse = {
  items: [
    conversation({ id: 'a', title: 'Rollout plan', updatedAt: daysAgo(0) }),
    conversation({ id: 'b', title: 'Backup policy', updatedAt: daysAgo(1) }),
    conversation({ id: 'c', title: 'Sync stalls', updatedAt: daysAgo(10) }),
  ],
  nextCursor: null,
};

function mockPages(pages: ConversationListResponse[]) {
  let call = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(typeof input === 'string' ? input : (input as Request).url ?? input);
    if (url.includes('/llm/conversations')) {
      const page = pages[Math.min(call, pages.length - 1)]!;
      call += 1;
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('Not found', { status: 404 });
  });
}

function Harness({ filter = '' }: { filter?: string }) {
  const list = useConversationList();
  return <ConversationList list={list} filter={filter} now={now} />;
}

function renderList(props: { filter?: string } = {}, path = '/ai') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <div className="flex flex-col">
          <Harness {...props} />
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ConversationList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('groups rows by recency against a fixed clock, newest bucket first', async () => {
    mockPages([PAGE_ONE]);
    renderList();

    const nav = await screen.findByRole('navigation', { name: 'Conversation history' });
    const headings = within(nav)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(headings).toEqual(['Today', 'Yesterday', 'Previous 30 days']);

    // Each group's list is labelled by its own heading.
    const lists = within(nav).getAllByRole('list');
    expect(lists).toHaveLength(3);
    lists.forEach((ul, i) => {
      expect(ul).toHaveAttribute(
        'aria-labelledby',
        within(nav).getAllByRole('heading', { level: 3 })[i]!.id,
      );
    });
  });

  it('gives every row a title and no icon, and marks the open one', async () => {
    mockPages([PAGE_ONE]);
    renderList({}, '/ai/c/b');

    const links = await screen.findAllByRole('link');
    expect(links).toHaveLength(3);
    links.forEach((a) => {
      expect(a).toHaveAttribute('title');
      expect(a.querySelector('svg'), 'the tree carries no per-row icon and neither does this').toBeNull();
    });
    expect(screen.getByRole('link', { name: /Backup policy/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('is one tab stop, and ArrowDown travels', async () => {
    mockPages([PAGE_ONE]);
    renderList();

    const links = await screen.findAllByRole('link');
    expect(links.filter((a) => a.getAttribute('tabindex') === '0')).toHaveLength(1);

    links[0]!.focus();
    fireEvent.keyDown(links[0]!, { key: 'ArrowDown' });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getAllByRole('link')[1]);
    });
  });

  it('filters case-insensitively over the title, before grouping', async () => {
    mockPages([PAGE_ONE]);
    renderList({ filter: 'ROLL' });

    await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(1));
    expect(screen.getByRole('link', { name: /Rollout plan/ })).toBeInTheDocument();
    // Applied BEFORE grouping, so a group with no match disappears entirely.
    expect(screen.queryByRole('heading', { level: 3, name: 'Yesterday' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Today' })).toBeInTheDocument();
  });

  it('says so when nothing matches the filter', async () => {
    mockPages([PAGE_ONE]);
    renderList({ filter: 'zzzz' });
    expect(await screen.findByText('No matching conversations')).toBeInTheDocument();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('shows the first-run empty state, naming what is saved', async () => {
    mockPages([{ items: [], nextCursor: null }]);
    renderList();
    expect(
      await screen.findByText('Your conversations will appear here. Only Q&A is saved.'),
    ).toBeInTheDocument();
  });

  it('renders skeleton pulses on the first load, never the empty state', () => {
    mockPages([PAGE_ONE]);
    const { container } = renderList();
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(8);
    expect(
      screen.queryByText('Your conversations will appear here. Only Q&A is saved.'),
    ).not.toBeInTheDocument();
  });

  it('treats a failure with nothing cached as a failure, not an empty history', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ message: 'Bad gateway (HTTP 502)' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }),
    );
    renderList();

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/Couldn['’]t load conversations/)).toBeInTheDocument();
    expect(within(alert).getByText('Bad gateway (HTTP 502)')).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });

  it('degrades to an amber strip when a refresh fails over a cached list', async () => {
    mockPages([
      { items: PAGE_ONE.items, nextCursor: 'cursor-1' },
    ]);
    renderList();
    await screen.findAllByRole('link');

    vi.mocked(globalThis.fetch).mockImplementation(async () =>
      new Response(JSON.stringify({ message: 'Bad gateway (HTTP 502)' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }),
    );
    fireEvent.click(screen.getByTestId('conversations-show-more'));

    const strip = await screen.findByRole('status');
    expect(within(strip).getByText('Showing the last loaded conversations')).toBeInTheDocument();
    expect(within(strip).getByRole('button', { name: /Retry/ })).toBeInTheDocument();
    // Red is failure, amber is degraded — the rows are still there.
    expect(screen.getAllByRole('link')).toHaveLength(3);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('pages the server from Show more and retires the button at the end', async () => {
    mockPages([
      { items: [conversation({ id: 'a', title: 'First' })], nextCursor: 'cursor-1' },
      { items: [conversation({ id: 'b', title: 'Second' })], nextCursor: null },
    ]);
    renderList();

    await screen.findByRole('link', { name: /First/ });
    fireEvent.click(screen.getByTestId('conversations-show-more'));

    await screen.findByRole('link', { name: /Second/ });
    await waitFor(() => {
      expect(screen.queryByTestId('conversations-show-more')).not.toBeInTheDocument();
    });
    const listCalls = vi
      .mocked(globalThis.fetch)
      .mock.calls.map((c) => String(c[0]))
      .filter((u) => u.includes('/llm/conversations'));
    expect(listCalls).toHaveLength(2);
    expect(listCalls[1]).toContain('cursor=cursor-1');
  });

  it('keeps Show more available while a filter is active — it loads more rows INTO the filter', async () => {
    mockPages([
      { items: [conversation({ id: 'a', title: 'First' })], nextCursor: 'cursor-1' },
      { items: [conversation({ id: 'b', title: 'Second' })], nextCursor: null },
    ]);
    renderList({ filter: 'zzzz' });

    expect(await screen.findByText('No matching conversations')).toBeInTheDocument();
    expect(screen.getByTestId('conversations-show-more')).toBeInTheDocument();
  });
});
