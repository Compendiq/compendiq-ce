import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { m } from 'framer-motion';
import { toast } from 'sonner';
import { Save, AlertTriangle } from 'lucide-react';
import { apiFetch } from '../../shared/lib/api';
import { Button } from '../../shared/components/Button';
import { useEnterprise } from '../../shared/enterprise/use-enterprise';
import {
  getClientInferenceManager,
  type ClientInferenceOrgMode,
} from '../../shared/lib/client-inference/client-inference-manager';

interface ClientInferenceAdminPolicy {
  enabled: boolean;
  mode: ClientInferenceOrgMode;
  allowedModels: string[];
  maxModelSizeBytes: number | null;
  enforceWebGpuOnly: boolean;
}

const MODES: Array<{ value: ClientInferenceOrgMode; label: string; detail: string }> = [
  {
    value: 'allowed',
    label: 'Allowed',
    detail: 'Authors may run on-device WebGPU models when hardware and their own settings allow.',
  },
  {
    value: 'mandated_offline_only',
    label: 'On-device only',
    detail: 'Ghost text must run on-device. Server fallback is prohibited for inline completion.',
  },
  {
    value: 'disabled_server_only',
    label: 'Disabled — server only',
    detail: 'Browser WebGPU workers are blocked. All inference stays on the server.',
  },
];

function useClientInferenceAdminPolicy() {
  return useQuery<ClientInferenceAdminPolicy>({
    queryKey: ['admin', 'client-inference-policy'],
    queryFn: () => apiFetch('/admin/client-inference-policy'),
    staleTime: 30_000,
  });
}

export function ClientInferenceOrgPolicyTab() {
  const queryClient = useQueryClient();
  const { hasFeature } = useEnterprise();
  const { data: policy, isLoading } = useClientInferenceAdminPolicy();

  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<ClientInferenceOrgMode>('allowed');
  const [initialized, setInitialized] = useState(false);

  const featureEnabled = hasFeature('org_llm_policy');

  if (policy && !initialized) {
    setEnabled(Boolean(policy.enabled));
    setMode(policy.mode);
    setInitialized(true);
  }

  const saveMutation = useMutation({
    mutationFn: (body: Pick<ClientInferenceAdminPolicy, 'enabled' | 'mode'>) =>
      apiFetch('/admin/client-inference-policy', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'client-inference-policy'] });
      queryClient.invalidateQueries({ queryKey: ['client-inference-policy'] });
      await getClientInferenceManager().refreshOrgPolicy();
      toast.success('On-device inference policy saved');
    },
    onError: (err) => toast.error(err.message),
  });

  const handleSave = useCallback(() => {
    saveMutation.mutate({ enabled, mode });
  }, [enabled, mode, saveMutation]);

  if (!featureEnabled) {
    return (
      <div className="space-y-6" data-testid="client-inference-policy-gated">
        <m.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-start gap-3 rounded-lg border border-warning/20 bg-warning/5 p-4"
        >
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning" />
          <div>
            <div className="text-sm font-medium text-warning">Enterprise Feature</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Organization-wide on-device inference policy requires an enterprise license with the LLM Policy feature enabled.
            </div>
          </div>
        </m.div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="client-inference-policy-loading">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-lg bg-foreground/5" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="client-inference-policy-form">
      <m.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-start gap-3 rounded-lg border border-warning/20 bg-warning/5 p-4"
      >
        <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning" />
        <div className="text-xs text-muted-foreground">
          Changes take effect on the next editor request. Open browsers pick up the new mode without a server restart.
        </div>
      </m.div>

      <div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-border accent-primary"
            data-testid="client-inference-policy-enabled-toggle"
          />
          <span className="font-medium">Enforce organization-wide on-device policy</span>
        </label>
        <p className="ml-6 text-xs text-muted-foreground">
          When off, authors keep the Community Edition user and admin toggles.
        </p>
      </div>

      <fieldset disabled={!enabled} className={!enabled ? 'opacity-50' : undefined}>
        <legend className="text-sm font-medium text-foreground">Org mode</legend>
        <div className="mt-3 grid gap-2" role="radiogroup" aria-label="On-device inference org mode">
          {MODES.map((option) => {
            const active = mode === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={!enabled}
                onClick={() => setMode(option.value)}
                data-testid={`client-inference-policy-mode-${option.value}`}
                className={`flex items-start justify-between rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed ${
                  active
                    ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/8'
                    : 'border-border hover:border-border-interactive'
                }`}
              >
                <span>
                  <span className="block text-sm font-medium text-foreground">{option.label}</span>
                  <span className="block text-xs text-muted-foreground">{option.detail}</span>
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="flex items-center justify-end border-t border-border pt-4">
        <Button
          onClick={handleSave}
          disabled={saveMutation.isPending}
          isLoading={saveMutation.isPending}
          variant="primary"
          leftIcon={!saveMutation.isPending ? <Save size={15} /> : undefined}
          data-testid="client-inference-policy-save-btn"
        >
          Save Policy
        </Button>
      </div>
    </div>
  );
}
