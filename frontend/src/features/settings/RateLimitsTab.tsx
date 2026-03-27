import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiFetch } from '../../shared/lib/api';

interface AdminSettings {
  rateLimitGlobal?: number;
  rateLimitAuth?: number;
  rateLimitAdmin?: number;
  rateLimitLlmStream?: number;
  rateLimitLlmEmbedding?: number;
  [key: string]: unknown;
}

const CATEGORIES = [
  {
    key: 'rateLimitGlobal' as const,
    label: 'Global (default)',
    description: 'Default limit for all routes without a specific category.',
    default: 100,
    min: 10,
    max: 10000,
  },
  {
    key: 'rateLimitAuth' as const,
    label: 'Authentication',
    description: 'Login, register, and setup endpoints. Keep low to prevent brute-force attacks.',
    default: 5,
    min: 3,
    max: 1000,
    warning: 'Values below 5 may cause issues with automated tools. Minimum 3 enforced for security.',
  },
  {
    key: 'rateLimitAdmin' as const,
    label: 'Admin operations',
    description: 'Admin settings, labels, audit log, errors, RBAC, and worker triggers.',
    default: 20,
    min: 5,
    max: 1000,
  },
  {
    key: 'rateLimitLlmStream' as const,
    label: 'LLM streaming',
    description: 'Improve, generate, summarize, ask, and diagram generation.',
    default: 10,
    min: 1,
    max: 1000,
  },
  {
    key: 'rateLimitLlmEmbedding' as const,
    label: 'Embedding & PDF',
    description: 'Embedding processing, PDF extraction, and re-embed operations.',
    default: 5,
    min: 1,
    max: 1000,
  },
] as const;

type CategoryKey = (typeof CATEGORIES)[number]['key'];

export function RateLimitsTab() {
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery<AdminSettings>({
    queryKey: ['admin-settings'],
    queryFn: () => apiFetch('/admin/settings'),
  });

  const [values, setValues] = useState<Record<CategoryKey, number>>(() => {
    const defaults: Record<string, number> = {};
    for (const cat of CATEGORIES) defaults[cat.key] = cat.default;
    return defaults as Record<CategoryKey, number>;
  });

  useEffect(() => {
    if (settings) {
      const next: Record<string, number> = {};
      for (const cat of CATEGORIES) {
        next[cat.key] = (settings[cat.key] as number) ?? cat.default;
      }
      setValues(next as Record<CategoryKey, number>);
    }
  }, [settings]);

  const mutation = useMutation({
    mutationFn: (body: Partial<AdminSettings>) =>
      apiFetch('/admin/settings', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      toast.success('Rate limits updated (takes effect within 60 seconds)');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to update rate limits');
    },
  });

  const hasChanges = CATEGORIES.some(
    (cat) => values[cat.key] !== ((settings?.[cat.key] as number) ?? cat.default),
  );

  function handleSave() {
    const updates: Partial<AdminSettings> = {};
    for (const cat of CATEGORIES) {
      if (values[cat.key] !== ((settings?.[cat.key] as number) ?? cat.default)) {
        updates[cat.key] = values[cat.key];
      }
    }
    mutation.mutate(updates);
  }

  function handleResetAll() {
    const defaults: Record<string, number> = {};
    for (const cat of CATEGORIES) defaults[cat.key] = cat.default;
    setValues(defaults as Record<CategoryKey, number>);
  }

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          Configure the maximum number of requests per minute for each endpoint category.
          Changes take effect within 60 seconds. All limits are per IP address.
        </p>
      </div>

      <div className="space-y-4">
        {CATEGORIES.map((cat) => (
          <div key={cat.key} className="rounded-lg border border-border/30 bg-background/50 p-4">
            <div className="flex items-center justify-between">
              <div>
                <label htmlFor={cat.key} className="text-sm font-medium">{cat.label}</label>
                <p className="text-xs text-muted-foreground">{cat.description}</p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  id={cat.key}
                  type="number"
                  min={cat.min}
                  max={cat.max}
                  value={values[cat.key]}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (!isNaN(v)) {
                      setValues((prev) => ({ ...prev, [cat.key]: Math.max(cat.min, Math.min(cat.max, v)) }));
                    }
                  }}
                  className="w-24 rounded-lg border border-border/40 bg-background/50 px-3 py-1.5 text-right text-sm outline-none focus:ring-1 focus:ring-primary/30"
                  data-testid={`rate-limit-${cat.key}`}
                />
                <span className="text-xs text-muted-foreground">/min</span>
              </div>
            </div>
            {'warning' in cat && cat.warning && values[cat.key] < 5 && (
              <p className="mt-2 text-xs text-yellow-500">{cat.warning}</p>
            )}
            {values[cat.key] !== cat.default && (
              <button
                onClick={() => setValues((prev) => ({ ...prev, [cat.key]: cat.default }))}
                className="mt-1 text-xs text-muted-foreground hover:text-destructive"
              >
                Reset to default ({cat.default}/min)
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3 border-t border-border/40 pt-4">
        <button
          onClick={handleSave}
          disabled={!hasChanges || mutation.isPending}
          className="glass-button-primary"
          data-testid="rate-limits-save-btn"
        >
          {mutation.isPending ? 'Saving...' : 'Save'}
        </button>
        <button
          onClick={handleResetAll}
          disabled={mutation.isPending}
          className="text-sm text-muted-foreground hover:text-destructive"
        >
          Reset all to defaults
        </button>
      </div>
    </div>
  );
}
