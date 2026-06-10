import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { KeyRound, X } from 'lucide-react';
import type { SettingsResponse } from '@compendiq/contracts';
import { apiFetch } from '../../lib/api';
import { useSettings } from '../../hooks/use-settings';

/** Settings → Confluence tab — always visible to every role (see settings-nav.ts). */
export const CONFLUENCE_SETTINGS_PATH = '/settings/personal/confluence';

/**
 * Onboarding banner prompting users without a Confluence PAT to configure one
 * (#771). The Confluence PAT is per-user; the setup wizard's Confluence step
 * runs once per deployment and is skippable, so users who log in afterwards
 * land on the dashboard with no hint that Settings → Confluence needs their
 * token before sync/search can work.
 *
 * Visibility is fully derived from `GET /api/settings`:
 *   show ⇔ settings loaded ∧ !hasConfluencePat ∧ !confluencePatPromptDismissed
 *
 * No "first login" flag needed — the condition is stateless on the client and
 * survives refresh and device switches. Dismissal persists server-side
 * (user_settings.confluence_pat_prompt_dismissed_at) via PUT /api/settings;
 * the cache is updated optimistically so the banner hides instantly.
 *
 * Rendered in AppLayout (TrialBanner pattern), which only wraps authenticated
 * app routes — the login page and setup wizard never show it.
 */
export function ConfluencePatBanner() {
  const { data: settings } = useSettings();
  const queryClient = useQueryClient();

  const dismiss = useMutation({
    mutationFn: () =>
      apiFetch('/settings', {
        method: 'PUT',
        body: JSON.stringify({ confluencePatPromptDismissed: true }),
      }),
    onMutate: async () => {
      // Optimistic hide: stop in-flight settings fetches from clobbering the
      // flip, then mark the prompt dismissed in the cache.
      await queryClient.cancelQueries({ queryKey: ['settings'] });
      queryClient.setQueryData<SettingsResponse>(['settings'], (old) =>
        old ? { ...old, confluencePatPromptDismissed: true } : old,
      );
    },
    onSettled: () => {
      // Re-sync with the server either way (confirms the dismissal, or rolls
      // the optimistic update back if the PUT failed).
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  // Never flash while settings are loading / unavailable.
  if (!settings) return null;
  if (settings.hasConfluencePat || settings.confluencePatPromptDismissed) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="confluence-pat-banner"
      className="nm-card mt-2 flex flex-wrap items-center gap-3 px-3 py-2 text-sm text-foreground"
    >
      <KeyRound size={16} className="shrink-0 text-primary" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        Connect Compendiq to Confluence — add your personal access token (PAT)
        so your spaces can sync.
      </span>
      <Link
        to={CONFLUENCE_SETTINGS_PATH}
        className="nm-button-primary shrink-0 px-3 py-1.5 text-xs"
      >
        Configure PAT
      </Link>
      <button
        type="button"
        onClick={() => dismiss.mutate()}
        disabled={dismiss.isPending}
        aria-label="Dismiss Confluence PAT reminder"
        className="nm-icon-button h-8 w-8 shrink-0"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
