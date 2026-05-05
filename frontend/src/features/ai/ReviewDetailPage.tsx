/**
 * ReviewDetailPage — full-viewport review detail (Compendiq/compendiq-ee#120).
 *
 * Three sections:
 *
 *   1. Header — page id/title, action type, status, submitted/expires.
 *   2. Diff view — side-by-side `diffLines(currentBodyText, proposedContent)`
 *      using `diff` v9 (unmaintained `htmldiff-js` is explicitly out of
 *      scope per .plans/120-ai-output-review.md §1.8). A toggle switches
 *      to a raw HTML view rendered in two columns. The view is responsive:
 *      stacks vertically below the `md` breakpoint.
 *   3. Actions panel — Approve / Reject / Edit-and-approve.
 *      - Approve  → POST /:id/approve
 *      - Reject   → small dialog for an optional `notes`, POST /:id/reject
 *      - Edit-and-approve → fullscreen textarea pre-loaded with the
 *        proposed body_text. The brief asked for a TipTap editor; the
 *        EE route only takes `editedContent` (plain text), so a textarea
 *        is the honest UI. A future iteration can add a TipTap variant
 *        once the route accepts `editedHtml`.
 *
 * Backend contract (EE overlay PR #122 — `routes/foundation/ai-reviews.ts`):
 *   GET  /api/ai-reviews/:id                  → { review: AiReviewDetail }
 *   POST /api/ai-reviews/:id/approve            body: { notes? }
 *   POST /api/ai-reviews/:id/reject             body: { notes? }
 *   POST /api/ai-reviews/:id/edit-and-approve   body: { editedContent, notes? }
 *
 * In CE-only mode the GET 404s; we surface a non-fatal "EE only" notice.
 */

