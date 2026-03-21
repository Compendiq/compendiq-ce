import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';

// ======== Templates ========

export function useTemplates(filters?: { scope?: string; category?: string }) {
  return useQuery({
    queryKey: ['templates', filters],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filters?.scope) params.set('scope', filters.scope);
      if (filters?.category) params.set('category', filters.category);
      const qs = params.toString();
      return apiFetch<{ items: Template[]; total: number }>(`/templates${qs ? `?${qs}` : ''}`);
    },
  });
}

export function useTemplate(id: number) {
  return useQuery({
    queryKey: ['templates', id],
    queryFn: () => apiFetch<Template>(`/templates/${id}`),
    enabled: id > 0,
  });
}

export function useCreateTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      title: string;
      bodyJson: string;
      bodyHtml: string;
      category?: string;
      isGlobal?: boolean;
    }) =>
      apiFetch<Template>('/templates', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates'] });
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

export function useCreateComment(pageId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { body: string; parentId?: number }) =>
      apiFetch<Comment>(`/pages/${pageId}/comments`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['comments', pageId] });
    },
  });
}

export function useResolveComment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ commentId, resolved }: { commentId: number; resolved: boolean }) =>
      apiFetch(`/comments/${commentId}/resolve`, {
        method: 'PUT',
        body: JSON.stringify({ resolved }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['comments'] });
    },
  });
}

export function useAddReaction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ commentId, emoji }: { commentId: number; emoji: string }) =>
      apiFetch(`/comments/${commentId}/reactions`, {
        method: 'POST',
        body: JSON.stringify({ emoji }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['comments'] });
    },
  });
}

// ======== Drafts ========

export function useDraft(pageId: number) {
  return useQuery({
    queryKey: ['drafts', pageId],
    queryFn: () => apiFetch<Draft>(`/pages/${pageId}/draft`),
    enabled: pageId > 0,
  });
}

export function useSaveDraft(pageId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { bodyJson: string; bodyHtml: string }) =>
      apiFetch<Draft>(`/pages/${pageId}/draft`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['drafts', pageId] });
    },
  });
}

export function usePublishDraft(pageId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch(`/pages/${pageId}/draft/publish`, {
        method: 'POST',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['drafts', pageId] });
      queryClient.invalidateQueries({ queryKey: ['pages', String(pageId)] });
      queryClient.invalidateQueries({ queryKey: ['pages'] });
    },
  });
}

export function useDiscardDraft(pageId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch(`/pages/${pageId}/draft`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['drafts', pageId] });
    },
  });
}

// ======== Trash ========

export function useTrash() {
  return useQuery({
    queryKey: ['trash'],
    queryFn: () => apiFetch<{ items: TrashItem[]; total: number }>('/trash'),
  });
}

export function useRestorePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pageId: number) =>
      apiFetch(`/trash/${pageId}/restore`, {
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

export function useMarkRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (notificationId: number) =>
      apiFetch(`/notifications/${notificationId}/read`, {
        method: 'PUT',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
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

export function useVerifyPage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ pageId, verified }: { pageId: number; verified: boolean }) =>
      apiFetch(`/pages/${pageId}/verify`, {
        method: 'PUT',
        body: JSON.stringify({ verified }),
      }),
    onSuccess: (_data, { pageId }) => {
      queryClient.invalidateQueries({ queryKey: ['pages', String(pageId)] });
    },
  });
}

export function useSetPageOwner() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ pageId, ownerId }: { pageId: number; ownerId: string }) =>
      apiFetch(`/pages/${pageId}/owner`, {
        method: 'PUT',
        body: JSON.stringify({ ownerId }),
      }),
    onSuccess: (_data, { pageId }) => {
      queryClient.invalidateQueries({ queryKey: ['pages', String(pageId)] });
    },
  });
}

export function useVerificationHealth() {
  return useQuery({
    queryKey: ['verification', 'health'],
    queryFn: () => apiFetch<VerificationHealth>('/verification/health'),
    staleTime: 60_000,
  });
}

// ======== Feedback ========

export function usePageFeedback(pageId: number) {
  return useQuery({
    queryKey: ['feedback', pageId],
    queryFn: () => apiFetch<PageFeedbackResponse>(`/pages/${pageId}/feedback`),
    enabled: pageId > 0,
  });
}

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

// ======== Knowledge Requests ========

export function useKnowledgeRequests(filters?: { status?: string }) {
  return useQuery({
    queryKey: ['knowledge-requests', filters],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filters?.status) params.set('status', filters.status);
      const qs = params.toString();
      return apiFetch<{ items: KnowledgeRequest[]; total: number }>(`/knowledge-requests${qs ? `?${qs}` : ''}`);
    },
  });
}

export function useCreateKnowledgeRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { title: string; description: string; priority?: string }) =>
      apiFetch<KnowledgeRequest>('/knowledge-requests', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge-requests'] });
    },
  });
}

