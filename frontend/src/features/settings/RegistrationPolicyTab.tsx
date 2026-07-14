import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiFetch } from '../../shared/lib/api';

type RegistrationMode = 'open' | 'closed';

interface AdminSettings {
  registrationMode?: RegistrationMode;
  [key: string]: unknown;
}

/**
 * Issue #1051 — deployment-level self-registration policy.
 *
 * CE-visible sub-tab (no EE gate) under Access Control. Reads/writes
 * `registrationMode` through the shared `GET/PUT /api/admin/settings` surface.
 * The very first account can always be created regardless of this setting
 * (bootstrap), so the choice only takes effect once an admin exists.
 */
export function RegistrationPolicyTab() {
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery<AdminSettings>({
    queryKey: ['admin-settings'],
    queryFn: () => apiFetch('/admin/settings'),
  });

  const [mode, setMode] = useState<RegistrationMode>('closed');

  useEffect(() => {
    if (settings?.registrationMode) {
      setMode(settings.registrationMode);
    }
  }, [settings]);

  const mutation = useMutation({
    mutationFn: (body: { registrationMode: RegistrationMode }) =>
      apiFetch('/admin/settings', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      toast.success('Registration policy updated');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to update registration policy');
    },
  });

  const savedMode: RegistrationMode = settings?.registrationMode ?? 'closed';
  const hasChanges = mode !== savedMode;

  function handleSave() {
    mutation.mutate({ registrationMode: mode });
  }

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          Control whether visitors can create their own accounts from the login screen.
          The first account is always allowed to register (initial setup); this setting
          only takes effect once an administrator exists.
        </p>
      </div>

      <div className="rounded-lg border border-border/30 bg-background/50 p-4">
        <label htmlFor="registration-mode" className="mb-1.5 block text-sm font-medium">
          Self-registration
        </label>
        <select
          id="registration-mode"
          value={mode}
          onChange={(e) => setMode(e.target.value as RegistrationMode)}
          className="w-full rounded-lg border border-border/40 bg-background/50 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/30"
          data-testid="registration-mode-select"
        >
          <option value="closed">Closed — only administrators can create accounts</option>
          <option value="open">Open — anyone can create their own account</option>
        </select>

        {mode === 'open' && (
          <div
            role="alert"
            data-testid="registration-open-warning"
            className="mt-3 rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs text-yellow-600 dark:text-yellow-400"
          >
            <p className="font-semibold">Anyone who can reach this server can create an account.</p>
            <p className="mt-1">
              Self-registered users can sign in and can view and edit any shared standalone
              pages. Only enable open registration on trusted or internal networks.
            </p>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-border/40 pt-4">
        <button
          onClick={handleSave}
          disabled={!hasChanges || mutation.isPending}
          className="nm-button-primary"
          data-testid="registration-policy-save-btn"
        >
          {mutation.isPending ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}
