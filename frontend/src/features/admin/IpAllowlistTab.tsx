import { useMemo, useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { m } from 'framer-motion';
import * as Switch from '@radix-ui/react-switch';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Shield,
  Network,
  ServerCog,
  Lock,
  TestTube2,
  Loader2,
  CheckCircle2,
  XCircle,
  Save,
} from 'lucide-react';
import type {
  IpAllowlistConfig,
  IpAllowlistTestResponse,
} from '@compendiq/contracts';
import { useAuthStore } from '../../stores/auth-store';
import { cn } from '../../shared/lib/cn';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ConfigResponse {
  config: IpAllowlistConfig;
}

interface BackendErrorBody {
  error?: string;
  cidr?: string;
  path?: string;
  message?: string;
}

interface PutError {
  kind: 'invalid_cidr' | 'invalid_exception' | 'other';
  cidr?: string;
  path?: string;
  message: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function linesToArray(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function arrayToLines(list: string[]): string {
  return list.join('\n');
}

function arraysShallowEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function configsEqual(a: IpAllowlistConfig, b: IpAllowlistConfig): boolean {
  return (
    a.enabled === b.enabled &&
    arraysShallowEqual(a.cidrs, b.cidrs) &&
    arraysShallowEqual(a.trustedProxies, b.trustedProxies) &&
    arraysShallowEqual(a.exceptions, b.exceptions)
  );
}

// Direct fetch helpers — we bypass `apiFetch` here because the backend
// surfaces structured error shapes (`{ error: 'invalid_cidr', cidr }`) that
// the shared helper flattens to `body.message`. Preserving the raw shape lets
// the UI highlight the offending CIDR.

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const { accessToken } = useAuthStore.getState();
  const headers = new Headers(init?.headers);
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(`/api${path}`, { ...init, headers, credentials: 'include' });
  if (!res.ok) {
    const body: BackendErrorBody = await res.json().catch(() => ({}));
    const err = new Error(body.message ?? body.error ?? res.statusText);
    (err as Error & { status?: number; body?: BackendErrorBody }).status = res.status;
    (err as Error & { status?: number; body?: BackendErrorBody }).body = body;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  if (res.headers.get('content-type')?.includes('application/json')) {
    return res.json();
  }
  return undefined as T;
}

function classifyPutError(err: unknown): PutError {
  if (err instanceof Error) {
    const body = (err as Error & { body?: BackendErrorBody }).body;
    if (body?.error === 'invalid_cidr' && typeof body.cidr === 'string') {
      return { kind: 'invalid_cidr', cidr: body.cidr, message: `Invalid CIDR: ${body.cidr}` };
    }
    if (body?.error === 'invalid_exception' && typeof body.path === 'string') {
      return { kind: 'invalid_exception', path: body.path, message: `Invalid exempt path: ${body.path}` };
    }
    return { kind: 'other', message: err.message };
  }
  return { kind: 'other', message: 'Unknown error' };
}

// ── Component ─────────────────────────────────────────────────────────────────

const EMPTY_CONFIG: IpAllowlistConfig = {
  enabled: false,
  cidrs: [],
  trustedProxies: [],
  exceptions: [],
};

export function IpAllowlistTab() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<ConfigResponse>({
    queryKey: ['ip-allowlist'],
    queryFn: () => fetchJson<ConfigResponse>('/admin/ip-allowlist'),
    staleTime: 30_000,
  });

  // Text-area working copies (so we preserve partial input while the user types).
  const [enabled, setEnabled] = useState(false);
  const [cidrsText, setCidrsText] = useState('');
  const [proxiesText, setProxiesText] = useState('');
  const [exceptions, setExceptions] = useState<string[]>([]);
  const [initialized, setInitialized] = useState(false);

  // Test-panel state
  const [testIp, setTestIp] = useState('');
  const [testResult, setTestResult] = useState<IpAllowlistTestResponse | null>(null);
  const [testInvalidIp, setTestInvalidIp] = useState(false);

  // Save-guard state — the admin must have confirmed an IP is allowed under
  // the *current* form before we let them turn the switch on and apply it.
  const [lastConfirmedIp, setLastConfirmedIp] = useState<string | null>(null);
  const [lastConfirmedIpAllowed, setLastConfirmedIpAllowed] = useState(false);

  // Inline validation (from the most recent PUT attempt).
  const [putError, setPutError] = useState<PutError | null>(null);

  // Hydrate the form once the query resolves.
  useEffect(() => {
    if (!data || initialized) return;
    setEnabled(data.config.enabled);
    setCidrsText(arrayToLines(data.config.cidrs));
    setProxiesText(arrayToLines(data.config.trustedProxies));
    setExceptions(data.config.exceptions);
    setInitialized(true);
  }, [data, initialized]);

  // Current working copy as an IpAllowlistConfig.
  const working: IpAllowlistConfig = useMemo(
    () => ({
      enabled,
      cidrs: linesToArray(cidrsText),
      trustedProxies: linesToArray(proxiesText),
      exceptions,
    }),
    [enabled, cidrsText, proxiesText, exceptions],
  );

  const loaded: IpAllowlistConfig = data?.config ?? EMPTY_CONFIG;
  const dirty = initialized && !configsEqual(working, loaded);

  // Any edit invalidates a previously confirmed test — the CIDR list may have
  // changed, so the admin has to retest against the *pending* config.
  useEffect(() => {
    if (dirty) {
      setLastConfirmedIp(null);
      setLastConfirmedIpAllowed(false);
    }
    // We intentionally depend on `dirty` only — the individual edit setters
    // will flip it true exactly when the form diverges from the loaded
    // config, which is the moment a previous confirmation becomes stale.
  }, [dirty]);

  // Save-button guard:
  //   - must be dirty
  //   - if the form would enable the allowlist, an IP must have tested as allowed
  //   - disabling the allowlist is always safe (no one is being locked out)
  const saveEnabled =
    dirty && (!working.enabled || (lastConfirmedIpAllowed && lastConfirmedIp !== null));

  // ── Mutations ───────────────────────────────────────────────────────────────

  const saveMutation = useMutation({
    mutationFn: (body: IpAllowlistConfig) =>
      fetchJson<void>('/admin/ip-allowlist', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      setPutError(null);
      queryClient.invalidateQueries({ queryKey: ['ip-allowlist'] });
      // Clear the confirmation — any IP confirmed against the previous saved
      // config is no longer authoritative.
      setLastConfirmedIp(null);
      setLastConfirmedIpAllowed(false);
      // Force re-hydration from the new server-side state on next render.
      setInitialized(false);
      toast.success('IP allowlist saved');
    },
    onError: (err: unknown) => {
      const classified = classifyPutError(err);
      setPutError(classified);
      if (classified.kind === 'invalid_cidr') {
        toast.error(classified.message);
      } else if (classified.kind === 'invalid_exception') {
        toast.error(classified.message);
      } else {
        toast.error(`Failed to save: ${classified.message}`);
      }
    },
  });

  const testMutation = useMutation({
    mutationFn: (ip: string) =>
      fetchJson<IpAllowlistTestResponse>('/admin/ip-allowlist/test', {
        method: 'POST',
        body: JSON.stringify({ ip }),
      }),
    onSuccess: (result, ip) => {
      setTestInvalidIp(false);
      setTestResult(result);
      if (result.allowed) {
        setLastConfirmedIp(ip);
        setLastConfirmedIpAllowed(true);
      } else {
        setLastConfirmedIp(null);
        setLastConfirmedIpAllowed(false);
      }
    },
    onError: (err: unknown) => {
      const status = (err as Error & { status?: number; body?: BackendErrorBody }).status;
      const body = (err as Error & { status?: number; body?: BackendErrorBody }).body;
      if (status === 400 && body?.error === 'invalid_ip') {
        setTestInvalidIp(true);
        setTestResult(null);
        setLastConfirmedIp(null);
        setLastConfirmedIpAllowed(false);
        return;
      }
      setTestInvalidIp(false);
      setTestResult(null);
      setLastConfirmedIp(null);
      setLastConfirmedIpAllowed(false);
      toast.error(err instanceof Error ? err.message : 'Test failed');
    },
  });

  const handleTest = useCallback(() => {
    const ip = testIp.trim();
    if (!ip) {
      setTestInvalidIp(true);
      setTestResult(null);
      return;
    }
    setTestInvalidIp(false);
    setTestResult(null);
    testMutation.mutate(ip);
  }, [testIp, testMutation]);

  const handleSave = useCallback(() => {
    if (!saveEnabled) return;
    setPutError(null);
    saveMutation.mutate(working);
  }, [saveEnabled, saveMutation, working]);

  // ── Render ──────────────────────────────────────────────────────────────────

  if (isLoading || !initialized) {
    return (
      <div className="space-y-4" data-testid="ip-allowlist-loading">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-lg bg-foreground/5" />
        ))}
      </div>
    );
  }

  const saveDisabledReason = !dirty
    ? 'No changes to save'
    : working.enabled && !lastConfirmedIpAllowed
      ? "Test your own IP in the panel above first to confirm it's allowed. Save is disabled until then."
      : '';

  return (
    <m.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="space-y-6"
      data-testid="ip-allowlist-tab"
    >
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">IP allowlist</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Restrict API access to specific IP ranges. When enabled, requests from
          non-matching IPs are rejected with 403 at the edge, before any route
          handler runs.
        </p>
      </div>

      {/* Lockout warning — NOT dismissible */}
      <div
        role="alert"
        className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-amber-100"
        data-testid="ip-allowlist-warning"
      >
        <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-400" />
        <div className="text-sm">
          This restricts access to the IPs listed.{' '}
          <strong>Make sure your own IP is in the Allowed ranges before saving</strong>{' '}
          — or you&apos;ll lose access. Use the Test panel below to verify.
        </div>
      </div>

      {/* Enable toggle */}
      <div className="glass-card flex items-center justify-between p-4" data-testid="ip-allowlist-enabled-row">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-foreground/5 text-muted-foreground">
            <Shield size={16} />
          </div>
          <div>
            <div className="text-sm font-medium">Enforce IP allowlist</div>
            <div className="text-xs text-muted-foreground">
              When off, the allowlist is persisted but not applied.
            </div>
          </div>
        </div>
        <Switch.Root
          checked={enabled}
          onCheckedChange={(v) => setEnabled(v)}
          className="relative h-5 w-9 shrink-0 rounded-full bg-foreground/10 transition-colors outline-none data-[state=checked]:bg-primary"
          data-testid="ip-allowlist-enabled-toggle"
          aria-label="Enable IP allowlist enforcement"
        >
          <Switch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-4" />
        </Switch.Root>
      </div>

      {/* Allowed CIDRs */}
      <div>
        <label htmlFor="ip-allowlist-cidrs" className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
          <Network size={14} className="text-muted-foreground" />
          Allowed CIDRs
        </label>
        <textarea
          id="ip-allowlist-cidrs"
          value={cidrsText}
          onChange={(e) => setCidrsText(e.target.value)}
          rows={6}
          spellCheck={false}
          className={cn(
            'w-full resize-y rounded-md bg-foreground/5 px-3 py-2 font-mono text-xs outline-none focus:ring-1 focus:ring-primary',
            putError?.kind === 'invalid_cidr' && 'ring-1 ring-destructive',
          )}
          placeholder="10.0.0.0/8\n2001:db8::/32"
          data-testid="ip-allowlist-cidrs"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          IPv4 and IPv6 supported. Example: 10.0.0.0/8, 2001:db8::/32. One CIDR per line.
        </p>
        {putError?.kind === 'invalid_cidr' && (
          <p className="mt-1 text-xs text-destructive" data-testid="ip-allowlist-cidrs-error">
            Invalid CIDR:{' '}
            <code className="rounded bg-destructive/10 px-1 py-0.5 font-mono">{putError.cidr}</code>
          </p>
        )}
      </div>

      {/* Trusted proxies */}
      <div>
        <label htmlFor="ip-allowlist-proxies" className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
          <ServerCog size={14} className="text-muted-foreground" />
          Trusted proxies
        </label>
        <textarea
          id="ip-allowlist-proxies"
          value={proxiesText}
          onChange={(e) => setProxiesText(e.target.value)}
          rows={4}
          spellCheck={false}
          className="w-full resize-y rounded-md bg-foreground/5 px-3 py-2 font-mono text-xs outline-none focus:ring-1 focus:ring-primary"
          placeholder="127.0.0.1/32\n::1/128"
          data-testid="ip-allowlist-proxies"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Reverse-proxy IP ranges whose X-Forwarded-For header will be honoured. Leave
          the loopback defaults unless you run behind a proxy.
        </p>
      </div>

      {/* Exempt paths (read-only) */}
      <div>
        <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
          <Lock size={14} className="text-muted-foreground" />
          Exempt paths
        </div>
        <ul
          className="space-y-1 rounded-md border border-border/40 bg-foreground/[0.02] p-3"
          data-testid="ip-allowlist-exceptions"
        >
          {exceptions.length === 0 ? (
            <li className="text-xs text-muted-foreground">(none)</li>
          ) : (
            exceptions.map((p) => (
              <li
                key={p}
                className="font-mono text-xs text-muted-foreground"
                data-testid={`ip-allowlist-exception-${p}`}
              >
                {p}
              </li>
            ))
          )}
        </ul>
        <p className="mt-1 text-xs text-muted-foreground">
          Fixed for v0.4; exempt from the allowlist check so you cannot lock yourself out.
        </p>
      </div>

      {/* Test panel */}
      <div className="glass-card space-y-3 p-4" data-testid="ip-allowlist-test-panel">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <TestTube2 size={14} className="text-muted-foreground" />
            Test an IP
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Dry-run the allowlist against a specific address. Confirming that your
            own IP is allowed unlocks the Save button.
          </p>
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={testIp}
            onChange={(e) => {
              setTestIp(e.target.value);
              setTestInvalidIp(false);
            }}
            placeholder="1.2.3.4 or 2001:db8::1"
            className="flex-1 rounded-md bg-foreground/5 px-3 py-2 font-mono text-xs outline-none focus:ring-1 focus:ring-primary"
            data-testid="ip-allowlist-test-ip"
            aria-label="IP address to test"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleTest();
              }
            }}
          />
          <button
            type="button"
            onClick={handleTest}
            disabled={testMutation.isPending || !testIp.trim()}
            className="flex items-center gap-1.5 rounded-md bg-foreground/5 px-3 py-2 text-sm hover:bg-foreground/10 disabled:opacity-50"
            data-testid="ip-allowlist-test-btn"
          >
            {testMutation.isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <TestTube2 size={14} />
            )}
            Test
          </button>
        </div>
        {testInvalidIp && (
          <div className="text-xs text-destructive" data-testid="ip-allowlist-test-invalid">
            Invalid IP address
          </div>
        )}
        {testResult && (
          <m.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className="space-y-2 rounded-md bg-foreground/[0.03] p-3 text-xs"
            data-testid="ip-allowlist-test-result"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
                  testResult.allowed
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : 'bg-destructive/15 text-destructive',
                )}
                data-testid="ip-allowlist-test-outcome"
              >
                {testResult.allowed ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                {testResult.allowed ? 'allowed' : 'blocked'}
              </span>
              {testResult.matchedCidr && (
                <span className="inline-flex items-center rounded-full bg-foreground/5 px-2 py-0.5 font-mono text-xs">
                  matched {testResult.matchedCidr}
                </span>
              )}
              {testResult.isTrustedProxy && (
                <span
                  className="inline-flex items-center rounded-full bg-blue-500/15 px-2 py-0.5 text-xs text-blue-300"
                  data-testid="ip-allowlist-test-trusted-proxy"
                >
                  trusted proxy
                </span>
              )}
            </div>
            <div className="text-muted-foreground" data-testid="ip-allowlist-test-reason">
              {testResult.reason}
            </div>
          </m.div>
        )}
      </div>

      {/* Save */}
      <div className="flex items-center justify-between border-t border-border/50 pt-4">
        <div className="text-xs text-muted-foreground">
          {dirty ? 'You have unsaved changes.' : 'No unsaved changes.'}
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={!saveEnabled || saveMutation.isPending}
          title={saveDisabledReason || undefined}
          aria-label="Save IP allowlist configuration"
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="ip-allowlist-save-btn"
        >
          {saveMutation.isPending ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Save size={14} />
          )}
          Save
        </button>
      </div>

      {putError?.kind === 'other' && (
        <div className="text-xs text-destructive" data-testid="ip-allowlist-save-error">
          {putError.message}
        </div>
      )}
    </m.div>
  );
}
