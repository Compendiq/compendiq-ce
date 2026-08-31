import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { m } from 'framer-motion';
import { toast } from 'sonner';
import {
  Plus, Trash2, Copy, CheckCircle2, AlertTriangle, XCircle, Shield,
} from 'lucide-react';
import { apiFetch } from '../../shared/lib/api';
import { Button, IconButton } from '../../shared/components/Button';
import { useEnterprise } from '../../shared/enterprise/use-enterprise';

// ── Types ──────────────────────────────────────────────────────────────────────

interface ScimToken {
  id: string;
  name: string;
  lastUsedAt: string | null;
  createdAt: string;
  expiresAt: string | null;
  createdBy: string | null;
}

interface ScimTokenCreateResult {
  id: string;
  name: string;
  token: string;        // plaintext, shown once
  expiresAt: string | null;
}

// ── Hooks ──────────────────────────────────────────────────────────────────────

function useScimTokens() {
  return useQuery<ScimToken[]>({
    queryKey: ['admin', 'scim-tokens'],
    queryFn: () => apiFetch('/admin/scim/tokens'),
    staleTime: 30_000,
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatDate(value: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleDateString();
}

type TokenState = 'active' | 'expiring' | 'expired';

function tokenStatus(expiresAt: string | null): TokenState {
  if (!expiresAt) return 'active';
  const now = Date.now();
  const exp = new Date(expiresAt).getTime();
  if (exp <= now) return 'expired';
  // Expiring soon: within 7 days
  if (exp - now < 7 * 24 * 60 * 60 * 1000) return 'expiring';
  return 'active';
}

/**
 * A token's state needs a channel besides hue. The dot this replaced was the
 * only thing in the row saying "expired" — the Expires column shows a date, not
 * a state word — and `success` vs `destructive` (and either against
 * `status-inactive`) collapse to near-identical warm greys under deuteranopia,
 * so the row read the same whether the token worked or not (WCAG 1.4.1).
 *
 * Icon SHAPE carries it visually, in the vocabulary the rest of admin already
 * uses for these three meanings (CheckCircle2 = healthy, AlertTriangle =
 * attention, XCircle = failed); the `sr-only` word is the accessible name,
 * which a `title` would not reliably be.
 */
const statusConfig: Record<
  TokenState,
  { icon: typeof CheckCircle2; className: string; label: string }
> = {
  active: { icon: CheckCircle2, className: 'text-success', label: 'Active' },
  expiring: { icon: AlertTriangle, className: 'text-warning', label: 'Expiring soon' },
  expired: { icon: XCircle, className: 'text-destructive', label: 'Expired' },
};

function TokenStatusIcon({ status }: { status: TokenState }) {
  const { icon: Icon, className, label } = statusConfig[status];
  return (
    <span
      className="inline-flex shrink-0 items-center"
      data-testid={`scim-token-status-${status}`}
    >
      {/* size 13 matches the row's Trash2 action, not the 18px banner icons. */}
      <Icon size={13} className={className} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

// ── Component ──────────────────────────────────────────────────────────────────

export function ScimSettingsPage() {
  const queryClient = useQueryClient();
  const { hasFeature } = useEnterprise();
  const { data: tokens, isLoading } = useScimTokens();

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [tokenName, setTokenName] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('');
  // Security: plaintext token held in state only until explicit dismiss
  const [revealedToken, setRevealedToken] = useState<ScimTokenCreateResult | null>(null);
  const [copiedConfirmed, setCopiedConfirmed] = useState(false);

  const featureEnabled = hasFeature('scim_provisioning');

  const createMutation = useMutation({
    mutationFn: (body: { name: string; expiresInDays?: number }) =>
      apiFetch<ScimTokenCreateResult>('/admin/scim/tokens', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'scim-tokens'] });
      setRevealedToken(result);
      setShowCreateForm(false);
      setTokenName('');
      setExpiresInDays('');
      toast.success('SCIM token generated');
    },
    onError: (err) => toast.error(err.message),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/admin/scim/tokens/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'scim-tokens'] });
      toast.success('Token revoked');
    },
    onError: (err) => toast.error(err.message),
  });

  const handleCreate = useCallback(() => {
    if (!tokenName.trim()) {
      toast.error('Token name is required');
      return;
    }
    const body: { name: string; expiresInDays?: number } = { name: tokenName.trim() };
    if (expiresInDays) {
      body.expiresInDays = parseInt(expiresInDays, 10);
    }
    createMutation.mutate(body);
  }, [tokenName, expiresInDays, createMutation]);

  const handleCopy = useCallback(async () => {
    if (!revealedToken) return;
    try {
      await navigator.clipboard.writeText(revealedToken.token);
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Copy failed — please select and copy manually');
    }
  }, [revealedToken]);

  const handleDismiss = useCallback(() => {
    // Security: remove plaintext from React state immediately
    setRevealedToken(null);
    setCopiedConfirmed(false);
  }, []);

  // ── Feature gate ────────────────────────────────────────────────────

  if (!featureEnabled) {
    return (
      <div className="space-y-6" data-testid="scim-gated">
        <m.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-start gap-3 rounded-lg border border-warning/20 bg-warning/5 p-4"
        >
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning" />
          <div>
            <div className="text-sm font-medium text-warning">Enterprise Feature</div>
            <div className="mt-1 text-xs text-muted-foreground">
              SCIM provisioning requires an enterprise license with the SCIM feature enabled.
            </div>
          </div>
        </m.div>
      </div>
    );
  }

  // ── Loading ─────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="scim-loading">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-lg bg-foreground/5" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="scim-settings">
      {/* Header */}
      <div>
        <h2 className="text-xl font-bold">SCIM Provisioning</h2>
        <p className="text-sm text-muted-foreground">
          Configure SCIM 2.0 bearer tokens for identity provider integration (Okta, Azure AD, etc.)
        </p>
      </div>

      {/* SCIM Base URL */}
      <div className="nm-card p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <Shield size={14} className="text-muted-foreground" />
              SCIM Base URL
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Enter this URL in your identity provider's SCIM configuration.
            </p>
          </div>
          <code className="rounded bg-foreground/5 px-3 py-1.5 font-mono text-sm">/scim/v2</code>
        </div>
      </div>

      {/* Plaintext reveal overlay — security: shown only once after creation */}
      {revealedToken && (
        <m.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="nm-card space-y-4 border border-warning/20 p-4"
          data-testid="scim-token-reveal"
        >
          <div className="flex items-start gap-3 rounded-lg bg-warning/5 p-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning" />
            <div className="text-xs text-muted-foreground">
              <span className="font-medium text-warning">Copy this token now.</span>{' '}
              It will not be shown again. Store it securely in your identity provider.
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Token for "{revealedToken.name}"
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                readOnly
                value={revealedToken.token}
                className="flex-1 rounded-md bg-foreground/5 px-3 py-2 font-mono text-sm outline-none"
                data-testid="scim-token-value"
              />
              <Button
                onClick={handleCopy}
                variant="secondary"
                leftIcon={<Copy size={14} />}
                data-testid="scim-copy-token"
              >
                Copy
              </Button>
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-border pt-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={copiedConfirmed}
                onChange={(e) => setCopiedConfirmed(e.target.checked)}
                className="h-4 w-4 rounded border-border accent-primary"
                data-testid="scim-copied-confirm"
              />
              I have copied this token
            </label>
            <Button
              onClick={handleDismiss}
              disabled={!copiedConfirmed}
              variant="primary"
              leftIcon={<CheckCircle2 size={14} />}
              data-testid="scim-dismiss-token"
            >
              Dismiss
            </Button>
          </div>
        </m.div>
      )}

      {/* Token creation */}
      {!showCreateForm ? (
        <Button
          onClick={() => setShowCreateForm(true)}
          variant="secondary"
          leftIcon={<Plus size={15} />}
          data-testid="generate-token-btn"
        >
          Generate Token
        </Button>
      ) : (
        <m.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="nm-card space-y-3 p-4"
          data-testid="scim-create-form"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Token Name
              </label>
              <input
                type="text"
                value={tokenName}
                onChange={(e) => setTokenName(e.target.value)}
                placeholder="e.g. Okta SCIM"
                className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                data-testid="scim-token-name"
                autoFocus
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Expires In (days)
              </label>
              <input
                type="number"
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
                placeholder="Leave empty for no expiry"
                min={1}
                className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                data-testid="scim-expires-days"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              onClick={handleCreate}
              disabled={!tokenName.trim() || createMutation.isPending}
              isLoading={createMutation.isPending}
              variant="primary"
              size="sm"
              data-testid="scim-create-submit"
            >
              Create
            </Button>
            <Button
              onClick={() => {
                setShowCreateForm(false);
                setTokenName('');
                setExpiresInDays('');
              }}
              variant="ghost"
              size="sm"
            >
              Cancel
            </Button>
          </div>
        </m.div>
      )}

      {/* Token list */}
      {!tokens?.length ? (
        <div className="nm-card py-12 text-center text-sm text-muted-foreground">
          No SCIM tokens
        </div>
      ) : (
        <div className="nm-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium">Last Used</th>
                <th className="px-4 py-3 font-medium">Expires</th>
                <th className="w-16 px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {tokens.map((t, i) => {
                const status = tokenStatus(t.expiresAt);
                return (
                  <m.tr
                    key={t.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: i * 0.03 }}
                    className="hover:bg-foreground/5"
                    data-testid={`scim-token-${t.id}`}
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <TokenStatusIcon status={status} />
                        <span className="font-medium">{t.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {formatDate(t.createdAt)}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {formatDate(t.lastUsedAt)}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {t.expiresAt ? formatDate(t.expiresAt) : 'Never'}
                    </td>
                    <td className="px-4 py-2.5">
                      <IconButton
                        onClick={() => revokeMutation.mutate(t.id)}
                        disabled={revokeMutation.isPending}
                        variant="destructive-ghost"
                        size="sm"
                        icon={<Trash2 size={13} />}
                        aria-label={`Revoke token ${t.name}`}
                        data-testid={`revoke-token-${t.id}`}
                      />
                    </td>
                  </m.tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
