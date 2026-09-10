import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { apiFetch } from '../../../shared/lib/api';

interface Pending {
  providerId: string;
  model: string;
}

interface Props {
  currentDimensions: number;
  /** Unsaved embedding identity change. Wipe is not offered in this state. */
  pending: Pending | null;
  /** Live assignment the destructive rebuild actually embeds with. */
  live?: Pending | null;
}

type Stage = 'idle' | 'probing' | 'confirm' | 'running';

/**
 * Shape of the BullMQ job-status payload returned by
 * `GET /api/admin/embedding/reembed/:jobId` (plan §2.5, §3.2).
 */
interface ReembedJobStatus {
  jobId: string;
  state?: string;
  progress?:
    | number
    | {
        phase?: 'waiting-on-user-locks' | 'started' | 'embedding' | 'complete';
        heldBy?: string[];
        total?: number;
        processed?: number;
        failed?: number;
        waitedMs?: number;
      };
  heldBy?: string[];
  returnvalue?: unknown;
  failedReason?: string;
}

export function EmbeddingReembedBanner({ currentDimensions, pending, live }: Props) {
  const [stage, setStage] = useState<Stage>('idle');
  const [newDims, setNewDims] = useState<number | null>(null);
  const [jobStatus, setJobStatus] = useState<ReembedJobStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Issue #257 — clean up the polling interval on unmount.
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function startPolling(jobId: string) {
    stopPolling();
    const startedAt = Date.now();
    const MAX_POLL_MS = 30 * 60 * 1_000; // 30 min safety cap
    pollRef.current = setInterval(async () => {
      try {
        const s = await apiFetch<ReembedJobStatus>(`/admin/embedding/reembed/${jobId}`);
        setJobStatus(s);
        const phase =
          typeof s.progress === 'object' && s.progress !== null
            ? (s.progress as { phase?: string }).phase
            : undefined;
        if (s.state === 'completed' || phase === 'complete') {
          toast.success('Re-embed complete');
          stopPolling();
          setStage('idle');
        } else if (s.state === 'failed') {
          toast.error(`Re-embed failed: ${s.failedReason ?? 'unknown error'}`);
          stopPolling();
          setStage('idle');
        } else if (Date.now() - startedAt > MAX_POLL_MS) {
          stopPolling();
        }
      } catch {
        // network blips — keep polling until the safety cap.
      }
    }, 2_000);
  }

  // Issue #257 / PR #261: after a successful re-embed POST, the parent
  // (LlmTab) recomputes `embeddingPending` from refetched saved assignments
  // and hands us `pending === null`. The banner must still render the
  // running-state UI below so the admin keeps seeing phase / heldBy /
  // progress while polling continues — only collapse to null when we're
  // NOT actively tracking a job.
  const hasRunningJob = stage === 'running' && jobStatus !== null;
  const midFlight = stage === 'probing' || stage === 'confirm' || hasRunningJob;
  if (pending && !midFlight) return null;
  if (!pending && !live && !midFlight) return null;

  async function start() {
    if (!live) return;
    setStage('probing');
    try {
      const probe = await apiFetch<{ dimensions: number; error?: string }>(
        '/admin/embedding/probe',
        { method: 'POST', body: JSON.stringify(live) },
      );
      if (probe.error) {
        toast.error(probe.error);
        setStage('idle');
        return;
      }
      setNewDims(probe.dimensions);
      setStage('confirm');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'probe failed');
      setStage('idle');
    }
  }

  async function confirm() {
    setStage('running');
    try {
      const heavy = newDims !== null && newDims !== currentDimensions;
      const body = heavy ? { newDimensions: newDims } : {};
      const r = await apiFetch<{ jobId: string; pageCount: number; heldBy?: string[] }>(
        '/admin/embedding/reembed',
        { method: 'POST', body: JSON.stringify(body) },
      );
      if (r.heldBy && r.heldBy.length > 0) {
        toast.info(
          `Re-embed queued (${r.pageCount} pages). Waiting for ${r.heldBy.join(', ')} to finish.`,
        );
      } else {
        toast.success(`Re-embed queued (${r.pageCount} pages, ${r.jobId})`);
      }
      // Seed an initial status so the progress line renders immediately.
      setJobStatus({ jobId: r.jobId, heldBy: r.heldBy });
      startPolling(r.jobId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'failed');
      setStage('idle');
    }
  }

  if (stage === 'confirm') {
    const heavy = newDims !== null && newDims !== currentDimensions;
    return (
      <div className="nm-card border-destructive/30 p-3 text-sm">
        {heavy ? (
          <p>
            Dimension change: <b>{currentDimensions} → {newDims}</b>. This will{' '}
            <b>delete all existing embeddings</b>, rewrite the column type, and rebuild the
            HNSW index. Continue?
          </p>
        ) : (
          <p>
            This rebuilds the current index (dimension stays at {currentDimensions}). Existing
            vectors will be replaced. Continue?
          </p>
        )}
        <div className="mt-2 flex gap-2">
          <button className="nm-button-ghost" onClick={() => setStage('idle')}>
            Cancel
          </button>
          <button className="nm-button-primary" onClick={confirm}>
            Confirm + re-embed
          </button>
        </div>
      </div>
    );
  }

  // While a job is in flight, surface its current phase so the admin can see
  // progress (plan §2.9). The banner keeps rendering until polling ends.
  if (stage === 'running' && jobStatus) {
    const progress =
      typeof jobStatus.progress === 'object' && jobStatus.progress !== null
        ? jobStatus.progress
        : undefined;
    const phase = progress?.phase;
    let status = 'Queued…';
    if (phase === 'waiting-on-user-locks') {
      const heldBy = progress?.heldBy?.join(', ') ?? '';
      const waitedSec = Math.round((progress?.waitedMs ?? 0) / 1000);
      status = `Waiting for ${heldBy} to finish (${waitedSec}s elapsed)`;
    } else if (phase === 'embedding') {
      status = `${progress?.processed ?? 0}/${progress?.total ?? 0} pages`;
    } else if (phase === 'started') {
      status = `Starting (${progress?.total ?? 0} pages)…`;
    } else if (phase === 'complete') {
      status = 'Complete';
    }
    const processed = progress?.processed ?? 0;
    const total = progress?.total ?? 0;
    // Determinate only where a real pair exists. `embedding` is the one phase
    // that reports both numbers; `waiting-on-user-locks`, `started` and
    // `complete` have nothing to divide, and a bar guessing at a width there
    // would be a claim the server never made.
    const percent =
      phase === 'embedding' && total > 0
        ? Math.min(100, Math.round((processed / total) * 100))
        : null;
    return (
      // Plain `nm-card`: the border tint is gone. It used to be a `border-`
      // utility on `status-embedding` at 30% — pale blue-grey while the token
      // was Steel (1.569:1 Paper / 1.808:1 Graphite against Pane), but the
      // token resolves to body ink now and the same 30% measures 1.941:1 /
      // 2.431:1, i.e. 1.4x and 1.9x the `--color-border` hairline every
      // ordinary card wears (1.414 / 1.264). A card announcing background work
      // would have been the most sharply drawn box on the panel.
      //
      // Lowering the alpha instead does not work: the largest ink alpha that
      // clears Graphite's 1.264 ceiling is 8% (1.212:1), which is QUIETER than
      // an untinted card — the marked surface would read as less defined than
      // an unmarked one. So the state moves off the border entirely and onto
      // the two channels that say it outright: the sentence below, and a
      // determinate bar wherever the job reports pages.
      <div className="nm-card space-y-2 p-3 text-sm" data-testid="reembed-progress-banner">
        <div className="flex items-center justify-between">
          <span>
            Re-embed in progress: <b>{status}</b>
          </span>
        </div>
        {percent !== null && (
          <div
            className="h-1.5 overflow-hidden rounded-full bg-foreground/10"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label="Re-embed progress"
            data-testid="reembed-progress-bar"
          >
            <div
              className="bg-action h-full rounded-full transition-[width] duration-300 ease-out"
              style={{ width: `${percent}%` }}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      className="nm-action-destructive"
      disabled={stage !== 'idle'}
      onClick={start}
    >
      {stage === 'probing' ? 'Probing…' : stage === 'running' ? 'Queuing…' : 'Wipe current index'}
    </button>
  );
}
