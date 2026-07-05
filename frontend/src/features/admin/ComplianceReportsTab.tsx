/**
 * Settings → Compliance Reports tab (EE-gated).
 *
 * Surfaces the seven SOC 2 / ISO 27001 reports from
 * `Compendiq/compendiq-ee#115`. Each report is a one-shot generator: the
 * admin picks a from/to window, hits "Generate", and the browser
 * downloads a ZIP containing a PDF cover sheet + a CSV body.
 *
 * The catalogue is delivered by `GET /api/admin/compliance-reports`,
 * which returns:
 *
 *   { catalogue: ReportId[], available: ReportId[] }
 *
 * `catalogue` is the canonical 7-id list — used to render the full grid
 * even if not every backend module is wired yet (Sprint 2 / 3 / 3-slice-2
 * landed reports incrementally; this tab is now built against the
 * "all 7 wired" registry but still renders coming-soon badges defensively
 * so older deployments downgrade cleanly instead of 400-ing on Generate).
 *
 * Generate flow:
 *   1. POST /api/admin/compliance-reports/generate { reportId, from, to }
 *   2. Response is a ZIP (Content-Type: application/zip). The
 *      X-Report-Sha256 header echoes the integrity hash printed on the
 *      cover sheet so the admin can verify the download without parsing
 *      the PDF binary.
 *   3. Browser downloads the file via createObjectURL + anchor click.
 *
 * The component does NOT use `apiFetch` for the generate POST because
 * `apiFetch` collapses non-JSON responses to `undefined`. We use
 * `fetch` directly with manual auth-header injection and ZIP-blob
 * handling, mirroring the export pattern in LlmAuditPage.
 */
import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { m } from 'framer-motion';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileText,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import type { ReportId, ComplianceReportCatalogue } from '@compendiq/contracts';
import { apiFetch, ApiError } from '../../shared/lib/api';
import { useAuthStore } from '../../stores/auth-store';
import { cn } from '../../shared/lib/cn';
import { ErrorState } from '../../shared/components/feedback/ErrorState';

// ── Catalogue ──────────────────────────────────────────────────────────
//
// `ReportId` and the catalogue request/response shapes are sourced from
// `@compendiq/contracts` (`schemas/compliance-reports.ts`) — the EE
// overlay route validator and registry use the same module, so adding
// a new report touches exactly one place. The local `CATALOGUE` below
// adds the UI-only fields (display copy, control mapping) on top.

interface CatalogueEntry {
  id: ReportId;
  title: string;
  /**
   * One-line auditor-facing description that mirrors the backend
   * module's `description` field — kept here so the UI does not need
   * a second round-trip to render the grid.
   */
  description: string;
  /**
   * Compliance-control mapping printed alongside the title. SOC 2 /
   * ISO 27001 controls relevant to each report — kept in the UI so
   * auditors know at a glance which evidence packet to download for
   * which control without consulting an external mapping doc.
   */
  controls: string;
}

const CATALOGUE: readonly CatalogueEntry[] = [
  {
    id: 'user_access',
    title: 'User Access Report',
    description:
      'Per-user identity, lifecycle, current role + group + space-role assignments, and login activity in the reporting window.',
    controls: 'SOC 2 CC6.2 / CC6.6 · ISO 27001 A.5.15 / A.5.18',
  },
  {
    id: 'admin_actions',
    title: 'Privileged Access Report',
    description:
      'All admin-role actions in the reporting window — every privileged operation, including deferred and rejected ones.',
    controls: 'SOC 2 CC6.3 · ISO 27001 A.8.2',
  },
  {
    id: 'sync_data_flow',
    title: 'Content Modification Report',
    description:
      'Page-content mutation audit trail: per-page create/update/delete/restore/move/reorder/draft-publish events plus the three bulk umbrellas.',
    controls: 'ISO 27001 A.8.15',
  },
  {
    id: 'auth_session',
    title: 'Authentication & Session Report',
    description:
      'Audit trail of every authentication and session-lifecycle event: logins (success + failure), logouts, token refresh / revocation, session create/revoke, password resets.',
    controls: 'SOC 2 CC6.1 / CC7.2 / CC7.3 · ISO 27001 A.8.16',
  },
  {
    id: 'ai_usage',
    title: 'LLM Usage & Safety Attestation',
    description:
      'Per-call LLM attestation with safety flags. Plaintext prompts and responses are NEVER exported — only the SHA-256 prompt_hash.',
    controls: 'SOC 2 CC6.7 · ISO 27001 A.8.15',
  },
  {
    id: 'rbac_changes',
    title: 'RBAC Change Log',
    description:
      'Every RBAC mutation in the reporting window: role grants/revokes, group lifecycle + membership, space access, page-level ACEs, page-permission inheritance toggles.',
    controls: 'SOC 2 CC6.3 · ISO 27001 A.5.18',
  },
  {
    id: 'data_retention',
    title: 'Data Retention Attestation',
    description:
      'Every retention-pruning sweep that ran during the reporting window with the table touched, rows pruned, and the retention window applied.',
    controls: 'ISO 27001 A.8.15',
  },
] as const;

