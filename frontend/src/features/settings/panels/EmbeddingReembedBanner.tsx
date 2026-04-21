import { useState } from 'react';
import { toast } from 'sonner';
import { apiFetch } from '../../../shared/lib/api';

interface Pending {
  providerId: string;
  model: string;
}

interface Props {
  currentDimensions: number;
  pending: Pending | null;
}

type Stage = 'idle' | 'probing' | 'confirm' | 'running';

export function EmbeddingReembedBanner({ currentDimensions, pending }: Props) {
  const [stage, setStage] = useState<Stage>('idle');
  const [newDims, setNewDims] = useState<number | null>(null);

  if (!pending) return null;

  async function start() {
    if (!pending) return;
    setStage('probing');
    try {
      const probe = await apiFetch<{ dimensions: number; error?: string }>(
        '/admin/embedding/probe',
        { method: 'POST', body: JSON.stringify(pending) },
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
      const r = await apiFetch<{ jobId: string; pageCount: number }>(
        '/admin/embedding/reembed',
        { method: 'POST', body: JSON.stringify(body) },
      );
      toast.success(`Re-embed queued (${r.pageCount} pages, ${r.jobId})`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'failed');
    } finally {
      setStage('idle');
    }
  }

  if (stage === 'confirm') {
    const heavy = newDims !== null && newDims !== currentDimensions;
    return (
      <div className="glass-card border-red-500/30 p-3 text-sm">
        {heavy ? (
          <>
            <p>
              ⚠ Dimension change: <b>{currentDimensions} → {newDims}</b>. This will{' '}
              <b>delete all existing embeddings</b>, rewrite the column type, and rebuild the
              HNSW index. Continue?
            </p>
            <div
              role="alert"
              className="mt-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-red-200"
            >
              <p className="font-semibold">⚠ Warning: re-embed worker not yet implemented.</p>
              <p className="mt-1">
                Confirming will <b>truncate every existing embedding row</b>, but the worker
                loop that re-embeds all pages against the new model/dimension is tracked as a
                follow-up and has not shipped yet. Until it does, RAG / semantic search will
                return <b>no results</b> for any page.
              </p>
              <p className="mt-1">
                See{' '}
                <a
                  href="https://github.com/Compendiq/compendiq-ce/issues/257"
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline"
                >
                  issue #257
                </a>{' '}
                for progress.
              </p>
            </div>
          </>
        ) : (
          <p>
            ⚠ Embedding model changed (dimension stays at {currentDimensions}). Existing
            vectors will be inconsistent until re-embedded. Continue?
          </p>
        )}
        <div className="mt-2 flex gap-2">
          <button className="glass-button-secondary" onClick={() => setStage('idle')}>
            Cancel
          </button>
          <button className="glass-button-primary" onClick={confirm}>
            Confirm + re-embed
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="glass-card border-yellow-500/30 flex items-center justify-between p-3 text-sm">
      <span>⚠ Embedding provider/model changed. Probe and re-embed required.</span>
      <button
        className="glass-button-primary"
        disabled={stage !== 'idle'}
        onClick={start}
      >
        {stage === 'probing' ? 'Probing…' : stage === 'running' ? 'Queuing…' : 'Probe & re-embed'}
      </button>
    </div>
  );
}