import { useState, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { m } from 'framer-motion';
import { toast } from 'sonner';
import {
  ArrowLeft,
  AlertTriangle,
  Check,
  Code2,
  Edit3,
  FileText,
  Info,
  Loader2,
  ShieldAlert,
  X,
} from 'lucide-react';
import { diffLines } from 'diff';
import { useAuthStore } from '../../stores/auth-store';
import { useEnterprise } from '../../shared/enterprise/use-enterprise';
import { cn } from '../../shared/lib/cn';
import {
  AI_REVIEW_ACTION_LABELS,
  type AiReviewDetail,
  type AiReviewDetailResponse,
} from '@compendiq/contracts';

interface BackendErrorBody {
  error?: string;
  message?: string;
}

type FetchError = Error & { status?: number; body?: BackendErrorBody };

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const { accessToken } = useAuthStore.getState();
  const headers = new Headers(init?.headers);
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(`/api${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });
  if (!res.ok) {
    const body: BackendErrorBody = await res.json().catch(() => ({}));
    const err = new Error(
      body.message ?? body.error ?? res.statusText,
    ) as FetchError;
    err.status = res.status;
    err.body = body;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  if (res.headers.get('content-type')?.includes('application/json')) {
    return res.json();
  }
  return undefined as T;
}

// ── Diff helpers ──────────────────────────────────────────────────────────

interface DiffPart {
  value: string;
  added?: boolean;
  removed?: boolean;
}

/**
 * Render a diff result as a side-by-side pair: removed parts on the
 * left, added parts on the right, unchanged in both. We render line-by-
 * line so the columns are visually aligned even when one side has more
 * content than the other.
 */
function splitForSideBySide(parts: DiffPart[]): {
  left: DiffPart[];
  right: DiffPart[];
} {
  const left: DiffPart[] = [];
  const right: DiffPart[] = [];
  for (const part of parts) {
    if (part.removed) {
      left.push(part);
    } else if (part.added) {
      right.push(part);
    } else {
      left.push(part);
      right.push(part);
    }
  }
  return { left, right };
}

// ── Component ─────────────────────────────────────────────────────────────

export function ReviewDetailPage() {
  const { isEnterprise, hasFeature } = useEnterprise();

  if (!isEnterprise || !hasFeature('ai_output_review')) {
    return (
      <div
        className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100"
        role="alert"
        data-testid="ai-review-detail-not-licensed"
      >
        AI output review is an Enterprise feature. Upgrade your license to
        access the reviewer queue.
      </div>
    );
  }

  return <ReviewDetailPageInner />;
}

function ReviewDetailPageInner() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [showHtml, setShowHtml] = useState(false);

  const { data, isLoading, error, refetch } = useQuery<
    AiReviewDetailResponse,
    FetchError
  >({
    queryKey: ['admin', 'ai-review', id],
    queryFn: () => fetchJson<AiReviewDetailResponse>(`/ai-reviews/${id}`),
    enabled: !!id,
    retry: false,
  });

  const review = data?.review;

  if (error?.status === 404) {
    return (
      <m.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="space-y-6"
        data-testid="ai-review-detail-overlay-missing"
      >
        <button
          type="button"
          onClick={() => navigate('/settings/ai/ai-reviews')}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          data-testid="ai-review-detail-back-btn"
        >
          <ArrowLeft size={14} /> Back to queue
        </button>
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-amber-100"
        >
          <Info size={18} className="mt-0.5 shrink-0 text-amber-400" />
          <div className="text-sm">
            This review couldn&apos;t be loaded. Either the review id is
            invalid, or the Enterprise overlay that exposes the review
            routes isn&apos;t deployed. The CE backend doesn&apos;t register
            <code> GET /api/ai-reviews/:id</code> — install the EE backend
            image to enable the workflow.
          </div>
        </div>
      </m.div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-destructive"
        data-testid="ai-review-detail-error"
      >
        <AlertTriangle size={18} className="mt-0.5 shrink-0" />
        <div className="text-sm">
          Failed to load review: {error.message}
        </div>
      </div>
    );
  }

  if (isLoading || !review) {
    return (
      <div className="space-y-3" data-testid="ai-review-detail-loading">
        <div className="h-12 animate-pulse rounded-lg bg-foreground/5" />
        <div className="h-64 animate-pulse rounded-lg bg-foreground/5" />
      </div>
    );
  }

  return (
    <ReviewDetailContent
      review={review}
      showHtml={showHtml}
      onToggleHtml={() => setShowHtml((v) => !v)}
      onAfterAction={() => {
        // After approve/reject/edit-and-approve the row's status moves;
        // refetch so the header reflects the new state.
        refetch();
      }}
      onBackToQueue={() => navigate('/settings/ai/ai-reviews')}
    />
  );
}

interface ContentProps {
  review: AiReviewDetail;
  showHtml: boolean;
  onToggleHtml: () => void;
  onAfterAction: () => void;
  onBackToQueue: () => void;
}

function ReviewDetailContent({
  review,
  showHtml,
  onToggleHtml,
  onAfterAction,
  onBackToQueue,
}: ContentProps) {
  const [rejectOpen, setRejectOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const approveMutation = useMutation({
    mutationFn: () =>
      fetchJson<{ ok: true }>(`/ai-reviews/${review.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      toast.success('Review approved');
      onAfterAction();
      onBackToQueue();
    },
    onError: (err: FetchError) => toast.error(`Approve failed: ${err.message}`),
  });

  const isPending = review.status === 'pending';

  const original = review.current_body_text ?? '';
  const proposed = review.proposed_content;
  const diff = useMemo(
    () => diffLines(original, proposed) as DiffPart[],
    [original, proposed],
  );
  const sideBySide = useMemo(() => splitForSideBySide(diff), [diff]);

  const stats = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const p of diff) {
      if (p.added) added += p.value.length;
      else if (p.removed) removed += p.value.length;
    }
    return { added, removed };
  }, [diff]);

  return (
    <m.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="space-y-6"
      data-testid="ai-review-detail-page"
    >
      {/* Header */}
      <div>
        <button
          type="button"
          onClick={onBackToQueue}
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          data-testid="ai-review-detail-back-btn"
        >
          <ArrowLeft size={14} /> Back to queue
        </button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold">
              <FileText size={20} className="text-muted-foreground" />
              {review.page_title ?? `Page #${review.page_id}`}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-xs font-medium">
                {AI_REVIEW_ACTION_LABELS[review.action_type]}
              </span>
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-xs font-medium',
                  review.status === 'pending' &&
                    'bg-amber-500/15 text-amber-300',
                  review.status === 'approved' &&
                    'bg-emerald-500/15 text-emerald-300',
                  review.status === 'edit-and-approved' &&
                    'bg-emerald-500/15 text-emerald-300',
                  review.status === 'rejected' &&
                    'bg-destructive/15 text-destructive',
                  review.status === 'expired' &&
                    'bg-muted-foreground/15 text-muted-foreground',
                )}
                data-testid="ai-review-detail-status"
              >
                {review.status}
              </span>
              <span className="text-xs">
                Submitted {new Date(review.authored_at).toLocaleString()}
              </span>
              {review.expires_at && isPending && (
                <span className="text-xs">
                  · Expires {new Date(review.expires_at).toLocaleString()}
                </span>
              )}
              {review.pii_findings_id && (
                <span
                  className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-2 py-0.5 text-xs text-rose-300"
                  data-testid="ai-review-detail-pii-flag"
                >
                  <ShieldAlert size={10} /> PII findings
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Diff toggle bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="text-success">+{stats.added}</span>
          <span className="text-destructive">-{stats.removed}</span>
        </div>
        <div className="flex rounded-md border border-border/50 text-xs">
          <button
            type="button"
            onClick={onToggleHtml}
            className={cn(
              'flex items-center gap-1 px-2 py-1',
              !showHtml
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-foreground/5',
            )}
            data-testid="ai-review-detail-text-toggle"
          >
            <FileText size={12} /> Text
          </button>
          <button
            type="button"
            onClick={onToggleHtml}
            className={cn(
              'flex items-center gap-1 px-2 py-1',
              showHtml
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-foreground/5',
            )}
            data-testid="ai-review-detail-html-toggle"
          >
            <Code2 size={12} /> HTML
          </button>
        </div>
      </div>

      {/* Side-by-side diff (or raw HTML pair) */}
      {showHtml ? (
        <div
          className="grid grid-cols-1 gap-4 md:grid-cols-2"
          data-testid="ai-review-detail-html-pair"
        >
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Current (page body)
            </p>
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-foreground/5 p-3 text-xs leading-relaxed">
              {review.current_body_html ?? '(no current HTML)'}
            </pre>
          </div>
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Proposed (AI output)
            </p>
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-foreground/5 p-3 text-xs leading-relaxed">
              {review.proposed_html ?? '(no proposed HTML)'}
            </pre>
          </div>
        </div>
      ) : (
        <div
          className="grid grid-cols-1 gap-4 md:grid-cols-2"
          data-testid="ai-review-detail-text-diff"
        >
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Current
            </p>
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-foreground/5 p-3 text-sm leading-relaxed">
              {sideBySide.left.map((part, i) => (
                <span
                  key={i}
                  className={cn(
                    part.removed &&
                      'bg-destructive/20 text-destructive line-through',
                  )}
                >
                  {part.value}
                </span>
              ))}
            </pre>
          </div>
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Proposed
            </p>
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-foreground/5 p-3 text-sm leading-relaxed">
              {sideBySide.right.map((part, i) => (
                <span
                  key={i}
                  className={cn(part.added && 'bg-success/20 text-success')}
                >
                  {part.value}
                </span>
              ))}
            </pre>
          </div>
        </div>
      )}

      {/* Reviewer notes (if already actioned) */}
      {review.review_notes && (
        <div
          className="rounded-md border border-border/40 bg-foreground/[0.02] p-3 text-sm"
          data-testid="ai-review-detail-existing-notes"
        >
          <div className="mb-1 text-xs font-medium text-muted-foreground">
            Reviewer notes
          </div>
          <p className="whitespace-pre-wrap text-foreground">
            {review.review_notes}
          </p>
        </div>
      )}

      {/* Action panel */}
      {isPending && (
        <div
          className="flex flex-wrap items-center justify-end gap-2 border-t border-border/50 pt-4"
          data-testid="ai-review-detail-actions"
        >
          <button
            type="button"
            onClick={() => setRejectOpen(true)}
            disabled={approveMutation.isPending}
            className="flex items-center gap-1.5 rounded-md border border-border/50 px-4 py-2 text-sm hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
            data-testid="ai-review-detail-reject-btn"
          >
            <X size={14} /> Reject
          </button>
          <button
            type="button"
            onClick={() => setEditOpen(true)}
            disabled={approveMutation.isPending}
            className="flex items-center gap-1.5 rounded-md border border-border/50 px-4 py-2 text-sm hover:bg-foreground/5 disabled:opacity-50"
            data-testid="ai-review-detail-edit-btn"
          >
            <Edit3 size={14} /> Edit & approve
          </button>
          <button
            type="button"
            onClick={() => approveMutation.mutate()}
            disabled={approveMutation.isPending}
            className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            data-testid="ai-review-detail-approve-btn"
          >
            {approveMutation.isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Check size={14} />
            )}
            Approve
          </button>
        </div>
      )}

      {rejectOpen && (
        <RejectDialog
          reviewId={review.id}
          onClose={() => setRejectOpen(false)}
          onDone={() => {
            setRejectOpen(false);
            onAfterAction();
            onBackToQueue();
          }}
        />
      )}
      {editOpen && (
        <EditAndApproveDialog
          reviewId={review.id}
          initialContent={review.proposed_content}
          onClose={() => setEditOpen(false)}
          onDone={() => {
            setEditOpen(false);
            onAfterAction();
            onBackToQueue();
          }}
        />
      )}
    </m.div>
  );
}

