import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Switch from '@radix-ui/react-switch';
import type { AdminSettings, ClientAssetManifest } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';
import { getClientInferenceManager } from '../../../shared/lib/client-inference/client-inference-manager';
import { SETTINGS_PANELS } from '../settings-nav';

export function ClientInferenceTab() {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => apiFetch<AdminSettings>('/admin/settings'),
  });
  const manifest = useQuery({
    queryKey: ['client-assets-manifest'],
    queryFn: () => apiFetch<ClientAssetManifest>('/models/client-assets'),
  });
  const save = useMutation({
    mutationFn: (clientInferenceEnabled: boolean) => apiFetch('/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({ clientInferenceEnabled }),
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      void queryClient.invalidateQueries({ queryKey: ['client-assets-manifest'] });
    },
  });

  const enabled = settings.data?.clientInferenceEnabled ?? false;
  const probe = getClientInferenceManager().lastProbe();
  const error = getClientInferenceManager().lastErrorCategory();

  return (
    <div className="space-y-6">
      <section aria-labelledby="client-inference-admin-enable">
        <h3 id="client-inference-admin-enable" className="text-sm font-semibold text-foreground">
          On-device model
        </h3>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          Authors also opt in under Settings → {SETTINGS_PANELS.editor.label}. Weights stay
          on this origin; the browser never fetches Hugging Face.
        </p>
        <div className="mt-3 flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-4">
          <label htmlFor="admin-client-inference" className="text-sm font-medium text-foreground">
            Enable on-device suggestions
          </label>
          <Switch.Root
            id="admin-client-inference"
            checked={enabled}
            onCheckedChange={(next) => save.mutate(next)}
            className="relative h-5 w-9 shrink-0 rounded-full bg-foreground/10 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring data-[state=checked]:bg-action"
          >
            <Switch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-4" />
          </Switch.Root>
        </div>
      </section>

      <section aria-labelledby="client-inference-manifest">
        <h3 id="client-inference-manifest" className="text-sm font-semibold text-foreground">
          Installed assets
        </h3>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          Copy operator-supplied files onto the volume as described in the{' '}
          <span className="font-mono text-xs">docs/runbooks/client-inference.md</span> runbook.
          Pre-download lives on each author&apos;s Editor card — this tab cannot fill another browser&apos;s cache.
        </p>
        {manifest.isPending && !manifest.data && (
          <p className="mt-3 text-sm leading-6 text-muted-foreground">Looking up installed assets…</p>
        )}
        {manifest.isError && !manifest.data && (
          <p role="status" className="mt-3 text-sm leading-6 text-muted-foreground">
            Could not read installed assets.{' '}
            <button
              type="button"
              className="nm-button-ghost h-8"
              onClick={() => { void manifest.refetch(); }}
            >
              Retry
            </button>
          </p>
        )}
        {manifest.data && (
          <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
            {manifest.data.models.map((model) => (
              <li key={model.id} className="px-4 py-3 text-sm">
                <span className="font-medium text-foreground">{model.id}</span>
                <span className="ml-2 text-muted-foreground">
                  {model.kind}
                  {' · '}
                  {model.installed ? `${model.bytes} bytes` : 'missing'}
                  {model.kind === 'onnx' && !model.available ? ' · unavailable while the flag is off' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="client-inference-probe">
        <h3 id="client-inference-probe" className="text-sm font-semibold text-foreground">
          Last GPU probe
        </h3>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          {probe
            ? `${probe.tier}${probe.adapterName ? ` · ${probe.adapterName}` : ''}`
            : 'No probe in this browser session yet.'}
          {error ? ` Last error category: ${error}.` : ''}
        </p>
      </section>
    </div>
  );
}