// ── Catalogue API ──────────────────────────────────────────────────────
//
// Response shape comes straight from the contracts package
// (`ComplianceReportCatalogue`). The EE route's response is validated
// against the same Zod schema, so wire drift surfaces at compile time.

function useCatalogue() {
  return useQuery<ComplianceReportCatalogue>({
    queryKey: ['admin', 'compliance-reports', 'catalogue'],
    queryFn: () => apiFetch<ComplianceReportCatalogue>('/admin/compliance-reports'),
    staleTime: 60_000,
    retry: false,
  });
}

// ── Date helpers ───────────────────────────────────────────────────────

/**
 * Format a Date into a `yyyy-mm-ddThh:mm` string suitable for
 * `<input type="datetime-local">`. The picker emits the same shape;
 * we reverse to a real Date by appending `:00.000Z` only when posting
 * — the user's timezone-naive picker value is treated as local for
 * display and posted as the literal ISO string the backend expects
 * (which the backend then parses via `new Date(...)`).
 */
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/**
 * Default reporting window: previous-quarter convention. From: today
 * minus 30 days at 00:00 local. To: today at 00:00 local. SOC 2 Type II
 * windows usually span months/quarters; the picker is the source of
 * truth for the actual window the admin wants.
 */
function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from: toLocalInputValue(from), to: toLocalInputValue(to) };
}

interface ValidationState {
  ok: boolean;
  reason?: string;
}

function validateRange(from: string, to: string): ValidationState {
  if (!from || !to) return { ok: false, reason: 'Pick both a from and a to date.' };
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    return { ok: false, reason: 'Invalid date format.' };
  }
  if (fromMs >= toMs) return { ok: false, reason: 'From must be earlier than to.' };
  if (toMs > Date.now() + 24 * 60 * 60 * 1000) {
    return { ok: false, reason: 'To cannot be more than 24 hours in the future.' };
  }
  const tenYearsMs = 10 * 365 * 24 * 60 * 60 * 1000;
  if (Date.now() - fromMs > tenYearsMs) {
    return { ok: false, reason: 'From cannot be more than 10 years in the past.' };
  }
  return { ok: true };
}

// ── Per-card generation logic ──────────────────────────────────────────

/**
 * One report card: metadata block + range pickers + Generate button.
 * Each card owns its own from/to/inFlight state so an admin can launch
 * multiple downloads in parallel without the cards stepping on each
 * other (large reports can take several seconds to assemble — making
 * the page modal would be hostile).
 */
