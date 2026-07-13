import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import {
  useTemplates,
  useComments,
  useTrash,
  useRestorePage,
  useNotifications,
  useUnreadCount,
  useMarkAllRead,
  useSearch,
  useTrending,
  useLocalSpaces,
  useRoles,
  useVerifyPage,
  useSubmitFeedback,
  useImportMarkdown,
  useExportPdf,
} from './use-standalone';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

function mockFetch(data: unknown, ok = true) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(data), {
      status: ok ? 200 : 500,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

describe('use-standalone hooks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- Templates ----

  describe('useTemplates', () => {
    it('fetches templates list', async () => {
      // GET /api/templates returns a bare array (see backend templates.ts),
      // not an { items, total } envelope.
      const mock = mockFetch([{ id: 1, title: 'Template A' }]);
      const { result } = renderHook(() => useTemplates(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toHaveLength(1);
      expect(result.current.data?.[0].title).toBe('Template A');
      expect(mock).toHaveBeenCalledTimes(1);
    });

    it('passes scope and category as query params', async () => {
      const mock = mockFetch([]);
      const { result } = renderHook(
        () => useTemplates({ scope: 'global', category: 'guide' }),
        { wrapper: createWrapper() },
      );
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      const url = (mock.mock.calls[0][0] as string);
      expect(url).toContain('scope=global');
      expect(url).toContain('category=guide');
    });
  });

  // ---- Comments ----

  describe('useComments', () => {
    it('fetches comments for a page', async () => {
      mockFetch({ items: [{ id: 1, body: 'Nice article' }], total: 1 });
      const { result } = renderHook(() => useComments(42), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.items).toHaveLength(1);
    });
  });

  // ---- Trash ----

  describe('useTrash', () => {
    it('fetches trashed pages', async () => {
      const mock = mockFetch({ items: [{ id: '1', title: 'Deleted Page' }], total: 1 });
      const { result } = renderHook(() => useTrash(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.items).toHaveLength(1);
      const [url] = mock.mock.calls[0] as [string];
      expect(url).toContain('/pages/trash');
    });
  });

  describe('useRestorePage', () => {
    it('posts restore request', async () => {
      const mock = mockFetch({ message: 'restored' });
      const { result } = renderHook(() => useRestorePage(), { wrapper: createWrapper() });
      await result.current.mutateAsync('7');
      const [url, opts] = mock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/pages/7/restore');
      expect(opts.method).toBe('POST');
    });
  });

  // ---- Notifications ----

  describe('useNotifications', () => {
    it('fetches notifications', async () => {
      mockFetch({ items: [{ id: 1, message: 'You were mentioned' }], total: 1 });
      const { result } = renderHook(() => useNotifications(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.items).toHaveLength(1);
    });
  });

  describe('useUnreadCount', () => {
    it('fetches unread count', async () => {
      mockFetch({ count: 5 });
      const { result } = renderHook(() => useUnreadCount(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.count).toBe(5);
    });
  });

  describe('useMarkAllRead', () => {
    it('sends mark-all-read request', async () => {
      const mock = mockFetch({ message: 'ok' });
      const { result } = renderHook(() => useMarkAllRead(), { wrapper: createWrapper() });
      await result.current.mutateAsync();
      const [url, opts] = mock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/notifications/read-all');
      expect(opts.method).toBe('PUT');
    });
  });

  // ---- Search ----

  describe('useSearch', () => {
    it('fetches search results when query is long enough', async () => {
      mockFetch({ items: [{ id: 1, title: 'Redis Guide' }], total: 1 });
      const { result } = renderHook(
        () => useSearch({ q: 'redis' }),
        { wrapper: createWrapper() },
      );
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.items).toHaveLength(1);
    });

    it('does not fetch when query is too short', () => {
      mockFetch({});
      const { result } = renderHook(
        () => useSearch({ q: 'r' }),
        { wrapper: createWrapper() },
      );
      expect(result.current.isFetching).toBe(false);
    });
  });

  // ---- Analytics ----

  describe('useTrending', () => {
    it('fetches trending pages', async () => {
      mockFetch({ items: [{ id: 1, title: 'Popular', viewCount: 100, trend: 'up' }] });
      const { result } = renderHook(() => useTrending(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.items[0].trend).toBe('up');
    });
  });

  // ---- Local Spaces ----

  describe('useLocalSpaces', () => {
    it('fetches local spaces', async () => {
      mockFetch({ items: [{ key: 'MY', name: 'My Space' }] });
      const { result } = renderHook(() => useLocalSpaces(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.items).toHaveLength(1);
    });
  });

  // ---- RBAC ----

  describe('useRoles', () => {
    it('fetches roles', async () => {
      mockFetch({ items: [{ id: 1, name: 'admin', permissions: ['all'] }] });
      const { result } = renderHook(() => useRoles(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.items[0].name).toBe('admin');
    });
  });

  // ---- Verification ----

  describe('useVerifyPage', () => {
    it('sends POST verify request without body (#357)', async () => {
      const mock = mockFetch({ success: true });
      const { result } = renderHook(() => useVerifyPage(), { wrapper: createWrapper() });
      await result.current.mutateAsync({ pageId: 42 });
      const [url, opts] = mock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/pages/42/verify');
      expect(opts.method).toBe('POST');
      // Backend ignores the body; we don't send one.
      expect(opts.body).toBeUndefined();
    });
  });

  // ---- Feedback ----

  describe('useSubmitFeedback', () => {
    it('submits feedback with isHelpful field', async () => {
      const mock = mockFetch({ id: 1 });
      const { result } = renderHook(() => useSubmitFeedback(10), { wrapper: createWrapper() });
      await result.current.mutateAsync({ isHelpful: true });
      const [url, opts] = mock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/pages/10/feedback');
      expect(opts.method).toBe('POST');
      const body = JSON.parse(opts.body as string);
      expect(body).toEqual({ isHelpful: true });
    });

    it('submits not-helpful feedback with comment', async () => {
      const mock = mockFetch({ id: 2 });
      const { result } = renderHook(() => useSubmitFeedback(10), { wrapper: createWrapper() });
      await result.current.mutateAsync({ isHelpful: false, comment: 'outdated info' });
      const [, opts] = mock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string);
      expect(body).toEqual({ isHelpful: false, comment: 'outdated info' });
    });
  });

  // ---- Import/Export ----

  describe('useImportMarkdown', () => {
    it('posts to /pages/import and returns the batch envelope (id from articles[0])', async () => {
      // The backend registers POST /api/pages/import (not /pages/import/markdown)
      // and returns { imported, total, articles:[{ id: 'standalone-<uuid>', ... }] }.
      const mock = mockFetch({
        imported: 1,
        total: 1,
        articles: [{ id: 'standalone-abc', title: 'Hello', success: true }],
      });
      const { result } = renderHook(() => useImportMarkdown(), { wrapper: createWrapper() });
      const data = await result.current.mutateAsync({ markdown: '# Hello', title: 'Hello' });
      const [url, opts] = mock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/pages/import');
      expect(url).not.toContain('/pages/import/markdown');
      expect(opts.method).toBe('POST');
      // spaceKey is ignored by the backend (standalone always lands in _standalone),
      // so it must not be sent.
      const body = JSON.parse(opts.body as string) as Record<string, unknown>;
      expect(body.spaceKey).toBeUndefined();
      // The created page id is the synthetic confluence id from articles[0].
      expect(data.articles[0]!.id).toBe('standalone-abc');
    });
  });

  describe('useExportPdf', () => {
    it('sends export request and returns a blob', async () => {
      const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
      const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(pdfBytes, {
          status: 200,
          headers: { 'Content-Type': 'application/pdf' },
        }),
      );
      const { result } = renderHook(() => useExportPdf(), { wrapper: createWrapper() });
      const blob = await result.current.mutateAsync(42);
      const [url, opts] = mock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/pages/42/export/pdf');
      expect(opts.method).toBe('POST');
      expect(blob.size).toBeGreaterThan(0);
    });
  });
});
