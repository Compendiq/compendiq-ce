import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { TrashListResponse } from '@compendiq/contracts';
import { apiFetch, ApiError, refreshAccessTokenOnce } from '../lib/api';
import { useAuthStore } from '../../stores/auth-store';

// ======== Templates ========

export function useTemplates(filters?: { scope?: string; category?: string }) {
  return useQuery({
    queryKey: ['templates', filters],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filters?.scope) params.set('scope', filters.scope);
      if (filters?.category) params.set('category', filters.category);
      const qs = params.toString();
      // GET /api/templates returns a bare array, not an { items, total } envelope.
      return apiFetch<Template[]>(`/templates${qs ? `?${qs}` : ''}`);
    },
  });
}

export function useUseTemplate() {
  return useMutation({
    mutationFn: (templateId: number) =>
      apiFetch<{ bodyJson: string; bodyHtml: string }>(`/templates/${templateId}/use`, {
        method: 'POST',
      }),
  });
}

// ======== Comments ========

export function useComments(pageId: number) {
  return useQuery({
    queryKey: ['comments', pageId],
    queryFn: () => apiFetch<{ items: Comment[]; total: number }>(`/pages/${pageId}/comments`),
    enabled: pageId > 0,
  });
}

// ======== Trash ========

export function useTrash() {
  return useQuery({
    queryKey: ['trash'],
    queryFn: () => apiFetch<TrashListResponse>('/pages/trash'),
  });
}

export function useRestorePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pageId: string) =>
      apiFetch(`/pages/${pageId}/restore`, {
        method: 'POST',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trash'] });
      queryClient.invalidateQueries({ queryKey: ['pages'] });
    },
  });
}

// ======== Notifications ========

export function useNotifications(filters?: { unread?: boolean }) {
  return useQuery({
    queryKey: ['notifications', filters],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filters?.unread !== undefined) params.set('unread', String(filters.unread));
      const qs = params.toString();
      return apiFetch<{ items: Notification[]; total: number }>(`/notifications${qs ? `?${qs}` : ''}`);
    },
  });
}

export function useUnreadCount() {
  return useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => apiFetch<{ count: number }>('/notifications/unread-count'),
    refetchInterval: 30_000, // poll every 30s
  });
}

export function useMarkAllRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch('/notifications/read-all', {
        method: 'PUT',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

// ======== Verification ========

/**
 * Mark a page as human-reviewed (#357). Backend exposes POST
 * /api/pages/:id/verify and ignores the body — the previous PUT call with a
 * `{ verified: boolean }` body was the source of the generic "Failed to
 * verify page" toast (404 from Fastify, no PUT route registered).
 */
export function useVerifyPage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ pageId }: { pageId: number }) =>
      apiFetch(`/pages/${pageId}/verify`, { method: 'POST' }),
    onSuccess: (_data, { pageId }) => {
      queryClient.invalidateQueries({ queryKey: ['pages', String(pageId)] });
    },
  });
}

// ======== Feedback ========

export function useSubmitFeedback(pageId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { isHelpful: boolean; comment?: string }) =>
      apiFetch(`/pages/${pageId}/feedback`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feedback', pageId] });
    },
  });
}

// ======== Search ========

export function useSearch(params: { q: string; source?: string; spaceKey?: string; page?: number }) {
  const { q, source, spaceKey, page } = params;
  return useQuery({
    queryKey: ['search', params],
    queryFn: () => {
      const sp = new URLSearchParams();
      sp.set('q', q);
      if (source) sp.set('source', source);
      if (spaceKey) sp.set('spaceKey', spaceKey);
      if (page) sp.set('page', String(page));
      return apiFetch<{ items: SearchResult[]; total: number }>(`/search?${sp}`);
    },
    enabled: q.length >= 2,
  });
}

// ======== Analytics ========

export function useTrending() {
  return useQuery({
    queryKey: ['analytics', 'trending'],
    queryFn: () => apiFetch<{ items: TrendingPage[] }>('/analytics/trending'),
    staleTime: 60_000,
  });
}

// ======== PDF Export ========

/**
 * Fetch a PDF blob from the backend. Uses `fetch` directly instead of
 * `apiFetch` because `apiFetch` only handles JSON responses — binary
 * content types like `application/pdf` would return `undefined`.
 */