// ── Reject dialog ─────────────────────────────────────────────────────────

interface RejectDialogProps {
  reviewId: string;
  onClose: () => void;
  onDone: () => void;
}

function RejectDialog({ reviewId, onClose, onDone }: RejectDialogProps) {
  const [notes, setNotes] = useState('');

  const mutation = useMutation({
    mutationFn: (body: { notes?: string }) =>
      fetchJson<{ ok: true }>(`/ai-reviews/${reviewId}/reject`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      toast.success('Review rejected');
      onDone();
    },
    onError: (err: FetchError) => toast.error(`Reject failed: ${err.message}`),
  });

  const submit = useCallback(() => {
    const trimmed = notes.trim();
    mutation.mutate(trimmed.length > 0 ? { notes: trimmed } : {});
  }, [notes, mutation]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      data-testid="ai-review-detail-reject-dialog"
    >
      <div className="w-full max-w-md rounded-xl border border-border/50 bg-background p-5 shadow-2xl">
        <h2 className="text-base font-semibold">Reject AI output</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Optional: leave a short note for the author so they can re-run
          the AI with better instructions.
        </p>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={4000}
          rows={4}
          placeholder="(optional notes)"
          className="mt-3 w-full rounded-md border border-border/50 bg-background p-2 text-sm focus:border-primary focus:outline-none"
          data-testid="ai-review-detail-reject-notes"
        />
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={mutation.isPending}
            className="rounded-md border border-border/50 px-4 py-2 text-sm hover:bg-foreground/5 disabled:opacity-50"
            data-testid="ai-review-detail-reject-cancel-btn"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={mutation.isPending}
            className="flex items-center gap-1.5 rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            data-testid="ai-review-detail-reject-confirm-btn"
          >
            {mutation.isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <X size={14} />
            )}
            Confirm reject
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Edit-and-approve dialog ───────────────────────────────────────────────

interface EditDialogProps {
  reviewId: string;
  initialContent: string;
  onClose: () => void;
  onDone: () => void;
}

function EditAndApproveDialog({
  reviewId,
  initialContent,
  onClose,
  onDone,
}: EditDialogProps) {
  const [content, setContent] = useState(initialContent);
  const [notes, setNotes] = useState('');

  const mutation = useMutation({
    mutationFn: (body: { editedContent: string; notes?: string }) =>
      fetchJson<{ ok: true }>(`/ai-reviews/${reviewId}/edit-and-approve`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      toast.success('Edited content approved');
      onDone();
    },
    onError: (err: FetchError) => toast.error(`Edit failed: ${err.message}`),
  });

  const submit = useCallback(() => {
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      toast.error('Edited content must not be empty.');
      return;
    }
    const trimmedNotes = notes.trim();
    mutation.mutate({
      editedContent: content,
      notes: trimmedNotes.length > 0 ? trimmedNotes : undefined,
    });
  }, [content, notes, mutation]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      data-testid="ai-review-detail-edit-dialog"
    >
      <div className="grid h-[90vh] w-full max-w-4xl grid-rows-[auto_1fr_auto] gap-3 rounded-xl border border-border/50 bg-background p-5 shadow-2xl">
        <div>
          <h2 className="text-base font-semibold">Edit & approve</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            The proposed content is pre-loaded below — edit it freely.
            Saving will record both the original AI authorship and your
            edits in the audit trail, then apply your edited version to
            the page.
          </p>
        </div>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          maxLength={1_000_000}
          className="h-full w-full resize-none rounded-md border border-border/50 bg-background p-3 font-mono text-sm leading-relaxed focus:border-primary focus:outline-none"
          data-testid="ai-review-detail-edit-textarea"
        />
        <div className="space-y-2">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={4000}
            rows={2}
            placeholder="(optional notes)"
            className="w-full rounded-md border border-border/50 bg-background p-2 text-sm focus:border-primary focus:outline-none"
            data-testid="ai-review-detail-edit-notes"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={mutation.isPending}
              className="rounded-md border border-border/50 px-4 py-2 text-sm hover:bg-foreground/5 disabled:opacity-50"
              data-testid="ai-review-detail-edit-cancel-btn"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={mutation.isPending}
              className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              data-testid="ai-review-detail-edit-confirm-btn"
            >
              {mutation.isPending ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Check size={14} />
              )}
              Save & approve
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
