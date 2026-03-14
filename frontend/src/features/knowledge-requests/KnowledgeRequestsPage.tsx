import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { m } from 'framer-motion';
import {
  Plus, Inbox, CheckCircle, Clock, XCircle,
  Loader2, Link as LinkIcon, User,
} from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { apiFetch } from '../../shared/lib/api';
import { useAuthStore } from '../../stores/auth-store';
import { cn } from '../../shared/lib/cn';

type RequestStatus = 'open' | 'in_progress' | 'completed' | 'declined';
type RequestPriority = 'low' | 'medium' | 'high';
type TabKey = 'all' | 'mine' | 'assigned';

interface KnowledgeRequest {
  id: string;
  title: string;
  description: string;
  priority: RequestPriority;
  status: RequestStatus;
  requesterId: string;
  requesterName: string;
  assigneeId: string | null;
  assigneeName: string | null;
  linkedPageId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface KnowledgeRequestsResponse {
  items: KnowledgeRequest[];
  total: number;
}

function useKnowledgeRequests(params: { tab: TabKey; status?: RequestStatus }) {
  const { tab, status } = params;
  return useQuery<KnowledgeRequestsResponse>({
    queryKey: ['knowledge-requests', { tab, status }],
    queryFn: () => {
      const sp = new URLSearchParams();
      if (tab === 'mine') sp.set('filter', 'mine');
      if (tab === 'assigned') sp.set('filter', 'assigned');
      if (status) sp.set('status', status);
      return apiFetch(`/knowledge-requests?${sp.toString()}`);
    },
    staleTime: 30_000,
  });
}

function useCreateRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { title: string; description: string; priority: RequestPriority }) =>
      apiFetch('/knowledge-requests', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge-requests'] });
    },
  });
}

function useFulfillRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ requestId, pageId }: { requestId: string; pageId: string }) =>
      apiFetch(`/knowledge-requests/${requestId}/fulfill`, {
        method: 'POST',
        body: JSON.stringify({ pageId }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge-requests'] });
    },
  });
}

const STATUS_CONFIG: Record<RequestStatus, { label: string; icon: typeof Clock; colorClass: string; bgClass: string }> = {
  open: { label: 'Open', icon: Inbox, colorClass: 'text-info', bgClass: 'bg-info/10' },
  in_progress: { label: 'In Progress', icon: Loader2, colorClass: 'text-warning', bgClass: 'bg-warning/10' },
  completed: { label: 'Completed', icon: CheckCircle, colorClass: 'text-success', bgClass: 'bg-success/10' },
  declined: { label: 'Declined', icon: XCircle, colorClass: 'text-muted-foreground', bgClass: 'bg-foreground/5' },
};

const PRIORITY_CONFIG: Record<RequestPriority, { label: string; colorClass: string; bgClass: string }> = {
  low: { label: 'Low', colorClass: 'text-muted-foreground', bgClass: 'bg-foreground/5' },
  medium: { label: 'Medium', colorClass: 'text-warning', bgClass: 'bg-warning/10' },
  high: { label: 'High', colorClass: 'text-destructive', bgClass: 'bg-destructive/10' },
};

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'mine', label: 'My Requests' },
  { key: 'assigned', label: 'Assigned to Me' },
];

