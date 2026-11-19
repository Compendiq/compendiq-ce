import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotesInspectorPanel } from './NotesInspectorPanel';
import { CommentsSidebar } from './CommentsSidebar';
import { CommentPopover } from './CommentPopover';

it('retains API-nested replies across consumers, refetch, remount and reply creation', async () => {
  const replies = [{ id: 2, parentId: 1, username: 'reader', body: 'Persisted reply', createdAt: new Date().toISOString() }];
  const fetchMock = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
    if (options?.method === 'POST') {
      const body = JSON.parse(String(options.body));
      expect(body.parentId).toBe(1);
      replies.push({ id: 3, parentId: 1, username: 'reader', body: body.body, createdAt: new Date().toISOString() });
      return Response.json(replies[1], { status: 201 });
    }
    return Response.json({ comments: [{ id: 1, parentId: null, username: 'author', body: 'Parent', createdAt: new Date().toISOString(), isResolved: false, replies }], total: 1 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = () => (
    <QueryClientProvider client={client}>
      <NotesInspectorPanel pageId="42" />
      <CommentsSidebar pageId="42" />
      <CommentPopover pageId="42" />
    </QueryClientProvider>
  );
  const mounted = render(view());
  const thread = await screen.findByTestId('comment-thread-1');
  expect(thread).toHaveTextContent('Persisted reply');
  expect(thread).toHaveTextContent('1 reply');
  fireEvent.click(screen.getByTestId('comments-toggle'));
  expect(within(screen.getByTestId('comments-sidebar')).getByText('Persisted reply')).toBeInTheDocument();
  act(() => window.dispatchEvent(new CustomEvent('compendiq:comment-select', { detail: { commentId: '1', rect: { top: 10, left: 10 } } })));
  expect(within(await screen.findByTestId('comment-popover-content')).getByText('Persisted reply')).toBeInTheDocument();
  await act(async () => { await client.invalidateQueries({ queryKey: ['comments', '42'] }); });
  expect(thread).toHaveTextContent('Persisted reply');
  mounted.unmount();
  render(view());
  expect(await screen.findByTestId('comment-thread-1')).toHaveTextContent('Persisted reply');
  fireEvent.click(screen.getByTestId('reply-toggle-1'));
  fireEvent.change(screen.getByPlaceholderText('Write a reply...'), { target: { value: 'New reply' } });
  fireEvent.click(screen.getByTestId('comment-submit'));
  await waitFor(() => expect(screen.getByTestId('comment-thread-1')).toHaveTextContent('New reply'));
  expect(screen.getByTestId('comment-thread-1')).toHaveTextContent('2 replies');
});

afterEach(() => { vi.unstubAllGlobals(); });
