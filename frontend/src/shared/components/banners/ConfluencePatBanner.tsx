import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { KeyRound, X } from 'lucide-react';
import type { SettingsResponse } from '@compendiq/contracts';
import { apiFetch } from '../../lib/api';
import { useSettings } from '../../hooks/use-settings';
import { CONFLUENCE_SETTINGS_PATH } from '../../lib/routes';

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

  // A strip, not a card, and a text link, not a filled button.
  //
  // This is an onboarding prompt that renders on EVERY authenticated route, and
  // as a `nm-card` with an `nm-button-primary` it carried the only filled teal
  // on screen — so on `/pages/:id` the loudest element was a setup nag and the
  // page's own primary action was quieter than it. It also cost ~145px of an
  // 845px phone viewport, on the route where vertical space matters most.
  //
  // It keeps its full reach (dismissing is still one click, and it still
  // appears everywhere until the token exists) and loses only its rank. The
  // copy is shortened so it fits one line at ordinary widths rather than
  // wrapping to three; "personal access token" is retained because that is the
  // phrase Settings → Confluence uses for the field being asked for.
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="confluence-pat-banner"
      className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground"
    >
      <KeyRound size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        Add your Confluence personal access token so your spaces can sync.
      </span>
      <Link
        to={CONFLUENCE_SETTINGS_PATH}
        className="shrink-0 rounded-md px-2 py-1 font-medium text-action underline-offset-2 transition-colors hover:bg-foreground/5 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        Configure PAT
      </Link>
      <button
        type="button"
        onClick={() => dismiss.mutate()}
        disabled={dismiss.isPending}
        aria-label="Dismiss Confluence PAT reminder"
        className="nm-icon-button size-7 shrink-0"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
