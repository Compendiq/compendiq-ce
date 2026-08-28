import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AdminSettings } from '@compendiq/contracts';
import { apiFetch } from '../../shared/lib/api';
import { SkeletonFormFields } from '../../shared/components/feedback/Skeleton';

export function DrawioSettingsTab() {
  const queryClient = useQueryClient();

  const { data: adminSettings, isLoading } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => apiFetch<AdminSettings>('/admin/settings'),
  });

  const [drawioEmbedUrl, setDrawioEmbedUrl] = useState<string | undefined>(undefined);

  const effectiveDrawioUrl = drawioEmbedUrl ?? adminSettings?.drawioEmbedUrl ?? '';
  const savedDrawioUrl = adminSettings?.drawioEmbedUrl ?? '';
  const hasChanges = drawioEmbedUrl !== undefined && drawioEmbedUrl !== savedDrawioUrl;

  const updateAdminSettings = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/admin/settings', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      queryClient.invalidateQueries({ queryKey: ['settings', 'drawio-url'] });
      setDrawioEmbedUrl(undefined);
      toast.success('Draw.io integration settings saved.');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not save Draw.io settings.'),
  });

  function handleSave() {
    if (drawioEmbedUrl === undefined) return;
    const trimmed = drawioEmbedUrl.trim();
    updateAdminSettings.mutate({
      drawioEmbedUrl: trimmed === '' ? null : trimmed,
    });
  }

  if (isLoading) {
    return <SkeletonFormFields />;
  }

  return (
    <div className="space-y-6">
      <section aria-labelledby="drawio-heading">
        <h3 id="drawio-heading" className="text-base font-semibold text-foreground">
          Draw.io Diagramming Server
        </h3>
        <p className="mt-1 max-w-[70ch] text-sm leading-6 text-muted-foreground">
          Configure the Draw.io embed server used for rendering and editing interactive architecture diagrams inside the article editor.
        </p>

        <div className="mt-4 max-w-xl space-y-4 rounded-xl border border-border p-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground" htmlFor="admin-drawio-url-input">
              Embed Server URL
            </label>
            <p className="mb-2 text-xs text-muted-foreground">
              URL of your self-hosted or managed Draw.io embed server. Change this if{' '}
              <code className="rounded bg-foreground/10 px-1 text-xs">embed.diagrams.net</code> is
              blocked by your corporate firewall. Leave empty to use the default (
              <code className="rounded bg-foreground/10 px-1 text-xs">https://embed.diagrams.net</code>).
            </p>
            <input
              id="admin-drawio-url-input"
              type="url"
              placeholder="https://embed.diagrams.net"
              value={effectiveDrawioUrl}
              onChange={(e) => setDrawioEmbedUrl(e.target.value)}
              className="nm-input w-full"
              data-testid="admin-drawio-url-input"
            />
          </div>

          <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">
            <span className="font-semibold text-foreground">Nginx CSP Note:</span> If using a custom domain or on-premise Draw.io container, also update the{' '}
            <code className="rounded bg-foreground/10 px-1 text-xs">frame-src</code> directive in{' '}
            <code className="rounded bg-foreground/10 px-1 text-xs">frontend/nginx-security-headers.conf</code> to permit iframe embedding.
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={!hasChanges || updateAdminSettings.isPending}
              className="nm-button-primary px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
              data-testid="admin-drawio-save-btn"
            >
              {updateAdminSettings.isPending ? 'Saving…' : 'Save'}
            </button>
            {hasChanges && (
              <button
                type="button"
                onClick={() => setDrawioEmbedUrl(undefined)}
                disabled={updateAdminSettings.isPending}
                className="nm-button-ghost px-3 py-2 text-sm"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