async function fetchPdfBlob(url: string, init?: RequestInit): Promise<Blob> {
  const { accessToken } = useAuthStore.getState();
  const headers = new Headers(init?.headers);
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);

  let res = await fetch(url, { ...init, headers, credentials: 'include' });

  if (res.status === 401) {
    const newToken = await refreshAccessTokenOnce();
    if (newToken) {
      headers.set('Authorization', `Bearer ${newToken}`);
      res = await fetch(url, { ...init, headers, credentials: 'include' });
    } else {
      useAuthStore.getState().clearAuth();
      throw new ApiError(401, 'Session expired');
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new ApiError(res.status, body.message ?? 'PDF export failed');
  }

  return res.blob();
}

export function useExportPdf() {
  return useMutation({
    mutationFn: (pageId: number) =>
      fetchPdfBlob(`/api/pages/${pageId}/export/pdf`, { method: 'POST' }),
  });
}

// ======== Markdown Import ========

export function useImportMarkdown() {
  const queryClient = useQueryClient();
  // Backend route is POST /api/pages/import (see backend pages-import.ts); it
  // returns a batch envelope and always files standalone imports under the
  // '_standalone' space, so spaceKey is not accepted.
  return useMutation({
    mutationFn: (data: { markdown: string; title: string }) =>
      apiFetch<{
        imported: number;
        total: number;
        articles: { id: string; title: string; success: boolean }[];
      }>('/pages/import', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pages'] });
    },
  });
}

// ======== Local Spaces ========

export function useLocalSpaces() {
  return useQuery({
    queryKey: ['local-spaces'],
    queryFn: () => apiFetch<LocalSpace[]>('/spaces/local'),
  });
}

export function useCreateLocalSpace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { key: string; name: string; description?: string; icon?: string }) =>
      apiFetch<LocalSpace>('/spaces/local', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['local-spaces'] });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
    },
  });
}

export function useUpdateLocalSpace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ key, ...data }: { key: string; name?: string; description?: string; icon?: string }) =>
      apiFetch(`/spaces/local/${key}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['local-spaces'] });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
    },
  });
}

export function useDeleteLocalSpace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (key: string) =>
      apiFetch(`/spaces/local/${key}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['local-spaces'] });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
    },
  });
}

export function useReorderPage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, sortOrder }: { id: string; sortOrder: number }) =>
      apiFetch(`/pages/${id}/reorder`, {
        method: 'PUT',
        body: JSON.stringify({ sortOrder }),
      }),
    onSuccess: () => {
      // ['pages'] covers the sidebar tree query (['pages', 'tree', …]). The old
      // extra ['space-tree'] invalidation matched no query — dead key (#959).
      queryClient.invalidateQueries({ queryKey: ['pages'] });
    },
  });
}

// ======== RBAC ========

export function useRoles() {
  return useQuery({
    queryKey: ['rbac', 'roles'],
    queryFn: () => apiFetch<{ items: Role[] }>('/rbac/roles'),
  });
}

// ======== Types ========

interface Template {
  id: number;
  title: string;
  bodyJson: string;
  bodyHtml: string;
  category: string | null;
  isGlobal: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface Comment {
  id: number;
  pageId: number;
  authorId: string;
  authorName: string;
  body: string;
  parentId: number | null;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
  reactions: { emoji: string; count: number; userReacted: boolean }[];
}

// Trash items are typed by TrashListResponse from @compendiq/contracts.

interface Notification {
  id: number;
  type: string;
  message: string;
  pageId: number | null;
  read: boolean;
  createdAt: string;
}

interface SearchResult {
  id: number;
  title: string;
  excerpt: string;
  source: 'confluence' | 'local';
  spaceKey: string;
  score: number;
}

interface TrendingPage {
  id: number;
  title: string;
  viewCount: number;
  trend: 'up' | 'down' | 'stable';
}

interface LocalSpace {
  key: string;
  name: string;
  description: string | null;
  icon: string | null;
  pageCount: number;
  createdBy: string | null;
  createdAt: string;
  source: 'local';
}

interface Role {
  id: number;
  name: string;
  permissions: string[];
}
