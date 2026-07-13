import { useEffect, useState } from 'react';
import { Clock, AlertTriangle } from 'lucide-react';
import { cn } from '../../lib/cn';
import { apiFetch } from '../../lib/api';
import { useAuthStore } from '../../../stores/auth-store';

/**
 * Response shape from `GET /api/license/info` (EE-only endpoint).
 * In CE deployments the endpoint returns 404 and the banner stays hidden.
 *
 * Producer: compendiq-ee/overlay/backend/src/enterprise/plugin.ts.
 */
interface LicenseInfoResponse {
  tier: 'community' | 'business' | 'enterprise' | 'team';
  type: 'trial' | 'paid' | null;
  expiresAt: string | null;
  daysRemaining: number | null;
  isValid: boolean;
}

/**
 * Banner shown only when the active license is a trial. Three visual states:
 *
 *   daysRemaining  > 7  → subtle informational banner ("Trial — N days remaining")
 *   daysRemaining  1..7 → warning banner ("Trial — only N day(s) left")
 *   daysRemaining  <= 0 → destructive banner ("Trial expired N days ago")
 *
 * Visible to admins only — non-admin users see a clean UI and don't need to
 * act on (or worry about) trial expiry. The fetch is also gated so regular
 * users don't poke the license endpoint on every mount.
 *
 * Self-fetching, single shot on mount. Trial state changes day-to-day at
 * coarse granularity, so a 24h-stale banner is fine — and avoids the
 * polling overhead of `<ServiceStatus />`. Page reload picks up changes
 * issued via /api/admin/license.
 */
export function TrialBanner() {
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const [info, setInfo] = useState<LicenseInfoResponse | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    // apiFetch attaches the in-memory Bearer token; the /license/info route is
    // auth-protected, so a raw fetch would 401 and the banner never renders.
    apiFetch<LicenseInfoResponse>('/license/info')
      .then((data) => {
        if (!cancelled) setInfo(data);
      })
      .catch(() => {
        // ApiError (e.g. 404 in a CE deployment without EE) or network error —
        // banner stays hidden.
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  if (!isAdmin) return null;
  if (!info || info.type !== 'trial' || info.daysRemaining === null) return null;

  const days = info.daysRemaining;
  const tone =
    days <= 0 ? 'destructive' : days <= 7 ? 'warning' : 'info';
  const Icon = tone === 'destructive' ? AlertTriangle : Clock;

  const message =
    days === 0
      ? 'Trial expired today — contact sales to upgrade.'
      : days < 0
        ? `Trial expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago — contact sales to upgrade.`
        : days === 1
          ? 'Trial — only 1 day left. Contact sales to keep enterprise features.'
          : days <= 7
            ? `Trial — only ${days} days left. Contact sales to keep enterprise features.`
            : `Trial — ${days} days remaining.`;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="trial-banner"
      className={cn(
        'mt-2 flex items-center gap-2 rounded-md border px-3 py-2 text-sm',
        tone === 'destructive' && 'border-destructive/30 bg-destructive/15 text-destructive',
        tone === 'warning' && 'border-amber-500/30 bg-amber-500/15 text-amber-900 dark:text-amber-200',
        tone === 'info' && 'border-border bg-muted/50 text-muted-foreground',
      )}
    >
      <Icon size={16} aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}