function ReportCard({
  entry,
  available,
}: {
  entry: CatalogueEntry;
  available: boolean;
}) {
  const initial = useMemo(defaultRange, []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [busy, setBusy] = useState(false);

  const validation = validateRange(from, to);

  const handleGenerate = useCallback(async () => {
    if (!available || busy || !validation.ok) return;
    setBusy(true);

    try {
      // Hand-rolled fetch so we can stream the ZIP body. apiFetch
      // returns `undefined` for non-JSON responses; we need the binary.
      const { accessToken } = useAuthStore.getState();
      const headers: HeadersInit = {
        'Content-Type': 'application/json',
      };
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

      const fromIso = new Date(from).toISOString();
      const toIso = new Date(to).toISOString();

      const res = await fetch('/api/admin/compliance-reports/generate', {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({ reportId: entry.id, from: fromIso, to: toIso }),
      });

      if (!res.ok) {
        // Try to surface the structured error body if the server sent one.
        let message = `Generation failed (${res.status})`;
        try {
          const body = (await res.json()) as { message?: string; error?: string };
          if (body.message) message = body.message;
          else if (body.error) message = body.error;
        } catch {
          // Body wasn't JSON — keep the default message.
        }
        toast.error(message);
        return;
      }

      const blob = await res.blob();
      const sha256 = res.headers.get('X-Report-Sha256') ?? '';
      const filename =
        res.headers
          .get('Content-Disposition')
          ?.match(/filename="([^"]+)"/)
          ?.[1] ??
        `compliance-${entry.id}-${new Date().toISOString().slice(0, 10)}.zip`;

      // Trigger download via anchor click (works in every browser; no
      // need for the showSaveFilePicker API which is patchy in Safari).
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
      }, 100);

      // The truncated hash on the toast is enough for an at-a-glance
      // verification; the full hash is on the PDF cover sheet.
      toast.success(
        sha256
          ? `Report generated · SHA-256 ${sha256.slice(0, 12)}…`
          : 'Report generated',
      );
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Generation failed';
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }, [available, busy, validation.ok, from, to, entry.id]);

  return (
    <div
      className={cn(
        'nm-card p-5 flex flex-col gap-4',
        !available && 'opacity-60',
      )}
      data-testid={`compliance-report-card-${entry.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <FileText size={18} className="mt-0.5 shrink-0 text-action" />
          <div>
            <h3 className="text-sm font-medium tracking-tight">{entry.title}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{entry.controls}</p>
          </div>
        </div>
        {available ? (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-500"
            data-testid={`badge-available-${entry.id}`}
          >
            <CheckCircle2 size={12} />
            Available
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-500"
            data-testid={`badge-coming-soon-${entry.id}`}
          >
            <AlertTriangle size={12} />
            Coming soon
          </span>
        )}
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">{entry.description}</p>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">From</span>
          <input
            type="datetime-local"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            disabled={!available || busy}
            data-testid={`from-${entry.id}`}
            className="rounded-md bg-foreground/5 px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">To</span>
          <input
            type="datetime-local"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            disabled={!available || busy}
            data-testid={`to-${entry.id}`}
            className="rounded-md bg-foreground/5 px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed"
          />
        </label>
      </div>

      {!validation.ok && available && (
        <p
          className="text-xs text-amber-500"
          data-testid={`validation-error-${entry.id}`}
        >
          {validation.reason}
        </p>
      )}

      <button
        type="button"
        onClick={handleGenerate}
        disabled={!available || busy || !validation.ok}
        data-testid={`generate-${entry.id}`}
        className={cn(
          'nm-button-primary inline-flex items-center justify-center gap-2 px-4 py-2 text-sm',
          (!available || !validation.ok) && 'cursor-not-allowed',
        )}
      >
        {busy ? (
          <>
            <Loader2 size={14} className="animate-spin" />
            Generating…
          </>
        ) : (
          <>
            <Download size={14} />
            Generate &amp; download
          </>
        )}
      </button>
    </div>
  );
}

// ── Tab root ───────────────────────────────────────────────────────────

export function ComplianceReportsTab() {
  const { data, isLoading, error, refetch } = useCatalogue();

  // The enterprise feature-gate is also enforced by the settings nav
  // (`requiresFeature: 'compliance_reports'`). Defence-in-depth:
  // a 403 / 404 from the catalogue endpoint surfaces here so a direct
  // navigation in dev tooling doesn't render a misleading empty grid.
  if (error instanceof ApiError && (error.statusCode === 402 || error.statusCode === 403 || error.statusCode === 404)) {
    return (
      <div className="space-y-4" data-testid="compliance-reports-gated">
        <m.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="nm-card p-6"
        >
          <div className="flex items-start gap-3">
            <ShieldCheck size={20} className="mt-0.5 text-action" />
            <div>
              <h2 className="text-base font-medium">Compliance reports require an Enterprise license</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                The SOC 2 / ISO 27001 evidence-packet generator is part of the Compendiq
                Enterprise tier. Configure a valid license in Settings → License to enable
                the seven reports.
              </p>
            </div>
          </div>
        </m.div>
      </div>
    );
  }

  // Any non-gate error (500, network failure) must surface here. Without
  // this branch, execution falls through to an empty availableSet and
  // renders the full catalogue with every report badged unavailable — a
  // backend failure would be indistinguishable from a healthy deployment
  // with no reports wired.
  if (error) {
    return (
      <ErrorState
        title="Couldn't load compliance reports"
        description={error instanceof Error ? error.message : undefined}
        onRetry={() => refetch()}
        testId="compliance-reports-error"
        retryTestId="compliance-reports-retry"
      />
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="compliance-reports-loading">
        <div className="nm-card h-40 animate-pulse" />
        <div className="nm-card h-40 animate-pulse" />
      </div>
    );
  }

  // Server is the authority on which reports are wired. We render the
  // full local CATALOGUE so the UI is identical across deployments at
  // different slice levels — only the badge + button changes.
  const availableSet = new Set<ReportId>(data?.available ?? []);

  return (
    <div className="space-y-6" data-testid="compliance-reports-tab">
      <div>
        <h2 className="text-lg font-medium tracking-tight">Compliance reports</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Self-serve evidence-packet generator for SOC 2 Type II and ISO 27001:2022 audits.
          Each report produces a signed PDF cover sheet (with a SHA-256 integrity hash of
          the CSV body) inside a ZIP archive. Generation is an admin action and is
          recorded in the audit log.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {CATALOGUE.map((entry) => (
          <ReportCard key={entry.id} entry={entry} available={availableSet.has(entry.id)} />
        ))}
      </div>
    </div>
  );
}
