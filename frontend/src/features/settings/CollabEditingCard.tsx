import { useEffect, useState } from 'react';
import * as Switch from '@radix-ui/react-switch';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AdminSettings } from '@compendiq/contracts';
import { apiFetch } from '../../shared/lib/api';

export function CollabEditingCard() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<AdminSettings>({
    queryKey: ['admin-settings'],
    queryFn: () => apiFetch('/admin/settings'),
  });

  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (typeof data?.collabEditingEnabled === 'boolean') {
      setEnabled(data.collabEditingEnabled);
    }
  }, [data?.collabEditingEnabled]);

  const mutation = useMutation({
    mutationFn: (collabEditingEnabled: boolean) =>
      apiFetch('/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({ collabEditingEnabled }),
      }),
    onSuccess: (_res, collabEditingEnabled) => {
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      queryClient.invalidateQueries({ queryKey: ['collab-config'] });
      toast.success(
        collabEditingEnabled
          ? 'Collaborative editing enabled'
          : 'Collaborative editing disabled',
      );
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Could not update collaborative editing');
    },
  });

  const saved = data?.collabEditingEnabled === true;
  const dirty = enabled !== saved;

  if (isLoading) {
    return (
      <div className="h-32 animate-pulse rounded-lg bg-muted/60" data-testid="collab-editing-loading" />
    );
  }

  return (
    <section aria-labelledby="collab-editing-heading" data-testid="collab-editing-card">
      <h3 id="collab-editing-heading" className="text-base font-semibold text-foreground">
        Collaborative editing
      </h3>
      <p
        id="collab-editing-help"
        className="mt-1 max-w-[70ch] text-sm leading-6 text-muted-foreground"
      >
        Opt-in realtime editing so two writers on the same article converge without
        a version conflict. Leave this off unless you have checked layout, expand,
        draw.io, tables and comments — the editor&apos;s Confluence nodes are why
        this is not on by default.
      </p>

      <div className="mt-4 flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-3">
        <label htmlFor="collab-editing-enabled" className="cursor-pointer text-sm font-medium text-foreground">
          Enable collaborative editing
        </label>
        <Switch.Root
          id="collab-editing-enabled"
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-describedby="collab-editing-help"
          data-testid="collab-editing-toggle"
          className="relative h-5 w-9 shrink-0 rounded-full bg-foreground/10 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring data-[state=checked]:bg-action"
        >
          <Switch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-4" />
        </Switch.Root>
      </div>

      <div className="mt-3">
        <button
          type="button"
          onClick={() => mutation.mutate(enabled)}
          disabled={!dirty || mutation.isPending}
          className="nm-button-primary px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="collab-editing-save"
        >
          {mutation.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </section>
  );
}
