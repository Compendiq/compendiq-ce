import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Switch from '@radix-ui/react-switch';
import type {
  AdminSettings,
  ClientAssetInspect,
  ClientAssetInstallStatus,
  ClientAssetManifest,
  ClientAssetSearchResponse,
} from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';
import { getClientInferenceManager } from '../../../shared/lib/client-inference/client-inference-manager';
import { SETTINGS_PANELS } from '../settings-nav';

const SEARCH_DEBOUNCE_MS = 300;

export function ClientInferenceTab() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const settings = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => apiFetch<AdminSettings>('/admin/settings'),
  });
  const manifest = useQuery({
    queryKey: ['client-assets-manifest'],
    queryFn: () => apiFetch<ClientAssetManifest>('/models/client-assets'),
  });
  const search = useQuery({
    queryKey: ['client-assets-search', debouncedQuery],
    queryFn: () => apiFetch<ClientAssetSearchResponse>(
      `/admin/client-assets/search?q=${encodeURIComponent(debouncedQuery)}`,
    ),
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
  const install = useMutation({
    mutationFn: async (repo: string) => {
      const info = await apiFetch<ClientAssetInspect>(
        `/admin/client-assets/inspect?repo=${encodeURIComponent(repo)}`,
      );
      if (!info.ok) throw new Error(info.reason ?? 'Model cannot be installed');
      return apiFetch<ClientAssetInstallStatus>('/admin/client-assets/install', {
        method: 'POST',
        body: JSON.stringify({ repo }),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['client-assets-install'] });
    },
  });
  const installStatus = useQuery({
    queryKey: ['client-assets-install'],
    queryFn: () => apiFetch<ClientAssetInstallStatus>('/admin/client-assets/install'),
    enabled: install.isSuccess,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1000 : false),
  });

  useEffect(() => {
    if (installStatus.data?.status === 'complete') {
      void queryClient.invalidateQueries({ queryKey: ['client-assets-manifest'] });
    }
  }, [installStatus.data?.status, queryClient]);

  const enabled = settings.data?.clientInferenceEnabled ?? false;
  const onnxInstalled = manifest.data?.models.some((m) => m.kind === 'onnx' && m.installed) ?? false;
  const probe = getClientInferenceManager().lastProbe();
  const error = getClientInferenceManager().lastErrorCategory();
  const hits = search.data?.models ?? [];

  return (
    <div className="space-y-6">
      <section aria-labelledby="client-inference-admin-enable">
        <h3 id="client-inference-admin-enable" className="text-sm font-semibold text-foreground">
          On-device suggestions
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
            disabled={!onnxInstalled}
            onCheckedChange={(next) => save.mutate(next)}
            className="relative h-5 w-9 shrink-0 rounded-full bg-foreground/10 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring data-[state=checked]:bg-action disabled:opacity-40"
          >
            <Switch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-4" />
          </Switch.Root>
        </div>
        {!onnxInstalled && (
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Install the on-device model first (download, upload, or volume copy).
          </p>
        )}
      </section>

      <section aria-labelledby="client-inference-download">
        <h3 id="client-inference-download" className="text-sm font-semibold text-foreground">
          Download model
        </h3>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          The server fetches a transformers.js q4 checkpoint from Hugging Face.
          Search is limited to text-generation models at or under 1 GiB.
        </p>
        <label htmlFor="client-inference-model-query" className="mt-3 block text-sm font-medium text-foreground">
          On-device model
        </label>
        <input
          id="client-inference-model-query"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
          placeholder="Search Hugging Face"
          autoComplete="off"
        />
        <ul role="listbox" aria-label="Model matches" className="mt-2 divide-y divide-border rounded-xl border border-border">
          {hits.map((hit) => (
            <li key={hit.repo}>
              <button
                type="button"
                role="option"
                aria-selected={selectedRepo === hit.repo}
                className={`w-full px-4 py-3 text-left text-sm ${selectedRepo === hit.repo ? 'bg-foreground/5' : ''}`}
                onClick={() => setSelectedRepo(hit.repo)}
              >
                <span className="font-medium text-foreground">{hit.repo}</span>
                {hit.recommended ? (
                  <span className="ml-2 text-xs text-muted-foreground">recommended</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="nm-button-ghost mt-3 h-8"
          disabled={!selectedRepo || install.isPending}
          onClick={() => {
            if (selectedRepo) install.mutate(selectedRepo);
          }}
        >
          Download model
        </button>
        {installStatus.data?.status === 'running' && (
          <p role="status" className="mt-2 text-xs leading-5 text-muted-foreground">
            Downloading… {installStatus.data.loaded} / {installStatus.data.total}
          </p>
        )}
        {installStatus.data?.status === 'failed' && (
          <p role="status" className="mt-2 text-xs leading-5 text-muted-foreground">
            {installStatus.data.error ?? 'Install failed'}
          </p>
        )}
        {install.isError && (
          <p role="status" className="mt-2 text-xs leading-5 text-muted-foreground">
            {install.error instanceof Error ? install.error.message : 'Install failed'}
          </p>
        )}
      </section>

      <section aria-labelledby="client-inference-manifest">
        <h3 id="client-inference-manifest" className="text-sm font-semibold text-foreground">
          Installed assets
        </h3>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          Copy operator-supplied files onto the volume as described in the{' '}
          <span className="font-mono text-xs">docs/runbooks/client-inference.md</span> runbook,
          or upload Hunspell dictionaries here. Pre-download lives on each author&apos;s
          Editor card — this tab cannot fill another browser&apos;s cache.
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
          <ul aria-label="Installed assets" className="mt-3 divide-y divide-border rounded-xl border border-border">
            {manifest.data.models.map((model) => (
              <li key={model.id} className="px-4 py-3 text-sm">
                <span className="font-medium text-foreground">{model.repo ?? model.id}</span>
                <span className="ml-2 text-muted-foreground">
                  {model.kind}
                  {' · '}
                  {model.installed ? `${model.bytes} bytes` : 'missing'}
                  {model.kind === 'onnx' && !model.available ? ' · unavailable while the flag is off' : ''}
                </span>
                <AssetUpload
                  modelId={model.id}
                  onDone={() => {
                    void queryClient.invalidateQueries({ queryKey: ['client-assets-manifest'] });
                  }}
                />
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

const UPLOAD_CHUNK = 8 * 1024 * 1024;

function assetFileName(name: string): string {
  if (name === 'model_q4.onnx') return 'onnx/model_q4.onnx';
  return name;
}

function AssetUpload({ modelId, onDone }: { modelId: string; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-2">
      <label className="block text-xs text-muted-foreground">
        Upload
        <input
          type="file"
          className="ml-2 text-xs"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            const dest = assetFileName(file.name);
            setError(null);
            void (async () => {
              try {
                for (let start = 0; start < file.size; start += UPLOAD_CHUNK) {
                  const slice = file.slice(start, Math.min(start + UPLOAD_CHUNK, file.size));
                  const end = start + slice.size - 1;
                  await apiFetch(`/admin/client-assets/${encodeURIComponent(modelId)}/files/${dest}`, {
                    method: 'PUT',
                    headers: {
                      'Content-Type': 'application/octet-stream',
                      'Content-Range': `bytes ${start}-${end}/${file.size}`,
                    },
                    body: slice,
                  });
                }
                onDone();
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Upload failed');
              }
            })();
          }}
        />
      </label>
      {error ? (
        <p role="status" className="mt-1 text-xs leading-5 text-muted-foreground">{error}</p>
      ) : null}
    </div>
  );
}
