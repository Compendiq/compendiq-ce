import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { m } from 'framer-motion';
import { toast } from 'sonner';
import {
  Shield, Loader2, Save, AlertTriangle,
} from 'lucide-react';
import { apiFetch } from '../../shared/lib/api';
import { cn } from '../../shared/lib/cn';
import { useEnterprise } from '../../shared/enterprise/use-enterprise';

// ── Types ──────────────────────────────────────────────────────────────────────

type OrgLlmProvider = 'ollama' | 'openai';

interface LlmPolicy {
  enabled: boolean;
  provider: OrgLlmProvider | null;
  model: string | null;
}

// ── Hooks ──────────────────────────────────────────────────────────────────────

function useLlmPolicy() {
  return useQuery<LlmPolicy>({
    queryKey: ['admin', 'llm-policy'],
    queryFn: () => apiFetch('/admin/llm-policy'),
    staleTime: 30_000,
  });
}

// ── Component ──────────────────────────────────────────────────────────────────

export function LlmPolicyTab() {
  const queryClient = useQueryClient();
  const { hasFeature } = useEnterprise();
  const { data: policy, isLoading } = useLlmPolicy();

  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<OrgLlmProvider | null>(null);
  const [model, setModel] = useState('');
  const [initialized, setInitialized] = useState(false);

  const featureEnabled = hasFeature('org_llm_policy');

  // Populate form when data loads
  if (policy && !initialized) {
    setEnabled(Boolean(policy.enabled));
    setProvider(policy.provider ?? null);
    setModel(policy.model ?? '');
    setInitialized(true);
  }

  const saveMutation = useMutation({
    mutationFn: (body: LlmPolicy) =>
      apiFetch('/admin/llm-policy', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'llm-policy'] });
      toast.success('LLM policy saved');
    },
    onError: (err) => toast.error(err.message),
  });

  const handleSave = useCallback(() => {
    saveMutation.mutate({
      enabled,
      provider: enabled ? provider : null,
      model: enabled ? (model.trim() || null) : null,
    });
  }, [enabled, provider, model, saveMutation]);

  if (!featureEnabled) {
    return (
      <div className="space-y-6" data-testid="llm-policy-gated">
        <m.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-4"
        >
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-500" />
          <div>
            <div className="text-sm font-medium text-amber-200">Enterprise Feature</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Organization-wide LLM policy requires an enterprise license with the LLM Policy feature enabled.
            </div>
          </div>
        </m.div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="llm-policy-loading">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-lg bg-foreground/5" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="llm-policy-form">
      {/* Warning banner */}
      <m.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-4"
      >
        <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-500" />
        <div className="text-xs text-muted-foreground">
          Changes take effect immediately for all users.
        </div>
      </m.div>

      {/* Enable toggle */}
      <div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-border accent-primary"
            data-testid="llm-policy-enabled-toggle"
          />
          <span className="font-medium">Enforce organization-wide LLM policy</span>
        </label>
        <p className="ml-6 text-xs text-muted-foreground">
          When enabled, all users are locked to the provider and model selected below.
        </p>
      </div>

      {/* Provider */}
      <div className={cn(!enabled && 'opacity-50 pointer-events-none')}>
        <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
          <Shield size={14} className="text-muted-foreground" />
          Provider
        </label>
        <p className="mb-2 text-xs text-muted-foreground">
          Locked LLM provider for the organization.
        </p>
        <div className="flex gap-3">
          {(['ollama', 'openai'] as const).map((option) => (
            <label
              key={option}
              className={cn(
                'flex items-center gap-2 rounded-md border px-4 py-2 text-sm cursor-pointer transition-colors',
                provider === option
                  ? 'border-primary/50 bg-primary/10 text-primary'
                  : 'border-border/50 bg-foreground/5 text-muted-foreground hover:bg-foreground/10',
              )}
            >
              <input
                type="radio"
                name="provider"
                value={option}
                checked={provider === option}
                onChange={() => setProvider(option)}
                disabled={!enabled}
                className="sr-only"
                data-testid={`provider-${option}`}
              />
              {option.charAt(0).toUpperCase() + option.slice(1)}
            </label>
          ))}
        </div>
      </div>

      {/* Model */}
      <div className={cn(!enabled && 'opacity-50 pointer-events-none')}>
        <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
          Model
        </label>
        <p className="mb-2 text-xs text-muted-foreground">
          Exact model identifier to enforce. Leave blank to let users pick any model from the locked provider.
        </p>
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="e.g. gpt-4o, qwen3:4b"
          disabled={!enabled}
          className="w-full max-w-md rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed"
          data-testid="model-input"
        />
      </div>

      {/* Save button */}
      <div className="flex items-center justify-end border-t border-border/50 pt-4">
        <button
          onClick={handleSave}
          disabled={saveMutation.isPending}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          data-testid="llm-policy-save-btn"
        >
          {saveMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Save Policy
        </button>
      </div>
    </div>
  );
}
