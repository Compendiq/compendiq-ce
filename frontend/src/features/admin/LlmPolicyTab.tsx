import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { m } from 'framer-motion';
import { toast } from 'sonner';
import {
  Shield, Loader2, Save, AlertTriangle, X,
} from 'lucide-react';
import { apiFetch } from '../../shared/lib/api';
import { cn } from '../../shared/lib/cn';
import { useEnterprise } from '../../shared/enterprise/use-enterprise';

// ── Types ──────────────────────────────────────────────────────────────────────

type ProviderLock = 'none' | 'ollama' | 'openai';

interface LlmPolicy {
  providerLock: ProviderLock;
  modelAllowlist: string[];
  maxTokensPerRequest: number | null;
  userOverrideAllowed: boolean;
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

  const [providerLock, setProviderLock] = useState<ProviderLock>('none');
  const [modelAllowlist, setModelAllowlist] = useState<string[]>([]);
  const [modelInput, setModelInput] = useState('');
  const [maxTokens, setMaxTokens] = useState<string>('');
  const [userOverride, setUserOverride] = useState(false);
  const [initialized, setInitialized] = useState(false);

  const featureEnabled = hasFeature('org_llm_policy');

  // Populate form when data loads
  if (policy && !initialized) {
    setProviderLock(policy.providerLock);
    setModelAllowlist(policy.modelAllowlist);
    setMaxTokens(policy.maxTokensPerRequest?.toString() ?? '');
    setUserOverride(policy.userOverrideAllowed);
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

  const handleAddModel = useCallback(() => {
    const trimmed = modelInput.trim();
    if (trimmed && !modelAllowlist.includes(trimmed)) {
      setModelAllowlist((prev) => [...prev, trimmed]);
      setModelInput('');
    }
  }, [modelInput, modelAllowlist]);

  const handleRemoveModel = useCallback((model: string) => {
    setModelAllowlist((prev) => prev.filter((m) => m !== model));
  }, []);

  const handleSave = useCallback(() => {
    saveMutation.mutate({
      providerLock,
      modelAllowlist,
      maxTokensPerRequest: maxTokens ? parseInt(maxTokens, 10) : null,
      userOverrideAllowed: userOverride,
    });
  }, [providerLock, modelAllowlist, maxTokens, userOverride, saveMutation]);

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

      {/* Provider lock */}
      <div>
        <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
          <Shield size={14} className="text-muted-foreground" />
          Provider Lock
        </label>
        <p className="mb-2 text-xs text-muted-foreground">
          Restrict which LLM provider users can select.
        </p>
        <div className="flex gap-3">
          {(['none', 'ollama', 'openai'] as const).map((option) => (
            <label
              key={option}
              className={cn(
                'flex items-center gap-2 rounded-md border px-4 py-2 text-sm cursor-pointer transition-colors',
                providerLock === option
                  ? 'border-primary/50 bg-primary/10 text-primary'
                  : 'border-border/50 bg-foreground/5 text-muted-foreground hover:bg-foreground/10',
              )}
            >
              <input
                type="radio"
                name="providerLock"
                value={option}
                checked={providerLock === option}
                onChange={() => setProviderLock(option)}
                className="sr-only"
                data-testid={`provider-lock-${option}`}
              />
              {option === 'none' ? 'No restriction' : option.charAt(0).toUpperCase() + option.slice(1)}
            </label>
          ))}
        </div>
      </div>

      {/* Model allowlist */}
      <div>
        <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
          Model Allowlist
        </label>
        <p className="mb-2 text-xs text-muted-foreground">
          If set, users can only select from these models. Leave empty to allow all models.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={modelInput}
            onChange={(e) => setModelInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAddModel();
              }
            }}
            placeholder="e.g. gpt-4o, qwen3:4b"
            className="flex-1 rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            data-testid="model-allowlist-input"
          />
          <button
            type="button"
            onClick={handleAddModel}
            disabled={!modelInput.trim()}
            className="rounded-md bg-foreground/5 px-3 py-2 text-sm hover:bg-foreground/10 disabled:opacity-50"
            data-testid="add-model-btn"
          >
            Add
          </button>
        </div>
        {modelAllowlist.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {modelAllowlist.map((model) => (
              <span
                key={model}
                className="flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs text-primary"
                data-testid={`model-chip-${model}`}
              >
                {model}
                <button
                  type="button"
                  onClick={() => handleRemoveModel(model)}
                  className="rounded-full p-0.5 hover:bg-primary/20"
                  aria-label={`Remove ${model}`}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Max tokens */}
      <div>
        <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
          Max Tokens per Request
        </label>
        <p className="mb-2 text-xs text-muted-foreground">
          Leave empty for no limit.
        </p>
        <input
          type="number"
          value={maxTokens}
          onChange={(e) => setMaxTokens(e.target.value)}
          placeholder="e.g. 4096"
          min={1}
          className="w-48 rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
          data-testid="max-tokens-input"
        />
      </div>

      {/* User override toggle */}
      <div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={userOverride}
            onChange={(e) => setUserOverride(e.target.checked)}
            className="h-4 w-4 rounded border-border accent-primary"
            data-testid="user-override-toggle"
          />
          Allow users to override policy settings
        </label>
        <p className="ml-6 text-xs text-muted-foreground">
          When enabled, individual users can change their LLM provider and model even if a policy is set.
        </p>
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
