import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AdminSettings } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';
import { SkeletonFormFields } from '../../../shared/components/feedback/Skeleton';

export function EmbeddingTab() {
  const queryClient = useQueryClient();

  const { data: adminSettings, isLoading } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => apiFetch<AdminSettings>('/admin/settings'),
  });

  const [chunkSize, setChunkSize] = useState<number | undefined>(undefined);
  const [chunkOverlap, setChunkOverlap] = useState<number | undefined>(undefined);
  const [drawioEmbedUrl, setDrawioEmbedUrl] = useState<string | undefined>(undefined);

  // Initialise local state once data loads
  const effectiveChunkSize = chunkSize ?? adminSettings?.embeddingChunkSize ?? 500;
  const effectiveChunkOverlap = chunkOverlap ?? adminSettings?.embeddingChunkOverlap ?? 50;
  const effectiveDrawioUrl = drawioEmbedUrl ?? adminSettings?.drawioEmbedUrl ?? '';

  const savedChunkSize = adminSettings?.embeddingChunkSize ?? 500;
  const savedChunkOverlap = adminSettings?.embeddingChunkOverlap ?? 50;
  const savedDrawioUrl = adminSettings?.drawioEmbedUrl ?? '';

  const hasChunkChanges =
    (chunkSize !== undefined && chunkSize !== savedChunkSize) ||
    (chunkOverlap !== undefined && chunkOverlap !== savedChunkOverlap);
  const hasDrawioChanges =
    drawioEmbedUrl !== undefined && drawioEmbedUrl !== savedDrawioUrl;
  const hasChanges = hasChunkChanges || hasDrawioChanges;

  const updateAdminSettings = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/admin/settings', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      // Also invalidate the drawio-url query so PageViewPage picks up the new URL
      queryClient.invalidateQueries({ queryKey: ['settings', 'drawio-url'] });
      setChunkSize(undefined);
      setChunkOverlap(undefined);
      setDrawioEmbedUrl(undefined);
      const hasChunk = variables.embeddingChunkSize !== undefined || variables.embeddingChunkOverlap !== undefined;
      if (hasChunk) {
        toast.success('Embedding settings saved. All pages queued for re-embedding.');
      } else {
        toast.success('Draw.io settings saved.');
      }
    },
    onError: (err) => toast.error(err.message),
  });

  function handleSave() {
    const updates: Record<string, unknown> = {};
    if (chunkSize !== undefined) updates.embeddingChunkSize = chunkSize;
    if (chunkOverlap !== undefined) updates.embeddingChunkOverlap = chunkOverlap;
    if (drawioEmbedUrl !== undefined) {
      // Empty string clears the setting (backend will delete the row, falling back to default)
      updates.drawioEmbedUrl = drawioEmbedUrl || undefined;
    }
    if (Object.keys(updates).length > 0) {
      updateAdminSettings.mutate(updates);
    }
  }

  if (isLoading) {
    return <SkeletonFormFields />;
  }

  return (
    <div className="space-y-6">
      <div className="glass-card border-yellow-500/30 p-3 text-sm text-yellow-400">
        These settings are shared across all users. Changing chunk settings will trigger re-embedding of all pages, which may take several minutes.
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium" htmlFor="admin-chunk-size-input">
          Chunk Size (tokens)
        </label>
        <p className="mb-1.5 text-sm text-muted-foreground">
          Controls how much text is grouped into each searchable unit for AI Q&amp;A.
          Smaller values (128-256) find precise facts but may miss context.
          Larger values (512-1024) capture complete sections. Default: 500.
        </p>
        <input
          id="admin-chunk-size-input"
          type="number"
          min={128}
          max={2048}
          step={64}
          value={effectiveChunkSize}
          onChange={(e) => setChunkSize(Number(e.target.value))}
          className="glass-input w-40"
          data-testid="admin-chunk-size-input"
        />
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium" htmlFor="admin-chunk-overlap-input">
          Chunk Overlap (tokens)
        </label>
        <p className="mb-1.5 text-sm text-muted-foreground">
          Tokens shared between adjacent chunks to prevent information loss at boundaries.
          Recommended: 10% of chunk size. Default: 50.
        </p>
        <input
          id="admin-chunk-overlap-input"
          type="number"
          min={0}
          max={512}
          step={10}
          value={effectiveChunkOverlap}
          onChange={(e) => setChunkOverlap(Number(e.target.value))}
          className="glass-input w-40"
          data-testid="admin-chunk-overlap-input"
        />
      </div>

      {hasChunkChanges && (
        <div
          className="glass-card border-yellow-500/30 p-3 text-sm text-yellow-400"
          data-testid="admin-chunk-change-warning"
        >
          Saving will mark all embedded pages dirty and trigger global re-embedding.
          This may take several minutes and temporarily affects AI Q&amp;A for all users.
        </div>
      )}

      <hr className="border-border/40" />

      <div>
        <label className="mb-1.5 block text-sm font-medium" htmlFor="admin-drawio-url-input">
          Draw.io Embed URL
        </label>
        <p className="mb-1.5 text-sm text-muted-foreground">
          URL of the draw.io embed server. Change this if{' '}
          <code className="rounded bg-foreground/10 px-1 text-xs">embed.diagrams.net</code> is
          blocked by your firewall. Leave empty to use the default (
          <code className="rounded bg-foreground/10 px-1 text-xs">https://embed.diagrams.net</code>).
        </p>
        <p className="mb-1.5 text-xs text-muted-foreground/70">
          Note: if you use a custom URL, also update the{' '}
          <code className="rounded bg-foreground/10 px-1 text-xs">frame-src</code> directive in{' '}
          <code className="rounded bg-foreground/10 px-1 text-xs">frontend/nginx-security-headers.conf</code>.
        </p>
        <input
          id="admin-drawio-url-input"
          type="url"
          placeholder="https://embed.diagrams.net"
          value={effectiveDrawioUrl}
          onChange={(e) => setDrawioEmbedUrl(e.target.value)}
          className="glass-input w-full max-w-md"
          data-testid="admin-drawio-url-input"
        />
      </div>

      <div>
        <button
          onClick={handleSave}
          disabled={!hasChanges || updateAdminSettings.isPending}
          className="glass-button-primary"
          data-testid="admin-chunk-save-btn"
        >
          {updateAdminSettings.isPending ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}