export function useFulfillRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ requestId, pageId }: { requestId: number; pageId: number }) =>
      apiFetch(`/knowledge-requests/${requestId}/fulfill`, {
        method: 'PUT',
        body: JSON.stringify({ pageId }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge-requests'] });
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

export function useSearchSuggestions(prefix: string) {
  return useQuery({
    queryKey: ['search', 'suggestions', prefix],
    queryFn: () => apiFetch<{ suggestions: string[] }>(`/search/suggestions?prefix=${encodeURIComponent(prefix)}`),
    enabled: prefix.length >= 2,
    staleTime: 10_000,
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

export function useContentQuality() {
  return useQuery({
    queryKey: ['analytics', 'content-quality'],
    queryFn: () => apiFetch<ContentQualityReport>('/analytics/content-quality'),
    staleTime: 60_000,
  });
}

export function useContentGaps() {
  return useQuery({
    queryKey: ['analytics', 'content-gaps'],
    queryFn: () => apiFetch<{ items: ContentGap[] }>('/analytics/content-gaps'),
    staleTime: 60_000,
  });
}

// ======== PDF Export ========

export function useExportPdf() {
  return useMutation({
    mutationFn: (pageId: number) =>
      apiFetch<Blob>(`/pages/${pageId}/export/pdf`, {
        method: 'POST',
      }),
  });
}

export function useBatchExportPdf() {
  return useMutation({
    mutationFn: (pageIds: number[]) =>
      apiFetch<Blob>('/pages/export/pdf', {
        method: 'POST',
        body: JSON.stringify({ pageIds }),
      }),
  });
}

// ======== Markdown Import ========

export function useImportMarkdown() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { markdown: string; title: string; spaceKey?: string }) =>
      apiFetch<{ id: number; title: string }>('/pages/import/markdown', {
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

export function useSpaceTree(spaceKey: string) {
  return useQuery({
    queryKey: ['space-tree', spaceKey],
    queryFn: () => apiFetch<{ items: SpaceTreeNode[] }>(`/spaces/${spaceKey}/tree`),
    enabled: !!spaceKey,
  });
}

export function useMovePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; parentId: string | null; spaceKey?: string }) =>
      apiFetch(`/pages/${id}/move`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      queryClient.invalidateQueries({ queryKey: ['space-tree'] });
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
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      queryClient.invalidateQueries({ queryKey: ['space-tree'] });
    },
  });
}

// ======== Breadcrumb ========

export interface BreadcrumbData {
  spaceKey: string | null;
  spaceName: string | null;
  source: 'confluence' | 'local';
  ancestors: { id: number; title: string }[];
  current: { id: number; title: string };
}

export function usePageBreadcrumb(pageId: string | undefined) {
  return useQuery({
    queryKey: ['page-breadcrumb', pageId],
    queryFn: () => apiFetch<BreadcrumbData>(`/pages/${pageId}/breadcrumb`),
    enabled: !!pageId,
    staleTime: 60_000,
  });
}

// ======== RBAC ========

export function useRoles() {
  return useQuery({
    queryKey: ['rbac', 'roles'],
    queryFn: () => apiFetch<{ items: Role[] }>('/rbac/roles'),
  });
}

export function useGroups() {
  return useQuery({
    queryKey: ['rbac', 'groups'],
    queryFn: () => apiFetch<{ items: Group[] }>('/rbac/groups'),
  });
}

export function useSpaceRoles(spaceKey: string) {
  return useQuery({
    queryKey: ['rbac', 'space-roles', spaceKey],
    queryFn: () => apiFetch<{ items: SpaceRole[] }>(`/rbac/spaces/${spaceKey}/roles`),
    enabled: !!spaceKey,
  });
}

// ======== Types ========

export interface Template {
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

export interface Comment {
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

export interface Draft {
  id: number;
  pageId: number;
  bodyJson: string;
  bodyHtml: string;
  savedAt: string;
}

export interface TrashItem {
  id: number;
  title: string;
  deletedAt: string;
  deletedBy: string;
  autoPurgeAt: string;
}

export interface Notification {
  id: number;
  type: string;
  message: string;
  pageId: number | null;
  read: boolean;
  createdAt: string;
}

export interface VerificationHealth {
  totalPages: number;
  verifiedPages: number;
  overduePages: number;
  averageAge: number;
}

export interface Feedback {
  id: number;
  pageId: number;
  userId: string;
  isHelpful: boolean;
  comment: string | null;
  createdAt: string;
}

export interface FeedbackSummary {
  helpful: number;
  notHelpful: number;
  total: number;
  helpfulPercentage: number;
}

/** Matches the GET /api/pages/:id/feedback backend response shape */
export interface PageFeedbackResponse {
  helpful: number;
  notHelpful: number;
  total: number;
  userVote: { isHelpful: boolean; comment: string | null } | null;
}

export interface KnowledgeRequest {
  id: number;
  title: string;
  description: string;
  priority: string;
  status: string;
  requestedBy: string;
  fulfilledByPageId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface SearchResult {
  id: number;
  title: string;
  excerpt: string;
  source: 'confluence' | 'local';
  spaceKey: string;
  score: number;
}

export interface TrendingPage {
  id: number;
  title: string;
  viewCount: number;
  trend: 'up' | 'down' | 'stable';
}

export interface ContentQualityReport {
  averageScore: number;
  distribution: { range: string; count: number }[];
  improvementSuggestions: { pageId: number; title: string; suggestion: string }[];
}

export interface ContentGap {
  topic: string;
  queryCount: number;
  suggestedTitle: string;
}

export interface LocalSpace {
  key: string;
  name: string;
  description: string | null;
  icon: string | null;
  pageCount: number;
  createdBy: string | null;
  createdAt: string;
  source: 'local';
}

export interface SpaceTreeNode {
  id: number;
  title: string;
  parentId: number | null;
  children: SpaceTreeNode[];
}

export interface Role {
  id: number;
  name: string;
  permissions: string[];
}

export interface Group {
  id: number;
  name: string;
  memberCount: number;
}

export interface SpaceRole {
  userId: string;
  userName: string;
  role: string;
}