export function KnowledgeRequestsPage() {
  const [searchParams] = useSearchParams();
  const prefillTitle = searchParams.get('title') ?? '';
  const user = useAuthStore((s) => s.user);

  const [activeTab, setActiveTab] = useState<TabKey>('all');
  const [statusFilter, setStatusFilter] = useState<RequestStatus | ''>('');
  const [showCreateModal, setShowCreateModal] = useState(!!prefillTitle);
  const [newTitle, setNewTitle] = useState(prefillTitle);
  const [newDescription, setNewDescription] = useState('');
  const [newPriority, setNewPriority] = useState<RequestPriority>('medium');

  // Fulfill modal state
  const [fulfillRequestId, setFulfillRequestId] = useState<string | null>(null);
  const [fulfillPageId, setFulfillPageId] = useState('');

  const { data, isLoading } = useKnowledgeRequests({
    tab: activeTab,
    status: statusFilter || undefined,
  });

  const createMutation = useCreateRequest();
  const fulfillMutation = useFulfillRequest();

  const handleCreate = useCallback(() => {
    if (!newTitle.trim()) return;
    createMutation.mutate(
      { title: newTitle.trim(), description: newDescription.trim(), priority: newPriority },
      {
        onSuccess: () => {
          setShowCreateModal(false);
          setNewTitle('');
          setNewDescription('');
          setNewPriority('medium');
        },
      },
    );
  }, [newTitle, newDescription, newPriority, createMutation]);

  const handleFulfill = useCallback(() => {
    if (!fulfillRequestId || !fulfillPageId.trim()) return;
    fulfillMutation.mutate(
      { requestId: fulfillRequestId, pageId: fulfillPageId.trim() },
      {
        onSuccess: () => {
          setFulfillRequestId(null);
          setFulfillPageId('');
        },
      },
    );
  }, [fulfillRequestId, fulfillPageId, fulfillMutation]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Knowledge Requests</h1>
          <p className="text-sm text-muted-foreground">
            Track and fulfill content requests from your team
          </p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          data-testid="create-request-btn"
        >
          <Plus size={16} />
          Create Request
        </button>
      </div>

      {/* Tabs + Status filter */}
      <div className="glass-card p-3">
        <div className="flex flex-wrap items-center gap-3">
          {/* Tabs */}
          <div className="flex gap-1">
            {TABS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm transition-colors',
                  activeTab === key
                    ? 'bg-primary/15 text-primary font-medium'
                    : 'text-muted-foreground hover:bg-foreground/5',
                )}
                data-testid={`tab-${key}`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Status filter */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as RequestStatus | '')}
            className="ml-auto rounded-md bg-foreground/5 px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
            data-testid="status-filter"
          >
            <option value="">All Statuses</option>
            <option value="open">Open</option>
            <option value="in_progress">In Progress</option>
            <option value="completed">Completed</option>
            <option value="declined">Declined</option>
          </select>
        </div>
      </div>

      {/* Request list */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="glass-card h-20 animate-pulse" />
          ))}
        </div>
      ) : !data?.items.length ? (
        <div className="glass-card flex flex-col items-center justify-center py-16 text-center">
          <div className="mb-4 rounded-full bg-muted p-3">
            <Inbox size={32} className="text-muted-foreground" />
          </div>
          <p className="text-lg font-medium" data-testid="empty-requests">No requests found</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {activeTab === 'mine'
              ? "You haven't created any requests yet"
              : activeTab === 'assigned'
                ? 'No requests are assigned to you'
                : 'Create a request to get started'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {data.items.map((request, i) => {
            const statusCfg = STATUS_CONFIG[request.status];
            const priorityCfg = PRIORITY_CONFIG[request.priority];
            const StatusIcon = statusCfg.icon;

            return (
              <m.div
                key={request.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.03 }}
                className="glass-card p-4"
                data-testid={`request-${request.id}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate font-medium">{request.title}</h3>
                      <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', priorityCfg.bgClass, priorityCfg.colorClass)}>
                        {priorityCfg.label}
                      </span>
                      <span className={cn('flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', statusCfg.bgClass, statusCfg.colorClass)}>
                        <StatusIcon size={12} />
                        {statusCfg.label}
                      </span>
                    </div>
                    {request.description && (
                      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                        {request.description}
                      </p>
                    )}
                    <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <User size={12} />
                        {request.requesterName}
                      </span>
                      {request.assigneeName && (
                        <span>Assigned to {request.assigneeName}</span>
                      )}
                      <span>{new Date(request.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                  {/* Actions */}
                  {request.status === 'open' && user && (
                    <button
                      onClick={() => {
                        setFulfillRequestId(request.id);
                        setFulfillPageId('');
                      }}
                      className="flex shrink-0 items-center gap-1 rounded-md bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/20 transition-colors"
                      data-testid={`fulfill-${request.id}`}
                    >
                      <LinkIcon size={12} />
                      Fulfill
                    </button>
                  )}
                </div>
              </m.div>
            );
          })}
        </div>
      )}

      {/* Create Request Modal */}
      {showCreateModal && (
        <>
          <div
            className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
            onClick={() => setShowCreateModal(false)}
            data-testid="create-modal-backdrop"
          />
          <div className="fixed inset-x-0 top-[15%] z-50 mx-auto w-full max-w-md" data-testid="create-request-modal">
            <div className="glass-card mx-4 overflow-hidden shadow-2xl">
              <div className="border-b border-border/50 px-5 py-4">
                <h2 className="font-semibold">Create Knowledge Request</h2>
              </div>
              <div className="space-y-4 p-5">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Title</label>
                  <input
                    type="text"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="What content is needed?"
                    className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                    data-testid="request-title-input"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Description</label>
                  <textarea
                    value={newDescription}
                    onChange={(e) => setNewDescription(e.target.value)}
                    placeholder="Describe what the article should cover..."
                    rows={3}
                    className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary resize-none"
                    data-testid="request-description-input"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Priority</label>
                  <select
                    value={newPriority}
                    onChange={(e) => setNewPriority(e.target.value as RequestPriority)}
                    className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                    data-testid="request-priority-select"
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t border-border/50 px-5 py-3">
                <button
                  onClick={() => setShowCreateModal(false)}
                  className="rounded-md bg-foreground/5 px-4 py-2 text-sm hover:bg-foreground/10"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreate}
                  disabled={!newTitle.trim() || createMutation.isPending}
                  className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  data-testid="submit-request"
                >
                  {createMutation.isPending && <Loader2 size={14} className="animate-spin" />}
                  Create
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Fulfill Modal */}
      {fulfillRequestId && (
        <>
          <div
            className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
            onClick={() => setFulfillRequestId(null)}
            data-testid="fulfill-modal-backdrop"
          />
          <div className="fixed inset-x-0 top-[20%] z-50 mx-auto w-full max-w-md" data-testid="fulfill-modal">
            <div className="glass-card mx-4 overflow-hidden shadow-2xl">
              <div className="border-b border-border/50 px-5 py-4">
                <h2 className="font-semibold">Fulfill Request</h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Link an existing article to fulfill this request
                </p>
              </div>
              <div className="p-5">
                <label className="mb-1 block text-xs text-muted-foreground">Page ID</label>
                <input
                  type="text"
                  value={fulfillPageId}
                  onChange={(e) => setFulfillPageId(e.target.value)}
                  placeholder="Enter the page ID to link..."
                  className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                  data-testid="fulfill-page-id-input"
                  autoFocus
                />
              </div>
              <div className="flex justify-end gap-2 border-t border-border/50 px-5 py-3">
                <button
                  onClick={() => setFulfillRequestId(null)}
                  className="rounded-md bg-foreground/5 px-4 py-2 text-sm hover:bg-foreground/10"
                >
                  Cancel
                </button>
                <button
                  onClick={handleFulfill}
                  disabled={!fulfillPageId.trim() || fulfillMutation.isPending}
                  className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  data-testid="submit-fulfill"
                >
                  {fulfillMutation.isPending && <Loader2 size={14} className="animate-spin" />}
                  Link Article
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
